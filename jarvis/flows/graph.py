"""流程节点图（第十八轮，契约见 docs/proposals/2026-10-round18-flows.md）。

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
``{{start.<字段 key>}}``；系统变量 ``{{sys.date}}`` ``{{sys.time}}`` ``{{sys.weekday}}``。

本文件是地基：结构校验（唯一开始、引用存在、无环、上限）与旧线性流程换算。
节点 data 的逐类型规整、变量只能引用上游等细则由引擎代理在这里补全。
"""
from __future__ import annotations

import re

NODE_TYPES = ("start", "llm", "tool", "condition", "template", "step", "end")
START_ID = "start"
ELSE_HANDLE = "else"
MAX_NODES = 30
MAX_EDGES = 60
MAX_NAME = 30
NODE_ID = re.compile(r"^[A-Za-z0-9_-]{1,32}$")
FIELD_KEY = re.compile(r"^[a-z][a-z0-9_]{0,23}$")
VAR = re.compile(r"\{\{\s*([A-Za-z0-9_-]{1,32})\.([A-Za-z0-9_]{1,24})\s*\}\}")
NODE_FIELDS = ("text", "items", "title", "links", "parts", "files")
SYS_FIELDS = ("date", "time", "weekday")

# v6 线性积木 → 节点图时，输入类积木变成开始节点的字段
_LEGACY_INPUT_FIELDS = {
    "input_text": {"key": "text", "label": "要处理的文字", "type": "paragraph", "required": True},
    "input_file": {"key": "file", "label": "上传资料", "type": "file", "required": True},
}


class GraphError(ValueError):
    """节点图不合法；message 直接给用户看。"""


def _title(node: dict) -> str:
    data = node.get("data") if isinstance(node.get("data"), dict) else {}
    return str(data.get("title") or node.get("id") or "节点")


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


def validate_graph(raw) -> dict:
    """结构校验并规整成 ``{"nodes": [...], "edges": [...]}``；不合法抛 :class:`GraphError`。"""
    if not isinstance(raw, dict):
        raise GraphError("流程格式不对")
    nodes_in, edges_in = raw.get("nodes"), raw.get("edges", [])
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
        seen.add(node_id)
        pos = item.get("position") if isinstance(item.get("position"), dict) else {}
        try:
            position = {"x": float(pos.get("x", 0)), "y": float(pos.get("y", 0))}
        except (TypeError, ValueError):
            position = {"x": 0.0, "y": 0.0}
        data = item.get("data") if isinstance(item.get("data"), dict) else {}
        nodes.append({"id": node_id, "type": kind, "position": position, "data": dict(data)})
    starts = [n for n in nodes if n["type"] == "start"]
    if len(starts) != 1 or starts[0]["id"] != START_ID:
        raise GraphError("流程要有且只有一个「开始」节点")
    if not any(n["type"] in ("end", "step") for n in nodes):
        raise GraphError("流程至少要有一个「结束」或输出节点")
    by_id = {n["id"]: n for n in nodes}
    edges: list[dict] = []
    pairs: set[tuple] = set()
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
        key = (source, target, handle)
        if key in pairs:
            continue
        pairs.add(key)
        edge_id = str(item.get("id") or f"e{i}")
        edges.append({"id": edge_id if NODE_ID.match(edge_id) else f"e{i}", "source": source, "target": target,
                      "sourceHandle": handle})
    if _find_cycle([n["id"] for n in nodes], edges):
        raise GraphError("流程里有环：连线不能绕回前面的节点")
    for node in nodes:
        for text in _strings(node["data"]):
            for ref, _field in VAR.findall(text):
                if ref != "sys" and ref not in by_id:
                    raise GraphError(f"「{_title(node)}」引用了不存在的节点 {ref}")
    return {"nodes": nodes, "edges": edges}


def _strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for v in value.values():
            yield from _strings(v)
    elif isinstance(value, list):
        for v in value:
            yield from _strings(v)


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
            if field["key"] not in {f["key"] for f in fields}:
                fields.append(field)
            continue
        chain.append(step)
    if not fields:
        fields.append(dict(_LEGACY_INPUT_FIELDS["input_text"]))
    nodes = [{"id": START_ID, "type": "start", "position": {"x": 0.0, "y": 0.0},
              "data": {"title": "开始", "fields": fields}}]
    edges = []
    prev = START_ID
    for i, step in enumerate(chain, start=1):
        node_id = str(step.get("id") or f"s{i}")
        node_id = node_id if NODE_ID.match(node_id) and node_id not in (START_ID, "end") else f"s{i}"
        nodes.append({"id": node_id, "type": "step", "position": {"x": 280.0 * i, "y": 0.0},
                      "data": {"step": step["plugin"], "options": dict(step.get("options") or {})}})
        edges.append({"id": f"e{i}", "source": prev, "target": node_id, "sourceHandle": None})
        prev = node_id
    nodes.append({"id": "end", "type": "end", "position": {"x": 280.0 * (len(chain) + 1), "y": 0.0},
                  "data": {"title": "结束", "output": f"{{{{{prev}.text}}}}", "page": False}})
    edges.append({"id": f"e{len(chain) + 1}", "source": prev, "target": "end", "sourceHandle": None})
    return {"nodes": nodes, "edges": edges}
