"""积木流程（第十三轮「智能平台工坊」）：输入 → 处理 → 输出，一条链跑到底。

- ``steps``：积木注册表与各积木执行函数；
- ``engine``：保存校验、运行前可用性检查、并发闸、限时执行；
- ``store``：tenant_flows / tenant_flow_runs（租户 schema v6）；
- ``page``：公开结果页 /r/<token> 的安全渲染；
- ``feishu_doc``：「汇总到飞书文档」的 docx 块转换与调用；
- ``routes``：/api/flows*、/api/r/<token>、/r/<token>。

server.py 只需一处 ``register(app, ...)``，外部依赖经 :class:`FlowDeps` 注入。
"""
from jarvis.flows.engine import FlowDeps, FlowValidationError, model_compose, normalize_flow
from jarvis.flows.routes import FlowRuntime, register
from jarvis.flows.steps import STEPS, step_catalog

_RUNTIME: FlowRuntime | None = None


def runtime() -> FlowRuntime | None:
    """当前生效的运行时（测试替换 deps / 超时用）。"""
    return _RUNTIME


def install(app, **kwargs) -> FlowRuntime:
    global _RUNTIME
    _RUNTIME = register(app, **kwargs)
    return _RUNTIME


__all__ = ["FlowDeps", "FlowRuntime", "FlowValidationError", "STEPS", "install", "model_compose",
           "normalize_flow", "register", "runtime", "step_catalog"]
