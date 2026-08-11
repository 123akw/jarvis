"""Provider-neutral search smoke with an offline default and opt-in live mode."""
from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import urlparse, urlsplit, urlunsplit
from uuid import uuid4
from zoneinfo import ZoneInfo


ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

_CHINA_TZ = ZoneInfo("Asia/Shanghai")
_URL = re.compile(r"https?://[^\s)\]>\"，。；]+")
_CHECKED = re.compile(r"checked_at[：:]\s*([^\n]+)", re.IGNORECASE)
_FINAL_TIME = re.compile(
    r"(?:截至|查询时间|checked_at).{0,30}\d{4}-\d{2}-\d{2}",
    re.IGNORECASE,
)
_PRICE = re.compile(
    r"(?:[¥￥$€]\s*\d[\d,.]*|\d[\d,.]*\s*(?:元|CNY|RMB|USD|EUR))",
    re.IGNORECASE,
)
_SEARCH_TOOLS = {"web_search", "movie_ratings", "esports_scores", "ticket_search"}
_SECRET_FIELDS = re.compile(
    r"(?i)\b(authorization|api[_-]?key|token|secret|password)"
    r"(\s*[:=]\s*)(?:bearer\s+)?[^\s,;]+"
)
_TICKET_PLATFORMS = (
    "damai.cn",
    "showstart.com",
    "maoyan.com",
    "taopiaopiao.com",
    "ctrip.com",
    "ticketmaster.com",
)

SCENARIOS = [
    {
        "id": "news",
        "question": "请查询最近一周娱乐新闻，列出重点，并给出截至时间和至少两个可点击来源。",
        "tool": "web_search",
    },
    {
        "id": "movie",
        "question": "请查询《哪吒之魔童闹海》各平台当前评分，分别写分制、评价人数、截至时间和来源，不要合并评分。",
        "tool": "movie_ratings",
    },
    {
        "id": "esports",
        "question": "请查询 BLG 最近一场 LoL 比分，写明赛事、对手、状态、比赛时间、截至时间和至少两个来源。",
        "tool": "esports_scores",
    },
    {
        "id": "tickets",
        "question": "上海近期演唱会门票哪里买？请推荐至少两个正规购票平台并列公开票价或明确无可靠公开价，附截至时间和链接。",
        "tool": "ticket_search",
    },
]


def _unique_sources(text: str) -> list[str]:
    return list(dict.fromkeys(_URL.findall(text)))


def _safe_url(url: str) -> str:
    """Strip credentials, query parameters and fragments from printable URLs."""
    try:
        parsed = urlsplit(url)
        host = parsed.hostname or ""
        if ":" in host and not host.startswith("["):
            host = f"[{host}]"
        port = f":{parsed.port}" if parsed.port is not None else ""
        return urlunsplit((parsed.scheme, f"{host}{port}", parsed.path, "", ""))
    except ValueError:
        return "[REDACTED URL]"


def _redact_text(text: str) -> str:
    redacted = _URL.sub(lambda match: _safe_url(match.group(0)), text)
    redacted = _SECRET_FIELDS.sub(r"\1\2[REDACTED]", redacted)
    return redacted


def _redact_payload(value):
    if isinstance(value, str):
        return _redact_text(value)
    if isinstance(value, list):
        return [_redact_payload(item) for item in value]
    if isinstance(value, dict):
        return {
            key: _redact_payload(item)
            for key, item in value.items()
        }
    return value


def _normalized_source(url: str) -> str:
    return url.rstrip("/")


def _ticket_platform(url: str) -> str:
    host = (urlparse(url).hostname or "").casefold()
    return next(
        (domain for domain in _TICKET_PLATFORMS if host == domain or host.endswith(f".{domain}")),
        host,
    )


def evaluate_case(
    scenario_id: str,
    final_answer: str,
    tool_output: str,
    tool_names: list[str],
) -> tuple[bool, list[str], str, list[str]]:
    """Return pass state, reasons, checked_at and final-answer sources."""
    expected = next(
        (item["tool"] for item in SCENARIOS if item["id"] == scenario_id),
        "",
    )
    reasons: list[str] = []
    checked_match = _CHECKED.search(tool_output)
    checked_at = checked_match.group(1).strip() if checked_match else ""
    sources = _unique_sources(final_answer)
    tool_sources = {_normalized_source(url) for url in _unique_sources(tool_output)}
    search_calls = sum(name in _SEARCH_TOOLS for name in tool_names)
    if "数据源：PandaScore" in tool_output:
        search_calls -= tool_names.count("esports_scores")

    if expected not in tool_names:
        reasons.append(f"未调用预期工具 {expected}")
    if not checked_at:
        reasons.append("工具结果缺 checked_at")
    if not _FINAL_TIME.search(final_answer):
        reasons.append("最终回答缺截至时间")
    if len(sources) < 2:
        reasons.append("最终回答少于 2 个 HTTP(S) 来源")
    if any(_normalized_source(source) not in tool_sources for source in sources):
        reasons.append("最终回答含工具结果未提供的来源")
    if search_calls > 2:
        reasons.append("单个问题超过 2 次联网搜索预算")
    if any(
        marker in tool_output
        for marker in (
            "未配置 TAVILY_API_KEY",
            "没有已配置的搜索供应商",
            "搜索供应商均未配置",
            "联网搜索认证失败",
            "额度或频率限制",
            "请求超时",
            "响应异常",
            "联网搜索暂时不可用",
            "未找到带有效 HTTP(S) 来源",
        )
    ):
        reasons.append("搜索供应商未成功返回")

    if scenario_id == "movie" and re.search(r"综合(?:分|评分)\s*(?:为|是|[:：])", final_answer):
        reasons.append("电影评分被错误合并")
    if scenario_id == "esports" and not (
        re.search(r"\d+\s*[-:：]\s*\d+", final_answer)
        or re.search(r"未查到|未知|暂无可靠", final_answer)
    ):
        reasons.append("电竞结果既无明确比分也无可靠空缺")
    if scenario_id == "tickets":
        platforms = {_ticket_platform(source) for source in sources}
        if len(platforms) < 2:
            reasons.append("票务结果少于 2 个不同购票平台")
        if re.search(r"最终成交价\s*(?:为|是|[:：])?\s*[¥￥$€]?\s*\d", final_answer):
            reasons.append("把公开展示价声称为最终成交价")
        if _PRICE.search(final_answer):
            if not re.search(r"展示价|起价|票面价|公开价", final_answer):
                reasons.append("公开票价缺少价格性质说明")
        elif "未查到可靠公开价" not in final_answer:
            reasons.append("票务结果既无合规公开价也无明确空缺")

    return not reasons, reasons, checked_at, sources


def _message_text(message) -> str:
    content = getattr(message, "content", "")
    if isinstance(content, str):
        return content
    return json.dumps(content, ensure_ascii=False)


def run(
    *,
    agent_factory=None,
    load_environment=None,
    run_id_factory=None,
    now=None,
) -> tuple[int, dict]:
    """Run four scenarios; callers may inject every live or nondeterministic boundary."""
    if load_environment is None:
        from jarvis import config

        load_environment = config.load_env
    if agent_factory is None:
        from jarvis.graph import build_agent

        agent_factory = build_agent
    if run_id_factory is None:
        run_id_factory = lambda: uuid4().hex
    if now is None:
        now = lambda: datetime.now(_CHINA_TZ)

    load_environment()
    agent = agent_factory()
    run_id = str(run_id_factory())
    results = []
    for index, scenario in enumerate(SCENARIOS, start=1):
        try:
            state = agent.invoke(
                {"messages": [{"role": "user", "content": scenario["question"]}]},
                config={
                    "configurable": {
                        "thread_id": f"search-smoke-{run_id}-{index}",
                    }
                },
            )
            messages = state["messages"]
            last_human = max(i for i, msg in enumerate(messages) if msg.type == "human")
            current = messages[last_human + 1:]
            tool_messages = [msg for msg in current if msg.type == "tool"]
            tool_names = [str(getattr(msg, "name", "")) for msg in tool_messages]
            tool_output = "\n".join(_message_text(msg) for msg in tool_messages)
            final_answer = _message_text(messages[-1])
            ok, reasons, checked_at, sources = evaluate_case(
                scenario["id"], final_answer, tool_output, tool_names
            )
            results.append({
                "id": scenario["id"],
                "question": scenario["question"],
                "expected_tool": scenario["tool"],
                "tools_called": tool_names,
                "ok": ok,
                "checked_at": checked_at,
                "sources": [_safe_url(source) for source in sources],
                "reasons": reasons,
            })
        except Exception as exc:  # Provider/model failures still produce valid JSON.
            results.append({
                "id": scenario["id"],
                "question": scenario["question"],
                "expected_tool": scenario["tool"],
                "tools_called": [],
                "ok": False,
                "checked_at": "",
                "sources": [],
                "reasons": [f"执行异常：{type(exc).__name__}"],
            })

    passed = sum(1 for item in results if item["ok"])
    payload = {
        "run_id": run_id,
        "run_at": now().strftime("%Y-%m-%d %H:%M:%S %Z"),
        "passed": passed,
        "total": len(results),
        "ok": passed == len(results),
        "results": results,
    }
    return (0 if payload["ok"] else 1), _redact_payload(payload)


class _OfflineAgent:
    """Small deterministic Agent-shaped stub used by the default smoke command."""

    def invoke(self, payload, config):
        question = payload["messages"][0]["content"]
        if "娱乐新闻" in question:
            tool_name = "web_search"
            detail = "provider：ddgs；公开新闻样例"
            sources = ("https://news.example/a", "https://media.example/b")
        elif "评分" in question:
            tool_name = "movie_ratings"
            detail = "provider：searxng；豆瓣 8.1/10，IMDb 7.8/10"
            sources = ("https://movie.example/a", "https://review.example/b")
        elif "BLG" in question:
            tool_name = "esports_scores"
            detail = "provider：ddgs；BLG 2:1 TES"
            sources = ("https://score.example/a", "https://league.example/b")
        else:
            tool_name = "ticket_search"
            detail = "provider：searxng；公开票面价 380 元，不是最终成交价"
            sources = ("https://damai.cn/event/a", "https://ticketmaster.com/event/b")
        source_text = f"来源：{sources[0]}\n来源：{sources[1]}"
        return {
            "messages": [
                SimpleNamespace(type="human", content=question),
                SimpleNamespace(
                    type="tool",
                    name=tool_name,
                    content=(
                        "checked_at：2026-08-11 14:30:00 CST\n"
                        f"{detail}\n{source_text}"
                    ),
                ),
                SimpleNamespace(
                    type="ai",
                    content=(
                        f"截至 2026-08-11 14:30，{detail}。"
                        f"来源：{sources[0]} 来源：{sources[1]}"
                    ),
                ),
            ],
            "config": config,
        }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--live",
        action="store_true",
        help="opt in to the configured model and search providers",
    )
    args = parser.parse_args(argv)
    if args.live:
        code, payload = run()
    else:
        code, payload = run(
            agent_factory=_OfflineAgent,
            load_environment=lambda: None,
            run_id_factory=lambda: "offline",
            now=lambda: datetime(2026, 8, 11, 14, 30, tzinfo=_CHINA_TZ),
        )
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return code


if __name__ == "__main__":
    raise SystemExit(main())
