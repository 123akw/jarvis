"""流程模板库（第十八轮，契约 §3.4 ``GET /api/flows/templates``）。

- 模板是现成的节点图（契约 §2），按场景分「办公 / 学习 / 内容创作 / 店铺 / 生活资讯」；
  每个模板只用注册表里真实存在的插件工具、技能与积木，位置由 :func:`layout` 左 → 右分层自动排好；
- 职业套餐里的旧线性流程（jarvis/plugins 的 ``_flow``）挑几条用 ``graph_from_steps`` 换算后一并收进来；
- ``plugins`` / ``needs`` 由节点图推出来（需要绑定飞书、要先填 Key……），``plugin_details`` 按当前账号
  标出能不能用（智能体账号没装的插件也列出，并说明到哪里加）；
- :class:`Access`（包着引擎的 nodes.Account）与 :func:`layout` / :func:`check_refs` 也给「一句话生成」用。
"""
from __future__ import annotations

import copy
import logging
from collections import deque

from jarvis.flows import graph as graph_mod

log = logging.getLogger("jarvis")

# 分层排版参数与画布「整理」（web-src/src/flows/graph.js）同一套：节点宽 240、层距 80 → 横向步长 320；
# 节点高约 88、行距 40 → 纵向步长 128
NODE_WIDTH, NODE_HEIGHT, LAYER_GAP, ROW_GAP = 240.0, 88.0, 80.0, 40.0
DX, DY = NODE_WIDTH + LAYER_GAP, NODE_HEIGHT + ROW_GAP

CATEGORIES = (
    {"id": "office", "label": "办公"},
    {"id": "study", "label": "学习"},
    {"id": "content", "label": "内容创作"},
    {"id": "shop", "label": "店铺"},
    {"id": "life", "label": "生活资讯"},
)
CATEGORY_IDS = tuple(c["id"] for c in CATEGORIES)

REQUIREMENT_NEEDS = {
    "feishu_bound": "需要绑定飞书",
    "wechat_owner": "只有管理员账号能发微信",
    "desktop": "需要打开电脑上的贾维斯桌面端",
}

# 首页精选位优先展示的模板（列表页按 featured 排在前面）
FEATURED = ("morning_brief", "meeting_todo", "xhs_post")

# 模型提示里常用的一句：技能里有「先问清楚」，流程里没人回答，让它直接写
NO_ASK = "资料已经给全，不要反问；缺的信息按最常见的情况写，并用【待补充】标出。"


# ---------- 注册表与账号可用性 ----------

def _registry():
    from jarvis.plugins.loader import registry
    return registry()


def _steps():
    from jarvis.flows import steps as flow_steps
    _registry()   # 插件包提供的积木（Word / Excel）在注册表首次加载时同步进 STEPS
    return flow_steps


def graph_plugins(graph: dict) -> list[str]:
    """节点图用到的插件（按节点顺序去重：工具的插件、技能、积木）——与引擎的流程列表同一口径。"""
    from jarvis.flows import nodes
    return nodes.graph_plugins(graph)


def static_needs(plugins: list[str]) -> list[str]:
    """不看账号的前提：需要绑定飞书、某插件要先填 Key……（模板卡片上常驻显示）。"""
    entries = _registry().entry_by_id
    needs: list[str] = []
    for pid in plugins:
        entry = entries.get(pid)
        if entry is None:
            continue
        for need in entry.get("requires") or ():
            text = REQUIREMENT_NEEDS.get(need)
            if text and text not in needs:
                needs.append(text)
        if entry.get("mcp") or entry.get("status") == "needs_config":
            text = f"「{entry['name']}」要先请管理员在插件管理里填好 Key"
            if text not in needs:
                needs.append(text)
    return needs


def default_deps():
    from jarvis.flows.engine import FlowDeps
    from jarvis.tenancy import TenantStore
    return FlowDeps(tenant_store=TenantStore)


class Access:
    """当前账号对节点能不能用：复用引擎的 :class:`jarvis.flows.nodes.Account`（智能体账号只认装了的插件、
    绑定 / 桌面端 / 文件等前置条件），积木按引擎的运行前检查只看前置条件——和画布、运行时说的一样。"""

    def __init__(self, account, deps):
        self.account, self.deps = account, deps

    @classmethod
    def load(cls, user_id: str, deps=None) -> "Access":
        from jarvis.flows import nodes
        deps = deps if deps is not None else default_deps()
        return cls(nodes.Account.load(user_id, deps), deps)

    @property
    def user_id(self) -> str:
        return self.account.user_id

    def installed_has(self, plugin_id: str) -> bool:
        return self.account.installed is None or plugin_id in self.account.installed

    def node_problem(self, node: dict) -> str:
        """插件类节点对这个账号的可用性问题（不查参数、提示词这些画布里改的东西）；能用返回空串。"""
        data, kind = node.get("data") or {}, node.get("type")
        if kind == "tool":
            return self.account.tool_problem(data.get("plugin") or "", data.get("tool") or "", self.deps)
        if kind == "llm" and data.get("skill"):
            return self.account.skill_problem(data["skill"])
        if kind == "step":
            from jarvis.flows.engine import requirement_problem
            if data.get("step") not in _steps().STEPS:
                return "这个积木已经不在了（可能插件被停用了）"
            return requirement_problem(data["step"], self.user_id, self.deps) or ""
        return ""

    def details(self, graph: dict) -> list[dict]:
        """[{id, name, icon, available, reason}]：节点图用到的每个插件。"""
        entries = _registry().entry_by_id
        problems: dict[str, str] = {}
        for node in graph.get("nodes") or []:
            pids = graph_plugins({"nodes": [node]})
            if pids and pids[0] not in problems:
                problems[pids[0]] = self.node_problem(node)
            elif pids and not problems[pids[0]]:
                problems[pids[0]] = self.node_problem(node)
        out = []
        for pid in graph_plugins(graph):
            entry = entries.get(pid) or {}
            reason = problems.get(pid, "")
            out.append({"id": pid, "name": entry.get("name") or pid, "icon": entry.get("icon") or "🧩",
                        "available": not reason, "reason": reason})
        return out


# ---------- 排版与引用检查 ----------

def _children(graph: dict) -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = {n["id"]: [] for n in graph["nodes"]}
    for e in graph["edges"]:
        if e["source"] in out:
            out[e["source"]].append(e)
    return out


def _parents(graph: dict) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {n["id"]: [] for n in graph["nodes"]}
    for e in graph["edges"]:
        if e["target"] in out and e["source"] not in out[e["target"]]:
            out[e["target"]].append(e["source"])
    return out


def topo_order(graph: dict) -> list[str]:
    """Kahn 拓扑序，同层按节点在列表里的先后（结果稳定）；有环时剩下的节点按原顺序补在后面。"""
    index = {n["id"]: i for i, n in enumerate(graph["nodes"])}
    indegree = {n["id"]: 0 for n in graph["nodes"]}
    children = _children(graph)
    for edges in children.values():
        for e in edges:
            if e["target"] in indegree:
                indegree[e["target"]] += 1
    ready = sorted((i for i, d in indegree.items() if d == 0), key=index.get)
    order: list[str] = []
    while ready:
        current = ready.pop(0)
        order.append(current)
        for e in children[current]:
            indegree[e["target"]] -= 1
            if indegree[e["target"]] == 0:
                ready.append(e["target"])
        ready.sort(key=index.get)
    return order + [n["id"] for n in graph["nodes"] if n["id"] not in order]


def _handle_rank(node: dict, handle) -> float:
    """条件分支的出口顺序：按分支先后，「其他情况」最后（排版时让第一个分支在上面）。"""
    if node.get("type") != "condition":
        return 0.0
    cases = [c.get("id") for c in (node.get("data") or {}).get("cases") or []]
    if handle in cases:
        return float(cases.index(handle))
    return float(len(cases))


def layout(graph: dict, dx: float = DX, dy: float = DY) -> dict:
    """左 → 右分层排版（就地改 position 并返回 graph）：层 = 从开始走过来的最长路径；
    每个节点尽量和上游对齐（多个上游取平均高度），同层按这个高度排（条件分支按出口顺序），
    挨得太近就往下推开，再整体挪回理想高度的中间。"""
    order = topo_order(graph)
    by_id = {n["id"]: n for n in graph["nodes"]}
    parents = _parents(graph)
    layer: dict[str, int] = {}
    for node_id in order:
        layer[node_id] = max((layer.get(p, 0) + 1 for p in parents[node_id] if p in layer), default=0)
    columns: dict[int, list[str]] = {}
    for node_id in order:
        columns.setdefault(layer[node_id], []).append(node_id)
    y: dict[str, float] = {}
    incoming: dict[str, list[dict]] = {n["id"]: [] for n in graph["nodes"]}
    for e in graph["edges"]:
        if e["target"] in incoming:
            incoming[e["target"]].append(e)
    for depth in sorted(columns):
        ids = columns[depth]

        def weight(node_id: str) -> tuple:
            keys = []
            for e in incoming[node_id]:
                if e["source"] in y:
                    src = by_id[e["source"]]
                    keys.append(y[e["source"]] + _handle_rank(src, e.get("sourceHandle")) * 0.01)
            centre = sum(keys) / len(keys) if keys else 0.0
            return (centre, order.index(node_id))

        ideal = {node_id: weight(node_id)[0] for node_id in ids}
        ids.sort(key=weight)
        placed: list[float] = []
        for node_id in ids:
            want = round(ideal[node_id])
            placed.append(want if not placed else max(want, placed[-1] + dy))
        shift = sum(round(ideal[i]) - p for i, p in zip(ids, placed)) / len(ids)
        for node_id, value in zip(ids, placed):
            y[node_id] = float(round(value + shift))
            by_id[node_id]["position"] = {"x": depth * dx, "y": y[node_id]}
    return graph


def ancestors(graph: dict) -> dict[str, set[str]]:
    parents = _parents(graph)
    out: dict[str, set[str]] = {}
    for node_id in parents:
        seen: set[str] = set()
        queue = deque(parents[node_id])
        while queue:
            current = queue.popleft()
            if current in seen:
                continue
            seen.add(current)
            queue.extend(parents.get(current, []))
        out[node_id] = seen
    return out


def _strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for v in value.values():
            yield from _strings(v)
    elif isinstance(value, list):
        for v in value:
            yield from _strings(v)


def check_refs(graph: dict) -> None:
    """变量只能引用祖先节点；开始节点只能引用声明过的输入；条件分支的连线要从分支出口连出。
    （引擎的 validate_graph 也会查；这里自己再查一遍，模板与生成的草稿不依赖引擎的进度。）"""
    by_id = {n["id"]: n for n in graph["nodes"]}
    up = ancestors(graph)
    start = by_id.get(graph_mod.START_ID) or {}
    start_fields = [f for f in (start.get("data") or {}).get("fields") or [] if isinstance(f, dict)]
    keys = graph_mod.start_var_names(start_fields)   # 文件输入另有 <key>_file（原文件）
    for node in graph["nodes"]:
        title = (node.get("data") or {}).get("title") or node["id"]
        texts = list(_strings(node.get("data") or {}))
        if node.get("type") == "condition":
            texts += ["{{%s}}" % r.get("var", "") for c in node["data"].get("cases") or []
                      for r in c.get("rules") or [] if r.get("var")]
        for text in texts:
            for ref, field in graph_mod.VAR.findall(text):
                if ref == "sys":
                    if field not in graph_mod.SYS_FIELDS:
                        raise graph_mod.GraphError(f"「{title}」用到的系统变量「{field}」不存在")
                    continue
                if ref not in by_id:
                    raise graph_mod.GraphError(f"「{title}」引用了不存在的节点 {ref}")
                if ref not in up[node["id"]]:
                    raise graph_mod.GraphError(f"「{title}」用到了「{by_id[ref]['data'].get('title') or ref}」的结果，"
                                               "但它不在前面：先用连线把它们连起来")
                if ref == graph_mod.START_ID:
                    if field not in keys:
                        raise graph_mod.GraphError(f"「{title}」用到的开始输入「{field}」不存在")
                elif field not in graph_mod.NODE_FIELDS:
                    raise graph_mod.GraphError(f"「{title}」用到的结果「{field}」不存在")
    for e in graph["edges"]:
        src = by_id.get(e["source"]) or {}
        if src.get("type") == "condition":
            handles = {c.get("id") for c in src["data"].get("cases") or []} | {graph_mod.ELSE_HANDLE}
            if e.get("sourceHandle") not in handles:
                raise graph_mod.GraphError(f"「{src['data'].get('title') or src['id']}」的连线要从某个分支的出口连出")


# ---------- 模板的写法 ----------

def _field(key, label, type_="text", *, required=False, placeholder="", default=None, options=None) -> dict:
    field = {"key": key, "label": label, "type": type_, "required": required, "placeholder": placeholder}
    if default is not None:
        field["default"] = default
    if options is not None:
        field["options"] = list(options)
    return field


def _start(*fields) -> dict:
    return {"id": "start", "type": "start", "data": {"title": "开始", "fields": list(fields)}}


def _llm(node_id, title, prompt, *, skill="", output="text") -> dict:
    return {"id": node_id, "type": "llm", "data": {"title": title, "prompt": prompt, "skill": skill, "output": output}}


def _tool(node_id, title, plugin, tool, **args) -> dict:
    return {"id": node_id, "type": "tool", "data": {"title": title, "plugin": plugin, "tool": tool, "args": dict(args)}}


def _case(case_id, label, *rules, logic="and") -> dict:
    return {"id": case_id, "label": label, "logic": logic,
            "rules": [{"var": var, "op": op, "value": value} for var, op, value in rules]}


def _cond(node_id, title, *cases) -> dict:
    return {"id": node_id, "type": "condition", "data": {"title": title, "cases": list(cases)}}


def _tpl(node_id, title, template) -> dict:
    return {"id": node_id, "type": "template", "data": {"title": title, "template": template}}


def _step(node_id, title, step, options=None, *, input="") -> dict:
    return {"id": node_id, "type": "step", "data": {"title": title, "step": step, "options": dict(options or {}),
                                                     "input": input}}


def _end(node_id, title, output, *, page=False) -> dict:
    return {"id": node_id, "type": "end", "data": {"title": title, "output": output, "page": page}}


def _edges(*pairs) -> list[dict]:
    out = []
    for i, pair in enumerate(pairs, 1):
        source, target, handle = (*pair, None)[:3]
        out.append({"id": f"e{i}", "source": source, "target": target, "sourceHandle": handle})
    return out


def _template(tid, name, category, icon, summary, nodes, edges, *, needs=(), keywords=(), trigger=None) -> dict:
    return {"id": tid, "name": name, "category": category, "icon": icon, "summary": summary,
            "graph": {"nodes": nodes, "edges": edges}, "extra_needs": list(needs), "keywords": list(keywords),
            "suggest_trigger": trigger}


# ---------- 模板 ----------

def _builtin() -> list[dict]:
    return [
        # ---- 办公 ----
        _template(
            "meeting_todo", "会议纪要变待办", "office", "🗒️",
            "贴进会议记录，整理成纪要、待办自动加进清单，纪要发到飞书",
            [_start(_field("notes", "会议记录", "paragraph", required=True,
                           placeholder="把录音转写或随手记的笔记贴进来")),
             _llm("n1", "整理纪要", "把下面的会议记录整理成会议纪要，结论、决定和待办分开列。" + NO_ASK
                  + "\n\n{{start.notes}}", skill="meeting_notes"),
             _llm("n2", "提炼待办", "从这份纪要里找出所有要有人去做的事，每行一条「- 事项（负责人，截止时间）」，"
                  "没有负责人或时间就省略括号；没有待办就只输出「无」。\n\n{{n1.text}}", output="list"),
             _step("n3", "加到待办", "to_todo"),
             _step("n4", "纪要发到飞书", "feishu_send", input="{{n1.text}}"),
             _end("end", "结束", "{{n1.text}}")],
            _edges(("start", "n1"), ("n1", "n2"), ("n2", "n3"), ("n3", "n4"), ("n4", "end")),
            keywords=("会议", "纪要", "开会", "待办", "录音", "飞书")),
        _template(
            "contract_review", "合同风险审查", "office", "⚖️",
            "上传合同，按高中低风险逐条提示；有高风险就提醒你签前找律师，结果生成网页",
            [_start(_field("contract", "合同文件", "file", required=True, placeholder="PDF、Word 或拍照都行"),
                    _field("side", "你是哪一方", "select", options=("甲方", "乙方", "不确定"), default="不确定"),
                    _field("focus", "最在意什么", placeholder="比如：按时收款、押金能退")),
             _llm("n1", "逐条审查", "逐条审查这份合同，按高、中、低风险列出问题和改法。我是：{{start.side}}；"
                  "最在意：{{start.focus}}。" + NO_ASK + "最后单独一行写「结论：有高风险」或「结论：没有高风险」。"
                  "\n\n{{start.contract}}", skill="contract_check"),
             _cond("n2", "有没有高风险", _case("high", "有高风险", ("n1.text", "contains", "结论：有高风险"))),
             _tpl("n3", "加上提醒", "⚠️ 这份合同有高风险条款，签字前建议请律师再看一遍。\n\n{{n1.text}}"),
             _step("n4", "记个待办", "to_todo", input="合同有高风险条款，签字前找律师看一遍（{{sys.date}}）"),
             _end("end", "审查结果", "{{n3.text}}", page=True),
             _end("end2", "审查结果", "{{n1.text}}", page=True)],
            _edges(("start", "n1"), ("n1", "n2"), ("n2", "n3", "high"), ("n3", "n4"), ("n4", "end"),
                   ("n2", "end2", "else")),
            needs=("合同是照片或扫描件时，字要拍清楚",),
            keywords=("合同", "条款", "审查", "风险", "签约", "协议", "律师")),
        _template(
            "excel_report", "Excel 报表分析成 Word", "office", "📊",
            "上传报表，Excel 工具按你指定的列精确分组汇总，AI 照着汇总写分析和建议，一起生成 Word",
            [_start(_field("report", "Excel 报表", "file", required=True, placeholder=".xlsx 或 .csv"),
                    _field("group_by", "按哪一列分组", default="部门"),
                    _field("metric", "汇总哪一列", default="金额")),
             # 汇总交给 Excel 工具（读整张表、数字精确），不让 AI 按读出的前几十行自己算
             _tool("n1", "分组汇总", "excel", "excel_summary", file_id="{{start.report_file}}",
                   group_by="{{start.group_by}}", columns="{{start.metric}}"),
             _llm("n2", "写分析", "根据这份分组汇总（Excel 工具算出的精确数字）写报表分析：先一句话结论，再列 3–5 条发现"
                  "（哪组最高 / 最低、差距多大、各组占合计的比例、有没有异常），最后给 2–3 条建议。"
                  "引用数字一律照抄汇总表，不要自己重新加总或编造。\n\n{{n1.text}}"),
             _tpl("n3", "拼成报告", "# {{start.metric}}按{{start.group_by}}汇总分析（{{sys.date}}）\n\n## 汇总表\n\n"
                  "{{n1.text}}\n\n## 分析与建议\n\n{{n2.text}}"),
             _step("n4", "生成 Word", "word_out", {"title": "报表分析"}),
             _end("end", "结束", "{{n3.text}}")],
            _edges(("start", "n1"), ("n1", "n2"), ("n2", "n3"), ("n3", "n4"), ("n4", "end")),
            needs=("表格要是 .xlsx 或 .csv（老版 .xls 先另存为 .xlsx）", "表格第一行要是列名，分组列和汇总列要填表里真实的列名"),
            keywords=("excel", "表格", "报表", "汇总", "统计", "数据", "分析", "word")),
        _template(
            "pdf_merge", "几份 PDF 合成一份", "office", "📎",
            "按顺序上传两到三份 PDF，原样合并成一个 PDF，给你下载链接（扫描件也行）",
            [_start(_field("first", "第一份 PDF", "file", required=True, placeholder="排在最前面的那份"),
                    _field("second", "第二份 PDF", "file", required=True),
                    _field("third", "第三份 PDF（可不传）", "file"),
                    _field("name", "合并后叫什么", default="合并后.pdf")),
             _tool("n1", "合并 PDF", "pdf", "pdf_merge",
                   file_ids="{{start.first_file}} {{start.second_file}} {{start.third_file}}", name="{{start.name}}"),
             _end("end", "合并好的 PDF", "{{n1.text}}")],
            _edges(("start", "n1"), ("n1", "end")),
            needs=("只能合并 PDF；Word、图片先另存为 PDF",),
            keywords=("pdf", "合并", "合成", "拼成一个", "拼接")),
        _template(
            "word_polish", "Word 文档润色后另存", "office", "🖋️",
            "上传 Word 文档，按原来的标题、列表和表格读出来，AI 按你的要求润色，再生成一份新的 Word",
            [_start(_field("doc", "Word 文档", "file", required=True, placeholder=".docx"),
                    _field("ask", "想怎么改", "paragraph", default="改得更通顺、专业，错别字和病句都改掉，意思不变",
                           placeholder="比如：语气更正式；压缩到一半篇幅；改成给领导看的汇报")),
             # Word 工具按原顺序读出标题 / 列表 / 表格（比读出的纯文字保留结构）
             _tool("n1", "读出文档", "word", "word_read", file_id="{{start.doc_file}}", max_chars="20000"),
             _llm("n2", "润色", "按下面的要求修改这份文档，保留原来的标题层级、列表和表格（用 Markdown 写），"
                  "只输出改好的全文，不要解释。" + NO_ASK + "\n\n要求：{{start.ask}}\n\n{{n1.text}}"),
             _step("n3", "生成 Word", "word_out", {"title": "润色后的文档"}),
             _end("end", "结束", "{{n2.text}}")],
            _edges(("start", "n1"), ("n1", "n2"), ("n2", "n3"), ("n3", "end")),
            needs=("只支持 .docx（老版 .doc 先另存为 .docx）",),
            keywords=("word", "docx", "润色", "改文档", "校对", "改写", "错别字")),
        _template(
            "weekly_report", "周报存成飞书文档", "office", "📈",
            "把一周的流水账理成成果、数据、问题和下周计划，存成飞书文档",
            [_start(_field("material", "这周做了什么", "paragraph", required=True,
                           placeholder="流水账就行：做了哪些事、数据、遇到的问题")),
             _llm("n1", "写周报", "把下面这周的工作记录整理成周报：成果、数据、问题、下周计划。" + NO_ASK
                  + "没有的数据不要编。\n\n{{start.material}}", skill="work_report"),
             _step("n2", "存成飞书文档", "feishu_doc"),
             _end("end", "结束", "{{n1.text}}")],
            _edges(("start", "n1"), ("n1", "n2"), ("n2", "end")),
            keywords=("周报", "月报", "总结", "述职", "工作记录", "飞书文档"),
            trigger={"repeat": "weekly", "time": "17:00", "weekday": 5}),
        _template(
            "official_notice", "通知公文生成 Word", "office", "📑",
            "说清要通知什么，按公文格式写成通知 / 请示 / 函，直接生成 Word",
            [_start(_field("what", "要通知什么", "paragraph", required=True,
                           placeholder="什么事、时间地点、谁参加、注意事项"),
                    _field("kind", "文种", "select", options=("通知", "请示", "函", "邀请函"), default="通知")),
             _llm("n1", "起草公文", "按常见公文格式写一份「{{start.kind}}」。" + NO_ASK + "\n\n{{start.what}}",
                  skill="official_doc"),
             _step("n2", "生成 Word", "word_out", {"title": "公文"}),
             _end("end", "结束", "{{n1.text}}")],
            _edges(("start", "n1"), ("n1", "n2"), ("n2", "end")),
            keywords=("通知", "公文", "请示", "邀请函", "放假", "行政")),
        _template(
            "notice_confirm_feishu", "群通知先确认再发飞书", "office", "📣",
            "说清要通知什么，AI 写成群通知，发到飞书前先给你过目、可以改",
            [_start(_field("what", "要通知什么", "paragraph", required=True,
                           placeholder="什么事、时间地点、谁要做什么")),
             _llm("n1", "写群通知", "把下面的事写成一条简短、友好的群通知，150 字以内，重点（时间、地点、要做什么）放前面。"
                  + NO_ASK + "\n\n{{start.what}}"),
             {"id": "ok", "type": "approval", "data": {"title": "发前给我看看", "message": "{{n1.text}}",
                                                      "editable": True, "timeout_hours": 24}},
             _step("n2", "发到飞书", "feishu_send"),
             _end("end", "结束", "{{ok.text}}")],
            _edges(("start", "n1"), ("n1", "ok"), ("ok", "n2"), ("n2", "end")),
            keywords=("群通知", "发通知", "确认", "审核", "过目", "先给我看")),
        # ---- 学习 ----
        _template(
            "study_plan", "学习计划拆成待办", "study", "🗓️",
            "说说学习目标和时间，排好复习计划，再拆成每天能打勾的待办",
            [_start(_field("goal", "学习目标", "paragraph", required=True,
                           placeholder="比如：三周后期末考高数，每天能学 2 小时")),
             _llm("n1", "排学习计划", "按这个目标排一份学习计划（按天或按周，留出复习）。" + NO_ASK
                  + "\n\n{{start.goal}}", skill="study_plan"),
             _llm("n2", "拆成待办", "把这份计划拆成可以打勾的待办，每行一条「- 任务（日期或第几天）」，最多 15 条，"
                  "只输出清单。\n\n{{n1.text}}", output="list"),
             _step("n3", "加到待办", "to_todo"),
             _end("end", "学习计划", "{{n1.text}}", page=True)],
            _edges(("start", "n1"), ("n1", "n2"), ("n2", "n3"), ("n3", "end")),
            keywords=("学习", "复习", "考试", "计划", "备考", "考证")),
        _template(
            "resume_word", "简历优化生成 Word", "study", "📄",
            "上传简历、写上目标岗位，照着岗位改简历（不编经历），生成 Word",
            [_start(_field("resume", "现在的简历", "file", required=True, placeholder="PDF 或 Word"),
                    _field("job", "目标岗位", required=True, placeholder="比如：新媒体运营")),
             _llm("n1", "优化简历", "照着目标岗位「{{start.job}}」改这份简历：经历写出成果、动词开头、能量化的量化，"
                  "不编造任何经历。先给改好的完整简历，再列出改了哪些地方。" + NO_ASK + "\n\n{{start.resume}}",
                  skill="resume_helper"),
             _step("n2", "生成 Word", "word_out", {"title": "优化后的简历"}),
             _end("end", "结束", "{{n1.text}}")],
            _edges(("start", "n1"), ("n1", "n2"), ("n2", "end")),
            keywords=("简历", "求职", "面试", "岗位", "找工作", "实习")),
        _template(
            "topic_brief", "联网速览一个主题", "study", "🔎",
            "想了解什么就写什么，联网搜最新资料，AI 整理成带来源的速览网页",
            [_start(_field("topic", "想了解什么", required=True, placeholder="比如：固态电池最新进展")),
             _tool("n1", "联网搜索", "search", "web_search", query="{{start.topic}}", max_results="5"),
             _llm("n2", "AI 速览", "根据搜索结果，给「{{start.topic}}」写一份速览：一段 150 字以内的概述，"
                  "再分「## 关键事实」「## 不同观点」「## 值得继续看」三节列要点，每条后面注明来源网址。"
                  "只用搜索结果里的信息。\n\n{{n1.text}}"),
             _end("end", "速览", "{{n2.text}}", page=True)],
            _edges(("start", "n1"), ("n1", "n2"), ("n2", "end")),
            keywords=("搜索", "查资料", "了解", "速览", "调研", "研究", "联网")),
        _template(
            "essay_review", "作文批改", "study", "✍️",
            "贴进作文选好年级，先说亮点再指问题，附升格示范段，生成网页",
            [_start(_field("essay", "作文", "paragraph", required=True),
                    _field("grade", "年级", "select", options=("小学", "初中", "高中", "大学及以上"), default="初中")),
             _llm("n1", "批改作文", "按{{start.grade}}的标准批改这篇作文：先说亮点，再指出问题，最后给一段升格示范。"
                  + NO_ASK + "\n\n{{start.essay}}", skill="essay_review"),
             _end("end", "批改结果", "{{n1.text}}", page=True)],
            _edges(("start", "n1"), ("n1", "end")),
            keywords=("作文", "批改", "写作", "语文")),
        # ---- 内容创作 ----
        _template(
            "xhs_post", "小红书笔记（超字数自动精简）", "content", "📣",
            "一句话说写什么，写成小红书笔记；超过字数就自动再精简一遍",
            [_start(_field("idea", "写什么", required=True, placeholder="比如：周末在家做的低卡早餐"),
                    _field("limit", "最多多少字", "number", default=500)),
             _llm("n1", "写小红书", "写一篇小红书笔记：有吸引人的标题、分段正文和 3–5 个话题标签。" + NO_ASK
                  + "\n\n主题：{{start.idea}}", skill="social_post"),
             _llm("n2", "数一数字数", "数一数下面这篇笔记大约有多少个字（标点不算），只输出一个整数，不要别的。"
                  "\n\n{{n1.text}}"),
             _cond("n3", "超字数了吗", _case("long", "超了", ("n2.text", "gt", "{{start.limit}}"))),
             _llm("n4", "精简", "把这篇小红书笔记精简到不超过下面这个字数，保留标题、核心卖点和话题标签。"
                  "\n\n字数上限：{{start.limit}}\n\n{{n1.text}}"),
             _end("end", "精简版", "{{n4.text}}"),
             _end("end2", "笔记", "{{n1.text}}")],
            _edges(("start", "n1"), ("n1", "n2"), ("n2", "n3"), ("n3", "n4", "long"), ("n4", "end"),
                   ("n3", "end2", "else")),
            keywords=("小红书", "笔记", "种草", "文案", "朋友圈")),
        _template(
            "video_script", "短视频口播稿（带热点素材）", "content", "🎬",
            "先联网找最新素材，再写 30 / 60 秒口播稿，开头抓人、附分镜字幕",
            [_start(_field("topic", "讲什么", required=True, placeholder="比如：打工人带饭的省钱小技巧"),
                    _field("length", "时长", "select", options=("30 秒", "60 秒", "90 秒"), default="60 秒")),
             _tool("n1", "搜新鲜素材", "search", "web_search", query="{{start.topic}}", time_range="month",
                   max_results="5"),
             _llm("n2", "写口播稿", "写一条{{start.length}}的口播稿，主题是「{{start.topic}}」，开头 3 秒要抓人，附分镜和字幕。"
                  "可以参考搜到的新鲜素材（只用其中可靠的事实）。" + NO_ASK + "\n\n{{n1.text}}", skill="video_script"),
             _end("end", "口播稿", "{{n2.text}}", page=True)],
            _edges(("start", "n1"), ("n1", "n2"), ("n2", "end")),
            keywords=("短视频", "口播", "脚本", "抖音", "视频号", "分镜")),
        _template(
            "topic_ideas", "每周选题灵感", "content", "💡",
            "搜你所在领域这周的热点，挑 5 个能写的选题，存进随手记",
            [_start(_field("field", "你做什么领域", required=True, default="职场",
                           placeholder="比如：职场穿搭、宠物、数码")),
             _tool("n1", "搜这周热点", "search", "web_search", query="{{start.field}} 热点", topic="news",
                   time_range="week", max_results="5"),
             _llm("n2", "挑选题", "从这些热点里给做「{{start.field}}」的博主挑 5 个可写的选题，"
                  "每行一条「- 选题标题：切入角度（为什么现在写）」，只输出清单。\n\n{{n1.text}}", output="list"),
             _tool("n3", "存进随手记", "memo", "memo_add", content="选题灵感（{{sys.date}}）\n{{n2.text}}"),
             _end("end", "选题", "{{n2.text}}")],
            _edges(("start", "n1"), ("n1", "n2"), ("n2", "n3"), ("n3", "end")),
            keywords=("选题", "热点", "灵感", "博主", "自媒体", "公众号"),
            trigger={"repeat": "weekly", "time": "09:00", "weekday": 1}),
        # ---- 店铺 ----
        _template(
            "customer_reply", "顾客消息分流回复", "shop", "💬",
            "顾客提到退款 / 退货就写售后回复并记待办，其他消息写日常回复",
            [_start(_field("message", "顾客说了什么", "paragraph", required=True),
                    _field("policy", "店里能给的办法", placeholder="比如：7 天无理由、可补发、送优惠券")),
             _cond("n1", "是不是要退款",
                   _case("refund", "要退款 / 退货", ("start.message", "contains", "退款"),
                         ("start.message", "contains", "退货"), ("start.message", "contains", "退钱"), logic="or")),
             _llm("n2", "售后回复", "顾客要退款或退货。先共情，再说清楚怎么办（店里能给的办法：{{start.policy}}），"
                  "语气体面，给 2 版回复。" + NO_ASK + "\n\n顾客原话：{{start.message}}", skill="service_reply"),
             _step("n3", "记个售后待办", "to_todo", input="有顾客要退款 / 退货，记得处理（{{sys.date}}）"),
             _end("end", "售后回复", "{{n2.text}}"),
             _llm("n4", "日常回复", "帮我回复这位顾客：先回应他的问题，再顺势推荐或促成下单，给 2 版回复。"
                  "店里能给的办法：{{start.policy}}。" + NO_ASK + "\n\n顾客原话：{{start.message}}",
                  skill="service_reply"),
             _end("end2", "日常回复", "{{n4.text}}")],
            _edges(("start", "n1"), ("n1", "n2", "refund"), ("n2", "n3"), ("n3", "end"), ("n1", "n4", "else"),
                   ("n4", "end2")),
            keywords=("顾客", "客户", "客服", "退款", "退货", "差评", "回复", "售后")),
        _template(
            "new_arrival", "商品上新：详情页 + 朋友圈", "shop", "🛍️",
            "说说新品卖点，同时写好商品标题卖点详情和三版朋友圈，合成一个网页",
            [_start(_field("product", "新品是什么", "paragraph", required=True,
                           placeholder="名称、卖点、价格、适合谁")),
             _llm("n1", "写商品文案", "给这款新品写商品标题、五条卖点和详情页文案。" + NO_ASK + "\n\n{{start.product}}",
                  skill="product_copy"),
             _llm("n2", "写朋友圈", "根据这款新品写 3 版上新朋友圈（实在型、故事型、互动型）。" + NO_ASK
                  + "\n\n{{start.product}}", skill="social_post"),
             _tpl("n3", "合在一起", "## 商品文案\n\n{{n1.text}}\n\n## 朋友圈预告\n\n{{n2.text}}"),
             _end("end", "上新文案", "{{n3.text}}", page=True)],
            _edges(("start", "n1"), ("start", "n2"), ("n1", "n3"), ("n2", "n3"), ("n3", "end")),
            keywords=("上新", "新品", "商品", "详情页", "卖点", "朋友圈", "淘宝")),
        _template(
            "promo_plan", "看天气定周末活动", "shop", "🎉",
            "查店铺所在城市这几天的天气，结合天气出一份周末促销方案",
            [_start(_field("city", "店在哪个城市", required=True, placeholder="比如：杭州"),
                    _field("goal", "想搞什么活动", "paragraph", required=True,
                           placeholder="比如：周末清库存，预算 2000 元")),
             _tool("n1", "查天气", "weather", "weather", city="{{start.city}}"),
             _llm("n2", "出活动方案", "给小店出一份周末活动方案（玩法、算账、物料、话术）。要结合这几天的天气："
                  "下雨就多做到店自提和线上，天晴可以做门口活动。" + NO_ASK
                  + "\n\n活动想法：{{start.goal}}\n\n天气：{{n1.text}}", skill="promo_plan"),
             _end("end", "活动方案", "{{n2.text}}", page=True)],
            _edges(("start", "n1"), ("n1", "n2"), ("n2", "end")),
            keywords=("活动", "促销", "满减", "店铺", "周末", "引流")),
        # ---- 生活资讯 ----
        _template(
            "morning_brief", "每天早报发飞书", "life", "🌅",
            "天气、今天的日程和待办整理成一份早报，发到飞书（适合每天定时）",
            [_start(_field("city", "城市", required=True, default="北京")),
             _tool("n1", "查天气", "weather", "weather", city="{{start.city}}"),
             _tool("n2", "看日程", "schedule", "schedule_list"),
             _tool("n3", "看待办", "todo", "todo_list"),
             _llm("n4", "写早报", "今天是 {{sys.date}} {{sys.weekday}}。把天气、日程和待办整理成一份简短的早报："
                  "先一句问候和穿衣带伞建议，再列今天的日程，最后列最要紧的 3 件待办；不超过 300 字。"
                  "\n\n天气：{{n1.text}}\n\n日程：{{n2.text}}\n\n待办：{{n3.text}}"),
             _step("n5", "发到飞书", "feishu_send"),
             _end("end", "早报", "{{n4.text}}")],
            _edges(("start", "n1"), ("start", "n2"), ("start", "n3"), ("n1", "n4"), ("n2", "n4"), ("n3", "n4"),
                   ("n4", "n5"), ("n5", "end")),
            needs=("适合配定时：每天 07:30 自动发",),
            keywords=("早报", "早上", "每天", "天气", "日程", "待办", "飞书", "提醒"),
            trigger={"repeat": "daily", "time": "07:30"}),
        _template(
            "news_digest", "每天行业新闻摘要", "life", "📰",
            "每天搜一次你关注领域的新闻，整理成 5 条摘要和趋势点评，发到飞书",
            [_start(_field("topic", "关注什么", required=True, default="人工智能")),
             _tool("n1", "搜今天的新闻", "search", "web_search", query="{{start.topic}} 新闻", topic="news",
                   time_range="day", max_results="5"),
             _llm("n2", "写摘要", "把今天关于「{{start.topic}}」的新闻整理成不超过 5 条的摘要，每条一句话加来源网址，"
                  "最后用一句话点评趋势。只用搜索结果里的信息，没有新消息就直说。\n\n{{n1.text}}"),
             _step("n3", "发到飞书", "feishu_send"),
             _end("end", "新闻摘要", "{{n2.text}}", page=True)],
            _edges(("start", "n1"), ("n1", "n2"), ("n2", "n3"), ("n3", "end")),
            keywords=("新闻", "资讯", "行业", "动态", "摘要", "每天"),
            trigger={"repeat": "daily", "time": "08:30"}),
        _template(
            "trip_plan", "周末出游攻略（看天气排）", "life", "🧳",
            "先查目的地天气：有雨就排室内为主的行程，天晴排户外，附预算表和行前清单",
            [_start(_field("city", "去哪个城市", required=True, placeholder="比如：苏州"),
                    _field("days", "玩几天", "select", options=("1 天", "2 天", "3 天"), default="2 天"),
                    _field("who", "和谁去、预算", placeholder="比如：带老人，人均 1000")),
             _tool("n1", "查天气", "weather", "weather", city="{{start.city}}"),
             _cond("n2", "会下雨吗", _case("rain", "有雨", ("n1.text", "contains", "雨"))),
             _llm("n3", "排雨天行程", "排一份{{start.city}}{{start.days}}的行程，这几天有雨：以博物馆、老街、室内展馆和美食为主，"
                  "户外安排在雨小的时段。同行与预算：{{start.who}}。附预算表和行前清单（记得带伞）。" + NO_ASK
                  + "\n\n天气：{{n1.text}}", skill="trip_plan"),
             _end("end", "雨天攻略", "{{n3.text}}", page=True),
             _llm("n4", "排晴天行程", "排一份{{start.city}}{{start.days}}的行程，这几天天气不错：多安排户外景点和散步路线，"
                  "注意防晒。同行与预算：{{start.who}}。附预算表和行前清单。" + NO_ASK
                  + "\n\n天气：{{n1.text}}", skill="trip_plan"),
             _end("end2", "晴天攻略", "{{n4.text}}", page=True)],
            _edges(("start", "n1"), ("n1", "n2"), ("n2", "n3", "rain"), ("n3", "end"), ("n2", "n4", "else"),
                   ("n4", "end2")),
            keywords=("旅行", "旅游", "出游", "攻略", "行程", "景点", "周末", "下雨")),
        _template(
            "weekly_menu", "一周菜单 + 买菜清单", "life", "🍲",
            "按人数和口味排一周晚饭，列好买菜清单并加进待办",
            [_start(_field("people", "几口人、口味忌口", "paragraph", required=True,
                           placeholder="比如：三口人，孩子不吃辣"),
                    _field("budget", "一周买菜预算", placeholder="比如：500 元")),
             _llm("n1", "排菜单", "排一周的家常晚饭菜单（周一到周日），照顾口味和忌口，买菜预算：{{start.budget}}。"
                  + NO_ASK + "\n\n{{start.people}}", skill="home_menu"),
             _llm("n2", "列买菜清单", "根据这份菜单列一张买菜清单，同类食材合并，每行一条「- 食材 数量」，只输出清单。"
                  "\n\n{{n1.text}}", output="list"),
             _step("n3", "加到待办", "to_todo"),
             _end("end", "一周菜单", "{{n1.text}}", page=True)],
            _edges(("start", "n1"), ("n1", "n2"), ("n2", "n3"), ("n3", "end")),
            keywords=("菜单", "做饭", "买菜", "晚饭", "菜谱", "家常"),
            trigger={"repeat": "weekly", "time": "18:00", "weekday": 7}),
    ]


# 职业套餐里的旧线性流程：挑几条和上面不重复的，换算成节点图收进来
_LEGACY = (
    ("project_manager", "project_archive", "office", "🗂️", ("项目", "资料", "归档", "文档", "拆分", "要点")),
    ("freelancer", "client_brief", "office", "🧑‍💻", ("客户", "需求", "拆解", "接单")),
    ("teacher", "courseware", "study", "📚", ("课件", "讲义", "备课", "章节", "要点")),
    ("student", "quick_read", "study", "📖", ("速读", "论文", "资料", "摘要", "读书")),
    ("creator", "topic_material", "content", "🎥", ("素材", "选题", "角度")),
)


def _legacy() -> list[dict]:
    from jarvis.plugins import PROFESSIONS
    flow_steps = _steps()
    by_profession = {p["id"]: p for p in PROFESSIONS}
    out = []
    for profession, flow_id, category, icon, keywords in _LEGACY:
        flow = next((f for f in (by_profession.get(profession) or {}).get("flows", []) if f["id"] == flow_id), None)
        if flow is None:
            continue
        graph = graph_mod.graph_from_steps(flow["steps"])
        for node in graph["nodes"]:
            if node["type"] == "step":
                spec = flow_steps.STEPS.get(node["data"]["step"])
                node["data"]["title"] = spec.name if spec else node["data"]["step"]
                node["data"].setdefault("input", "")
        out.append(_template(f"pro_{flow_id}", flow["name"], category, icon, flow["summary"], graph["nodes"],
                             graph["edges"], keywords=keywords))
    return out


def _all_raw() -> list[dict]:
    items = _builtin()
    try:
        items += _legacy()
    except Exception as exc:   # 职业清单出问题不拖垮模板库
        log.warning("legacy flow templates skipped: %s", type(exc).__name__)
    return items


def all_templates() -> list[dict]:
    """全部模板（深拷贝、已排版）：{id, name, summary, category, icon, plugins, graph, needs, keywords, suggest_trigger}。"""
    out = []
    for raw in _all_raw():
        item = copy.deepcopy(raw)
        layout(item["graph"])
        item["plugins"] = graph_plugins(item["graph"])
        needs = static_needs(item["plugins"])
        item["needs"] = needs + [n for n in item.pop("extra_needs") if n not in needs]
        out.append(item)
    return out


def get_template(template_id: str) -> dict | None:
    return next((t for t in all_templates() if t["id"] == template_id), None)


def templates_for(user_id: str, deps=None) -> dict:
    """``GET /api/flows/templates`` 的响应：契约字段之外，``plugin_details`` 按当前账号标出能不能用、为什么。"""
    access = Access.load(user_id, deps)
    templates = []
    for item in all_templates():
        details = access.details(item["graph"])
        templates.append({
            "id": item["id"], "name": item["name"], "summary": item["summary"], "category": item["category"],
            "icon": item["icon"], "plugins": item["plugins"], "graph": item["graph"], "needs": item["needs"],
            "plugin_details": details, "available": all(d["available"] for d in details),
            "suggest_trigger": item["suggest_trigger"], "featured": item["id"] in FEATURED,
        })
    return {"categories": [dict(c) for c in CATEGORIES], "templates": templates}
