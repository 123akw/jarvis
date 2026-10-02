"""智能体主页的问候与快捷问题（第十四轮，用户反馈 1）。

主页的 4 个快捷问题要像「这个智能体的用户」真会说的话：依据智能体的名称、一句话介绍、职业、
已装插件生成。「学习助手」不该出现「那家火锅叫啥」「奶茶店在搞什么活动」。

- **模型版**：服务器默认模型（环境变量那套，与市场推荐同一个）一次补全，输出 JSON；
  每个问题 ≤18 字、各对应一个已装插件、不出现具体人名店名。校验不过 / 超时 / 没模型一律走规则版。
- **规则版**：职业 chips 里与已装插件对得上的 + 按插件的中性模板（模板里用智能体的介绍或
  职业做主题词，如学习助手 →「帮我把这周的复习计划排进日程」），零模型、随时可算。
- **存储**：tenant_prefs 的 ``platform_home``（不加表），带上平台内容签名；名称 / 介绍 /
  职业 / 插件一改签名就变，读到的旧结果作废、退回规则版并在后台重新生成。
- **触发**：市场开号、新建、``PUT /api/platform``、``GET /api/platform`` 都调 :meth:`HomeService.schedule`；
  签名没变且已是模型版就什么都不做。生成放后台线程，不拖慢接口；同一账号同一签名同时只跑一个。
  模型失败记下规则版，``RETRY_AFTER`` 秒后再读到才重试，不会每次刷新都烧一次模型。
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeout
import datetime as dt
import hashlib
import json
import logging
import re
import threading
from typing import Callable
from urllib.parse import urljoin

from jarvis import plugins as catalog
from jarvis.tenancy import TenantStore

log = logging.getLogger(__name__)

PREF_KEY = "platform_home"
CHIP_COUNT = 4
CHIP_MAX = 18
GREETING_MAX = 20
MODEL_TIMEOUT = 20.0
MODEL_MAX_TOKENS = 1500        # 含思考过程（推理模型的思考也算在内）
RETRY_AFTER = 6 * 3600          # 模型失败后过多久再试（秒）
CHAT_KINDS = ("tool", "skill")  # 对话里能直接用上的插件；通道与流程积木不出快捷问题

# ---------- 规则版 ----------

# 职业的主题词：模板里「这周的{topic}计划」「{topic}要做的事」用；subject 是「帮我搜一下{subject}」用
PROFESSION_TOPICS = {
    "shop_owner": "门店", "freelancer": "接单", "project_manager": "项目", "sales": "客户跟进",
    "teacher": "备课", "student": "复习", "creator": "选题", "office": "行政",
}
PROFESSION_SUBJECTS = {
    "shop_owner": "小店经营的新做法", "freelancer": "行业最新动态", "project_manager": "项目管理的好方法",
    "sales": "行业最新动态", "teacher": "教学资料", "student": "学习资料", "creator": "最近的热门选题",
    "office": "最新的劳动政策",
}
_NAME_SUFFIX = re.compile(r"(?:的)?(?:小管家|管家|小助手|助手|助理|小帮手|帮手|小秘书|秘书|智能体|小精灵|搭子|专家|顾问)$")
_TAGLINE_LEAD = re.compile(r"^(?:帮你|帮我|替你|陪你|专门|用来|随时)?(?:搜索|搜集|搜|查找|查询|查|整理|管理|记录|规划|安排|"
                           r"跟进|打理|处理|收集|分享|学习)?")
_PUNCT = re.compile(r"[，。、；：！？,.;:!?\s「」『』“”\"'（）()]+")

# 每个插件的中性模板（第一条优先）。{topic} 是短主题词，{subject} 是介绍里的主题（搜索用）
TEMPLATES: dict[str, tuple[str, ...]] = {
    "schedule": ("帮我把这周的{topic}计划排进日程", "我下周都有哪些安排"),
    "todo": ("把{topic}要做的事列成待办", "今天还有哪些事没做完"),
    "memo": ("帮我记一条{topic}笔记", "我之前记的笔记在哪"),
    "memory": ("记住我的{topic}习惯", "你都记得我哪些偏好"),
    "weather": ("明天出门要带伞吗", "这周末天气怎么样"),
    "search": ("帮我搜一下{subject}", "最近{topic}有什么新消息"),
    "recall": ("上次聊{topic}说到哪了", "把我们聊过的要点翻出来"),
    "movies": ("最近有什么高分电影", "这部新片口碑怎么样"),
    "esports": ("今晚有什么比赛", "关注的战队最近赢了没"),
    "tickets": ("最近有什么值得看的演出", "演出门票哪里买划算"),
    "meeting": ("开始记会议纪要", "会开完了，停止记录"),
}

# 职业 chips 归到哪个插件（按先后匹配）：只留用户装了的那几条
_CHIP_HINTS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("meeting", ("会议纪要",)),
    ("weather", ("天气", "下雨", "带伞")),
    ("recall", ("上次", "之前", "聊到", "聊过")),
    ("memory", ("记住",)),
    ("movies", ("口碑", "评分", "电影", "新片")),
    ("search", ("查", "搜", "热点")),
    ("schedule", ("提醒", "安排", "几节课", "拜访", "有哪些会", "评审", "点")),
    ("todo", ("作业", "没完成", "要交", "待办", "交初稿", "补货", "记一下")),
    ("memo", ("记个", "记下", "选题")),
)


def chat_plugins(row: dict) -> list[dict]:
    """已装、能在对话里直接用的插件（按安装顺序）。"""
    out = []
    for plugin_id in row.get("plugins") or ():
        item = catalog.get_plugin(plugin_id)
        if item and item.get("kind") in CHAT_KINDS:
            out.append(item)
    return out


def _clean_topic(text: str, limit: int) -> str:
    text = _PUNCT.sub("", text or "")
    return text if 2 <= len(text) <= limit else ""


def topics(row: dict) -> tuple[str, str]:
    """(topic, subject)：topic 是短主题词（≤6 字），subject 是搜索用的主题（≤8 字）。

    职业的主题词最贴切（学生→复习）；没有职业时，名字形如「××助手」取「××」；再没有用介绍。"""
    name = " ".join(str(row.get("name") or "").split())
    tagline = " ".join(str(row.get("tagline") or "").split())
    profession = row.get("profession") or ""
    from_name = _clean_topic(_NAME_SUFFIX.sub("", name), 6) if _NAME_SUFFIX.search(name) else ""
    # 介绍以动词开头（「搜索学习资料」）时，去掉动词剩下的就是主题；否则整句不拿来当主题词
    lead = _TAGLINE_LEAD.match(tagline)
    from_tagline = _clean_topic(tagline[lead.end():], 8) if lead and lead.end() else ""
    topic = PROFESSION_TOPICS.get(profession) or from_name or (from_tagline if len(from_tagline) <= 6 else "") or "工作"
    subject = from_tagline or PROFESSION_SUBJECTS.get(profession) or f"{topic}的最新资讯"
    return topic, subject


def _chip_plugin(text: str) -> str | None:
    for plugin_id, words in _CHIP_HINTS:
        if any(word in text for word in words):
            return plugin_id
    return None


def rules_home(row: dict) -> dict:
    """规则版主页：职业的问候；快捷问题 = 职业 chips 里对得上已装插件的 + 每个插件的中性模板。"""
    profession = catalog.get_profession(row.get("profession") or "")
    name = row.get("name") or "你的智能体"
    greeting = profession["home"]["greeting"] if profession else f"你好，我是「{name}」，有什么可以帮你？"
    installed = chat_plugins(row)
    ids = [item["id"] for item in installed]
    topic, subject = topics(row)
    chips: list[tuple[str, str]] = []
    seen: set[str] = set()

    def push(text: str, plugin_id: str) -> None:
        text = " ".join(str(text or "").split())
        if text and text not in seen and len(chips) < CHIP_COUNT and len(text) <= CHIP_MAX + 4:
            seen.add(text)
            chips.append((text, plugin_id))

    covered: set[str] = set()
    for text in (profession["home"]["chips"] if profession else ()):
        plugin_id = _chip_plugin(text)
        if plugin_id in ids and plugin_id not in covered:
            push(text, plugin_id)
            covered.add(plugin_id)

    def variants(item: dict) -> list[str]:
        own = TEMPLATES.get(item["id"])
        if own:
            return [t.format(topic=topic, subject=subject) for t in own]
        return [str(x) for x in item.get("examples") or ()][:2]   # 新插件（PDF、Excel……）用它自带的示例

    # 先每个插件一条（没被职业 chips 覆盖的优先），不够再轮第二条
    pending = [item for item in installed if item["id"] not in covered] + [item for item in installed if item["id"] in covered]
    for round_ in range(2):
        for item in pending:
            options = variants(item)
            if round_ < len(options):
                push(options[round_], item["id"])
    return {"greeting": greeting, "chips": [t for t, _p in chips], "chip_plugins": [p for _t, p in chips],
            "source": "rules"}


# ---------- 模型版 ----------

SYSTEM_PROMPT = (
    "你在为一个专属智能体设计主页：一句问候，加 4 个快捷问题（用户点一下就直接发给智能体）。\n"
    "要求：\n"
    "1. 问候不超过 16 个字，用智能体的口吻，贴合它的定位；不要自称贾维斯，不要表情。\n"
    "2. 每个快捷问题不超过 18 个字，像这个智能体的用户真会对它说的话（第一人称、口语、具体）。\n"
    "3. 每个问题都必须用得上一个「已装技能」，写出对应技能的 id；4 个问题尽量覆盖不同的技能。\n"
    "4. 贴合智能体的名称、介绍和职业；不要出现具体的人名、店名、品牌名、地名，不要编造数字。\n"
    "5. 不要 Markdown、引号、表情、编号。\n"
    "只输出一个 JSON 对象，不要任何解释：\n"
    '{"greeting": "问候", "chips": [{"text": "快捷问题", "plugin": "技能 id"}, ...]}'
)


def user_prompt(row: dict) -> str:
    profession = catalog.get_profession(row.get("profession") or "")
    lines = [f"智能体名称：{row.get('name') or ''}",
             f"一句话介绍：{row.get('tagline') or '（无）'}",
             f"职业：{profession['name'] + '——' + profession['summary'] if profession else '（未指定）'}",
             "已装技能（id：名称——能干什么）："]
    lines += [f"- {item['id']}：{item['name']}——{item.get('summary') or ''}" for item in chat_plugins(row)]
    return "\n".join(lines)


_FENCE = re.compile(r"^```(?:json)?\s*|\s*```$")
_BAD = re.compile("[*`#<>\\[\\]【】\"“”]|贾维斯|https?://|[\U0001F000-\U0001FAFF☀-➿⬀-⯿]")
# 「王姐」「李总」「张经理」这类具体称呼：常见姓 + 称谓
_PERSON = re.compile("[王李张刘陈杨赵黄周吴徐孙胡朱高林何郭马罗梁宋郑谢韩唐冯董程曹袁邓许沈曾彭吕苏卢蒋蔡丁魏叶潘杜"
                     "戴钟汪田姜范方石姚谭廖邹熊金陆郝孔白崔毛邱秦江顾侯邵孟龙段雷钱汤]"
                     "(?:姐|哥|总|经理|老师|叔|姨|阿姨|师傅|老板|医生|律师|主任)")


def _clean_line(value) -> str:
    if not isinstance(value, str):
        return ""
    text = " ".join(value.split()).strip("「」'\" ")
    return text


def parse_model_output(raw: str, row: dict) -> dict | None:
    """校验模型输出：chips 至少 2 条合格（≤18 字、插件已装、不含人名 / 表情 / 链接）。

    合格的不足 4 条时用规则版补齐；问候不合格（太长、自称贾维斯……）只换成规则版的问候；
    不是 JSON、合格的 chips 不足 2 条返回 None（整段退回规则版）。"""
    text = _FENCE.sub("", (raw or "").strip())
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        data = json.loads(text[start:end + 1])
    except ValueError:
        return None
    if not isinstance(data, dict) or not isinstance(data.get("chips"), list):
        return None
    greeting = _clean_line(data.get("greeting"))
    if not greeting or len(greeting) > GREETING_MAX or _BAD.search(greeting) or _PERSON.search(greeting):
        greeting = rules_home(row)["greeting"]
    installed = {item["id"] for item in chat_plugins(row)}
    chips: list[tuple[str, str]] = []
    seen: set[str] = set()
    for entry in data["chips"]:
        if not isinstance(entry, dict):
            continue
        chip, plugin_id = _clean_line(entry.get("text")), entry.get("plugin")
        if (not chip or len(chip) > CHIP_MAX or chip in seen or plugin_id not in installed
                or _BAD.search(chip) or _PERSON.search(chip)):
            continue
        seen.add(chip)
        chips.append((chip, plugin_id))
        if len(chips) >= CHIP_COUNT:
            break
    if len(chips) < min(2, CHIP_COUNT):
        return None
    if len(chips) < CHIP_COUNT:
        backup = rules_home(row)
        for chip, plugin_id in zip(backup["chips"], backup["chip_plugins"]):
            if len(chips) < CHIP_COUNT and chip not in seen:
                seen.add(chip)
                chips.append((chip, plugin_id))
    return {"greeting": greeting, "chips": [t for t, _p in chips], "chip_plugins": [p for _t, p in chips],
            "source": "model"}


# ---------- 存储与调度 ----------

def signature(row: dict) -> str:
    """影响主页内容的字段：名称、介绍、职业、插件。图标、主题色变了不用重生成。"""
    basis = json.dumps([row.get("name") or "", row.get("tagline") or "", row.get("profession") or "",
                        list(row.get("plugins") or ())], ensure_ascii=False)
    return hashlib.sha256(basis.encode("utf-8")).hexdigest()[:16]


def model_complete(llm, system: str, user: str, *, timeout: float = MODEL_TIMEOUT) -> str:
    """用服务器默认模型做一次非流式补全（DNS 钉死到公网地址、不读代理环境变量）。

    与市场推荐同一条路，但 max_tokens 放宽到 MODEL_MAX_TOKENS：默认模型带思考过程时，
    思考也计入 max_tokens，400 时实测约四分之一的回复被截断成空串。"""
    from jarvis.provider_runtime import close_async_client, safe_http_clients

    client, async_client = safe_http_clients(timeout=timeout)
    try:
        response = client.post(
            urljoin(llm.base_url.rstrip("/") + "/", "chat/completions"),
            headers={"Authorization": f"Bearer {llm.api_key}", "Content-Type": "application/json"},
            json={"model": llm.model, "temperature": 0.3, "max_tokens": MODEL_MAX_TOKENS, "stream": False,
                  "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]},
        )
        response.raise_for_status()
        payload = response.json()
        return str(((payload.get("choices") or [{}])[0].get("message") or {}).get("content") or "")
    finally:
        client.close()
        close_async_client(async_client)


def _now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


_POOL =ThreadPoolExecutor(max_workers=2, thread_name_prefix="jarvis-home")
_MODEL_POOL = ThreadPoolExecutor(max_workers=2, thread_name_prefix="jarvis-home-model")


class HomeService:
    """complete() 返回一次模型补全函数 (system, user) -> str，或 None（没有可用模型，只走规则）。"""

    def __init__(self, complete: Callable[[], Callable[[str, str], str] | None] | None = None, *,
                 store_factory=TenantStore, executor=None, timeout: float = MODEL_TIMEOUT, clock=_now):
        self.complete = complete or (lambda: None)
        self.store_factory = store_factory
        self.executor = executor or _POOL
        self.timeout = timeout
        self.clock = clock
        self._pending: set[tuple[str, str]] = set()
        self._lock = threading.Lock()

    def _stored(self, owner_id: str) -> dict | None:
        try:
            raw = self.store_factory().get_pref(PREF_KEY, owner_id=owner_id)
            data = json.loads(raw) if raw else None
        except Exception as exc:
            log.info("platform home read failed: %s", type(exc).__name__)
            return None
        return data if isinstance(data, dict) else None

    def view(self, row: dict) -> dict:
        """当前主页：存着的结果签名对得上就用它，否则现算规则版。"""
        stored = self._stored(row["owner_id"]) if row.get("owner_id") else None
        if stored and stored.get("sig") == signature(row) and isinstance(stored.get("chips"), list):
            return {"greeting": str(stored.get("greeting") or ""), "chips": [str(c) for c in stored["chips"]],
                    "chip_plugins": [str(p) for p in stored.get("chip_plugins") or []],
                    "source": "model" if stored.get("source") == "model" else "rules"}
        return rules_home(row)

    def _model(self):
        try:
            return self.complete()
        except Exception:
            return None

    def needs_generation(self, row: dict) -> bool:
        stored = self._stored(row["owner_id"])
        if not stored or stored.get("sig") != signature(row):
            return True
        if stored.get("source") == "model":
            return False
        try:
            at = dt.datetime.fromisoformat(str(stored.get("at")))
        except ValueError:
            return True
        return (self.clock() - at).total_seconds() >= RETRY_AFTER

    def schedule(self, row: dict | None) -> bool:
        """需要时把生成放到后台；返回是否真的排上了。没有模型、已是最新、同一签名正在生成都不排。"""
        if not row or not row.get("owner_id") or self._model() is None:
            return False
        try:
            if not self.needs_generation(row):
                return False
        except Exception:
            return False
        key = (row["owner_id"], signature(row))
        with self._lock:
            if key in self._pending:
                return False
            self._pending.add(key)
        snapshot = dict(row, plugins=list(row.get("plugins") or ()))

        def run() -> None:
            try:
                self.generate(snapshot)
            except Exception as exc:
                log.info("platform home generation failed: %s", type(exc).__name__)
            finally:
                with self._lock:
                    self._pending.discard(key)
        try:
            self.executor.submit(run)
        except Exception:
            with self._lock:
                self._pending.discard(key)
            return False
        return True

    def generate(self, row: dict) -> dict:
        """同步生成并存下：模型版优先，失败退回规则版（规则版也存，供 RETRY_AFTER 判断）。"""
        home = None
        started = self.clock()
        complete = self._model()
        if complete is not None and chat_plugins(row):
            future = _MODEL_POOL.submit(complete, SYSTEM_PROMPT, user_prompt(row))
            try:
                home = parse_model_output(future.result(timeout=self.timeout), row)
                if home is None:
                    log.info("platform home model output rejected, using rules")
            except FutureTimeout:
                log.info("platform home model timed out, using rules")
            except Exception as exc:
                log.info("platform home model failed: %s", type(exc).__name__)
        home = home or rules_home(row)
        sig = signature(row)
        # 生成途中平台又改了、新内容已经先存好：别拿旧签名的结果把它盖掉
        newer = self._stored(row["owner_id"])
        if newer and newer.get("sig") != sig and str(newer.get("at") or "") > started.isoformat():
            return home
        record = dict(home, sig=sig, at=self.clock().isoformat())
        self.store_factory().set_pref(PREF_KEY, json.dumps(record, ensure_ascii=False), owner_id=row["owner_id"])
        return home


_service = HomeService()


def configure(service: HomeService) -> HomeService:
    global _service
    _service = service
    return service


def service() -> HomeService:
    return _service


def view(row: dict) -> dict:
    return _service.view(row)


def schedule(row: dict | None) -> bool:
    return _service.schedule(row)
