"""新手引导的「看过没」（第十八轮，归新手引导代理）。

- ``GET /api/onboarding``  → ``{"seen": {tour_id: {"status": "done"|"skipped", "at": iso}}}``
- ``PUT /api/onboarding``  ``{"tour": id, "status": "done"|"skipped"}`` 记一笔；``{"reset": true}`` 清空（重新看全部引导）。

按账号存 tenant_prefs（键 ``onboarding``），换设备也只出现一次；游客由前端存 localStorage。
地基只放空实现。
"""
from __future__ import annotations


def register(app, *, request_principal, panel_write, deny, tenant_store) -> None:
    return None
