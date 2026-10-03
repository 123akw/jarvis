"""流程的公共部件：依赖注入、旧线性流程校验、运行前可用性、并发闸、限时等待、模型补全。

- 校验（v6 旧接口 ``{name, steps}``）：第一步必须是 input 角色、至少一个 output、≤8 步、积木 id 在注册表里、
  选项按积木声明规整（未知键丢弃，缺省补默认，非法值给人话错误）；保存时再换算成节点图（graph.py）；
- 可用性（运行前）：飞书没绑定、微信不是 Owner 之类的条件在开跑前统一检查（:func:`requirement_problem`）；
- 并发：同一账号同时只跑一条（:class:`RunGuard`）；
- 执行：节点图执行器在 executor.py（第十八轮），每个节点在线程池里跑并限时，
  ``cancel`` 置位（客户端断开）后最多 0.25 秒内停止等待（:func:`wait_future`）。
"""
from __future__ import annotations

import logging
import re
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeout
from dataclasses import dataclass
from typing import Any, Callable

from jarvis.flows.steps import ROLE_INPUT, ROLE_OUTPUT, STEPS, StepFailure, clip, normalize_option

log = logging.getLogger("jarvis")

MAX_STEPS = 8
MAX_NAME = 30
MAX_SUMMARY = 60
TOTAL_SECONDS = 240.0
POLL_SECONDS = 0.25
_STEP_ID = re.compile(r"^[A-Za-z0-9_-]{1,32}$")

STEP_POOL = ThreadPoolExecutor(max_workers=8, thread_name_prefix="jarvis-flow-step")


class FlowValidationError(ValueError):
    """保存流程时的校验失败；message 直接给用户看。"""


@dataclass
class FlowDeps:
    """执行器的外部依赖：server.py 注入真实实现，测试整体替换。"""
    tenant_store: Callable[[], Any]
    compose: Callable[[str, str], str] | None = None            # (user_id, prompt) -> 文本
    describe_image: Callable[[bytes, str], str] | None = None   # (data, ext) -> 描述
    feishu_ready: Callable[[str], bool] = lambda user_id: False
    push_feishu: Callable[[str, str], bool] = lambda user_id, text: False
    feishu_doc_target: Callable[[str], Any] = lambda user_id: None
    wechat_owner: Callable[[str], bool] = lambda user_id: False
    wechat_ready: Callable[[], bool] = lambda: False
    push_wechat: Callable[[str], bool] = lambda text: False
    find_tool: Callable[[str], Any] | None = None               # 工具名 -> LangChain 工具（测试替身用；默认查注册表）


# ---------- 校验 ----------

def _option(spec_option: dict, raw, step_name: str):
    return normalize_option(spec_option, raw, step_name, FlowValidationError)


def _ensure_pack_steps() -> None:
    """插件包提供的积木在插件注册表首次加载时注册进 STEPS；保存流程前确保已经加载过。"""
    try:
        from jarvis.plugins.loader import registry
        registry()
    except Exception as exc:   # 插件系统出问题不能拖垮核心积木
        log.warning("plugin registry load failed: %s", type(exc).__name__)


def normalize_steps(raw_steps) -> list[dict]:
    _ensure_pack_steps()
    if not isinstance(raw_steps, list) or not raw_steps:
        raise FlowValidationError("流程里还没有积木")
    if len(raw_steps) > MAX_STEPS:
        raise FlowValidationError(f"一条流程最多 {MAX_STEPS} 步")
    steps, seen = [], set()
    for index, raw in enumerate(raw_steps):
        if not isinstance(raw, dict):
            raise FlowValidationError("积木格式不对")
        plugin = raw.get("plugin")
        spec = STEPS.get(plugin) if isinstance(plugin, str) else None
        if spec is None:
            raise FlowValidationError(f"第 {index + 1} 步的积木不存在")
        if index == 0 and spec.role != ROLE_INPUT:
            raise FlowValidationError("第一步要放资料输入（文字输入或资料上传）")
        if index > 0 and spec.role == ROLE_INPUT:
            raise FlowValidationError("资料输入只能放在第一步")
        raw_options = raw.get("options") or {}
        if not isinstance(raw_options, dict):
            raise FlowValidationError(f"「{spec.name}」的设置格式不对")
        options = {o["key"]: _option(o, raw_options.get(o["key"]), spec.name) for o in spec.options}
        step_id = raw.get("id")
        if not isinstance(step_id, str) or not _STEP_ID.match(step_id) or step_id in seen:
            step_id = uuid.uuid4().hex[:8]
        seen.add(step_id)
        steps.append({"id": step_id, "plugin": plugin, "options": options})
    if not any(STEPS[s["plugin"]].role == ROLE_OUTPUT for s in steps):
        raise FlowValidationError("至少要有一个输出积木（比如生成网页或发到飞书）")
    if sum(1 for s in steps if s["plugin"] == "web_page") > 1:
        raise FlowValidationError("一条流程只能生成一个网页")
    return steps


def default_summary(steps: list[dict]) -> str:
    return clip(" → ".join(STEPS[s["plugin"]].name for s in steps), MAX_SUMMARY)


def normalize_flow(name, steps, summary=None) -> dict:
    """保存前规整：{name, summary, steps}；不合法抛 FlowValidationError。"""
    clean_steps = normalize_steps(steps)
    clean_name = " ".join(str(name or "").split())[:MAX_NAME] or "未命名流程"
    clean_summary = " ".join(str(summary or "").split())[:MAX_SUMMARY] or default_summary(clean_steps)
    return {"name": clean_name, "summary": clean_summary, "steps": clean_steps}


def requirement_problem(plugin: str, user_id: str, deps: FlowDeps) -> str | None:
    """这块积木对当前账号能不能用；不能用返回人话原因。"""
    requires = STEPS[plugin].requires
    try:
        if "feishu_bound" in requires and not deps.feishu_ready(user_id):
            return "先在设置里绑定飞书"
        if "wechat_owner" in requires and not deps.wechat_owner(user_id):
            return "只有管理员账号能发到微信，换管理员账号来跑"
    except Exception as exc:
        log.warning("flow requirement check failed: %s", type(exc).__name__)
        return "暂时查不到绑定状态，请稍后再试"
    return None


# ---------- 并发闸 ----------

class RunGuard:
    """每个账号同时只跑一条。登记带时间戳：万一响应没被消费、finally 没走到，超时后自动作废。"""

    def __init__(self, stale_after: float = TOTAL_SECONDS + 60, clock=time.monotonic):
        self._lock = threading.Lock()
        self._running: dict[str, float] = {}
        self._stale_after = stale_after
        self._clock = clock

    def acquire(self, user_id: str) -> bool:
        now = self._clock()
        with self._lock:
            started = self._running.get(user_id)
            if started is not None and now - started < self._stale_after:
                return False
            self._running[user_id] = now
            return True

    def release(self, user_id: str) -> None:
        with self._lock:
            self._running.pop(user_id, None)


# ---------- 等待 ----------

def wait_future(future, timeout: float, cancel: threading.Event | None, clock=time.monotonic):
    """等线程池里的活：最多 ``timeout`` 秒；``cancel`` 置位后最多 0.25 秒内抛 InterruptedError。"""
    deadline = clock() + timeout
    while True:
        if cancel is not None and cancel.is_set():
            raise InterruptedError
        left = deadline - clock()
        if left <= 0:
            raise FutureTimeout
        try:
            return future.result(timeout=min(POLL_SECONDS, left))
        except FutureTimeout:
            continue


def model_compose(bundle_for, chunk_text, user_id: str, prompt: str, *, max_tokens: int = 2000) -> str:
    """一次纯文本补全：用该账号自己的模型配置，不经 Agent、不调工具、不建线程（同 briefing）。"""
    from langchain_core.messages import HumanMessage
    from jarvis.tenancy import tenant_scope

    with tenant_scope(user_id), bundle_for(user_id) as bundle:
        model = getattr(bundle, "model", None)
        if model is None:
            raise StepFailure("还没有可用的模型，请先在设置里配置模型")
        reply = model.bind(max_tokens=max_tokens).invoke([HumanMessage(content=prompt)])
    return chunk_text(reply.content)
