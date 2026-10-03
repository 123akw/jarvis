"""流程（第十三轮「智能平台工坊」起步，第十八轮升级为节点图画布）。

- ``steps``：积木注册表与各积木执行函数；
- ``engine``：依赖注入、旧线性流程校验、运行前可用性、并发闸、限时等待；
- ``executor``：节点图执行器（拓扑序、条件分支、变量、AI / 插件工具 / 积木 / 结束节点）；
- ``nodes``：节点目录（GET /api/flows/nodes）与插件工具的参数、可用性；
- ``store``：tenant_flows / tenant_flow_runs / tenant_flow_triggers（租户 schema v6 / v7）；
- ``page``：公开结果页 /r/<token> 的安全渲染；
- ``feishu_doc``：「汇总到飞书文档」的 docx 块转换与调用；
- ``routes``：/api/flows*、/api/r/<token>、/r/<token>。
- ``graph``：节点图（第十八轮）：结构校验、旧线性流程换算；
- ``extras``：模板库、一句话生成、定时运行（第十八轮）；
- ``approvals`` / ``hooks``：发送前确认、消息与链接触发（第二十轮）。

server.py 只需一处 ``register(app, ...)``，外部依赖经 :class:`FlowDeps` 注入。
"""
from jarvis.flows import approvals, extras, hooks
from jarvis.flows.engine import FlowDeps, FlowValidationError, model_compose, normalize_flow
from jarvis.flows.graph import GraphError, graph_from_steps, validate_graph
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
    approvals.register(app, request_principal=kwargs["request_principal"], panel_write=kwargs["panel_write"],
                       deny=kwargs["deny"], runtime=runtime)   # 第二十轮：发送前确认
    hooks.register(app, request_principal=kwargs["request_principal"], panel_write=kwargs["panel_write"],
                   deny=kwargs["deny"], runtime=runtime)       # 第二十轮：消息触发 / 链接触发
    _RUNTIME = register(app, **kwargs)
    return _RUNTIME


def start_scheduler(notifier=None):
    """server.py 的 lifespan 调：启动定时运行（见 extras.start_scheduler）。"""
    return extras.start_scheduler(runtime=runtime, notifier=notifier)


__all__ = ["FlowDeps", "FlowRuntime", "FlowValidationError", "GraphError", "STEPS", "graph_from_steps", "install",
           "model_compose", "normalize_flow", "register", "runtime", "start_scheduler", "step_catalog",
           "validate_graph"]
