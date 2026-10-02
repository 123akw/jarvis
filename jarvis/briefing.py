"""今日简报卡：「今日」板顶部默认一行的 AI 简报，点开再看 2–3 行细节。

成本与打扰护栏（见 docs/proposals/2026-10-feature-ideas.md「克制原则」）：
- **每个账号每天最多 1 次模型调用**：按账号加进程内锁；调用模型前先在 tenant_prefs
  记一笔 ``pending``，并发请求、重复点击、生成途中重启都不会烧第二次。
- **只在被看见时生成**：网页「今日」板第一次可见时才 POST，没打开就是零成本；05:00 前
  不生成（凌晨看一眼不该占掉当天唯一的一次）。
- **一次补全，不走工具循环**：日程、待办、天气由代码先查好写进提示词，模型只负责把事实
  说成人话；输出经 :func:`parse_brief` 清洗（去 Markdown / 链接 / 表情，限行限长）。
- **失败静默降级**：模型异常、超时或输出不可用时退回 :func:`fallback_brief` 规则摘要
  （零模型），当天不重试；规则摘要每次读取都按当前日程/待办现算，不会过时。

存储：当天结果是 tenant_prefs 里的一条 JSON（``brief_day``，次日覆盖），不加表。
"""
from __future__ import annotations

import datetime
import json
import logging
import re
import threading
from concurrent.futures import ThreadPoolExecutor

from fastapi import Request
from fastapi.responses import JSONResponse

from jarvis.tenancy import TenantMigrationError, TenantStore, tenant_scope

log = logging.getLogger("jarvis")

PREF_KEY = "brief_day"
START_HOUR = 5              # 05:00 前不生成
COMPOSE_TIMEOUT = 30.0      # 秒：超时按失败处理，退回规则摘要
PENDING_STALE = 120         # 秒：生成途中进程重启遗留的 pending 视为失败（当天不再重试）
MAX_TOKENS = 320
HEADLINE_MAX = 60
DETAIL_MAX = 40
DETAIL_LINES = 3
_WEEK = "一二三四五六日"

BRIEF_PROMPT = (
    "你是私人管家贾维斯，要为主人写「今日」板顶部的一张简报卡。只能使用下面列出的事实，"
    "不要编造任何时间、数字、人名或安排。\n"
    "输出格式：\n"
    "第 1 行：一句话总览，不超过 40 个字。依次说清：今天还剩几个日程、下一项是什么（时间+事项）、"
    "还有几个待办没完成；有天气就在句末带上（如「外面 26°C 多云」）。示例："
    "「今天还有 2 个日程，15:00 项目周会前还有 3 个待办没完成；外面 26°C 多云」\n"
    "第 2–4 行：最多 3 行补充，每行不超过 28 个字，可以是接下来的安排、最该先清的待办、一句贴心提醒"
    "（如下雨带伞、明早空腹体检）。\n"
    "时间一律 24 小时制（如 15:00）。不要 Markdown、编号、表情、链接，不要称呼和客套话。\n"
    "\n事实：\n"
    "今天：{date}（{weekday}），现在 {now}\n"
    "天气：{weather}\n"
    "今天的日程：{today}\n"
    "明天的日程：{tomorrow}\n"
    "未完成待办（共 {todo_count} 项）：{todos}\n"
)

_URL = re.compile(r"https?://\S+|www\.\S+")
_LEAD = re.compile(r"^\s*(?:[#>*•·\-–—]+|\d{1,2}\s*[.、)）]|[（(]\d{1,2}[)）])\s*")
_EMOJI = re.compile("[\U0001F000-\U0001FAFF☀-➿⬀-⯿️‍]")
_TITLE = re.compile(r"(?:今日)?简报[:：]?|今天[:：]?")
_CJK_PUNCT_SPACE = re.compile(r"\s*([，。；：、！？])\s*")


def _clip(text: str, limit: int) -> str:
    text = " ".join(str(text).split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _sched(rows: list[dict]) -> str:
    return "；".join(f"{x['time']} {x['title']}{'（已过）' if x.get('past') else ''}" for x in rows) or "无"


def gather_facts(store, now: datetime.datetime, weather: str = "") -> dict:
    """从租户数据里取简报要用的事实（纯本地读，不联网）。"""
    today = now.strftime("%Y-%m-%d")
    tomorrow = (now + datetime.timedelta(days=1)).strftime("%Y-%m-%d")
    now_min = now.strftime("%Y-%m-%d %H:%M")
    rows = store.list_schedule()

    def pick(day: str) -> list[dict]:
        return [{"time": x["when"][11:16], "title": x["title"], "past": x["when"] < now_min}
                for x in rows if x["when"][:10] == day]

    return {
        "date": today, "weekday": "周" + _WEEK[now.weekday()], "now": now.strftime("%H:%M"),
        "today": pick(today), "tomorrow": pick(tomorrow)[:3],
        "todos": [x["content"] for x in store.list_todos() if not x["done"]],
        "weather": weather or "",
    }


def build_prompt(facts: dict) -> str:
    todos = facts["todos"]
    shown = "".join(f"「{t}」" for t in todos[:8]) + ("等" if len(todos) > 8 else "")
    return BRIEF_PROMPT.format(
        date=facts["date"], weekday=facts["weekday"], now=facts["now"],
        weather=facts["weather"] or "未知（不要提天气）",
        today=_sched(facts["today"]), tomorrow=_sched(facts["tomorrow"]),
        todo_count=len(todos), todos=shown or "无",
    )


def _clean(line: str) -> str:
    line = _URL.sub("", line)
    for mark in ("**", "__", "`"):
        line = line.replace(mark, "")
    line = _EMOJI.sub("", _LEAD.sub("", line))
    line = _CJK_PUNCT_SPACE.sub(r"\1", " ".join(line.split()))   # 去表情后留下的「， 26°C」空格
    return line.strip(" ：:。")


def parse_brief(raw: str) -> dict | None:
    """模型输出 → {headline, details}：去 Markdown / 链接 / 表情，首行为总览，最多再取 3 行。"""
    lines: list[str] = []
    for line in (raw or "").splitlines():
        if line.strip().startswith("```"):
            continue
        text = _clean(line)
        if not text or (not lines and _TITLE.fullmatch(text)):
            continue
        lines.append(text)
    if not lines:
        return None
    return {"headline": _clip(lines[0], HEADLINE_MAX),
            "details": [_clip(x, DETAIL_MAX) for x in lines[1:1 + DETAIL_LINES]]}


def fallback_brief(facts: dict) -> dict:
    """不靠模型的规则摘要：日程数 + 下一项、待办数、天气。"""
    today = facts["today"]
    upcoming = [x for x in today if not x["past"]]
    todos = facts["todos"]
    parts = []
    if not today:
        parts.append("今天没有日程")
    elif upcoming:
        parts.append(f"今天 {len(today)} 个日程，下一项 {upcoming[0]['time']} {_clip(upcoming[0]['title'], 14)}")
    else:
        parts.append(f"今天的 {len(today)} 个日程都已结束")
    parts.append(f"{len(todos)} 个待办未完成" if todos else "待办已清空")
    if facts.get("weather"):
        parts.append(facts["weather"])
    details = []
    if len(upcoming) > 1:
        details.append("接下来 " + " · ".join(f"{x['time']} {x['title']}" for x in upcoming[1:3]))
    if todos:
        details.append("待办 " + "".join(f"「{t}」" for t in todos[:2]) + (f"等 {len(todos)} 项" if len(todos) > 2 else ""))
    if facts["tomorrow"]:
        first = facts["tomorrow"][0]
        details.append(f"明天 {first['time']} {first['title']}")
    return {"headline": _clip("；".join(parts), HEADLINE_MAX),
            "details": [_clip(x, DETAIL_MAX) for x in details[:DETAIL_LINES]]}


def fetch_weather(location: dict | None, *, timeout: float = 4.0) -> str:
    """当前定位的天气一句话（「26°C 多云，18–27°C」）；没定位或网络不通返回空串。"""
    if not location:
        return ""
    try:
        from jarvis.tools.weather import _FORECAST, _desc, _get_json
        fc = _get_json(_FORECAST, {
            "latitude": location["lat"], "longitude": location["lon"],
            "current": "temperature_2m,weather_code",
            "daily": "temperature_2m_max,temperature_2m_min",
            "timezone": "auto", "forecast_days": 1,
        }, timeout=timeout)
        cur, daily = fc["current"], fc["daily"]
        return (f"{round(cur['temperature_2m'])}°C {_desc(cur['weather_code'])}，"
                f"{round(daily['temperature_2m_min'][0])}–{round(daily['temperature_2m_max'][0])}°C")
    except Exception as exc:  # 天气只是锦上添花：失败就不提
        log.info("brief weather skipped: %s", type(exc).__name__)
        return ""


def model_compose(bundle_for, chunk_text, user_id: str, prompt: str) -> str:
    """一次纯文本补全：用该账号自己的模型配置，不经 Agent、不调工具、不建线程。"""
    from langchain_core.messages import HumanMessage

    with tenant_scope(user_id), bundle_for(user_id) as bundle:
        model = getattr(bundle, "model", None)
        if model is None:
            raise RuntimeError("runtime has no chat model")
        reply = model.bind(max_tokens=MAX_TOKENS).invoke([HumanMessage(content=prompt)])
    return chunk_text(reply.content)


_POOL = ThreadPoolExecutor(max_workers=4, thread_name_prefix="jarvis-brief")


class BriefService:
    """GET 只读缓存（零模型、零联网）；POST 当天第一次才生成，之后都读缓存。"""

    def __init__(self, *, store_factory=TenantStore, compose=None, weather=fetch_weather,
                 now_fn=None, timeout: float = COMPOSE_TIMEOUT):
        self.store_factory = store_factory
        self.compose = compose            # (user_id, prompt) -> str
        self.weather = weather            # (location) -> str
        self.now = now_fn or datetime.datetime.now
        self.timeout = timeout
        self._locks: dict[str, threading.Lock] = {}
        self._guard = threading.Lock()

    def _lock(self, user_id: str) -> threading.Lock:
        with self._guard:
            return self._locks.setdefault(user_id, threading.Lock())

    @staticmethod
    def _record(store, today: str) -> dict | None:
        try:
            record = json.loads(store.get_pref(PREF_KEY) or "null")
        except ValueError:
            return None
        return record if isinstance(record, dict) and record.get("date") == today else None

    def _present(self, store, record: dict, now: datetime.datetime) -> dict:
        source = record.get("source")
        if source == "pending":
            try:
                started = datetime.datetime.fromisoformat(record.get("started", ""))
                fresh = (now - started).total_seconds() < PENDING_STALE
            except ValueError:
                fresh = False
            if fresh:
                return {"status": "pending", "date": record["date"]}
            source = "fallback"           # 生成途中断掉：按失败处理，当天不再烧模型
        base = {"status": "ready", "date": record["date"], "at": record.get("at", "")}
        if source == "model" and record.get("headline"):
            return {**base, "source": "model", "headline": record["headline"],
                    "details": list(record.get("details") or [])}
        facts = gather_facts(store, now, record.get("weather", ""))
        return {**base, "source": "fallback", **fallback_brief(facts)}

    def view(self, user_id: str) -> dict:
        now = self.now()
        today = now.strftime("%Y-%m-%d")
        if now.hour < START_HOUR:
            return {"status": "early", "date": today}
        with tenant_scope(user_id):
            store = self.store_factory()
            record = self._record(store, today)
            return self._present(store, record, now) if record else {"status": "none", "date": today}

    def _run_compose(self, user_id: str, prompt: str) -> str:
        if self.compose is None:
            raise RuntimeError("brief composer not configured")
        return _POOL.submit(self.compose, user_id, prompt).result(timeout=self.timeout)

    def ensure(self, user_id: str) -> dict:
        now = self.now()
        today = now.strftime("%Y-%m-%d")
        if now.hour < START_HOUR:
            return {"status": "early", "date": today}
        with self._lock(user_id):
            with tenant_scope(user_id):
                store = self.store_factory()
                record = self._record(store, today)
                if record:
                    return self._present(store, record, self.now())
                # 先记账再调模型：这一笔落盘之后，今天无论成败都不会再有第二次调用
                store.set_pref(PREF_KEY, json.dumps(
                    {"date": today, "source": "pending", "started": now.isoformat(timespec="seconds")}))
                try:
                    weather = self.weather(store.get_location()) if self.weather else ""
                except Exception:
                    weather = ""
                facts = gather_facts(store, now, weather)
            record = {"date": today, "at": now.strftime("%H:%M"), "weather": weather, "source": "fallback"}
            try:
                parsed = parse_brief(self._run_compose(user_id, build_prompt(facts)))
            except Exception as exc:
                log.warning("brief compose failed: %s", type(exc).__name__)
                parsed = None
            if parsed:
                record.update(source="model", **parsed)
            with tenant_scope(user_id):
                store = self.store_factory()
                store.set_pref(PREF_KEY, json.dumps(record, ensure_ascii=False))
                return self._present(store, record, self.now())


_SERVICE: BriefService | None = None


def service() -> BriefService | None:
    """当前生效的服务实例（测试替换 compose / now 用）。"""
    return _SERVICE


def register(app, *, request_principal, panel_write, tenant_store, bundle_for, chunk_text, deny) -> BriefService:
    """注入依赖并挂上 GET/POST /api/brief。"""
    global _SERVICE
    _SERVICE = BriefService(
        store_factory=tenant_store,
        compose=lambda user_id, prompt: model_compose(bundle_for, chunk_text, user_id, prompt),
    )

    def migration_failed() -> JSONResponse:
        return JSONResponse({"error": "个人数据迁移失败"}, status_code=503, headers={"Cache-Control": "no-store"})

    @app.get("/api/brief")
    def brief_get(request: Request):
        principal, _token = request_principal(request)
        if not principal:
            return deny()
        try:
            return _SERVICE.view(principal.user_id)
        except TenantMigrationError:
            return migration_failed()

    @app.post("/api/brief")
    def brief_post(request: Request):
        principal, err = panel_write(request)
        if err:
            return err
        try:
            return _SERVICE.ensure(principal.user_id)
        except TenantMigrationError:
            return migration_failed()

    return _SERVICE
