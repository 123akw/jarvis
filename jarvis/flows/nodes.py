"""节点目录与插件工具（第十八轮，契约 §3.2 / §4）。

- :func:`find_tool`：按工具名找注册表里的 LangChain 工具（插件包工具已包好限时与人话错误，先查它们；
  再查核心工具）；
- :func:`tool_args`：工具参数 schema → 画布表单用的参数清单（人话标签、类型、必填、可选值；要文件的参数标 ``file``）；
- :func:`file_args`：工具里要「文件空间里的文件」（file_id / file_ids）的参数——流程里填开始节点的「原文件」变量；
- :class:`Account`：当前账号能用哪些插件（智能体账号只认装了的；绑定 / 桌面端 / 文件等前置条件）；
- :func:`node_catalog`：``GET /api/flows/nodes`` 的节点目录（基础 / 插件工具 / 技能 / 积木）。
"""
from __future__ import annotations

import copy
import logging
import re
from dataclasses import dataclass, field

from jarvis.flows import graph as graph_mod
from jarvis.flows.steps import ROLE_OUTPUT, ROLE_PROCESS, STEPS, clip

log = logging.getLogger("jarvis")

DEFAULT_TOOL_TIMEOUT = 30.0
GUARD_MARGIN = 5.0   # 插件包工具自己会在超时后回人话；外层多等一会儿，免得抢在它前面报超时

# 核心工具（插件清单里 entry 为空、直接用贾维斯核心工具的那些）的人话名字
CORE_TOOL_LABELS = {
    "weather": "查城市天气", "weather_here": "查我这里的天气", "my_location": "查我在哪",
    "web_search": "联网搜索", "web_extract": "读网页正文",
    "schedule_add": "加一条日程", "schedule_list": "看日程", "schedule_del": "删一条日程",
    "todo_add": "加一条待办", "todo_list": "看待办", "todo_done": "勾掉一条待办",
    "memo_add": "记一条备忘", "memo_list": "看备忘", "memo_del": "删一条备忘",
    "profile_remember": "记住一件关于我的事", "profile_list": "看记住的我", "profile_forget": "忘掉一条关于我的事",
    "recall_history": "翻聊天记录", "movie_ratings": "查电影评分", "esports_scores": "查电竞比分",
    "ticket_search": "查演出票务", "meeting_start": "开始记会议", "meeting_stop": "结束会议出纪要",
}
ARG_LABELS = {
    "city": "城市", "query": "关键词", "url": "网址", "title": "标题", "when": "时间", "content": "内容",
    "fact": "要记住的事", "limit": "最多几条", "topic": "类型", "time_range": "时间范围", "domains": "限定网站",
    "max_results": "最多几条", "year": "年份", "team": "战队", "game": "游戏", "date": "日期", "event": "活动",
    "file_id": "文件", "file_ids": "文件", "name": "文件名", "markdown": "内容", "pages": "页码",
    "include_past": "包含过去的", "expression": "算式", "amount": "金额",
}
REQUIREMENT_REASONS = {
    "feishu_bound": "先在设置里绑定飞书",
    "wechat_owner": "只有管理员账号能用",
    "desktop": "要先打开电脑上的贾维斯桌面端",
    "files": "文件功能暂时不可用",
}
NODE_OUTPUTS = {
    "llm": ["text", "items"], "tool": ["text", "items", "links", "files"], "template": ["text", "items"],
    "step": ["text", "items", "title", "links", "parts"], "condition": [], "end": ["text", "links"],
}
_FIRST_CLAUSE = re.compile(r"[，,。；;：:（(\n]|如「|如\s")
_FIRST_SENTENCE = re.compile(r"(?<=[。！？!?])|\n")


def _registry():
    from jarvis.plugins.loader import registry
    return registry()


def first_clause(text: str, limit: int) -> str:
    head = _FIRST_CLAUSE.split(str(text or "").strip(), maxsplit=1)[0].strip()
    return clip(head, limit)


def first_sentence(text: str, limit: int = 60) -> str:
    head = _FIRST_SENTENCE.split(str(text or "").strip(), maxsplit=1)[0].strip()
    return clip(head, limit)


# ---------- 工具 ----------

def find_tool(name: str, deps=None, user_id: str | None = None):
    """工具名 → 工具对象；找不到返回 None。测试可经 ``deps.find_tool`` 换成替身。

    给了 ``user_id`` 且 deps 有 ``user_tool`` 钩子时，再按账号换一次（第十九轮：联网工具走账号自己的
    搜索设置，而不是全局那份）。只在真正执行时传 user_id；目录与运行前检查只看参数，不必换。"""
    tool = _lookup_tool(name, deps)
    hook = getattr(deps, "user_tool", None) if deps is not None else None
    if tool is not None and user_id and hook is not None:
        try:
            return hook(user_id, name, tool) or tool
        except Exception as exc:   # 换不了就用全局那份，流程照跑
            log.warning("flow user tool hook failed: %s", type(exc).__name__)
    return tool


def _lookup_tool(name: str, deps=None):
    custom = getattr(deps, "find_tool", None) if deps is not None else None
    if custom is not None:
        return custom(name)
    try:
        for tool in _registry().pack_tools:
            if tool.name == name:
                return tool
    except Exception as exc:
        log.warning("flow tool lookup failed: %s", type(exc).__name__)
    from jarvis.tools import TOOLS
    return next((tool for tool in TOOLS if tool.name == name), None)


def tool_schema(tool) -> dict:
    schema = getattr(tool, "args_schema", None)
    if schema is None:
        return {"type": "object", "properties": {}, "required": []}
    if isinstance(schema, dict):
        return schema
    try:
        return schema.model_json_schema()
    except Exception:
        return {"type": "object", "properties": dict(getattr(tool, "args", {}) or {}), "required": []}


def prop_type(prop: dict) -> str:
    kind = prop.get("type")
    if isinstance(kind, list):
        kind = next((k for k in kind if k != "null"), None)
    if not kind and isinstance(prop.get("anyOf"), list):
        kind = next((p.get("type") for p in prop["anyOf"] if isinstance(p, dict) and p.get("type") not in (None, "null")),
                    None)
    if not kind and ("$ref" in prop or "properties" in prop):
        kind = "object"
    return kind if kind in ("string", "integer", "number", "boolean", "array", "object") else "string"


def arg_label(name: str, prop: dict) -> str:
    return ARG_LABELS.get(name) or first_clause(prop.get("description") or "", 12) or name


FILE_ARG_NAMES = ("file_id", "file_ids")


def is_file_arg(name: str, prop: dict | None) -> bool:
    """参数要的是文件空间里的文件：名字是 file_id / file_ids，或说明里写了 file_id。"""
    if name in FILE_ARG_NAMES:
        return True
    return "file_id" in str((prop or {}).get("description") or "").lower()


def uses_file_space(tool) -> bool:
    """内置插件包（Excel / PDF / Word…）按 file_id 读账号文件空间；第三方子进程插件与 MCP 工具的同名参数不算。"""
    return tool is not None and not getattr(tool, "plugin_sandboxed", False) and not getattr(tool, "plugin_mcp", False)


def file_args(tool) -> list[str]:
    """工具里要文件（file_id）的参数名；流程里这些参数填开始节点的「原文件」变量 ``{{start.<key>_file}}``。"""
    if not uses_file_space(tool):
        return []
    props = tool_schema(tool).get("properties") or {}
    return [name for name, prop in props.items() if is_file_arg(name, prop if isinstance(prop, dict) else {})]


def tool_args(tool) -> list[dict]:
    """画布表单用的参数清单：[{name, label, type, required, description, enum, default}]。"""
    if tool is None:
        return []
    schema = tool_schema(tool)
    props = schema.get("properties") or {}
    required = set(schema.get("required") or [])
    wants_file = set(file_args(tool))
    out = []
    for name, prop in props.items():
        if not isinstance(prop, dict):
            prop = {}
        enum = prop.get("enum")
        default = prop.get("default")
        out.append({"name": name, "label": arg_label(name, prop), "type": prop_type(prop),
                    "required": name in required, "description": clip(prop.get("description") or "", 160),
                    "enum": list(enum) if isinstance(enum, list) else None,
                    "default": default if isinstance(default, (str, int, float, bool)) else None,
                    "file": name in wants_file})
    return out


def tool_label(entry: dict | None, tool_name: str, tool=None) -> str:
    if tool_name in CORE_TOOL_LABELS:
        return CORE_TOOL_LABELS[tool_name]
    for info in (entry or {}).get("tool_info") or []:   # MCP 插件：清单里的 tool_labels → 服务给的 title
        if info.get("name") == tool_name and info.get("label"):
            return clip(info["label"], 20)
    description = getattr(tool, "description", "") if tool is not None else ""
    return first_clause(description, 20) or tool_name


def tool_summary(entry: dict | None, tool_name: str, tool=None) -> str:
    for info in (entry or {}).get("tool_info") or []:
        if info.get("name") == tool_name and info.get("description"):
            return clip(info["description"], 60)
    description = getattr(tool, "description", "") if tool is not None else ""
    return first_sentence(description) or (entry or {}).get("summary") or ""


def plugin_timeout(plugin_id: str) -> float:
    try:
        pack = _registry().by_id.get(plugin_id)
        return float((pack.manifest or {}).get("timeout") or DEFAULT_TOOL_TIMEOUT) if pack else DEFAULT_TOOL_TIMEOUT
    except Exception:
        return DEFAULT_TOOL_TIMEOUT


# ---------- 账号能用什么 ----------

@dataclass
class Account:
    """一次请求 / 一次运行里算一次：智能体账号装了哪些插件、前置条件满足哪些。"""
    user_id: str
    installed: list[str] | None = None          # None = Owner / 没有智能体：全部已启用插件都能用
    status: dict = field(default_factory=dict)  # feishu_bound / wechat_owner / desktop / files

    @classmethod
    def load(cls, user_id: str, deps=None) -> "Account":
        installed = None
        try:
            from jarvis.platforms import agent_platform
            row = agent_platform(user_id)
            installed = list(row["plugins"]) if row is not None else None
        except Exception as exc:
            log.info("flow platform lookup failed: %s", type(exc).__name__)
        try:
            from jarvis.plugins import requirement_status
            status = dict(requirement_status(user_id))
        except Exception as exc:
            log.info("flow requirement lookup failed: %s", type(exc).__name__)
            status = {}
        if deps is not None:   # 飞书 / 微信以注入的依赖为准（与积木的检查一致，测试可替换）
            for key, check in (("feishu_bound", lambda: deps.feishu_ready(user_id)),
                               ("wechat_owner", lambda: deps.wechat_owner(user_id))):
                try:
                    status[key] = bool(check())
                except Exception:
                    status[key] = False
        return cls(user_id=user_id, installed=installed, status=status)

    def plugin_problem(self, plugin_id: str) -> str:
        """这个插件对当前账号能不能用；能用返回空串，否则返回人话原因。"""
        entry = _registry().entry_by_id.get(plugin_id)
        if entry is None:
            return "这个节点用的插件已经停用或卸载了，换一个或删掉它"
        name = entry.get("name") or plugin_id
        if self.installed is not None and plugin_id not in self.installed:
            return f"这个智能体还没装「{name}」，到智能体设置里加上就能用"
        if entry.get("status") == "needs_config":
            return entry.get("reason") or f"「{name}」还没配置好，请管理员到插件管理里配置"
        if entry.get("status") != "ok":
            reason = entry.get("reason") or "插件加载失败"
            return f"「{name}」暂时不可用：{reason}"
        for need in entry.get("requires") or ():
            if not self.status.get(need, False):
                return REQUIREMENT_REASONS.get(need, "暂时用不了")
        return ""

    def tool_problem(self, plugin_id: str, tool_name: str, deps=None) -> str:
        problem = self.plugin_problem(plugin_id)
        if problem:
            return problem
        entry = _registry().entry_by_id.get(plugin_id) or {}
        if tool_name not in (entry.get("tools") or ()) or find_tool(tool_name, deps) is None:
            return f"「{entry.get('name') or plugin_id}」里已经没有这个工具了，换一个或删掉它"
        return ""

    def skill_problem(self, skill_id: str) -> str:
        entry = _registry().entry_by_id.get(skill_id)
        if entry is None or entry.get("kind") != "skill":
            return "这个节点用的技能已经停用或卸载了，换一个或删掉它"
        problem = self.plugin_problem(skill_id)
        if problem:
            return problem
        if skill_body(skill_id) is None:
            return f"「{entry.get('name') or skill_id}」的说明读不出来，暂时用不了"
        return ""


def skill_body(skill_id: str) -> dict | None:
    """技能插件的 {name, body}；没有或不可用返回 None。"""
    try:
        pack = _registry().by_id.get(skill_id)
    except Exception:
        return None
    if pack is None or pack.status != "ok" or not pack.skill:
        return None
    return {"name": pack.name, "body": str(pack.skill.get("body") or "")}


# ---------- 节点目录 ----------

def _basic_items() -> list[dict]:
    return [
        {"key": "llm", "type": "llm", "title": "AI 处理", "icon": "✨",
         "summary": "让 AI 按你的要求处理前面的结果：总结、改写、提取、翻译都行",
         "data": {"title": "AI 处理", "prompt": "", "output": "text"}, "available": True, "reason": ""},
        {"key": "condition", "type": "condition", "title": "条件分支", "icon": "🔀",
         "summary": "按条件走不同的路，比如天气里有「雨」就提醒带伞",
         "data": {"title": "条件分支", "cases": [{"id": "c1", "label": "分支 1", "logic": "and",
                                                  "rules": [{"var": "", "op": "contains", "value": ""}]}]},
         "available": True, "reason": ""},
        {"key": "template", "type": "template", "title": "文本拼接", "icon": "📝",
         "summary": "把几个节点的结果和固定的话拼成一段",
         "data": {"title": "文本拼接", "template": ""}, "available": True, "reason": ""},
        {"key": "end", "type": "end", "title": "结束", "icon": "🏁",
         "summary": "流程的最终结果，还能生成一个可分享的结果网页",
         "data": {"title": "结束", "output": "", "page": False}, "available": True, "reason": ""},
    ]


def _tool_items(account: Account, deps) -> list[dict]:
    items = []
    for entry in _registry().entries:
        if entry.get("kind") not in ("tool", "channel") or not entry.get("tools"):
            continue
        plugin_problem = account.plugin_problem(entry["id"])
        for tool_name in entry["tools"]:
            tool = find_tool(tool_name, deps)
            label = tool_label(entry, tool_name, tool)
            reason = plugin_problem or ("" if tool is not None else "这个工具暂时用不了")
            items.append({
                "key": f"tool:{entry['id']}:{tool_name}", "type": "tool", "title": label,
                "icon": entry.get("icon") or "🧩", "summary": tool_summary(entry, tool_name, tool),
                "plugin": entry["id"], "plugin_name": entry.get("name") or entry["id"],
                "category": entry.get("category") or "", "args": tool_args(tool),
                "data": {"title": label, "plugin": entry["id"], "tool": tool_name, "args": {}},
                "available": not reason, "reason": reason,
            })
    return items


def _skill_items(account: Account) -> list[dict]:
    items = []
    for entry in _registry().entries:
        if entry.get("kind") != "skill":
            continue
        reason = account.skill_problem(entry["id"])
        items.append({
            "key": f"skill:{entry['id']}", "type": "llm", "title": entry.get("name") or entry["id"],
            "icon": entry.get("icon") or "🧠", "summary": entry.get("summary") or "",
            "plugin": entry["id"], "plugin_name": entry.get("name") or entry["id"],
            "category": entry.get("category") or "",
            "data": {"title": entry.get("name") or entry["id"], "skill": entry["id"], "prompt": "{{start.text}}",
                     "output": "text"},
            "available": not reason, "reason": reason,
        })
    return items


def step_options(spec) -> list[dict]:
    keys = ("key", "label", "type", "choices", "default", "min", "max", "max_length")
    return [{k: copy.deepcopy(v) for k, v in o.items() if k in keys} for o in spec.options]


def _step_items(user_id: str, deps) -> list[dict]:
    from jarvis.flows.engine import requirement_problem
    entries = _registry().entry_by_id
    items = []
    for spec in list(STEPS.values()):
        if spec.role not in (ROLE_PROCESS, ROLE_OUTPUT):
            continue
        entry = entries.get(spec.id) or {}
        reason = requirement_problem(spec.id, user_id, deps) or ""
        items.append({
            "key": f"step:{spec.id}", "type": "step", "role": spec.role, "title": spec.name,
            "icon": spec.icon or entry.get("icon") or "🧱", "summary": spec.summary or entry.get("summary") or "",
            "options": step_options(spec),
            "data": {"title": spec.name, "step": spec.id,
                     "options": {o["key"]: o.get("default") for o in spec.options}, "input": ""},
            "available": not reason, "reason": reason,
        })
    return items


def node_catalog(user_id: str, deps) -> dict:
    """``GET /api/flows/nodes``：可用性按当前账号算（智能体账号没装的插件也列出，并说怎么加上）。"""
    graph_mod._ensure_steps()
    account = Account.load(user_id, deps)
    try:
        from jarvis.plugins import CATEGORIES
        categories = [dict(item) for item in CATEGORIES]
    except Exception:
        categories = []
    return {
        "groups": [
            {"id": "basic", "label": "基础", "items": _basic_items()},
            {"id": "tools", "label": "插件工具", "items": _tool_items(account, deps)},
            {"id": "skills", "label": "技能", "items": _skill_items(account)},
            {"id": "steps", "label": "积木", "items": _step_items(user_id, deps)},
        ],
        "categories": categories,
        "vars": {"sys": [{"key": k, "label": graph_mod.SYS_LABELS[k]} for k in graph_mod.SYS_FIELDS],
                 "fields": [{"key": k, "label": graph_mod.FIELD_LABELS[k]} for k in graph_mod.NODE_FIELDS],
                 # 开始节点的文件字段另有一项「原文件」：{{start.<key>_file}}（给要 file_id 的工具用）
                 "start_file": {"suffix": graph_mod.FILE_SUFFIX, "label": graph_mod.FILE_VAR_LABEL}},
        "outputs": copy.deepcopy(NODE_OUTPUTS),
        "field_types": list(graph_mod.FIELD_TYPES),
        "limits": {"nodes": graph_mod.MAX_NODES, "edges": graph_mod.MAX_EDGES, "fields": graph_mod.MAX_FIELDS,
                   "foreach": graph_mod.MAX_FOREACH},
    }


def graph_plugins(graph: dict) -> list[str]:
    """流程用到的插件 id（插件工具、技能、积木），按出现顺序去重。"""
    out: list[str] = []
    for node in graph.get("nodes") or []:
        data = node.get("data") or {}
        pid = ""
        if node.get("type") == "tool":
            pid = data.get("plugin") or ""
        elif node.get("type") == "llm":
            pid = data.get("skill") or ""
        elif node.get("type") == "step":
            pid = data.get("step") or ""
        if pid and pid not in out:
            out.append(pid)
    return out
