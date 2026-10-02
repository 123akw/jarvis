"""账号级智能体：平台账号的 Agent 只绑定所选插件的工具（+ now / calc），自称平台名、带职业人设；
插件一改只重建该账号的 Agent；Owner 与没有平台的账号完全不变。"""
import base64

import jarvis.provider_runtime as runtime_mod
import jarvis.server as server_mod
import pytest
from fastapi.testclient import TestClient
from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langchain_core.language_models import BaseChatModel
from pydantic import Field

from jarvis import platforms
from jarvis.accounts import AccountStore
from jarvis.channels import feishu
from jarvis.prompts import SYSTEM_PROMPT, compose_system_prompt
from jarvis.provider_runtime import AgentRuntimeManager
from jarvis.provider_settings import SecretStore
from jarvis.tenancy import tenant_scope
from jarvis.tools import TOOLS

ALL_TOOLS = {tool.name for tool in TOOLS}
SCHEDULE_TODO = {"now", "calc", "schedule_add", "schedule_list", "schedule_del", "todo_add", "todo_list", "todo_done"}
WEATHER_SEARCH = {"now", "calc", "weather", "weather_here", "my_location", "web_search", "web_extract"}


class ToolRecordingModel(BaseChatModel):
    """记下 Agent 交给模型的工具清单与每次看到的消息；回答固定一句话。"""

    bound: list = Field(default_factory=list)
    seen: list = Field(default_factory=list)

    @property
    def _llm_type(self) -> str:
        return "tool-recording"

    def bind_tools(self, tools, **kwargs):
        self.bound.append(sorted(getattr(tool, "name", "") for tool in tools))
        return self

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        self.seen.append(list(messages))
        return ChatResult(generations=[ChatGeneration(message=AIMessage(content="好的"))])


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("JARVIS_PROVIDER", "deepseek")
    monkeypatch.setenv("JARVIS_BASE_URL", "https://api.deepseek.com")
    monkeypatch.setenv("JARVIS_MODEL", "deepseek-chat")
    monkeypatch.setenv("JARVIS_API_KEY", "env-key")
    models = []

    def fake_chat_openai(**kwargs):
        models.append(ToolRecordingModel())
        return models[-1]

    monkeypatch.setattr(runtime_mod, "ChatOpenAI", fake_chat_openai)
    accounts = AccountStore()
    accounts._ensure_bootstrap()
    store = SecretStore(tmp_path / "secrets", master_key=base64.urlsafe_b64encode(b"K" * 32).decode(),
                        write_enabled=True)
    manager = AgentRuntimeManager(store)
    yield accounts, manager, models
    manager.close()


def _platform(user_id, plugins_, **extra):
    fields = platforms.clean_platform({"name": "小林奶茶", "icon": "🧋", "accent": "#FF9F0A",
                                       "profession": "shop_owner", "plugins": plugins_, **extra})
    return platforms.PlatformStore().create(user_id, fields)


def _bound_tools(bundle) -> set[str]:
    return set(bundle.agent.nodes["tools"].bound.tools_by_name)


def test_each_platform_account_binds_only_its_chosen_tools(env):
    accounts, manager, models = env
    alice = accounts.create_user("alice", "Alice-pass-123", "Member")["id"]
    bob = accounts.create_user("bob", "Bob-pass-12345", "Member")["id"]
    carol = accounts.create_user("carol", "Carol-pass-123", "Member")["id"]   # 没有平台
    owner = accounts.unique_active_owner().user_id
    _platform(alice, ["schedule", "todo"])
    _platform(bob, ["weather", "search", "feishu", "split_file"])            # 通道与积木不带对话工具
    _platform(owner, ["todo"])                                                # Owner 装了平台也不受约束

    with manager.acquire(alice) as a, manager.acquire(bob) as b, \
            manager.acquire(carol) as c, manager.acquire(owner) as o:
        assert _bound_tools(a) == SCHEDULE_TODO
        assert _bound_tools(b) == WEATHER_SEARCH
        assert _bound_tools(c) == ALL_TOOLS
        assert _bound_tools(o) == ALL_TOOLS
        # 交给模型的工具清单同样只有这些：模型根本看不到别的工具
        assert set(a.model.bound[-1]) == SCHEDULE_TODO and set(b.model.bound[-1]) == WEATHER_SEARCH
        assert set(c.model.bound[-1]) == ALL_TOOLS


def test_changing_plugins_rebuilds_only_that_accounts_agent(env):
    accounts, manager, _models = env
    alice = accounts.create_user("alice", "Alice-pass-123", "Member")["id"]
    bob = accounts.create_user("bob", "Bob-pass-12345", "Member")["id"]
    _platform(alice, ["schedule", "todo"])
    _platform(bob, ["weather"])
    with manager.acquire(alice) as first, manager.acquire(bob) as bob_first:
        assert _bound_tools(first) == SCHEDULE_TODO
    with manager.acquire(alice) as again:
        assert again is first                                     # 没改就复用，不重复建
    platforms.PlatformStore().update(alice, {"plugins": ["memo"]})
    with manager.acquire(alice) as rebuilt, manager.acquire(bob) as bob_again:
        assert rebuilt is not first and first.closed
        assert _bound_tools(rebuilt) == {"now", "calc", "memo_add", "memo_list", "memo_del"}
        assert bob_again is bob_first                             # 别人的 Agent 不受影响


def test_platform_identity_and_persona_reach_the_model(env):
    accounts, manager, _models = env
    alice = accounts.create_user("alice", "Alice-pass-123", "Member")["id"]
    _platform(alice, ["schedule", "todo"], tagline="订单排班一手抓")
    with tenant_scope(alice), manager.acquire(alice) as bundle:
        bundle.agent.invoke({"messages": [HumanMessage(content="你是谁")]}, {"configurable": {"thread_id": "t-alice"}})
        system = bundle.model.seen[-1][0].content
    assert system.startswith(SYSTEM_PROMPT)
    assert "你是「小林奶茶」🧋：订单排班一手抓" in system and "由贾维斯驱动" in system
    assert "小店的经营助手" in system and "干活的工作助手" in system   # 职业人设与定位
    assert "本智能体装了这些技能：日程提醒、待办清单" in system


def test_owner_and_accounts_without_platform_keep_the_full_prompt(env):
    accounts, _manager, _models = env
    owner = accounts.unique_active_owner().user_id
    carol = accounts.create_user("carol", "Carol-pass-123", "Member")["id"]
    _platform(owner, ["todo"])
    for user_id in (owner, carol):
        with tenant_scope(user_id):
            assert compose_system_prompt() == SYSTEM_PROMPT
        assert platforms.agent_tool_names(user_id) is None


def test_web_feishu_and_voice_share_the_same_runtime(env, monkeypatch):
    """飞书、语音拿 Agent 都经 server._bundle_for → AgentRuntimeManager.acquire，平台在各入口一致生效。"""
    accounts, manager, _models = env
    alice = accounts.create_user("alice", "Alice-pass-123", "Member")["id"]
    _platform(alice, ["schedule", "todo"])
    monkeypatch.setattr(server_mod, "_runtime_manager", manager)
    assert feishu.get_bridge()._bundle_for is server_mod._bundle_for
    with server_mod._bundle_for(alice) as bundle:
        assert _bound_tools(bundle) == SCHEDULE_TODO


def test_platform_update_over_http_switches_tools_on_next_turn(env, monkeypatch):
    accounts, manager, _models = env
    accounts.create_user("alice", "Alice-pass-123", "Member")
    alice = [u["id"] for u in accounts.list_users() if u["username"] == "alice"][0]
    client = TestClient(server_mod.app)
    client.post("/api/login", json={"username": "alice", "password": "Alice-pass-123"})
    client.headers["X-JWS-CSRF"] = client.get("/api/session").json()["csrf_token"]
    client.post("/api/platform", json={"name": "小林奶茶", "accent": "#0A84FF", "plugins": ["schedule", "todo"]})
    with manager.acquire(alice) as before:
        assert _bound_tools(before) == SCHEDULE_TODO
    assert client.put("/api/platform", json={"plugins": ["weather", "search"]}).status_code == 200
    with manager.acquire(alice) as after:
        assert _bound_tools(after) == WEATHER_SEARCH


def test_failed_platform_lookup_retries_on_next_acquire(env, monkeypatch):
    accounts, manager, _models = env
    alice = accounts.create_user("alice", "Alice-pass-123", "Member")["id"]
    _platform(alice, ["schedule", "todo"])
    real = platforms.agent_tool_names
    calls = []

    def flaky(user_id):
        calls.append(user_id)
        if len(calls) == 1:
            raise RuntimeError("database is locked")
        return real(user_id)

    monkeypatch.setattr(platforms, "agent_tool_names", flaky)
    with manager.acquire(alice) as first:
        assert _bound_tools(first) == ALL_TOOLS                  # 读不到时这一次先不限工具……
    with manager.acquire(alice) as second:
        assert second is not first and _bound_tools(second) == SCHEDULE_TODO   # ……下次立刻重建再查
