"""服务端个人微信桥：iLink 扫码登录、凭据恢复与消息长轮询。"""
from __future__ import annotations

import base64
import json
import logging
import random
import threading
import time
import uuid
from pathlib import Path
from typing import Callable

import httpx
import segno

from jarvis import config

ILINK = "https://ilinkai.weixin.qq.com/ilink/bot"
ILINK_CHANNEL_VERSION = "2.4.6"
ILINK_APP_ID = "bot"
ILINK_APP_CLIENT_VERSION = str((2 << 16) | (4 << 8) | 6)
QR_EXPIRES_SECONDS = 180
REPLY_CHUNK_SIZE = 1500
# 必须低于 iLink 心跳帧间隔（实测约 18 秒）：心跳字节会不断重置 read 超时，
# 僵死会话（连接活、心跳在发、但响应永不完成也不派消息）在更长的超时下
# 永远不会被翻新，表现为「状态已连接却收不到任何消息」（2026-08-12 线上）。
UPDATES_READ_TIMEOUT_SECONDS = 15

log = logging.getLogger(__name__)


class WeChatBridge:
    """一套进程内桥接状态机；网络和线程边界可注入以便确定性测试。"""

    def __init__(
        self,
        agent_getter=None,
        chunk_text=None,
        owner_getter=None,
        data_dir_getter: Callable[[], Path] | None = None,
        client_factory=None,
        thread_factory=None,
        sleeper=None,
    ):
        self._agent_getter = agent_getter
        self._chunk_text = chunk_text
        self._owner_getter = owner_getter
        self._data_dir_getter = data_dir_getter or config.data_dir
        self._client_factory = client_factory or (
            lambda: httpx.Client(trust_env=False)
        )
        self._thread_factory = thread_factory or threading.Thread
        self._sleep = sleeper or time.sleep
        self._lock = threading.RLock()
        self._state = {
            "state": "idle",
            "qr_uri": "",
            "error": "",
            "since": "",
        }
        self._generation = 0
        self._updates_stop = threading.Event()
        self._updates_thread = None

    def configure(self, agent_getter, chunk_text, owner_getter=None) -> None:
        """由 Web 服务注入 Agent 与消息文本转换器。"""
        with self._lock:
            self._agent_getter = agent_getter
            self._chunk_text = chunk_text
            self._owner_getter = owner_getter

    def _token_path(self) -> Path:
        data_dir = self._data_dir_getter()
        data_dir.mkdir(parents=True, exist_ok=True)
        return data_dir / "wechat_token"

    def _sync_path(self) -> Path:
        data_dir = self._data_dir_getter()
        data_dir.mkdir(parents=True, exist_ok=True)
        return data_dir / "wechat_sync.json"

    def _load_sync_buf(self) -> str:
        try:
            payload = json.loads(self._sync_path().read_text(encoding="utf-8"))
            value = payload.get("get_updates_buf", "")
            return value if isinstance(value, str) else ""
        except (OSError, TypeError, ValueError):
            return ""

    def _save_sync_buf(self, value: str) -> None:
        if not value:
            return
        path = self._sync_path()
        pending = path.with_suffix(".tmp")
        pending.write_text(
            json.dumps({"get_updates_buf": value}, ensure_ascii=False),
            encoding="utf-8",
        )
        pending.chmod(0o600)
        pending.replace(path)
        path.chmod(0o600)

    def _clear_sync_buf(self) -> None:
        self._sync_path().unlink(missing_ok=True)

    @staticmethod
    def _base_info() -> dict:
        return {
            "channel_version": ILINK_CHANNEL_VERSION,
            "bot_agent": "JWS-Agent",
        }

    @staticmethod
    def _headers(token: str) -> dict:
        return {
            "Content-Type": "application/json",
            "AuthorizationType": "ilink_bot_token",
            "iLink-App-Id": ILINK_APP_ID,
            "iLink-App-ClientVersion": ILINK_APP_CLIENT_VERSION,
            "X-WECHAT-UIN": base64.b64encode(
                str(random.randint(1, 2**32 - 1)).encode()
            ).decode(),
            "Authorization": f"Bearer {token}",
        }

    def status(self) -> dict:
        with self._lock:
            return dict(self._state)

    def _set(self, **changes) -> None:
        with self._lock:
            self._state.update(changes)

    def _set_for_generation(self, generation: int, **changes) -> bool:
        with self._lock:
            if generation != self._generation:
                return False
            self._state.update(changes)
            return True

    def connect(self) -> dict:
        """获取一个二维码；正在连接或已在线时保持幂等。"""
        with self._lock:
            if self._state["state"] in {"loading", "waiting", "connected"}:
                return dict(self._state)
            self._generation += 1
            generation = self._generation
            self._state.update(
                state="loading", qr_uri="", error="", since=""
            )

        client = None
        try:
            client = self._client_factory()
            response = client.get(
                f"{ILINK}/get_bot_qrcode",
                params={"bot_type": 3},
                timeout=15,
            )
            response.raise_for_status()
            payload = response.json()
            if not isinstance(payload, dict) or payload.get("ret") not in (None, 0):
                raise ValueError("unexpected response")
            qrcode = payload.get("qrcode")
            scan_url = payload.get("qrcode_img_content")
            if not isinstance(qrcode, str) or not qrcode:
                raise ValueError("missing qrcode")
            if not isinstance(scan_url, str) or not scan_url:
                raise ValueError("missing qrcode image content")
            qr_uri = segno.make(scan_url).svg_data_uri(scale=4, border=2)

            with self._lock:
                if generation != self._generation:
                    return dict(self._state)
                self._state.update(
                    state="waiting",
                    qr_uri=qr_uri,
                    error="",
                    since=time.strftime("%H:%M:%S"),
                )
                worker = self._thread_factory(
                    target=self._poll_qrcode,
                    args=(generation, qrcode),
                    daemon=True,
                    name="jarvis-wechat-qr",
                )
                worker.start()
                return dict(self._state)
        except (KeyError, TypeError, ValueError):
            self._set_for_generation(
                generation,
                state="error",
                qr_uri="",
                error="取二维码失败：iLink 响应异常，请重试",
                since="",
            )
            return self.status()
        except (httpx.HTTPError, OSError) as exc:
            log.warning("iLink QR request failed: %s", type(exc).__name__)
            self._set_for_generation(
                generation,
                state="error",
                qr_uri="",
                error="取二维码失败：网络异常，请重试",
                since="",
            )
            return self.status()
        except Exception as exc:
            log.exception("Unexpected iLink QR error: %s", type(exc).__name__)
            self._set_for_generation(
                generation,
                state="error",
                qr_uri="",
                error="取二维码失败：服务异常，请重试",
                since="",
            )
            return self.status()
        finally:
            if client is not None:
                client.close()

    def _poll_qrcode(self, generation: int, qrcode: str) -> None:
        """轮询本代二维码；旧代次永远不能覆盖新状态。"""
        client = self._client_factory()
        deadline = time.monotonic() + QR_EXPIRES_SECONDS
        try:
            while time.monotonic() < deadline:
                with self._lock:
                    if (
                        generation != self._generation
                        or self._state["state"] != "waiting"
                    ):
                        return
                try:
                    response = client.get(
                        f"{ILINK}/get_qrcode_status",
                        params={"qrcode": qrcode},
                        timeout=35,
                    )
                    response.raise_for_status()
                    payload = response.json()
                    if not isinstance(payload, dict):
                        raise ValueError("invalid QR status")
                    if payload.get("status") == "confirmed":
                        token = payload.get("bot_token")
                        if not isinstance(token, str) or not token:
                            raise ValueError("missing bot token")
                        self._confirm_login(generation, token)
                        return
                    if payload.get("status") in {"expired", "cancelled"}:
                        self._set_for_generation(
                            generation,
                            state="idle",
                            qr_uri="",
                            error="二维码已失效，请重新生成",
                            since="",
                        )
                        return
                except (httpx.HTTPError, TypeError, ValueError):
                    # 状态接口本身可能长轮询超时；下一轮继续等扫码确认。
                    pass
                self._sleep(1)

            self._set_for_generation(
                generation,
                state="idle",
                qr_uri="",
                error="二维码超时，请重新生成",
                since="",
            )
        finally:
            client.close()

    def _confirm_login(self, generation: int, token: str) -> bool:
        """只允许当前二维码代次写凭据并取得消息轮询所有权。"""
        with self._lock:
            if generation != self._generation:
                return False
            path = self._token_path()
            self._clear_sync_buf()
            path.write_text(token, encoding="utf-8")
            path.chmod(0o600)
            self._state.update(
                state="connected", qr_uri="", error="", since=""
            )
            self._start_updates_locked(generation, token)
            return True

    def _start_updates_locked(self, generation: int, token: str) -> None:
        self._updates_stop.set()
        stop = threading.Event()
        self._updates_stop = stop
        worker = self._thread_factory(
            target=self._updates_loop,
            args=(generation, token, stop),
            daemon=True,
            name="jarvis-wechat-updates",
        )
        self._updates_thread = worker
        worker.start()

    def _reply(self, text: str, from_id: str) -> str:
        if not self._agent_getter or not self._chunk_text or not self._owner_getter:
            return "贾维斯尚未就绪。"
        owner = self._owner_getter()
        if owner is None:
            return "贾维斯账号未就绪。"
        contact = from_id.split("@", 1)[0]
        alias = "wx-" + contact[-12:]
        from jarvis.graph import heal_dangling_tool_calls
        from jarvis.tenancy import TenantStore, tenant_scope

        with tenant_scope(owner.user_id):
            store = TenantStore()
            store.migrate_legacy()
            thread = store.upsert_thread(alias, text)
            heal_dangling_tool_calls(self._agent_getter(), thread.checkpoint_thread_id)
            result = self._agent_getter().invoke(
                {"messages": [{"role": "user", "content": text}]},
                config={"configurable": {"thread_id": thread.checkpoint_thread_id}},
            )
        return self._chunk_text(result["messages"][-1].content)

    @staticmethod
    def _text_of(message: dict) -> str:
        for item in message.get("item_list", []):
            if isinstance(item, dict) and item.get("type") == 1:
                text_item = item.get("text_item", {})
                if isinstance(text_item, dict):
                    text = text_item.get("text", "")
                    return text if isinstance(text, str) else ""
        return ""

    @staticmethod
    def _split_reply(text: str, limit: int = REPLY_CHUNK_SIZE) -> list[str]:
        text = text.strip()
        if not text:
            return ["（贾维斯没有生成文本回复。）"]
        return [text[index:index + limit] for index in range(0, len(text), limit)]

    def _handle_updates_response(
        self, client, token: str, payload: dict
    ) -> str:
        """处理一次 getupdates 数据并返回下一轮 buffer。"""
        if not isinstance(payload, dict):
            raise ValueError("invalid updates response")
        next_buf = payload.get("get_updates_buf", "")
        if not isinstance(next_buf, str):
            next_buf = ""
        self._save_sync_buf(next_buf)
        messages = payload.get("msgs", [])
        if not isinstance(messages, list):
            raise ValueError("invalid messages")

        for message in messages:
            if not isinstance(message, dict) or message.get("message_type") != 1:
                continue
            from_id = message.get("from_user_id", "")
            if not isinstance(from_id, str) or not from_id:
                continue
            if "@im.chatroom" in from_id or "group" in from_id.lower():
                continue
            text = self._text_of(message).strip()
            if not text:
                continue
            try:
                answer = self._reply(text, from_id)
            except Exception as exc:
                log.warning("JARVIS WeChat reply failed: %s", type(exc).__name__)
                answer = f"（贾维斯暂时无法应答：{type(exc).__name__}）"

            context_token = message.get("context_token", "")
            for chunk in self._split_reply(answer):
                try:
                    response = client.post(
                        f"{ILINK}/sendmessage",
                        headers=self._headers(token),
                        timeout=20,
                        json={
                            "msg": {
                                "from_user_id": "",
                                "to_user_id": from_id,
                                "client_id": f"jws-agent:{uuid.uuid4().hex}",
                                "message_type": 2,
                                "message_state": 2,
                                "context_token": context_token,
                                "item_list": [
                                    {"type": 1, "text_item": {"text": chunk}}
                                ],
                            },
                            "base_info": self._base_info(),
                        },
                    )
                    response.raise_for_status()
                    sent_payload = response.json()
                    if (
                        isinstance(sent_payload, dict)
                        and sent_payload.get("ret") not in (None, 0)
                    ):
                        raise ValueError("send rejected")
                except (httpx.HTTPError, TypeError, ValueError) as exc:
                    log.warning(
                        "iLink sendmessage failed for %s: %s",
                        from_id[:16],
                        type(exc).__name__,
                    )
        return next_buf

    def _updates_loop(
        self, generation: int, token: str, stop: threading.Event
    ) -> None:
        client = self._client_factory()
        buffer = self._load_sync_buf()
        try:
            while not stop.is_set():
                with self._lock:
                    if (
                        generation != self._generation
                        or self._state["state"] != "connected"
                    ):
                        return
                try:
                    response = client.post(
                        f"{ILINK}/getupdates",
                        headers=self._headers(token),
                        timeout=httpx.Timeout(45, read=UPDATES_READ_TIMEOUT_SECONDS),
                        json={
                            "get_updates_buf": buffer,
                            "base_info": self._base_info(),
                        },
                    )
                    if response.status_code == 401:
                        self._handle_unauthorized(generation)
                        return
                    response.raise_for_status()
                    payload = response.json()
                    ret = payload.get("ret", 0) if isinstance(payload, dict) else 0
                    errcode = payload.get("errcode", 0) if isinstance(payload, dict) else 0
                    errmsg = payload.get("errmsg", "") if isinstance(payload, dict) else ""
                    expired = ret == -14 or errcode == -14 or (
                        (ret == -2 or errcode == -2)
                        and str(errmsg).lower() == "unknown error"
                    )
                    if expired:
                        self._handle_unauthorized(generation)
                        return
                    if ret not in (None, 0) or errcode not in (None, 0):
                        raise ValueError("iLink API rejected getupdates")
                    buffer = self._handle_updates_response(
                        client, token, payload
                    )
                except httpx.TimeoutException:
                    # 空转长轮询到期是正常节奏：不告警、不退避，立即翻新请求。
                    continue
                except (httpx.HTTPError, TypeError, ValueError) as exc:
                    log.warning("iLink getupdates retry: %s", type(exc).__name__)
                    stop.wait(2)
        finally:
            client.close()

    def _handle_unauthorized(self, generation: int) -> None:
        with self._lock:
            if generation != self._generation:
                return
            self._updates_stop.set()
            self._updates_thread = None
            self._token_path().unlink(missing_ok=True)
            self._clear_sync_buf()
            self._state.update(
                state="idle",
                qr_uri="",
                error="微信登录态失效，请重新扫码",
                since="",
            )

    def disconnect(self) -> dict:
        """停止当前所有后台任务并删除微信凭据。"""
        with self._lock:
            self._generation += 1
            self._updates_stop.set()
            self._updates_thread = None
            self._token_path().unlink(missing_ok=True)
            self._clear_sync_buf()
            self._state.update(
                state="idle", qr_uri="", error="", since=""
            )
            return dict(self._state)

    def resume_on_boot(self) -> dict:
        """服务启动时复用保存的 Token，并取得消息轮询所有权。"""
        # Token ownership is fixed to the one active Owner.  Do this check before
        # opening the credential file so an ambiguous account set cannot inspect it.
        try:
            owner = self._owner_getter() if self._owner_getter else None
        except Exception:
            owner = None
        if owner is None:
            return self.status()
        path = self._token_path()
        if not path.exists():
            return self.status()
        token = path.read_text(encoding="utf-8").strip()
        if not token:
            path.unlink(missing_ok=True)
            return self.status()
        with self._lock:
            if self._state["state"] == "connected":
                return dict(self._state)
            self._generation += 1
            generation = self._generation
            self._state.update(
                state="connected", qr_uri="", error="", since=""
            )
            self._start_updates_locked(generation, token)
            return dict(self._state)

    def shutdown(self) -> None:
        """停止线程但保留 Token，供下一次服务启动恢复。"""
        with self._lock:
            self._generation += 1
            self._updates_stop.set()
            self._updates_thread = None
            self._state.update(
                state="idle", qr_uri="", error="", since=""
            )


_bridge = WeChatBridge()


def init(agent_getter, chunk_text, owner_getter=None) -> None:
    _bridge.configure(agent_getter, chunk_text, owner_getter)


def status() -> dict:
    return _bridge.status()


def connect() -> dict:
    return _bridge.connect()


def disconnect() -> dict:
    return _bridge.disconnect()


def resume_on_boot() -> dict:
    return _bridge.resume_on_boot()


def shutdown() -> None:
    _bridge.shutdown()
