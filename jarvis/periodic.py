"""后台定时线程的共用生命周期（日程提醒 / 晨报电台 / Heartbeat / 夜间蒸馏 / 会话清理）。

此前四个类各抄一份一模一样的 _loop/start/stop，并且共有三个缺陷：
- _loop 没有兜底：scan_once 里 try 之外的一行抛错，线程就静默死亡（只在 stderr 留堆栈）；
- stop() 不 join、start() 又 clear 同一个 Event：旧线程若正跑在一轮里，回到 wait 时信号已被
  清掉而复活，出现两个线程同时跑；
- owner_getter 抛错或「没有唯一 Owner」时直接 return，一条日志都没有，主动功能无声停摆。
"""
from __future__ import annotations

import logging
import threading
import time

log = logging.getLogger("jarvis")

WARN_EVERY_SECONDS = 3600.0
_last_warned: dict[str, float] = {}
_warn_lock = threading.Lock()


def warn_throttled(key: str, message: str, *args, every: float = WARN_EVERY_SECONDS) -> None:
    """同一 key 的告警在 every 秒内只打一次：扫描线程几十秒一轮，不能刷屏。"""
    now = time.monotonic()
    with _warn_lock:
        last = _last_warned.get(key)
        if last is not None and now - last < every:
            return
        _last_warned[key] = now
    log.warning(message, *args)


class PeriodicWorker:
    """子类实现 scan_once()，并设置 thread_name。"""

    thread_name = "jarvis-periodic"
    first_delay: float | None = None   # 子类可设：启动后先等这么久跑第一轮；None = 等满一个周期

    def __init__(self, interval: float) -> None:
        self._interval = interval
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def scan_once(self):  # pragma: no cover - 子类实现
        raise NotImplementedError

    def _resolve_owner(self, owner_getter):
        """取唯一 Owner；取不到时记限频告警而不是静默停摆。"""
        try:
            owner = owner_getter()
        except Exception as exc:
            warn_throttled(f"{self.thread_name}:owner-error",
                           "%s: owner lookup failed: %s", self.thread_name, type(exc).__name__)
            return None
        if owner is None:
            warn_throttled("no-unique-owner",
                           "没有唯一的启用 Owner 账号（0 个或多于 1 个），日程提醒/晨报/心跳/夜间蒸馏暂停")
        return owner

    def _run(self, stop: threading.Event) -> None:
        delay = self._interval if self.first_delay is None else self.first_delay
        while not stop.wait(delay):
            delay = self._interval
            try:
                self.scan_once()
            except Exception:
                log.exception("%s round crashed; will retry next round", self.thread_name)

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        # 每次启动一份新的停止信号：残留的旧线程只会看到自己那份已置位的信号
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, args=(self._stop,),
                                        daemon=True, name=self.thread_name)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._thread = None
