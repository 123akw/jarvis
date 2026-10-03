"""积木流程（第十三轮「智能平台工坊」）：输入 → 处理 → 输出，一条链跑到底。

- ``steps``：积木注册表与各积木执行函数；
- ``engine``：保存校验、运行前可用性检查、并发闸、限时执行；
- ``store``：tenant_flows / tenant_flow_runs（租户 schema v6）；
- ``page``：公开结果页 /r/<token> 的安全渲染；
- ``feishu_doc``：「汇总到飞书文档」的 docx 块转换与调用；
- ``routes``：/api/flows*、/api/r/<token>、/r/<token>。
- ``graph``：节点图（第十八轮）：结构校验、旧线性流程换算；
- ``extras``：模板库、一句话生成、定时运行（第十八轮）。

server.py 只需一处 ``register(app, ...)``，外部依赖经 :class:`FlowDeps` 注入。
"""
from jarvis.flows import extras
from jarvis.flows.engine import FlowDeps, FlowValidationError, model_compose, normalize_flow
from jarvis.flows.routes import FlowRuntime, register
from jarvis.flows.steps import STEPS, step_catalog

_RUNTIME: FlowRuntime | None = None


def runtime() -> FlowRuntime | None:
    """当前生效的运行时（测试替换 deps / 超时用）。"""
    return _RUNTIME


def install(app, **kwargs) -> FlowRuntime:
    global _RUNTIME
    # extras 先注册：/api/flows/templates、/api/flows/compose 不能被 /api/flows/{flow_id} 抢先匹配
    extras.register(app, request_principal=kwargs["request_principal"], panel_write=kwargs["panel_write"],
                    deny=kwargs["deny"], runtime=runtime)
    _RUNTIME = register(app, **kwargs)
    return _RUNTIME


def start_scheduler(notifier=None):
    """server.py 的 lifespan 调：启动定时运行（见 extras.start_scheduler）。"""
    return extras.start_scheduler(runtime=runtime, notifier=notifier)


__all__ = ["FlowDeps", "FlowRuntime", "FlowValidationError", "STEPS", "install", "model_compose",
           "normalize_flow", "register", "runtime", "start_scheduler", "step_catalog"]
