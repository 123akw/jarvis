"""用量、配额与管理告警（第二十轮，归「用量与配额」代理；契约 §5）。

- 记账：模型调用（次数、输入 / 输出 token、估算费用）按账号、按天、按类别（chat / flow / compose / voice / other）
  写 ``usage_daily``；流程运行次数与失败次数同表（kind=flow_run）。
- 配额：``tenant_quotas`` 每账号每天的模型调用与流程运行上限（没设用环境变量默认值，Owner 不限）；
  超了在对话 / 流程入口给人话提示。
- 告警：定时流程被自动暂停、渠道（飞书 / 微信）断开、配额用尽等写 ``admin_alerts`` 并推给 Owner。
- 接口：``GET /api/admin/usage``、``PUT /api/admin/quotas/{user_id}``、``GET /api/admin/alerts``、
  ``POST /api/admin/alerts/read``、``GET /api/usage/me``。

其他模块只调下面这几个函数（地基为空实现，签名不变）。
"""
from __future__ import annotations

from contextlib import contextmanager


def register(app, *, request_principal, panel_write, deny, tenant_store, accounts) -> None:
    return None


@contextmanager
def kind_scope(kind: str):
    """把这段代码里的模型调用记到某个类别（flow / compose / voice …）；默认 chat。"""
    yield


def check_model(user_id: str) -> str | None:
    """今天的模型调用还能不能用：能用返回 None，超了返回给用户看的人话。"""
    return None


def check_flow_run(user_id: str) -> str | None:
    """今天还能不能再跑流程：能跑返回 None，超了返回人话。"""
    return None


def record_flow_run(user_id: str, ok: bool) -> None:
    """记一次流程运行（成功 / 失败）。"""
    return None


def alert(kind: str, title: str, detail: str = "", *, owner_id: str | None = None) -> None:
    """记一条管理告警并推给 Owner（同类告警会合并、限频）。"""
    return None
