"""流程节点图（第十八轮，契约见 docs/proposals/2026-10-round18-flows.md §2）。

流程从 v6 的「≤8 步线性链」升级为节点图（参考 Dify / Langflow）：

    {"nodes": [{"id", "type", "position": {"x", "y"}, "data": {...}}],
     "edges": [{"id", "source", "target", "sourceHandle"}]}

节点类型（``NODE_TYPES``）：
- ``start``      开始：唯一，id 固定为 ``start``；``data.fields`` 声明运行时要填的输入（文字 / 长文 / 文件 / 数字 / 选项）；
- ``llm``        AI 处理：``data.prompt`` 里用 ``{{节点.字段}}`` 引用上游；可带 ``skill``（技能插件 id）；
- ``tool``       插件工具：``data.plugin`` + ``data.tool``，``data.args`` 每个参数一段可含变量的文字；
- ``condition``  条件分支：``data.cases`` 每个分支一个出口（sourceHandle = case id），另有 ``else`` 出口；
- ``template``   文本拼接：``data.template``；
- ``step``       现成积木（拆分、AI 提炼、加到待办、发飞书、飞书文档、发微信、生成网页、Excel、Word…）：``data.step`` + ``data.options``；
- ``end``        结束：``data.output`` 是最终结果（可含变量），``data.page`` 为真时生成结果网页。

变量写法 ``{{node_id.field}}``：字段有 text / items / title / links / parts / files；开始节点是
``{{start.<字段 key>}}``；系统变量 ``{{sys.date}}`` ``{{sys.time}}`` ``{{sys.weekday}}``；
开了「逐条处理」（``foreach``）的节点里另有 ``{{item}}``（当前条目）。

本文件只做「保存时」的校验与规整（结构、上限、逐类型规整 data、变量只能引用上游）；
「能不能跑」（插件装没装、必填参数、飞书绑定……）在运行前由执行器检查（jarvis/flows/executor.py），
这样画布里没配完的流程也能先存下来。
"""
from __future__ import annotations

import re
from collections import deque

NODE_TYPES = ("start", "llm", "tool", "condition", "template", "step", "end")
START_ID = "start"
ELSE_HANDLE = "else"
MAX_NODES = 30
MAX_EDGES = 60
MAX_NAME = 30
MAX_TITLE = 30
MAX_PROMPT = 4000
MAX_TEMPLATE = 4000
MAX_ARG = 2000
MAX_ARGS = 20
MAX_FIELDS = 8
MAX_FIELD_LABEL = 20
MAX_PLACEHOLDER = 60
MAX_DEFAULT = 2000
MAX_SELECT_OPTIONS = 20
MAX_OPTION_CHARS = 40
MAX_CASES = 8
MAX_RULES = 10
MAX_CASE_LABEL = 20
MAX_RULE_VALUE = 200
MAX_FOREACH = 20
NODE_ID = re.compile(r"^[A-Za-z0-9_-]{1,32}$")
FIELD_KEY = re.compile(r"^[a-z][a-z0-9_]{0,23}$")
VAR = re.compile(r"\{\{\s*([A-Za-z0-9_-]{1,32})\.([A-Za-z0-9_]{1,24})\s*\}\}")
ITEM_VAR = re.compile(r"\{\{\s*item\s*\}\}")
VAR_PATH = re.compile(r"^\s*(?:\{\{\s*)?([A-Za-z0-9_-]{1,32})\.([A-Za-z0-9_]{1,24})(?:\s*\}\})?\s*$")
PLUGIN_ID = re.compile(r"^[a-z][a-z0-9_]{1,30}$")
TOOL_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$")
ARG_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_-]{0,63}$")
NODE_FIELDS = ("text", "items", "title", "links", "parts", "files")
LIST_FIELDS = ("items", "parts", "links", "files")
SYS_FIELDS = ("date", "time", "weekday")
RESERVED_IDS = ("sys", "item")
FIELD_TYPES = ("text", "paragraph", "file", "number", "select")
LLM_OUTPUTS = ("text", "list")
LOGICS = ("and", "or")
OPS = ("contains", "not_contains", "equals", "not_equals", "empty", "not_empty", "gt", "lt", "ge", "le")
UNARY_OPS = ("empty", "not_empty")
NUMBER_OPS = ("gt", "lt", "ge", "le")

TYPE_NAMES = {"start": "开始", "llm": "AI 处理", "tool": "插件工具", "condition": "条件分支",
              "template": "文本拼接", "step": "积木", "end": "结束"}
FIELD_LABELS = {"text": "文字", "items": "清单", "title": "标题", "links": "链接", "parts": "分段", "files": "文件"}
SYS_LABELS = {"date": "今天日期", "time": "现在时间", "weekday": "星期几"}
OP_LABELS = {"contains": "包含", "not_contains": "不包含", "equals": "等于", "not_equals": "不等于",
             "empty": "为空", "not_empty": "不为空", "gt": "大于", "lt": "小于", "ge": "大于等于", "le": "小于等于"}

# v6 线性积木 → 节点图时，输入类积木变成开始节点的字段
_LEGACY_INPUT_FIELDS = {
    "input_text": {"key": "text", "label": "要处理的文字", "type": "paragraph", "required": True},
    "input_file": {"key": "file", "label": "上传资料", "type": "file", "required": True},
}


class GraphError(ValueError):
    """节点图不合法；message 直接给用户看。"""


# ---------- 小工具 ----------

def _one_line(value, limit: int) -> str:
    return " ".join(str(value or "").split())[:limit]


def _title(node: dict) -> str:
    data = node.get("data") if isinstance(node.get("data"), dict) else {}
    return str(data.get("title") or TYPE_NAMES.get(node.get("type"), "") or node.get("id") or "节点")


def _label(node: dict) -> str:
    return f"「{_title(node)}」"


def _text(data: dict, key: str, limit: int, where: str, what: str) -> str:
    """可含变量的多行文字：去掉首尾空白，超长报人话。"""
    raw = data.get(key)
    if raw is None:
        return ""
    if isinstance(raw, (int, float)) and not isinstance(raw, bool):
        raw = str(raw)
    if not isinstance(raw, str):
        raise GraphError(f"{where}的{what}格式不对")
    text = raw.replace("\r\n", "\n").strip()
    if len(text) > limit:
        raise GraphError(f"{where}的{what}最多 {limit} 个字")
    return text


def _var_path(raw) -> str:
    """「n1.text」或「{{n1.text}}」→ 「n1.text」；空串原样返回；不合法返回 None。"""
    text = str(raw or "").strip()
    if not text:
        return ""
    match = VAR_PATH.match(text)
    return f"{match.group(1)}.{match.group(2)}" if match else None


def _ensure_steps():
    from jarvis.flows import steps as flow_steps
    try:   # 插件包提供的积木在插件注册表首次加载时注册进 STEPS
        from jarvis.plugins.loader import registry
        registry()
    except Exception:
        pass
    return flow_steps


# ---------- 逐类型规整 data ----------

def _norm_field(raw, index: int, where: str, seen: set[str]) -> dict:
    if not isinstance(raw, dict):
        raise GraphError(f"{where}的第 {index} 个输入格式不对")
    key = str(raw.get("key") or "").strip()
    if not FIELD_KEY.match(key):
        raise GraphError(f"{where}的第 {index} 个输入的代号要用小写字母开头，只能有小写字母、数字和下划线")
    if key in seen:
        raise GraphError(f"{where}里有两个输入的代号都是 {key}")
    seen.add(key)
    label = _one_line(raw.get("label"), MAX_FIELD_LABEL) or key
    kind = raw.get("type") or "text"
    if kind not in FIELD_TYPES:
        raise GraphError(f"{where}的「{label}」类型不对")
    field = {"key": key, "label": label, "type": kind, "required": bool(raw.get("required", False)),
             "placeholder": _one_line(raw.get("placeholder"), MAX_PLACEHOLDER), "default": None}
    default = raw.get("default")
    if kind == "select":
        options_in = raw.get("options")
        if not isinstance(options_in, list):
            options_in = []
        options: list[str] = []
        for option in options_in:
            text = _one_line(option, MAX_OPTION_CHARS + 1)
            if len(text) > MAX_OPTION_CHARS:
                raise GraphError(f"{where}的「{label}」每个选项最多 {MAX_OPTION_CHARS} 个字")
            if text and text not in options:
                options.append(text)
        if not options:
            raise GraphError(f"{where}的「{label}」至少要有一个选项")
        if len(options) > MAX_SELECT_OPTIONS:
            raise GraphError(f"{where}的「{label}」最多 {MAX_SELECT_OPTIONS} 个选项")
        field["options"] = options
        if default not in (None, ""):
            default = _one_line(default, MAX_OPTION_CHARS)
            if default not in options:
                raise GraphError(f"{where}的「{label}」默认值要从选项里选")
            field["default"] = default
    elif kind == "number":
        if default not in (None, ""):
            try:
                value = float(str(default).replace(",", "").strip())
            except ValueError:
                raise GraphError(f"{where}的「{label}」默认值要是数字") from None
            field["default"] = int(value) if value.is_integer() and abs(value) < 1e15 else value
    elif kind in ("text", "paragraph"):
        if default not in (None, ""):
            text = str(default).replace("\r\n", "\n").strip()
            if len(text) > MAX_DEFAULT:
                raise GraphError(f"{where}的「{label}」默认值最多 {MAX_DEFAULT} 个字")
            field["default"] = text if kind == "paragraph" else " ".join(text.split())
    return field


def _norm_start(data: dict, where: str) -> dict:
    fields_in = data.get("fields")
    if fields_in is None:
        fields_in = []
    if not isinstance(fields_in, list):
        raise GraphError(f"{where}的输入格式不对")
    if len(fields_in) > MAX_FIELDS:
        raise GraphError(f"{where}最多 {MAX_FIELDS} 个输入")
    seen: set[str] = set()
    fields = [_norm_field(raw, i, where, seen) for i, raw in enumerate(fields_in, 1)]
    return {"title": _one_line(data.get("title"), MAX_TITLE) or "开始", "fields": fields}


def _norm_foreach(data: dict, where: str) -> str:
    raw = data.get("foreach")
    if raw in (None, "", False):
        return ""
    path = _var_path(raw) if isinstance(raw, str) else None
    if not path:
        raise GraphError(f"{where}的「逐条处理」要选一个上游节点的清单")
    ref, field = path.split(".")
    if ref in ("sys", START_ID) or field not in LIST_FIELDS:
        raise GraphError(f"{where}的「逐条处理」只能选上游节点的清单（条目、分段或链接）")
    return f"{{{{{path}}}}}"


def _norm_llm(data: dict, where: str) -> dict:
    skill = str(data.get("skill") or "").strip()
    if skill and not PLUGIN_ID.match(skill):
        raise GraphError(f"{where}选的技能不存在")
    output = data.get("output") or "text"
    if output not in LLM_OUTPUTS:
        raise GraphError(f"{where}的输出方式只能是「一段文字」或「清单」")
    return {"title": _one_line(data.get("title"), MAX_TITLE) or "AI 处理",
            "prompt": _text(data, "prompt", MAX_PROMPT, where, "要求"),
            "skill": skill, "output": output, "foreach": _norm_foreach(data, where)}


def _norm_tool(data: dict, where: str) -> dict:
    plugin = str(data.get("plugin") or "").strip()
    tool = str(data.get("tool") or "").strip()
    if not plugin or not PLUGIN_ID.match(plugin):
        raise GraphError(f"{where}还没选插件")
    if not tool or not TOOL_NAME.match(tool):
        raise GraphError(f"{where}还没选要用的工具")
    args_in = data.get("args")
    if args_in is None:
        args_in = {}
    if not isinstance(args_in, dict):
        raise GraphError(f"{where}的参数格式不对")
    if len(args_in) > MAX_ARGS:
        raise GraphError(f"{where}最多 {MAX_ARGS} 个参数")
    args: dict[str, str] = {}
    for name, value in args_in.items():
        if not isinstance(name, str) or not ARG_NAME.match(name):
            raise GraphError(f"{where}有个参数名不对")
        if value is None:
            continue
        if isinstance(value, bool):
            value = "true" if value else "false"
        elif isinstance(value, (int, float)):
            value = str(value)
        if not isinstance(value, str):
            raise GraphError(f"{where}的参数「{name}」要填文字")
        value = value.replace("\r\n", "\n").strip()
        if len(value) > MAX_ARG:
            raise GraphError(f"{where}的参数「{name}」最多 {MAX_ARG} 个字")
        if value:
            args[name] = value
    return {"title": _one_line(data.get("title"), MAX_TITLE) or "插件工具", "plugin": plugin, "tool": tool,
            "args": args, "foreach": _norm_foreach(data, where)}


def _norm_rule(raw, where: str, case_label: str) -> dict:
    if not isinstance(raw, dict):
        raise GraphError(f"{where}的「{case_label}」条件格式不对")
    op = raw.get("op") or "contains"
    if op not in OPS:
        raise GraphError(f"{where}的「{case_label}」里有不认识的比较方式")
    var = _var_path(raw.get("var"))
    if var is None:
        raise GraphError(f"{where}的「{case_label}」要比较的变量不对")
    value = raw.get("value")
    if isinstance(value, bool):
        value = "true" if value else "false"
    value = "" if value is None or op in UNARY_OPS else str(value).replace("\r\n", "\n").strip()
    if len(value) > MAX_RULE_VALUE:
        raise GraphError(f"{where}的「{case_label}」比较的值最多 {MAX_RULE_VALUE} 个字")
    return {"var": var, "op": op, "value": value}


def _norm_condition(data: dict, where: str) -> dict:
    cases_in = data.get("cases")
    if cases_in is None:
        cases_in = []
    if not isinstance(cases_in, list):
        raise GraphError(f"{where}的分支格式不对")
    if len(cases_in) > MAX_CASES:
        raise GraphError(f"{where}最多 {MAX_CASES} 个分支")
    cases, seen = [], set()
    for i, raw in enumerate(cases_in, 1):
        if not isinstance(raw, dict):
            raise GraphError(f"{where}的分支格式不对")
        case_id = str(raw.get("id") or "").strip() or f"c{i}"
        if not NODE_ID.match(case_id) or case_id == ELSE_HANDLE:
            raise GraphError(f"{where}的第 {i} 个分支编号不对")
        if case_id in seen:
            raise GraphError(f"{where}有两个分支编号重复了")
        seen.add(case_id)
        label = _one_line(raw.get("label"), MAX_CASE_LABEL) or f"分支 {i}"
        logic = raw.get("logic") or "and"
        if logic not in LOGICS:
            raise GraphError(f"{where}的「{label}」只能选「全部满足」或「满足任一」")
        rules_in = raw.get("rules")
        if rules_in is None:
            rules_in = []
        if not isinstance(rules_in, list):
            raise GraphError(f"{where}的「{label}」条件格式不对")
        if len(rules_in) > MAX_RULES:
            raise GraphError(f"{where}的「{label}」最多 {MAX_RULES} 条条件")
        cases.append({"id": case_id, "label": label, "logic": logic,
                      "rules": [_norm_rule(rule, where, label) for rule in rules_in]})
    return {"title": _one_line(data.get("title"), MAX_TITLE) or "条件分支", "cases": cases}


def _norm_template(data: dict, where: str) -> dict:
    return {"title": _one_line(data.get("title"), MAX_TITLE) or "文本拼接",
            "template": _text(data, "template", MAX_TEMPLATE, where, "内容")}


def _norm_step(data: dict, where: str) -> dict:
    flow_steps = _ensure_steps()
    step_id = data.get("step")
    spec = flow_steps.STEPS.get(step_id) if isinstance(step_id, str) else None
    if spec is None:
        raise GraphError(f"{where}用的积木不存在了（可能插件被停用了），换一个或删掉它")
    if spec.role == flow_steps.ROLE_INPUT:
        raise GraphError(f"「{spec.name}」已经并进「开始」节点：在开始节点里加一个输入就行")
    raw_options = data.get("options")
    if raw_options is None:
        raw_options = {}
    if not isinstance(raw_options, dict):
        raise GraphError(f"{where}的设置格式不对")
    options = {o["key"]: flow_steps.normalize_option(o, raw_options.get(o["key"]), spec.name, GraphError)
               for o in spec.options}
    return {"title": _one_line(data.get("title"), MAX_TITLE) or spec.name, "step": spec.id, "options": options,
            "input": _text(data, "input", MAX_TEMPLATE, where, "输入内容")}


def _norm_end(data: dict, where: str) -> dict:
    return {"title": _one_line(data.get("title"), MAX_TITLE) or "结束",
            "output": _text(data, "output", MAX_TEMPLATE, where, "最终结果"),
            "page": bool(data.get("page", False))}


_NORMALIZERS = {"start": _norm_start, "llm": _norm_llm, "tool": _norm_tool, "condition": _norm_condition,
                "template": _norm_template, "step": _norm_step, "end": _norm_end}


# ---------- 图的结构 ----------

def _find_cycle(ids: list[str], edges: list[dict]) -> bool:
    out: dict[str, list[str]] = {i: [] for i in ids}
    for e in edges:
        out[e["source"]].append(e["target"])
    state: dict[str, int] = {}

    def visit(n: str) -> bool:
        state[n] = 1
        for m in out[n]:
            if state.get(m) == 1 or (m not in state and visit(m)):
                return True
        state[n] = 2
        return False

    return any(n not in state and visit(n) for n in ids)


def parents_of(graph: dict) -> dict[str, list[str]]:
    parents: dict[str, list[str]] = {n["id"]: [] for n in graph["nodes"]}
    for e in graph["edges"]:
        if e["source"] not in parents[e["target"]]:
            parents[e["target"]].append(e["source"])
    return parents


def children_of(graph: dict) -> dict[str, list[str]]:
    children: dict[str, list[str]] = {n["id"]: [] for n in graph["nodes"]}
    for e in graph["edges"]:
        if e["target"] not in children[e["source"]]:
            children[e["source"]].append(e["target"])
    return children


def ancestors_of(graph: dict) -> dict[str, set[str]]:
    """每个节点的全部祖先（能沿连线走到它的节点）。"""
    parents = parents_of(graph)
    out: dict[str, set[str]] = {}
    for node_id in parents:
        seen: set[str] = set()
        queue = deque(parents[node_id])
        while queue:
            current = queue.popleft()
            if current in seen:
                continue
            seen.add(current)
            queue.extend(parents[current])
        out[node_id] = seen
    return out


def reachable_from_start(graph: dict) -> set[str]:
    children = children_of(graph)
    seen, queue = {START_ID}, deque([START_ID])
    while queue:
        for child in children.get(queue.popleft(), []):
            if child not in seen:
                seen.add(child)
                queue.append(child)
    return seen


def topo_order(graph: dict) -> list[str]:
    """拓扑序（Kahn），同一层按节点在列表里的先后，结果稳定。"""
    order_index = {n["id"]: i for i, n in enumerate(graph["nodes"])}
    indegree = {n["id"]: 0 for n in graph["nodes"]}
    children = children_of(graph)
    for parent, kids in children.items():
        for kid in kids:
            indegree[kid] += 1
    ready = sorted((i for i, d in indegree.items() if d == 0), key=order_index.get)
    order: list[str] = []
    while ready:
        current = ready.pop(0)
        order.append(current)
        for kid in children[current]:
            indegree[kid] -= 1
            if indegree[kid] == 0:
                ready.append(kid)
        ready.sort(key=order_index.get)
    return order


def node_texts(node: dict) -> list[str]:
    """节点里可能含变量的文字（用来查引用）。"""
    data, kind = node["data"], node["type"]
    if kind == "llm":
        return [data["prompt"], data["foreach"]]
    if kind == "tool":
        return [*data["args"].values(), data["foreach"]]
    if kind == "condition":
        return [f"{{{{{r['var']}}}}}" if r["var"] else "" for c in data["cases"] for r in c["rules"]] + \
               [r["value"] for c in data["cases"] for r in c["rules"]]
    if kind == "template":
        return [data["template"]]
    if kind == "step":
        return [data["input"]]
    if kind == "end":
        return [data["output"]]
    return []


def _check_refs(graph: dict, by_id: dict[str, dict]) -> None:
    ancestors = ancestors_of(graph)
    start_keys = {f["key"] for f in by_id[START_ID]["data"]["fields"]}
    for node in graph["nodes"]:
        where = _label(node)
        texts = node_texts(node)
        uses_item = any(ITEM_VAR.search(t) for t in texts if t)
        if uses_item and not node["data"].get("foreach"):
            raise GraphError(f"{where}用了「当前条目」，要先打开「逐条处理」")
        for text in texts:
            for ref, field in VAR.findall(text or ""):
                if ref == "sys":
                    if field not in SYS_FIELDS:
                        raise GraphError(f"{where}用到的系统变量「{field}」不存在")
                    continue
                target = by_id.get(ref)
                if target is None:
                    raise GraphError(f"{where}引用了不存在的节点 {ref}")
                if ref not in ancestors[node["id"]]:
                    raise GraphError(f"{where}用到了{_label(target)}的结果，但它不在{where}前面：先用连线把它们连起来")
                if ref == START_ID:
                    if field not in start_keys:
                        raise GraphError(f"{where}用到的开始输入「{field}」不存在了")
                elif field not in NODE_FIELDS:
                    raise GraphError(f"{where}用到的{_label(target)}没有「{field}」这项结果")


def validate_graph(raw) -> dict:
    """保存前的校验与规整：返回 ``{"nodes": [...], "edges": [...]}``；不合法抛 :class:`GraphError`（人话）。

    - 结构：唯一开始（id=start）、≤30 节点、≤60 连线、无环、连线两端存在、开始前 / 结束后不能再接；
      至少一个「结束」或输出积木；条件分支的连线出口（sourceHandle）是它的某个分支 id 或 ``else``；
    - data 逐类型规整：未知键丢弃、补默认值、超长 / 选项不合法报错（指明哪个节点）；
    - 变量 ``{{节点.字段}}`` 只能引用祖先节点，开始节点只能引用声明过的输入；``{{item}}`` 只在逐条处理里用。
    没配完（提示词空、必填参数没填、节点没连上）不拦，运行前再查，免得画布里存不下半成品。"""
    if not isinstance(raw, dict):
        raise GraphError("流程格式不对")
    nodes_in, edges_in = raw.get("nodes"), raw.get("edges", [])
    if edges_in is None:
        edges_in = []
    if not isinstance(nodes_in, list) or not isinstance(edges_in, list):
        raise GraphError("流程格式不对")
    if len(nodes_in) > MAX_NODES:
        raise GraphError(f"一个流程最多 {MAX_NODES} 个节点")
    if len(edges_in) > MAX_EDGES:
        raise GraphError(f"一个流程最多 {MAX_EDGES} 条连线")
    nodes: list[dict] = []
    seen: set[str] = set()
    for item in nodes_in:
        if not isinstance(item, dict):
            raise GraphError("流程格式不对")
        node_id, kind = str(item.get("id") or ""), item.get("type")
        if not NODE_ID.match(node_id):
            raise GraphError("节点编号只能用字母、数字、下划线和短横线")
        if node_id in seen:
            raise GraphError("节点编号重复了")
        if kind not in NODE_TYPES:
            raise GraphError(f"不认识的节点类型：{kind}")
        if node_id in RESERVED_IDS or (node_id == START_ID and kind != "start"):
            raise GraphError(f"节点编号不能用 {node_id}")
        seen.add(node_id)
        pos = item.get("position") if isinstance(item.get("position"), dict) else {}
        try:
            position = {"x": float(pos.get("x", 0)), "y": float(pos.get("y", 0))}
        except (TypeError, ValueError):
            position = {"x": 0.0, "y": 0.0}
        if position["x"] != position["x"] or position["y"] != position["y"] or \
                abs(position["x"]) > 1e6 or abs(position["y"]) > 1e6:   # NaN / 极端值
            position = {"x": 0.0, "y": 0.0}
        data = item.get("data") if isinstance(item.get("data"), dict) else {}
        nodes.append({"id": node_id, "type": kind, "position": position, "data": dict(data)})
    starts = [n for n in nodes if n["type"] == "start"]
    if len(starts) != 1 or starts[0]["id"] != START_ID:
        raise GraphError("流程要有且只有一个「开始」节点")
    for node in nodes:
        node["data"] = _NORMALIZERS[node["type"]](node["data"], _label(node))
    flow_steps = _ensure_steps()
    if not any(n["type"] == "end" or (n["type"] == "step" and flow_steps.STEPS[n["data"]["step"]].role
                                      == flow_steps.ROLE_OUTPUT) for n in nodes):
        raise GraphError("流程至少要有一个「结束」或输出节点")
    if sum(1 for n in nodes if n["type"] == "step" and n["data"]["step"] == "web_page") > 1:
        raise GraphError("一条流程只能生成一个网页（「生成网页」积木只能放一个）")
    by_id = {n["id"]: n for n in nodes}
    edges: list[dict] = []
    pairs: set[tuple] = set()
    edge_ids: set[str] = set()
    for i, item in enumerate(edges_in):
        if not isinstance(item, dict):
            raise GraphError("流程格式不对")
        source, target = str(item.get("source") or ""), str(item.get("target") or "")
        if source not in by_id or target not in by_id:
            raise GraphError("有连线连到了不存在的节点")
        if source == target:
            raise GraphError("节点不能连到自己")
        if target == START_ID:
            raise GraphError("「开始」节点前面不能再接节点")
        if by_id[source]["type"] == "end":
            raise GraphError("「结束」节点后面不能再接节点")
        handle = item.get("sourceHandle") or None
        handle = str(handle) if handle is not None else None
        if by_id[source]["type"] == "condition":
            handles = {c["id"] for c in by_id[source]["data"]["cases"]} | {ELSE_HANDLE}
            if handle not in handles:
                raise GraphError(f"{_label(by_id[source])}的连线要从某个分支的出口连出")
        else:
            handle = None
        key = (source, target, handle)
        if key in pairs:
            continue
        pairs.add(key)
        edge_id = str(item.get("id") or f"e{i}")
        if not NODE_ID.match(edge_id) or edge_id in edge_ids:
            edge_id = f"e{i}"
            while edge_id in edge_ids:
                edge_id += "x"
        edge_ids.add(edge_id)
        edges.append({"id": edge_id, "source": source, "target": target, "sourceHandle": handle})
    if _find_cycle([n["id"] for n in nodes], edges):
        raise GraphError("流程里有环：连线不能绕回前面的节点")
    graph = {"nodes": nodes, "edges": edges}
    _check_refs(graph, by_id)
    return graph


def default_summary(graph: dict, limit: int = 60) -> str:
    """没写简介时按拓扑序把节点标题串起来：「查天气 → AI 处理 → 结束」。"""
    by_id = {n["id"]: n for n in graph["nodes"]}
    titles = [_title(by_id[i]) for i in topo_order(graph) if by_id[i]["type"] != "start"]
    text = " → ".join(titles)
    return text if len(text) <= limit else text[: limit - 1] + "…"


def graph_from_steps(steps: list[dict]) -> dict:
    """v6 线性流程 → 节点图：输入积木并入开始节点的字段，其余积木按顺序串成 step 节点，最后接结束节点。"""
    fields: list[dict] = []
    chain: list[dict] = []
    for step in steps or []:
        plugin = step.get("plugin") if isinstance(step, dict) else None
        if not plugin:
            continue
        if plugin in _LEGACY_INPUT_FIELDS:
            field = dict(_LEGACY_INPUT_FIELDS[plugin])
            hint = _one_line((step.get("options") or {}).get("label"), MAX_PLACEHOLDER) \
                if isinstance(step.get("options"), dict) else ""
            if hint:
                field["placeholder"] = hint   # v6 文字输入的「输入框提示」
            if field["key"] not in {f["key"] for f in fields}:
                fields.append(field)
            continue
        chain.append(step)
    if not fields:
        fields.append(dict(_LEGACY_INPUT_FIELDS["input_text"]))
    nodes = [{"id": START_ID, "type": "start", "position": {"x": 0.0, "y": 0.0},
              "data": {"title": "开始", "fields": fields}}]
    edges = []
    used = {START_ID, "end", *RESERVED_IDS}
    prev = START_ID
    for i, step in enumerate(chain, start=1):
        node_id = str(step.get("id") or f"s{i}")
        if not NODE_ID.match(node_id) or node_id in used:
            node_id = f"s{i}"
            while node_id in used:
                node_id += "x"
        used.add(node_id)
        nodes.append({"id": node_id, "type": "step", "position": {"x": 280.0 * i, "y": 0.0},
                      "data": {"step": step["plugin"], "options": dict(step.get("options") or {})}})
        edges.append({"id": f"e{i}", "source": prev, "target": node_id, "sourceHandle": None})
        prev = node_id
    nodes.append({"id": "end", "type": "end", "position": {"x": 280.0 * (len(chain) + 1), "y": 0.0},
                  "data": {"title": "结束", "output": f"{{{{{prev}.text}}}}" if prev != START_ID else "", "page": False}})
    edges.append({"id": f"e{len(chain) + 1}", "source": prev, "target": "end", "sourceHandle": None})
    return {"nodes": nodes, "edges": edges}
