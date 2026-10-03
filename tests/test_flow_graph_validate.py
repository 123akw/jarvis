"""第十八轮节点图的保存校验：逐类型规整 data（未知键丢弃、默认值、上限、选项合法性）、
条件分支出口、积木角色、变量只能引用祖先节点；错误都是人话并指明哪个节点。"""
import pytest
from jarvis.flows.graph import (MAX_FIELDS, GraphError, ancestors_of, default_summary, topo_order, validate_graph)


def _g(nodes, edges):
    return {"nodes": nodes, "edges": edges}


def _e(source, target, handle=None):
    return {"source": source, "target": target, "sourceHandle": handle}


START = {"id": "start", "type": "start", "data": {"fields": [{"key": "text", "label": "文字", "type": "paragraph"}]}}
END = {"id": "end", "type": "end", "data": {}}


def _llm(node_id="n1", **data):
    return {"id": node_id, "type": "llm", "data": {"prompt": "总结 {{start.text}}", **data}}


def _chain(*middle):
    """start → middle… → end 的直线。"""
    nodes = [START, *middle, END]
    ids = [n["id"] for n in nodes]
    return _g(nodes, [_e(a, b) for a, b in zip(ids, ids[1:])])


def _error(graph) -> str:
    with pytest.raises(GraphError) as err:
        validate_graph(graph)
    return str(err.value)


# ---------- 规整：未知键丢弃、默认值 ----------

def test_node_data_is_normalized_with_defaults_and_unknown_keys_dropped():
    graph = _chain(
        {"id": "n1", "type": "llm", "data": {"prompt": " 总结 {{start.text}} ", "evil": "<script>", "output": None}},
        {"id": "n2", "type": "tool", "data": {"plugin": "weather", "tool": "weather",
                                              "args": {"city": "{{n1.text}}", "days": 3, "empty": "", "none": None}}},
        {"id": "n3", "type": "template", "data": {"template": "{{n2.text}}\n{{sys.date}}"}},
        {"id": "n4", "type": "step", "data": {"step": "split_file", "options": {"max_parts": "5", "evil": 1}}},
    )
    graph["nodes"][-1] = {"id": "end", "type": "end", "data": {"page": 1, "x": 2}}
    out = validate_graph(graph)
    data = {n["id"]: n["data"] for n in out["nodes"]}
    assert data["start"] == {"title": "开始", "fields": [{"key": "text", "label": "文字", "type": "paragraph",
                                                         "required": False, "placeholder": "", "default": None}]}
    assert data["n1"] == {"title": "AI 处理", "prompt": "总结 {{start.text}}", "skill": "", "output": "text", "foreach": ""}
    assert data["n2"] == {"title": "插件工具", "plugin": "weather", "tool": "weather",
                          "args": {"city": "{{n1.text}}", "days": "3"}, "foreach": ""}
    assert data["n3"] == {"title": "文本拼接", "template": "{{n2.text}}\n{{sys.date}}"}
    assert data["n4"] == {"title": "文件拆分", "step": "split_file", "options": {"mode": "chapter", "max_parts": 5},
                          "input": ""}
    assert data["end"] == {"title": "结束", "output": "", "page": True}
    assert all(e["sourceHandle"] is None for e in out["edges"])
    assert default_summary(out) == "AI 处理 → 插件工具 → 文本拼接 → 文件拆分 → 结束"


def test_start_fields_select_number_and_defaults():
    start = {"id": "start", "type": "start", "data": {"title": "  早报  设置 ", "fields": [
        {"key": "city", "label": "城市", "type": "text", "required": True, "default": "  深圳  ", "placeholder": "比如深圳"},
        {"key": "mood", "label": "语气", "type": "select", "options": ["正式", "轻松", "正式", ""], "default": "轻松"},
        {"key": "days", "label": "天数", "type": "number", "default": "3"},
        {"key": "doc", "label": "资料", "type": "file", "default": "忽略"},
    ]}}
    out = validate_graph(_g([start, END], [_e("start", "end")]))
    fields = out["nodes"][0]["data"]["fields"]
    assert out["nodes"][0]["data"]["title"] == "早报 设置"
    assert fields[0] == {"key": "city", "label": "城市", "type": "text", "required": True, "placeholder": "比如深圳",
                         "default": "深圳"}
    assert fields[1]["options"] == ["正式", "轻松"] and fields[1]["default"] == "轻松"
    assert fields[2]["default"] == 3 and fields[3]["default"] is None


def test_condition_cases_and_handles_are_normalized():
    cond = {"id": "c", "type": "condition", "data": {"cases": [
        {"id": "rain", "label": "下雨", "rules": [{"var": "{{start.text}}", "op": "contains", "value": "雨"}]},
        {"label": "", "logic": "or", "rules": [{"var": "start.text", "op": "empty", "value": "忽略"}]},
    ]}}
    out = validate_graph(_g([START, cond, END, {**END, "id": "end2"}],
                            [_e("start", "c", "whatever"), _e("c", "end", "rain"), _e("c", "end2", "else")]))
    data = out["nodes"][1]["data"]
    assert data["cases"][0] == {"id": "rain", "label": "下雨", "logic": "and",
                                "rules": [{"var": "start.text", "op": "contains", "value": "雨"}]}
    assert data["cases"][1]["id"] == "c2" and data["cases"][1]["label"] == "分支 2"
    assert data["cases"][1]["rules"][0]["value"] == ""   # 为空 / 不为空不需要比较值
    assert [e["sourceHandle"] for e in out["edges"]] == [None, "rain", "else"]


# ---------- 报错：人话并指明节点 ----------

@pytest.mark.parametrize("graph, message", [
    # 开始节点的输入
    (_g([{**START, "data": {"fields": [{"key": "Text"}]}}, END], [_e("start", "end")]), "小写字母开头"),
    (_g([{**START, "data": {"fields": [{"key": "a"}, {"key": "a"}]}}, END], [_e("start", "end")]), "代号都是 a"),
    (_g([{**START, "data": {"fields": [{"key": f"f{i}"} for i in range(MAX_FIELDS + 1)]}}, END], []), "最多 8 个输入"),
    (_g([{**START, "data": {"fields": [{"key": "a", "label": "颜色", "type": "select"}]}}, END], []), "「颜色」至少要有一个选项"),
    (_g([{**START, "data": {"fields": [{"key": "a", "label": "颜色", "type": "select", "options": ["红"],
                                         "default": "蓝"}]}}, END], []), "默认值要从选项里选"),
    (_g([{**START, "data": {"fields": [{"key": "a", "label": "数量", "type": "number", "default": "很多"}]}}, END], []),
     "「数量」默认值要是数字"),
    (_g([{**START, "data": {"fields": [{"key": "a", "type": "video"}]}}, END], []), "类型不对"),
    # AI / 工具 / 文本 / 结束
    (_chain(_llm(prompt="字" * 4001, title="写总结")), "「写总结」的要求最多 4000 个字"),
    (_chain(_llm(output="table")), "输出方式"),
    (_chain(_llm(skill="../evil")), "技能不存在"),
    (_chain({"id": "t", "type": "tool", "data": {"title": "查天气", "tool": "weather"}}), "「查天气」还没选插件"),
    (_chain({"id": "t", "type": "tool", "data": {"plugin": "weather", "tool": "weather", "args": {"a b": "x"}}}),
     "参数名不对"),
    (_chain({"id": "t", "type": "tool", "data": {"plugin": "weather", "tool": "weather", "args": {"city": "x" * 2001}}}),
     "最多 2000 个字"),
    (_chain({"id": "t", "type": "template", "data": {"title": "拼", "template": ["x"]}}), "「拼」的内容格式不对"),
    # 积木
    (_chain({"id": "s", "type": "step", "data": {"step": "input_text"}}), "已经并进「开始」节点"),
    (_chain({"id": "s", "type": "step", "data": {"step": "rm_rf"}}), "积木不存在了"),
    (_chain({"id": "s", "type": "step", "data": {"step": "split_file", "options": {"max_parts": 99}}}), "2–20"),
    (_chain({"id": "s", "type": "step", "data": {"step": "web_page"}}, {"id": "s2", "type": "step", "data": {"step": "web_page"}}),
     "只能生成一个网页"),
    # 条件分支
    (_chain({"id": "c", "type": "condition", "data": {"title": "看天气", "cases": [
        {"id": "x", "rules": [{"var": "start.text", "op": "like"}]}]}}), "「看天气」的「分支 1」里有不认识的比较方式"),
    (_chain({"id": "c", "type": "condition", "data": {"cases": [{"id": "else"}]}}), "分支编号不对"),
    (_chain({"id": "c", "type": "condition", "data": {"cases": [{"id": "a"}, {"id": "a"}]}}), "重复"),
    (_g([START, {"id": "c", "type": "condition", "data": {"title": "看天气", "cases": [{"id": "a"}]}}, END],
        [_e("start", "c"), _e("c", "end", "b")]), "「看天气」的连线要从某个分支的出口连出"),
    (_g([START, {"id": "c", "type": "condition", "data": {"cases": [{"id": "a"}]}}, END],
        [_e("start", "c"), _e("c", "end")]), "分支的出口"),
    # 结构
    (_g([START, {**END, "id": "sys"}], []), "不能用 sys"),
    (_g([START, {"id": "n1", "type": "template", "data": {}}], [_e("start", "n1")]), "结束"),
    (_g([START, _llm(), END], [_e("start", "n1"), _e("n1", "end"), _e("end", "n1")]), "「结束」节点后面"),
])
def test_validation_errors_are_human_and_name_the_node(graph, message):
    assert message in _error(graph)


# ---------- 变量：只能引用祖先 ----------

def test_variables_must_reference_ancestors():
    a, b = _llm("a"), _llm("b", prompt="用 {{a.text}}", title="改写")
    parallel = _g([START, a, b, END], [_e("start", "a"), _e("start", "b"), _e("a", "end"), _e("b", "end")])
    assert _error(parallel) == "「改写」用到了「AI 处理」的结果，但它不在「改写」前面：先用连线把它们连起来"
    downstream = _g([START, _llm("a", prompt="{{b.text}}"), _llm("b"), END],
                    [_e("start", "a"), _e("a", "b"), _e("b", "end")])
    assert "不在" in _error(downstream)
    ok = validate_graph(_g([START, a, {**b, "data": {"prompt": "{{a.items}} {{start.text}} {{sys.weekday}}"}}, END],
                           [_e("start", "a"), _e("a", "b"), _e("b", "end")]))
    assert ancestors_of(ok)["b"] == {"start", "a"} and topo_order(ok) == ["start", "a", "b", "end"]


@pytest.mark.parametrize("prompt, message", [
    ("{{start.city}}", "开始输入「city」不存在了"),
    ("{{sys.year}}", "系统变量「year」不存在"),
    ("{{start.text}} {{item}}", "要先打开「逐条处理」"),
    ("{{ghost.text}}", "不存在的节点 ghost"),
])
def test_variable_errors(prompt, message):
    assert message in _error(_chain(_llm(prompt=prompt)))


def test_variable_field_must_be_an_output_and_condition_vars_are_checked():
    graph = _g([START, _llm("a"), _llm("b", prompt="{{a.secret}}"), END],
               [_e("start", "a"), _e("a", "b"), _e("b", "end")])
    assert "没有「secret」这项结果" in _error(graph)
    cond = {"id": "c", "type": "condition", "data": {"cases": [{"id": "x", "rules": [{"var": "a.text", "op": "empty"}]}]}}
    graph = _g([START, _llm("a"), cond, END], [_e("start", "c"), _e("start", "a"), _e("c", "end", "x"), _e("a", "end")])
    assert "不在" in _error(graph)


def test_foreach_must_point_at_an_ancestor_list():
    lister = _llm("a", output="list")
    each = _llm("b", prompt="展开 {{item}}", foreach="a.items")
    graph = validate_graph(_g([START, lister, each, END], [_e("start", "a"), _e("a", "b"), _e("b", "end")]))
    assert graph["nodes"][2]["data"]["foreach"] == "{{a.items}}"
    assert "逐条处理" in _error(_g([START, lister, {**each, "data": {**each["data"], "foreach": "a.text"}}, END],
                                     [_e("start", "a"), _e("a", "b"), _e("b", "end")]))
    assert "不在" in _error(_g([START, lister, {**each, "data": {**each["data"], "foreach": "{{a.items}}"}}, END],
                               [_e("start", "a"), _e("start", "b"), _e("a", "end"), _e("b", "end")]))


def test_unfinished_nodes_can_still_be_saved():
    """画布里没配完的流程也能先存下来：提示词空、必填参数没填、节点没连上，都留到运行前检查。"""
    graph = _g([START, {"id": "n1", "type": "llm", "data": {}}, {"id": "t", "type": "tool",
                                                                 "data": {"plugin": "weather", "tool": "weather"}}, END],
               [_e("start", "end")])
    out = validate_graph(graph)
    assert out["nodes"][1]["data"]["prompt"] == "" and out["nodes"][2]["data"]["args"] == {}
