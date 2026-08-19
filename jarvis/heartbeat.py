"""Heartbeat 主动唤醒：管家定期看一眼关注清单，该开口时才开口。

data/HEARTBEAT.md 是一份纯文本「关注清单」——主人手写（或让贾维斯代记）想被盯着
的事。后台线程每 JARVIS_HEARTBEAT_INTERVAL 秒（默认 30 分钟）醒一次：文件存在且
非空才把内容连同当前时间交给模型判断「现在该不该主动说点什么」；该说则经微信主动
推送（复用「提醒发给我」绑定通道），并投递一份进桌面/网页 pending 领取箱。模型判
轮空（只答 PASS）就保持沉默。JARVIS_HEARTBEAT_ENABLED=0 时线程根本不启动。
"""
import datetime
import logging
import os
import threading

from jarvis import config

log = logging.getLogger("jarvis")

HEARTBEAT_FILE = "HEARTBEAT.md"
DEFAULT_INTERVAL = 30 * 60.0   # 30 分钟一轮；打扰过频改这里，不必关开关
PASS_TOKEN = "PASS"

HEARTBEAT_PROMPT = (
    "你在做后台巡检，主人此刻并没有发问。下面是主人手写的关注清单与当前时间。"
    "只有当清单里有「此刻确实该提醒或跟进」的事项时，才输出一条要主动发给主人的话："
    "口语化、一到三句、不用 Markdown 符号；除此之外的一切情况只输出 PASS。\n"
    "当前时间：{now}\n关注清单：\n{content}"
)


def heartbeat_path():
    return config.data_dir() / HEARTBEAT_FILE


class PendingOutbox:
    """桌面/网页 pending 通道的心跳投递箱：按用户暂存、领取即清、线程安全。

    桌面与网页轮询同一端点，谁先来谁领走——每条心跳只送达一处，与日程提醒
    「同一通道只提醒一次」的克制口径一致。
    """

    def __init__(self):
        self._lock = threading.Lock()
        self._items: dict[str, list[dict]] = {}

    def put(self, user_id: str, title: str, when: str) -> None:
        with self._lock:
            queue = self._items.setdefault(user_id, [])
            queue.append({"id": f"heartbeat-{when}-{len(queue)}", "when": when, "title": title})

    def drain(self, user_id: str) -> list[dict]:
        with self._lock:
            return self._items.pop(user_id, [])


class HeartbeatScanner:
    """读清单 → 模型裁量 → 双通道推送；依赖全部可注入，pytest 可确定性直测。"""

    def __init__(self, *, owner_getter=None, compose=None, push_wechat=None,
                 outbox=None, path_fn=heartbeat_path, now_fn=None,
                 interval: float = DEFAULT_INTERVAL):
        self._owner_getter = owner_getter
        self._compose = compose
        self._push_wechat = push_wechat
        self._outbox = outbox
        self._path_fn = path_fn
        self._now = now_fn or datetime.datetime.now
        self._interval = interval
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def scan_once(self) -> bool:
        """跑一轮，返回是否真的推送了消息；任何异常只告警不外抛、不崩服务。"""
        if not self._owner_getter or not self._compose:
            return False
        try:
            owner = self._owner_getter()
        except Exception:
            return False
        if owner is None:
            return False
        try:
            path = self._path_fn()
            if not path.exists():
                return False   # 没建清单 = 没开这个功能，不烧模型
            content = path.read_text(encoding="utf-8").strip()
        except Exception as exc:
            log.warning("heartbeat read failed: %s", type(exc).__name__)
            return False
        if not content:
            return False
        now = self._now()
        try:
            message = (self._compose(owner, content, now) or "").strip()
        except Exception as exc:
            log.warning("heartbeat compose failed: %s", type(exc).__name__)
            return False
        if not message or message.upper() == PASS_TOKEN:
            return False
        delivered = False
        if self._push_wechat is not None:
            try:
                delivered = bool(self._push_wechat(f"🔔 {message}"))
            except Exception as exc:
                log.warning("heartbeat wechat push failed: %s", type(exc).__name__)
        if self._outbox is not None:
            try:
                self._outbox.put(owner.user_id, message, now.strftime("%Y-%m-%d %H:%M"))
                delivered = True
            except Exception as exc:
                log.warning("heartbeat outbox failed: %s", type(exc).__name__)
        if delivered:
            log.info("heartbeat pushed: %s", message[:60])
        return delivered

    def _loop(self) -> None:
        while not self._stop.wait(self._interval):
            self.scan_once()

    def start(self) -> None:
        if self._thread is not None:
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, daemon=True, name="jarvis-heartbeat")
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._thread = None


def maybe_create(**kwargs) -> HeartbeatScanner | None:
    """按环境开关建扫描器；JARVIS_HEARTBEAT_ENABLED=0 返回 None，线程根本不存在。"""
    if os.getenv("JARVIS_HEARTBEAT_ENABLED", "1") == "0":
        return None
    try:
        interval = float(os.getenv("JARVIS_HEARTBEAT_INTERVAL", "") or DEFAULT_INTERVAL)
    except ValueError:
        interval = DEFAULT_INTERVAL
    return HeartbeatScanner(interval=interval, **kwargs)
