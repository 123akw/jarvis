"""第二十轮 §4.1：对话里跑流程——flow_list / flow_run 两个核心工具。

运行用替身（引擎的 run_headless 由引擎代理按契约 §2 加 source / waiting / quota），流程本身存在真实的 FlowStore 里。"""
import threading

import pytest

from jarvis import platforms
from jarvis.accounts import AccountStore
from jarvis.flows import engine
from jarvis.flows.graph import validate_graph
from jarvis.flows.store import FlowStore
from jarvis.plugins import BASE_TOOLS
from jarvis.tenancy import TenantStore, tenant_scope
from jarvis.tools import TOOLS, flows_tool
from jarvis.tools.failure import is_failure, public_text
from jarvis.tools.flows_tool import find_flows, flow_list, flow_run


def _graph(fields, *, title="AI 处理"):
    return validate_graph({
        "nodes": [
            {"id": "start", "type": "start", "position": {"x": 0, "y": 0}, "data": {"fields": fields}},
            {"id": "ai", "type": "llm", "position": {"x": 200, "y": 0}, "data": {"title": title, "prompt": "整理"}},
            {"id": "end", "type": "end", "position": {"x": 400, "y": 0}, "data": {"output": "{{ai.text}}", "page": True}},
        ],
        "edges": [{"source": "start", "target": "ai"}, {"source": "ai", "target": "end"}],
    })


NEWS_FIELDS = [{"key": "city", "label": "城市", "type": "text", "required": True},
               {"key": "tone", "label": "语气", "type": "select", "options": ["正式", "轻松"], "default": "正式"},
               {"key": "days", "label": "天数", "type": "number"}]
REVIEW_FIELDS = [{"key": "contract", "label": "合同", "type": "file", "required": True},
                 {"key": "focus", "label": "关注点", "type": "paragraph"}]


class FakeRuntime:
    """只替换运行：流程照样存在真实的 FlowStore 里。"""

    def __init__(self, result=None):
        self.deps = engine.FlowDeps(tenant_store=TenantStore)
        self.calls = []
        self.result = result or {"status": "ok", "run_id": "r1", "error": "",
                                 "output": {"text": "## 今日早报\n- 晴，25 度", "page_url": "/r/tok123",
                                            "links": [{"label": "结果网页", "url": "/r/tok123"},
                                                      {"label": "早报.docx", "url": "/api/files/abcdefgh12"}]}}
        self.gate = None

    def store(self):
        self.deps.tenant_store()
        return FlowStore()

    def run_headless(self, user_id, flow_id, inputs=None, *, source="schedule"):
        self.calls.append({"user_id": user_id, "flow_id": flow_id, "inputs": inputs, "source": source})
        if self.gate is not None:
            self.gate.wait(5)
        return dict(self.result)


@pytest.fixture()
def owner_id():
    accounts = AccountStore(); accounts._ensure_bootstrap()
    return accounts.list_users()[0]["id"]


@pytest.fixture()
def runtime(monkeypatch):
    fake = FakeRuntime()
    monkeypatch.setattr(flows_tool, "_runtime", lambda: fake)
    monkeypatch.delenv("JARVIS_PUBLIC_URL", raising=False)
    return fake


def _flow(owner, name, fields=(), summary=""):
    return FlowStore().create_flow(owner, name=name, summary=summary or f"{name}的说明", graph=_graph(list(fields)))


def _run(owner, args, config=None):
    with tenant_scope(owner):
        return flow_run.invoke(args, config=config or {})


# ---------- 注册 ----------

def test_tools_are_registered_for_everyone_including_agent_accounts(owner_id):
    names = {t.name for t in TOOLS}
    assert {"flow_list", "flow_run"} <= names and {"flow_list", "flow_run"} <= set(BASE_TOOLS)
    member = AccountStore().create_user("member", "Member-pass-123", "Member")["id"]
    platforms.PlatformStore().create(member, platforms.clean_platform(
        {"name": "小林奶茶", "icon": "🧋", "accent": "#FF9F0A", "profession": "shop_owner", "plugins": ["todo"]}))
    assert {"flow_list", "flow_run"} <= platforms.agent_tool_names(member)


def test_tool_chip_labels():
    import jarvis.server as server_mod
    from jarvis.channels.feishu.bridge import tool_label
    assert server_mod._tool_label("flow_run") == {"label": {"icon": "▶️", "name": "运行流程"}}
    assert server_mod._tool_label("flow_list") == {"label": {"icon": "🔀", "name": "我的流程"}}
    assert tool_label("flow_run") == "运行流程"


# ---------- 名字匹配 ----------

def test_find_flows_exact_contains_fuzzy_and_ambiguous():
    flows = [{"id": "1", "name": "早报"}, {"id": "2", "name": "早报（周末版）"}, {"id": "3", "name": "销售周报"},
             {"id": "4", "name": "技术周报"}, {"id": "5", "name": "合同审查"}]
    assert find_flows(flows, "早报")[0]["id"] == "1"                     # 完全一致优先，哪怕别的也包含它
    assert find_flows(flows, "我的「早报」流程")[0]["id"] == "1"          # 「我的」「流程」与引号不算
    assert find_flows(flows, "合同审核")[0]["id"] == "5"                  # 相似度兜底
    assert find_flows(flows, "每天的合同审查")[0]["id"] == "5"            # 名字包含在原话里
    picked, candidates = find_flows(flows, "周报")
    assert picked is None and [f["id"] for f in candidates] == ["3", "4"]
    assert find_flows(flows, "天气提醒") == (None, [])
    assert find_flows([], "早报") == (None, [])


# ---------- flow_run ----------

def test_run_maps_inputs_by_key_and_label_and_reports_result_with_links(owner_id, runtime):
    flow = _flow(owner_id, "每日早报", NEWS_FIELDS)
    out = _run(owner_id, {"name": "早报", "inputs": {"城市": "上海", "tone": "轻松一点", "天数": 3}})
    [call] = runtime.calls
    assert call == {"user_id": owner_id, "flow_id": flow["id"], "source": "chat",
                    "inputs": {"city": "上海", "tone": "轻松", "days": 3}}   # 选项宽松对上「轻松」
    assert not is_failure(out)
    assert "流程「每日早报」跑完了" in out and "晴，25 度" in out
    assert "[结果网页](/r/tok123)" in out and "[早报.docx](/api/files/abcdefgh12)" in out
    assert "贾维斯网页里打开" not in out                                    # 网页里的对话：相对地址照样能点


def test_text_input_fills_first_text_field_and_public_url_makes_links_absolute(owner_id, runtime, monkeypatch):
    monkeypatch.setenv("JARVIS_PUBLIC_URL", "https://jv.example.com/")
    _flow(owner_id, "每日早报", NEWS_FIELDS)
    out = _run(owner_id, {"name": "每日早报", "inputs": "北京"})
    assert runtime.calls[0]["inputs"] == {"city": "北京"}
    assert "[结果网页](https://jv.example.com/r/tok123)" in out


def test_json_string_inputs_and_single_unmatched_key_goes_to_the_only_text_field(owner_id, runtime):
    _flow(owner_id, "随手整理", [{"key": "content", "label": "要整理的内容", "type": "paragraph", "required": True}])
    _run(owner_id, {"name": "随手整理", "inputs": '{"正文": "今天开了三个会"}'})
    assert runtime.calls[-1]["inputs"] == {"content": "今天开了三个会"}


def test_attachment_marker_goes_to_file_field_and_rest_to_text(owner_id, runtime):
    _flow(owner_id, "合同审查", REVIEW_FIELDS)
    _run(owner_id, {"name": "合同审查", "inputs": "［附件：采购合同.pdf · file_id=AbCdEf123456］ 重点看违约金"})
    assert runtime.calls[-1]["inputs"] == {"contract": {"file_id": "AbCdEf123456"}, "focus": "重点看违约金"}
    _run(owner_id, {"name": "合同审查", "inputs": {"合同": "［附件：采购合同.pdf · file_id=AbCdEf123456］"}})
    assert runtime.calls[-1]["inputs"] == {"contract": {"file_id": "AbCdEf123456"}}


def test_ambiguous_name_asks_instead_of_running(owner_id, runtime):
    _flow(owner_id, "销售周报"); _flow(owner_id, "技术周报")
    out = _run(owner_id, {"name": "周报"})
    assert runtime.calls == []
    assert "「销售周报」" in out and "「技术周报」" in out and "先问领导要跑哪一条" in out
    assert not is_failure(out)


def test_unknown_name_lists_existing_flows_and_is_marked_failed(owner_id, runtime):
    _flow(owner_id, "每日早报")
    out = _run(owner_id, {"name": "天气提醒"})
    assert is_failure(out) and "「每日早报」" in out and runtime.calls == []
    assert public_text(out) == "没找到叫「天气提醒」的流程"


def test_no_flows_at_all(owner_id, runtime):
    out = _run(owner_id, {"name": "早报"})
    assert is_failure(out) and "还没有任何流程" in out


def test_missing_required_and_unknown_inputs_ask_first(owner_id, runtime):
    _flow(owner_id, "合同审查", REVIEW_FIELDS)
    missing = _run(owner_id, {"name": "合同审查", "inputs": {"关注点": "付款条款"}})
    assert "还要填：合同（文件，必填）" in missing and "📎 上传" in missing and runtime.calls == []
    _flow(owner_id, "每日早报", NEWS_FIELDS)
    wrong = _run(owner_id, {"name": "每日早报", "inputs": {"城市": "上海", "风格": "活泼", "篇幅": "短"}})
    assert "「风格」「篇幅」对不上" in wrong and "城市（文字，必填）" in wrong and runtime.calls == []


@pytest.mark.parametrize("result, expect, public", [
    ({"status": "busy", "error": "你有一条流程正在运行，等它跑完再试"}, "没开跑", "你有一条流程正在运行，等它跑完再试"),
    ({"status": "quota", "error": "今天的用量到上限了，明天再来，或请管理员调高"}, "到上限", "今天的用量到上限了，明天再来，或请管理员调高"),
    ({"status": "error", "error": "「发到飞书」：先在设置里绑定飞书"}, "没跑成", "「每日早报」没跑成：「发到飞书」：先在设置里绑定飞书"),
])
def test_busy_quota_and_error_are_human_and_marked_failed(owner_id, runtime, result, expect, public):
    _flow(owner_id, "每日早报")
    runtime.result = {"run_id": None, "output": None, **result}
    out = _run(owner_id, {"name": "每日早报"})
    assert is_failure(out) and expect in out and public_text(out) == public
    assert "status" not in out and "error" not in out                       # 不出现英文字段名


def test_waiting_gives_the_approval_link(owner_id, runtime, monkeypatch):
    monkeypatch.setenv("JARVIS_PUBLIC_URL", "https://jv.example.com")
    _flow(owner_id, "群发通知")
    runtime.result = {"status": "waiting", "run_id": "r9", "output": None, "error": "",
                      "approval": {"id": "ap12345678", "url": "/approve/ap12345678",
                                   "expires_at": "2026-10-04T08:00:00+00:00"}}
    out = _run(owner_id, {"name": "群发通知"})
    assert not is_failure(out)
    assert "已经发给领导确认了" in out and "[去确认](https://jv.example.com/approve/ap12345678)" in out
    assert "前有效" in out


def test_feishu_conversation_notes_relative_links(owner_id, runtime):
    _flow(owner_id, "每日早报")
    with tenant_scope(owner_id):
        thread = TenantStore().upsert_thread("fs-p-abc", "跑一下早报")
    out = _run(owner_id, {"name": "每日早报"}, config={"configurable": {"thread_id": thread.checkpoint_thread_id}})
    assert "要在贾维斯网页里打开" in out


def test_slow_run_returns_running_hint(owner_id, runtime, monkeypatch):
    _flow(owner_id, "每日早报")
    runtime.gate = threading.Event()
    monkeypatch.setattr(flows_tool, "CHAT_WAIT_SECONDS", 0.05)
    out = _run(owner_id, {"name": "每日早报"})
    runtime.gate.set()
    assert "已经开跑了" in out and "运行记录" in out and not is_failure(out)


def test_runtime_missing_is_a_failure(owner_id, monkeypatch):
    monkeypatch.setattr(flows_tool, "_runtime", lambda: None)
    with tenant_scope(owner_id):
        assert is_failure(flow_run.invoke({"name": "早报"})) and is_failure(flow_list.invoke({}))


# ---------- flow_list ----------

def test_flow_list_shows_inputs_and_schedule(owner_id, runtime):
    news = _flow(owner_id, "每日早报", NEWS_FIELDS, summary="天气 → 汇总 → 结果网页")
    _flow(owner_id, "合同审查", REVIEW_FIELDS)
    from jarvis.flows.schedule import TriggerStore
    TriggerStore().save(owner_id, news["id"], kind="schedule", enabled=True,
                        config={"schedule": {"repeat": "daily", "time": "08:00"}}, next_run_at="2026-10-04T00:00:00+00:00")
    with tenant_scope(owner_id):
        out = flow_list.invoke({})
    assert "领导共有 2 条流程" in out
    assert "「每日早报」：天气 → 汇总 → 结果网页｜要填：城市（文字，必填）、语气（选：正式/轻松，默认 正式）、天数（数字）｜定时：每天 08:00" in out
    assert "「合同审查」" in out and "合同（文件，必填）" in out and "没有定时" in out


def test_flow_list_empty_and_only_own_flows(owner_id, runtime):
    member = AccountStore().create_user("member", "Member-pass-123", "Member")["id"]
    _flow(owner_id, "老板的早报")
    with tenant_scope(member):
        assert "还没有流程" in flow_list.invoke({})
        assert is_failure(flow_run.invoke({"name": "老板的早报"}))
    assert runtime.calls == []
