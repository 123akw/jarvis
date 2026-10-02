"""插件推荐：规则（职业 → 套餐；描述关键词 → 插件）+ 模型（有描述且服务器默认模型可用时）。

模型只负责「从清单里挑」：提示词里列出全部插件 / 职业 id，输出必须是 JSON，含清单外 id、
格式不对、超时（约 8 秒）都退回规则结果，绝不把模型的自由发挥直接交给前端。公开接口的
成本护栏：同时最多 MODEL_CONCURRENCY 个模型请求，满了直接走规则。

两条路都只对 Owner 推荐微信类插件（微信桥只连 Owner，别人装了也用不上）。
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeout
import json
import logging
import re
import threading
from typing import Callable
from urllib.parse import urljoin

from jarvis.plugins import OWNER_ONLY, PLUGINS, PROFESSIONS, get_profession, is_plugin, is_profession, names_for

log = logging.getLogger(__name__)

MAX_DESCRIPTION_CHARS = 300
MODEL_TIMEOUT = 8.0
MODEL_MAX_TOKENS = 1500         # 思考型模型（deepseek-v4-flash 等）的思考过程也计入 max_tokens，400 会被截成空串
MODEL_CONCURRENCY = 4
MAX_PLUGINS = 8
REASON_MAX_CHARS = 80
DEFAULT_PLUGINS = ("schedule", "todo", "memo", "search")

# 描述里出现这些词 → 推荐对应插件（命中越早越靠前）
PLUGIN_KEYWORDS: dict[str, tuple[str, ...]] = {
    "schedule": ("日程", "安排", "开会", "约", "预约", "排班", "课表", "上课", "提醒", "时间"),
    "todo": ("待办", "任务", "清单", "要做", "跟进", "订单", "进度", "作业", "截止", "交付"),
    "memo": ("记一下", "笔记", "灵感", "备忘", "素材", "地址", "电话", "记录"),
    "memory": ("客户", "偏好", "喜好", "习惯", "会员", "老客"),
    "weather": ("天气", "下雨", "出门", "户外", "摆摊", "穿衣", "温度"),
    "search": ("搜", "查", "资讯", "新闻", "行情", "热点", "政策", "竞品"),
    "recall": ("上次", "之前", "以前", "聊过", "翻"),
    "movies": ("电影", "影视", "追剧", "评分", "影评", "片子"),
    "esports": ("电竞", "战队", "英雄联盟", "王者", "比分", "LOL", "lol"),
    "tickets": ("门票", "演唱会", "演出", "展览", "话剧", "景区", "买票"),
    "meeting": ("会议", "纪要", "例会", "周会", "复盘", "开会"),
    "feishu": ("飞书", "团队", "同事", "协作"),
    "wechat": ("微信", "朋友圈", "微商", "客户群", "私域"),
    "input_file": ("文件", "文档", "资料", "PDF", "pdf", "Word", "课件", "合同", "报告", "方案"),
    "split_file": ("长文档", "拆分", "拆开", "章节", "合同", "课件"),
    "ai_extract": ("提炼", "总结", "摘要", "要点", "周报", "改写", "文案", "整理"),
    "web_page": ("分享", "二维码", "网页", "链接", "发给"),
}

# 描述里出现这些词 → 判断职业（取命中最多的；没有就不定职业）
PROFESSION_KEYWORDS: dict[str, tuple[str, ...]] = {
    "shop_owner": ("店", "奶茶", "餐", "咖啡", "微商", "摆摊", "老板", "进货", "上新", "零售"),
    "project_manager": ("项目", "产品经理", "里程碑", "交付", "排期", "立项"),
    "teacher": ("老师", "教师", "备课", "课件", "家长", "班主任", "学生们"),
    "student": ("学生", "考试", "复习", "论文", "考研", "上学", "作业"),
    "sales": ("销售", "经纪", "拜访", "房产", "保险", "业绩", "成单", "中介"),
    "freelancer": ("自由职业", "接单", "设计师", "摄影", "外包", "独立开发", "甲方"),
    "creator": ("博主", "视频", "公众号", "小红书", "抖音", "写作", "自媒体", "up主", "UP主"),
    "office": ("行政", "人事", "HR", "hr", "招聘", "考勤", "通知", "入职"),
}

# 没有职业时的通用流程：有资料走「资料速读」，否则「一段话整成清单」
GENERIC_FLOWS = {
    "file": {"id": "generic_file", "name": "资料速读", "summary": "上传一份资料，读出摘要并生成网页",
             "steps": [{"plugin": "input_file", "options": {}}, {"plugin": "ai_extract", "options": {"task": "摘要"}},
                       {"plugin": "web_page", "options": {"title": "资料速读"}}]},
    "text": {"id": "generic_text", "name": "一段话整成清单", "summary": "随口说的一段话，整理成待办并生成网页",
             "steps": [{"plugin": "input_text", "options": {}}, {"plugin": "ai_extract", "options": {"task": "待办"}},
                       {"plugin": "to_todo", "options": {}}, {"plugin": "web_page", "options": {"title": "待办清单"}}]},
}
_FILE_HINTS = ("input_file", "split_file")


class RecommendError(ValueError):
    """请求参数不对：message 直接给用户看。"""


def _hits(text: str, words: tuple[str, ...]) -> list[str]:
    return [word for word in words if word in text]


def guess_profession(description: str) -> str | None:
    best, score = None, 0
    for profession_id, words in PROFESSION_KEYWORDS.items():
        found = len(_hits(description, words))
        if found > score:
            best, score = profession_id, found
    return best


def _flows_for(profession_id: str | None, plugins: list[str]) -> list[dict]:
    if profession_id:
        return get_profession(profession_id)["flows"]
    kind = "file" if any(p in plugins for p in _FILE_HINTS) else "text"
    return [json.loads(json.dumps(GENERIC_FLOWS[kind], ensure_ascii=False))]


def _allowed(plugin_ids, owner: bool) -> list[str]:
    return [pid for pid in plugin_ids if owner or pid not in OWNER_ONLY]


def rules(profession: str | None = None, description: str = "", *, owner: bool = False) -> dict:
    """规则推荐（零模型）：职业套餐打底，描述里的关键词补插件。"""
    text = description or ""
    guessed = None if profession else guess_profession(text)
    base_profession = profession or guessed
    picked: list[str] = list(get_profession(base_profession)["plugins"]) if base_profession else []
    # 关键词命中按在描述里出现的先后排：用户先说的事，先配
    keyword_hits: list[tuple[int, str, str]] = []
    for plugin_id, words in PLUGIN_KEYWORDS.items():
        found = _hits(text, words)
        if found:
            word = min(found, key=text.index)
            keyword_hits.append((text.index(word), plugin_id, word))
    keyword_hits.sort()
    for _at, plugin_id, _word in keyword_hits:
        if plugin_id not in picked:
            picked.append(plugin_id)
    picked = _allowed(picked, owner) or list(DEFAULT_PLUGINS)
    picked = picked[:MAX_PLUGINS]
    hits = [(plugin_id, word) for _at, plugin_id, word in keyword_hits if plugin_id in picked]
    reason = _rule_reason(base_profession, guessed is not None, hits)
    return {"plugins": picked, "flows": _flows_for(base_profession, picked), "reason": reason, "source": "rules"}


def _rule_reason(profession_id: str | None, guessed: bool, hits: list[tuple[str, str]]) -> str:
    parts = []
    if profession_id:
        name = get_profession(profession_id)["name"]
        parts.append(f"听起来你是「{name}」，先按这个职业的日常配了一套" if guessed
                     else f"按「{name}」的日常配了一套")
    if hits:
        words = "".join(f"「{word}」" for _pid, word in hits[:3])
        parts.append(f"你提到了{words}，{'、'.join(names_for([pid for pid, _w in hits[:3]]))}都给你配上了")
    if not parts:
        return "先给你配上最常用的几样：日程、待办、随手记和联网搜索，之后随时增减。"
    return "；".join(parts) + "。"


# ---------- 模型推荐 ----------

SYSTEM_PROMPT = (
    "你是「智能体市场」的选品顾问。用户会描述自己的职业和想做的事，你要从给定的插件清单里"
    "挑出最合适的 3 到 8 个，并判断最接近的职业。只能使用清单里出现的 id，不要编造。"
    "只输出一个 JSON 对象，不要任何解释或 Markdown：\n"
    '{"profession": "职业 id 或 null", "plugins": ["插件 id", ...], "reason": "一句话说明为什么这样配，不超过 60 字，口语化"}'
)


def _catalog_text() -> str:
    lines = ["插件清单（id：名称——能干什么）："]
    lines += [f"- {item['id']}：{item['name']}——{item['summary']}" for item in PLUGINS]
    lines.append("职业清单（id：名称）：")
    lines += [f"- {item['id']}：{item['name']}" for item in PROFESSIONS]
    return "\n".join(lines)


def user_prompt(profession: str | None, description: str) -> str:
    chosen = f"用户在表单里选的职业：{get_profession(profession)['name']}（{profession}）\n" if profession else ""
    return f"{_catalog_text()}\n\n{chosen}用户的描述：{description}"


_FENCE = re.compile(r"^```(?:json)?\s*|\s*```$")


def parse_model_output(raw: str, profession: str | None, *, owner: bool = False) -> dict | None:
    """校验模型输出：JSON 对象、plugins 全在清单内且非空、职业 id 合法；任何一项不符返回 None。"""
    text = _FENCE.sub("", (raw or "").strip())
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        data = json.loads(text[start:end + 1])
    except ValueError:
        return None
    if not isinstance(data, dict):
        return None
    plugins = data.get("plugins")
    if not isinstance(plugins, list) or not plugins or not all(is_plugin(p) for p in plugins):
        return None
    picked = _allowed(dict.fromkeys(plugins), owner)[:MAX_PLUGINS]
    if not picked:
        return None
    chosen = data.get("profession")
    if chosen in (None, "", "null"):
        chosen = None
    elif not is_profession(chosen):
        return None
    reason = data.get("reason")
    if not isinstance(reason, str) or not " ".join(reason.split()):
        return None
    reason = " ".join(reason.replace("*", "").replace("`", "").split())
    if len(reason) > REASON_MAX_CHARS:
        reason = reason[:REASON_MAX_CHARS - 1] + "…"
    base = profession or chosen
    return {"plugins": picked, "flows": _flows_for(base, picked), "reason": reason, "source": "model"}


def model_complete(llm, system: str, user: str, *, timeout: float = MODEL_TIMEOUT) -> str:
    """用服务器默认模型做一次非流式补全（DNS 钉死到公网地址、不读代理环境变量）。"""
    from jarvis.provider_runtime import close_async_client, safe_http_clients

    client, async_client = safe_http_clients(timeout=timeout)
    try:
        response = client.post(
            urljoin(llm.base_url.rstrip("/") + "/", "chat/completions"),
            headers={"Authorization": f"Bearer {llm.api_key}", "Content-Type": "application/json"},
            json={"model": llm.model, "temperature": 0, "max_tokens": MODEL_MAX_TOKENS, "stream": False,
                  "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]},
        )
        response.raise_for_status()
        payload = response.json()
        return str(((payload.get("choices") or [{}])[0].get("message") or {}).get("content") or "")
    finally:
        client.close()
        close_async_client(async_client)


_POOL = ThreadPoolExecutor(max_workers=MODEL_CONCURRENCY, thread_name_prefix="jarvis-recommend")
_SLOTS = threading.BoundedSemaphore(MODEL_CONCURRENCY)


class Recommender:
    """complete(system, user) -> str 是一次模型补全；None 表示没有可用模型（只走规则）。"""

    def __init__(self, complete: Callable[[str, str], str] | None = None, *, timeout: float = MODEL_TIMEOUT):
        self.complete = complete
        self.timeout = timeout

    def recommend(self, profession: str | None = None, description: str = "", *, owner: bool = False) -> dict:
        if profession is not None and not is_profession(profession):
            raise RecommendError("没有这个职业")
        text = " ".join(str(description or "").split())
        if len(text) > MAX_DESCRIPTION_CHARS:
            raise RecommendError(f"描述最多 {MAX_DESCRIPTION_CHARS} 字")
        fallback = rules(profession, text, owner=owner)
        if not text or self.complete is None:
            return fallback
        # 名额在模型请求真正结束时才归还：超时后后台那次请求还在跑，不能让新请求越堆越多
        if not _SLOTS.acquire(blocking=False):
            log.info("recommend model busy, using rules")
            return fallback
        try:
            future = _POOL.submit(self.complete, SYSTEM_PROMPT, user_prompt(profession, text))
        except Exception:
            _SLOTS.release()
            return fallback
        future.add_done_callback(lambda _done: _SLOTS.release())
        try:
            raw = future.result(timeout=self.timeout)
        except FutureTimeout:
            log.info("recommend model timed out")
            return fallback
        except Exception as exc:
            log.info("recommend model failed: %s", type(exc).__name__)
            return fallback
        if not str(raw or "").strip():
            log.warning("recommend model returned empty text (max_tokens=%s), using rules", MODEL_MAX_TOKENS)
            return fallback
        parsed = parse_model_output(raw, profession, owner=owner)
        if parsed is None:
            log.info("recommend model output rejected, using rules")
            return fallback
        return parsed
