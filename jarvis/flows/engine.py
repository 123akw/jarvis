"""流程校验与执行器。

- 校验（保存时）：第一步必须是 input 角色、至少一个 output、≤8 步、积木 id 在注册表里、
  选项按积木声明规整（未知键丢弃，缺省补默认，非法值给人话错误）；
- 可用性（运行前）：飞书没绑定、微信不是 Owner 之类的条件在开跑前统一检查，命中就在那一步报
  step_error，不白烧前面的模型调用。保存时不拦，免得「从职业模板新建」还没绑定飞书就存不了；
- 执行：同一账号同时只跑一条（:class:`RunGuard`）；每步在线程池里跑并限时（AI 步约 60 秒），
  整条约 3 分钟；出错给人话原因并停下；``cancel`` 置位（客户端断开）后最多 0.25 秒内停止等待。
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

from jarvis.flows.steps import ROLE_INPUT, ROLE_OUTPUT, STEPS, Outcome, StepFailure, StepJob, clip, preview

log = logging.getLogger("jarvis")

MAX_STEPS = 8
MAX_NAME = 30
MAX_SUMMARY = 60
TOTAL_SECONDS = 180.0
POLL_SECONDS = 0.25
_STEP_ID = re.compile(r"^[A-Za-z0-9_-]{1,32}$")

_STEP_POOL = ThreadPoolExecutor(max_workers=8, thread_name_prefix="jarvis-flow-step")


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


# ---------- 校验 ----------

def _option(spec_option: dict, raw, step_name: str):
    key, kind, default = spec_option["key"], spec_option["type"], spec_option.get("default")
    if raw is None or raw == "":
        return default
    if kind == "select":
        if raw not in spec_option["choices"]:
            raise FlowValidationError(f"「{step_name}」的「{spec_option['label']}」不在可选范围内")
        return raw
    if kind == "number":
        try:
            value = int(raw)
        except (TypeError, ValueError):
            raise FlowValidationError(f"「{step_name}」的「{spec_option['label']}」要填数字") from None
        low, high = spec_option.get("min"), spec_option.get("max")
        if (low is not None and value < low) or (high is not None and value > high):
            raise FlowValidationError(f"「{step_name}」的「{spec_option['label']}」要在 {low}–{high} 之间")
        return value
    text = " ".join(str(raw).split()) if key != "instruction" else str(raw).strip()
    limit = spec_option.get("max_length", 200)
    if len(text) > limit:
        raise FlowValidationError(f"「{step_name}」的「{spec_option['label']}」最多 {limit} 个字")
    return text


def normalize_steps(raw_steps) -> list[dict]:
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
            return "发到微信只对管理员账号开放"
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


# ---------- 执行 ----------

def new_context() -> dict:
    return {"text": "", "parts": [], "items": [], "title": "", "links": []}


def _wait(future, timeout: float, cancel: threading.Event | None, clock) -> Outcome:
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


def execute(*, flow: dict, user_id: str, payload: dict, deps: FlowDeps, store, emit: Callable[[dict], None],
            cancel: threading.Event | None = None, input_info: dict | None = None,
            total_seconds: float = TOTAL_SECONDS, timeouts: dict[str, float] | None = None,
            clock=time.monotonic) -> dict:
    """跑一条流程，逐个事件交给 emit（契约 4.3 的 SSE 事件）；返回 {run_id, status, output}。

    运行记录在开跑时落库（status=running），结束时回写每步结果；任何意外都保证收尾。"""
    run_id = store.start_run(user_id, flow["id"], input_info or {})
    job = StepJob(user_id=user_id, run_id=run_id, flow=flow, payload=payload, deps=deps, store=store)
    records: list[dict] = []
    status, error = "error", ""

    def send(event: dict) -> None:
        if cancel is not None and cancel.is_set():
            return   # 没人在听了
        try:
            emit(event)
        except Exception:
            pass

    try:
        send({"type": "run_start", "run_id": run_id})
        for step in flow["steps"]:
            problem = requirement_problem(step["plugin"], user_id, deps)
            if problem:
                send({"type": "step_error", "step_id": step["id"], "message": problem})
                records.append({"step_id": step["id"], "plugin": step["plugin"], "status": "error", "message": problem})
                error = problem
                return {"run_id": run_id, "status": status, "output": None}
        ctx = new_context()
        deadline = clock() + total_seconds
        for step in flow["steps"]:
            spec = STEPS[step["plugin"]]
            if cancel is not None and cancel.is_set():
                error = "页面关掉了，流程已停止"
                break
            send({"type": "step_start", "step_id": step["id"], "plugin": step["plugin"]})
            started = clock()
            limit = min((timeouts or {}).get(spec.id, spec.timeout), deadline - started)
            message = ""
            try:
                if limit <= 0:
                    raise FutureTimeout
                future = _STEP_POOL.submit(spec.run, job, ctx, step["options"])
                outcome = _wait(future, limit, cancel, clock)
            except StepFailure as exc:
                message = str(exc)
            except InterruptedError:
                error = "页面关掉了，流程已停止"
                records.append({"step_id": step["id"], "plugin": step["plugin"], "status": "error", "message": error})
                break
            except FutureTimeout:
                message = ("整条流程超过 3 分钟，已停止" if deadline - clock() <= 0.05
                           else f"这一步超时了（超过 {int(limit)} 秒），请稍后再试")
            except Exception as exc:
                log.exception("flow step %s crashed: %s", spec.id, type(exc).__name__)
                message = "这一步出了点问题，请稍后再试"
            ms = int((clock() - started) * 1000)
            if message:
                send({"type": "step_error", "step_id": step["id"], "message": message, "ms": ms})
                records.append({"step_id": step["id"], "plugin": step["plugin"], "status": "error", "message": message, "ms": ms})
                error = message
                break
            summary, shown = clip(outcome.summary, 60), preview(outcome.preview)
            send({"type": "step_done", "step_id": step["id"], "summary": summary, "preview": shown, "ms": ms})
            records.append({"step_id": step["id"], "plugin": step["plugin"], "status": "ok",
                            "summary": summary, "preview": shown, "ms": ms})
        else:
            status = "ok"
        return {"run_id": run_id, "status": status, "output": job.output if status == "ok" else None}
    finally:
        output = job.output if status == "ok" else None
        try:
            store.finish_run(user_id, run_id, status=status, steps=records, error=error)
        except Exception as exc:
            log.warning("flow run record failed: %s", type(exc).__name__)
        send({"type": "run_done", "status": status, "output": output})


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
