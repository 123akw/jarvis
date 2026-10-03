"""「发送前让我确认」（第二十轮，归引擎代理；契约 docs/proposals/2026-10-round20-flows-ops.md §3）。

流程跑到 ``approval`` 节点时停下：运行记录 status=waiting，表 ``tenant_flow_approvals`` 记一条待确认
（``state`` 存恢复运行所需的上下文），按账号的送达渠道推一条「有一步等你确认」并附 /approve/<id> 链接；
用户在网页上同意（可改内容）/ 拒绝后从确认节点接着跑或停下；超时（默认 24 小时）记为 expired。

- ``GET  /api/approvals?status=pending``   我的待确认列表
- ``GET  /api/approvals/{id}``              详情（要发出去的内容、可改的字段、所属流程与运行）
- ``POST /api/approvals/{id}``              ``{decision: approve|reject, edits: {...}, note}``（CSRF）

地基只放空实现。
"""
from __future__ import annotations


def register(app, *, request_principal, panel_write, deny, runtime) -> None:
    return None
