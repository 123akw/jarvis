"""翻旧账工具：按关键词检索领导以前和贾维斯聊过的内容（跨会话），回答时注明出处。

只读本人的历史（tenant_scope 隔离）；检索前先把最近活跃、还没进索引的线程补同步一下
（当前这一轮所在的会话除外——这一问本身还没答完，不该被自己搜到）。
"""
import datetime as dt

from langchain_core.runnables import RunnableConfig
from langchain_core.tools import tool
from pydantic import BaseModel, Field

from jarvis import history_index
from jarvis.tenancy import TenantStore, current_owner_id
from jarvis.tools.failure import fail

_SYNC_BUDGET = 0.5   # 秒：工具里补同步的时间上限，剩下的交给后台回填


class RecallHistoryArgs(BaseModel):
    query: str = Field(description="要找的关键词，1～3 个，用空格分开，如「日料 推荐」「合同 违约金」；不要整句照抄")
    limit: int = Field(default=5, ge=1, le=10, description="最多返回几条，默认 5")


def _day(at: str, *, short: bool) -> str:
    parsed = history_index._parse(at)
    if parsed is None:
        return "某天"
    local = parsed.astimezone()
    year = "" if local.year == dt.datetime.now().astimezone().year else f"{local.year}/" if short else f"{local.year}年"
    return f"{year}{local.month}/{local.day}" if short else f"{year}{local.month}月{local.day}日"


def _excerpt(content: str, terms: list[str]) -> str:
    return history_index.snippet(content, terms, before=40, width=160)[0]


def _current_alias(owner_id: str, config: RunnableConfig | None) -> str | None:
    checkpoint = ((config or {}).get("configurable") or {}).get("thread_id")
    if not checkpoint:
        return None
    with TenantStore()._connect() as c:
        row = c.execute("SELECT alias FROM tenant_threads WHERE owner_id=? AND checkpoint_thread_id=?",
                        (owner_id, str(checkpoint))).fetchone()
    return row["alias"] if row else None


@tool(args_schema=RecallHistoryArgs)
def recall_history(query: str, limit: int = 5, config: RunnableConfig = None) -> str:
    """翻旧账：按关键词检索领导以前和你聊过的对话（跨会话）。领导问「上次你推荐的那家店叫什么」
    「我们之前聊过的…」「我以前说过…」这类涉及过去对话的问题时使用。
    回答时注明出处（会话标题 + 日期），如「出自 9/21《周末去哪吃》」；没翻到就直说，不要编。"""
    try:
        owner = current_owner_id()
        terms = history_index.query_terms(query)
        if not terms:
            return "请给出要找的关键词。"
        current = _current_alias(owner, config)
        history_index.refresh(owner, budget=_SYNC_BUDGET, exclude=(current,) if current else ())
        index = history_index.HistoryIndex()
        hits = index.search(query, owner_id=owner, limit=limit, per_thread=3)
        if not hits and len(terms) > 1:   # 几个词同时出现的没有：放宽成任一出现
            hits = index.search(query, owner_id=owner, limit=limit, per_thread=3, match_all=False)
    except Exception as exc:  # 工具不能抛异常：失败转成一句话交给模型如实转告
        return fail(f"翻旧账暂时不可用（{type(exc).__name__}），请如实告诉领导没能查到。", "翻旧账暂时不可用，请稍后再试")
    if not hits:
        return f"没有翻到提到「{' '.join(terms)}」的旧对话。可以换个说法再找一次；还是没有就直说没找到。"
    lines = [f"翻到 {len(hits)} 条相关的旧对话（从新到旧）："]
    for n, hit in enumerate(hits, 1):
        who = "领导说" if hit["role"] == "user" else "贾维斯说"
        lines.append(f"{n}. 出处：{_day(hit['at'], short=True)}《{hit['title']}》（{_day(hit['at'], short=False)}）"
                     f"\n   {who}：{_excerpt(hit['content'], terms)}")
        if hit["role"] == "user":
            try:
                reply = index.message_after(hit["thread_id"], hit["pos"], owner_id=owner)
            except Exception:
                reply = None
            if reply:
                lines.append(f"   贾维斯答：{_excerpt(reply['content'], terms)}")
    lines.append("回答时按「出自 月/日《会话标题》」注明出处。")
    return "\n".join(lines)
