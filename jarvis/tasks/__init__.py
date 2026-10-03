"""「交给贾维斯」：后台任务与自动化（第二十一轮，归「任务」代理；契约 docs/proposals/2026-10-round21-assistant.md §5）。

- 后台任务：用户在对话里交代一件要花时间的事（调研、整理、跨几个工具办事），助理在后台按账号的智能体
  跑完（关掉网页也照跑），过程写进活动记录、计划逐步打勾，跑完推通知；中途能停、能补一句话改方向；
  遇到要用户同意的动作（见 jarvis/consent.py）停下等确认，确认后接着跑。
- 自动化：「每天早上 8 点把天气和日程发我」「收到 xx 的消息就……」——用一句话建，后台到点 / 收到时开一个后台任务。

地基只放空实现，下面的导出签名不变。
"""
from __future__ import annotations


def register(app, *, request_principal, panel_write, deny, bundle_for, notifier=None) -> None:
    """注册 /api/tasks*、/api/automations*（地基为空实现）。"""
    return None


def start_scheduler(*, bundle_for, notifier=None):
    """启动后台任务执行池与自动化调度；返回带 stop() 的对象或 None（地基为空实现）。"""
    return None


def start_task(user_id: str, goal: str, *, title: str = "", source: str = "chat", origin_thread: str = "") -> dict | None:
    """开一个后台任务，立即返回 {id, title, status}（地基为空实现，返回 None）。"""
    return None


def on_consent_decided(consent: dict) -> None:
    """同意 / 拒绝了某个后台任务里的动作：接着跑或收尾（同意与活动记录代理调用；地基为空实现）。"""
    return None
