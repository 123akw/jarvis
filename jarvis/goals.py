"""目标与想法（第二十一轮，归「目标与想法」代理；契约 §7；参考 Meta Muse 的 Goals / Ideas 两个页签）。

- 目标：长期的事（「三个月减 5 公斤」「准备期末考」）记下目标、为什么、策略、现在到哪一步；助理定期回访进度。
- 想法：助理根据记忆、目标、日程主动想到的建议，按「值不值得打扰」打分，只推高分的；用户可调打扰频率。

地基只放空实现。
"""
from __future__ import annotations


def register(app, *, request_principal, panel_write, deny, bundle_for, notifier=None) -> None:
    """注册 /api/goals*、/api/ideas*（地基为空实现）。"""
    return None


def start_worker(*, bundle_for, notifier=None):
    """想法生成与目标回访的后台线程；返回带 stop() 的对象或 None（地基为空实现）。"""
    return None
