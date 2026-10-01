"""飞书事件长连接客户端（WebSocket 模式，服务器无需公网回调地址）。

流程与官方 SDK lark-oapi 1.7.3 ``lark_oapi/ws/client.py`` 对齐：

1. POST {domain}/callback/ws/endpoint  body {"AppID", "AppSecret"} → wss URL（含 service_id）
   与 ClientConfig（PingInterval / ReconnectInterval / ReconnectNonce，单位秒）；
2. 建立 WebSocket，二进制帧为 pbbp2.Frame（见 frame.py）；
3. 每 PingInterval 秒发 CONTROL/ping，pong 帧里可能带新的 ClientConfig；
4. DATA 帧 type=event：payload 是事件 JSON（sum>1 时按 message_id 分片合包），
   处理后原帧追加 biz_rt 头、payload 换成 {"code":200} 回写即 ack。
   官方文档要求 3 秒内处理完，否则重推——所以这里只做解析+入队就立刻 ack，
   真正的 Agent 回复在桥的工作池里跑；
5. 断线后先随机抖动 [0, ReconnectNonce) 秒，之后每 ReconnectInterval 秒重试。

为什么不直接用 lark-oapi：它的 ws.Client 在模块导入时抓取全局事件循环、
``start()`` 永久阻塞且没有 stop()，无法随 FastAPI lifespan 优雅启停；整包安装
46MB / 1 万余文件并新增 pycryptodome 等依赖。这里改用已在锁文件里的
``websockets``（同步客户端）自写约 200 行，一个后台线程、可注入、可测试。
"""
from __future__ import annotations

import inspect
import json
import logging
import random
import threading
import time
from typing import Callable
from urllib.parse import parse_qs, urlparse

import httpx

from jarvis.channels.feishu.api import DEFAULT_DOMAIN
from jarvis.channels.feishu.frame import METHOD_CONTROL, METHOD_DATA, Frame, FrameError, ping_frame

log = logging.getLogger(__name__)

ENDPOINT_PATH = "/callback/ws/endpoint"
# 官方 SDK 常量：握手头与错误码
_HS_STATUS, _HS_MSG, _HS_AUTH = "handshake-status", "handshake-msg", "handshake-autherrcode"
_AUTH_FAILED, _FORBIDDEN, _EXCEED_CONN_LIMIT = 514, 403, 1000040350
_RETRYABLE_ENDPOINT_CODES = {1, 1000040343}  # system busy / internal error
FATAL_RETRY_SECONDS = 600  # 凭据/配置类错误：慢速重试，管理员改完后台无需重启服务
FRAGMENT_TTL_SECONDS = 5


class ConnectError(RuntimeError):
    def __init__(self, message: str, *, fatal: bool = False) -> None:
        super().__init__(message)
        self.fatal = fatal


def _default_ws_connect(url: str):
    from websockets.sync.client import connect

    kwargs = {"open_timeout": 15, "max_size": 8 * 1024 * 1024}
    if "proxy" in inspect.signature(connect).parameters:
        kwargs["proxy"] = None  # 与官方 SDK 一致：不走环境代理，直连飞书
    return connect(url, **kwargs)


def _handshake_error(exc: Exception) -> ConnectError | None:
    response = getattr(exc, "response", None)
    headers = getattr(response, "headers", None) or getattr(exc, "headers", None)
    if headers is None:
        return None
    try:
        status = int(headers.get(_HS_STATUS))
    except (TypeError, ValueError):
        return None
    message = str(headers.get(_HS_MSG) or "")[:80]
    if status == _AUTH_FAILED:
        try:
            auth_code = int(headers.get(_HS_AUTH) or 0)
        except (TypeError, ValueError):
            auth_code = 0
        if auth_code == _EXCEED_CONN_LIMIT:
            return ConnectError("长连接数超限（每个应用最多 50 条），请检查是否有其他进程在用同一应用", fatal=True)
        return ConnectError(f"长连接鉴权失败：{message}", fatal=False)
    if status == _FORBIDDEN:
        return ConnectError(f"飞书拒绝建立长连接：{message}", fatal=True)
    return ConnectError(f"长连接握手失败（{status}）：{message}")


class LongConnection:
    """一条长连接 + 一个后台线程；on_event 必须快速返回（只入队）。"""

    def __init__(
        self,
        app_id: str,
        app_secret: str,
        *,
        on_event: Callable[[dict], None],
        on_state: Callable[[str, str], None] | None = None,
        before_connect: Callable[[], None] | None = None,
        domain: str = DEFAULT_DOMAIN,
        client_factory: Callable[[], httpx.Client] | None = None,
        ws_connect: Callable[[str], object] | None = None,
        thread_factory=threading.Thread,
        clock: Callable[[], float] = time.monotonic,
        rng: Callable[[], float] = random.random,
    ) -> None:
        self._app_id = app_id
        self._secret = app_secret
        self._domain = (domain or DEFAULT_DOMAIN).rstrip("/")
        self._on_event = on_event
        self._on_state = on_state or (lambda _state, _error: None)
        self._before_connect = before_connect
        self._client_factory = client_factory or (lambda: httpx.Client(trust_env=False, timeout=15))
        self._ws_connect = ws_connect or _default_ws_connect
        self._thread_factory = thread_factory
        self._clock = clock
        self._rng = rng
        self._stop = threading.Event()
        self._thread = None
        self._session_open = False
        self._fragments: dict[str, tuple[float, list[bytes | None]]] = {}
        # 本地默认值；每次握手及 pong 帧里的 ClientConfig 会覆盖（与官方 SDK 相同）
        self.ping_interval = 120
        self.reconnect_interval = 120
        self.reconnect_nonce = 30

    # ---- 生命周期 ----

    def start(self) -> None:
        if self._thread is not None:
            return
        self._stop.clear()
        self._thread = self._thread_factory(target=self.run_forever, daemon=True, name="jarvis-feishu-ws")
        self._thread.start()

    def stop(self, timeout: float = 5.0) -> None:
        # 不在调用方线程里关连接：close() 要等关闭握手（最长 close_timeout），会拖慢服务停机。
        # 收帧循环每 ≤1 秒检查一次停止信号，由长连接线程自己在 finally 里关闭。
        self._stop.set()
        thread, self._thread = self._thread, None
        if thread is not None and thread is not threading.current_thread():
            join = getattr(thread, "join", None)
            if callable(join):
                join(timeout)

    @property
    def stopped(self) -> bool:
        return self._stop.is_set()

    def run_forever(self) -> None:
        ever_connected = False
        failures = 0  # 连续「连不上」的次数；连上过一次就清零
        while not self._stop.is_set():
            self._session_open = False
            try:
                self._on_state("reconnecting" if ever_connected else "connecting", "")
                if self._before_connect is not None:
                    try:
                        self._before_connect()
                    except Exception as exc:  # 取机器人信息失败不阻断收消息
                        log.warning("feishu before_connect failed: %s", type(exc).__name__)
                self.run_session(self.discover())
                delay = 0.0  # 只有 stop() 会让会话正常返回
            except ConnectError as exc:
                failures += 1
                self._on_state("error", str(exc))
                delay = FATAL_RETRY_SECONDS if exc.fatal else self.reconnect_interval
                log.warning("feishu long connection failed: %s", exc)
            except Exception as exc:
                if self._stop.is_set():  # stop() 主动关连接导致的异常，不算掉线
                    break
                if self._session_open:  # 连上后掉线：与官方 SDK 一样先随机抖动再重连
                    failures = 0
                    self._on_state("reconnecting", "长连接已断开，正在重连")
                    delay = self._rng() * self.reconnect_nonce
                else:
                    failures += 1
                    self._on_state("reconnecting", f"连接飞书失败（{type(exc).__name__}），稍后重试")
                    delay = self._rng() * self.reconnect_nonce if failures == 1 else self.reconnect_interval
                log.warning("feishu long connection dropped: %s", type(exc).__name__)
            ever_connected = ever_connected or self._session_open
            if delay > 0 and not self._stop.is_set():
                self._stop.wait(delay)
        self._on_state("stopped", "")

    # ---- 取连接地址 ----

    def discover(self) -> str:
        client = self._client_factory()
        try:
            try:
                response = client.post(
                    self._domain + ENDPOINT_PATH,
                    json={"AppID": self._app_id, "AppSecret": self._secret},
                    headers={"locale": "zh"},
                    timeout=15,
                )
            except httpx.HTTPError as exc:
                raise ConnectError(f"连不上飞书开放平台（{type(exc).__name__}）") from exc
            if response.status_code != 200:
                raise ConnectError(f"获取长连接地址失败（HTTP {response.status_code}）")
            try:
                payload = response.json()
            except ValueError as exc:
                raise ConnectError("获取长连接地址失败：响应不是 JSON") from exc
        finally:
            client.close()
        code = payload.get("code") if isinstance(payload, dict) else None
        if code != 0:
            message = str(payload.get("msg", ""))[:80] if isinstance(payload, dict) else ""
            raise ConnectError(
                f"飞书拒绝建立长连接（code={code}）：{message}。请检查 FEISHU_APP_ID/FEISHU_APP_SECRET 与应用发布状态",
                fatal=code not in _RETRYABLE_ENDPOINT_CODES,
            )
        data = payload.get("data") or {}
        url = data.get("URL") or data.get("url")
        if not isinstance(url, str) or not url.startswith(("wss://", "ws://")):
            raise ConnectError("获取长连接地址失败：缺少 URL")
        self.configure(data.get("ClientConfig") or {})
        return url

    def configure(self, conf: dict) -> None:
        if not isinstance(conf, dict):
            return
        for key, attr, low, high in (
            ("PingInterval", "ping_interval", 5, 600),
            ("ReconnectInterval", "reconnect_interval", 1, 600),
            ("ReconnectNonce", "reconnect_nonce", 0, 120),
        ):
            value = conf.get(key)
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                setattr(self, attr, min(high, max(low, value)))

    # ---- 一次连接的生命周期 ----

    def run_session(self, url: str) -> None:
        query = parse_qs(urlparse(url).query)
        try:
            service_id = int((query.get("service_id") or ["0"])[0])
        except ValueError:
            service_id = 0
        try:
            conn = self._ws_connect(url)
        except Exception as exc:
            mapped = _handshake_error(exc)
            if mapped is not None:
                raise mapped from exc
            raise
        if self._stop.is_set():  # stop() 与连接建立赛跑：别留下一条孤儿连接
            conn.close()
            return
        self._session_open = True
        self._on_state("connected", "")
        log.info("feishu long connection established: %s", urlparse(url).hostname)
        next_ping = self._clock()
        try:
            while not self._stop.is_set():
                now = self._clock()
                if now >= next_ping:
                    conn.send(ping_frame(service_id).encode())
                    next_ping = now + self.ping_interval
                try:
                    raw = conn.recv(timeout=max(0.05, min(1.0, next_ping - now)))
                except TimeoutError:
                    continue
                if isinstance(raw, str):
                    raw = raw.encode("utf-8")
                self.handle_frame(conn, raw)
        finally:
            try:
                conn.close()
            except Exception:
                pass

    def handle_frame(self, conn, raw: bytes) -> None:
        try:
            frame = Frame.decode(raw)
        except FrameError as exc:
            log.warning("feishu frame decode failed: %s", exc)
            return
        if frame.method == METHOD_CONTROL:
            if frame.header("type") == "pong" and frame.payload:
                try:
                    self.configure(json.loads(frame.payload))
                except ValueError:
                    pass
            return
        if frame.method != METHOD_DATA:
            return
        payload = frame.payload or b""
        try:
            total = int(frame.header("sum", "1") or 1)
            seq = int(frame.header("seq", "0") or 0)
        except ValueError:
            return
        if total > 1:
            combined = self._combine(frame.header("message_id", "") or "", total, seq, payload)
            if combined is None:
                return
            payload = combined
        if frame.header("type") != "event":
            return  # 卡片回调等其他类型本桥不订阅；与官方 SDK 一样不回写
        started = self._clock()
        code = 200
        try:
            event = json.loads(payload)
            if isinstance(event, dict):
                self._on_event(event)
        except ValueError:
            log.warning("feishu event payload is not json")
        except Exception as exc:
            code = 500
            log.warning("feishu event handler crashed: %s", type(exc).__name__)
        frame.headers.append(("biz_rt", str(int((self._clock() - started) * 1000))))
        frame.payload = json.dumps({"code": code}).encode("utf-8")
        conn.send(frame.encode())

    def _combine(self, message_id: str, total: int, seq: int, payload: bytes) -> bytes | None:
        now = self._clock()
        for key in [k for k, (deadline, _) in self._fragments.items() if deadline < now]:
            self._fragments.pop(key, None)
        if not 0 <= seq < total or total > 1024:
            return None
        _deadline, parts = self._fragments.get(message_id, (0.0, [None] * total))
        if len(parts) != total:
            parts = [None] * total
        parts[seq] = payload
        if any(part is None for part in parts):
            self._fragments[message_id] = (now + FRAGMENT_TTL_SECONDS, parts)
            return None
        self._fragments.pop(message_id, None)
        return b"".join(parts)  # type: ignore[arg-type]
