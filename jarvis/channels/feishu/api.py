"""飞书开放平台 HTTP 调用：tenant_access_token 缓存/刷新 + 本桥用到的少数几个接口。

接口与字段均按 open.feishu.cn 官方文档（2026-10 核实）：
- 自建应用取 token：POST /open-apis/auth/v3/tenant_access_token/internal，
  有效期最长 2 小时；剩余 <30 分钟时再调会发新 token。
- 回复消息：POST /open-apis/im/v1/messages/:message_id/reply（单用户/单群 5 QPS）
- 发送消息：POST /open-apis/im/v1/messages?receive_id_type=...
- CardKit 流式卡片：POST /cardkit/v1/cards、PUT .../elements/:element_id/content、
  PATCH .../settings（单卡片 10 次/秒，sequence 必须严格递增）
- 消息资源下载：GET /open-apis/im/v1/messages/:message_id/resources/:file_key?type=image
- 表情回复：POST/DELETE /open-apis/im/v1/messages/:message_id/reactions
- 机器人信息：GET /open-apis/bot/v3/info（取机器人 open_id，用于群聊 @ 判定）
"""
from __future__ import annotations

import json
import logging
import threading
import time
import uuid as uuid_mod
from typing import Any, Callable

import httpx

log = logging.getLogger(__name__)

DEFAULT_DOMAIN = "https://open.feishu.cn"
# 提前刷新余量：比官方 SDK 的 10 分钟更早一点也没坏处，剩余 <30 分钟时平台会发新 token
TOKEN_REFRESH_MARGIN_SECONDS = 10 * 60
# token 失效类错误码（与官方 SDK channel/errors.py 的 _TOKEN_INVALID_CODES 一致，另加 99991661 缺 token）
TOKEN_INVALID_CODES = frozenset({99991661, 99991663, 99991664, 99991665, 99991666, 99991668})
# 缺权限 / 应用无权调用：用于判定「流式卡片不可用」并降级（官方 SDK 的 _PERMISSION_CODES 子集）
PERMISSION_CODES = frozenset({99991672, 99991679, 99991680, 99991681, 230003, 230010, 300311})
MAX_RESOURCE_BYTES = 10 * 1024 * 1024


class FeishuAPIError(RuntimeError):
    """飞书接口返回非 0 code 或网络/协议异常。message 不含 token 或消息内容。"""

    def __init__(self, code: int, msg: str = "", status: int = 0) -> None:
        super().__init__(f"feishu api error code={code} status={status} msg={msg[:120]}")
        self.code = code
        self.msg = msg[:200]
        self.status = status

    @property
    def token_invalid(self) -> bool:
        return self.code in TOKEN_INVALID_CODES

    @property
    def permission_denied(self) -> bool:
        return self.code in PERMISSION_CODES


class FeishuAPI:
    """线程安全的最小客户端；httpx.Client 可注入（测试用 MockTransport）。"""

    def __init__(
        self,
        app_id: str,
        app_secret: str,
        *,
        domain: str = DEFAULT_DOMAIN,
        client: httpx.Client | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.app_id = app_id
        self._secret = app_secret
        self.domain = (domain or DEFAULT_DOMAIN).rstrip("/")
        self._client = client or httpx.Client(trust_env=False, timeout=20)
        self._clock = clock
        self._token_lock = threading.Lock()
        self._token = ""
        self._token_deadline = 0.0

    def close(self) -> None:
        try:
            self._client.close()
        except Exception:
            pass

    # ---- tenant_access_token ----

    def tenant_token(self, *, force: bool = False) -> str:
        with self._token_lock:
            if not force and self._token and self._clock() < self._token_deadline:
                return self._token
            payload = self._post_json(
                "/open-apis/auth/v3/tenant_access_token/internal",
                {"app_id": self.app_id, "app_secret": self._secret},
                auth=False,
            )
            token = payload.get("tenant_access_token")
            if not isinstance(token, str) or not token:
                raise FeishuAPIError(-1, "missing tenant_access_token")
            try:
                expire = int(payload.get("expire", 7200))
            except (TypeError, ValueError):
                expire = 7200
            self._token = token
            self._token_deadline = self._clock() + max(30, expire - TOKEN_REFRESH_MARGIN_SECONDS)
            return token

    def invalidate_token(self) -> None:
        with self._token_lock:
            self._token = ""
            self._token_deadline = 0.0

    # ---- 通用请求 ----

    def _post_json(self, path: str, body: dict, *, auth: bool) -> dict:
        return self._request("POST", path, json_body=body, auth=auth)

    def _send(self, method: str, path: str, *, json_body=None, params=None, auth: bool, token: str = "") -> httpx.Response:
        headers = {"Content-Type": "application/json; charset=utf-8"}
        if auth:
            headers["Authorization"] = f"Bearer {token}"
        try:
            return self._client.request(
                method, self.domain + path, json=json_body, params=params, headers=headers, timeout=20,
            )
        except httpx.HTTPError as exc:
            raise FeishuAPIError(-1, f"network {type(exc).__name__}") from exc

    @staticmethod
    def _decode(response: httpx.Response) -> dict:
        try:
            payload = response.json()
        except ValueError as exc:
            raise FeishuAPIError(-1, "invalid json", response.status_code) from exc
        if not isinstance(payload, dict):
            raise FeishuAPIError(-1, "invalid payload", response.status_code)
        code = payload.get("code", 0)
        if code not in (0, None):
            raise FeishuAPIError(int(code) if isinstance(code, int) else -1,
                                 str(payload.get("msg", "")), response.status_code)
        if response.status_code >= 400:
            raise FeishuAPIError(-1, "http error", response.status_code)
        return payload

    def _request(self, method: str, path: str, *, json_body=None, params=None, auth: bool = True) -> dict:
        """带 token 的请求；token 失效时强制刷新并重试一次。"""
        if not auth:
            return self._decode(self._send(method, path, json_body=json_body, params=params, auth=False))
        for attempt in (0, 1):
            token = self.tenant_token(force=attempt == 1)
            try:
                return self._decode(self._send(method, path, json_body=json_body, params=params, auth=True, token=token))
            except FeishuAPIError as exc:
                if exc.token_invalid and attempt == 0:
                    self.invalidate_token()
                    continue
                raise
        raise FeishuAPIError(-1, "unreachable")  # pragma: no cover

    # ---- 业务接口 ----

    def bot_info(self) -> dict:
        payload = self._request("GET", "/open-apis/bot/v3/info")
        bot = payload.get("bot") or (payload.get("data") or {}).get("bot") or {}
        return bot if isinstance(bot, dict) else {}

    def reply(self, message_id: str, msg_type: str, content: dict, *, in_thread: bool = False) -> str:
        body: dict[str, Any] = {
            "msg_type": msg_type,
            "content": json.dumps(content, ensure_ascii=False),
            "uuid": uuid_mod.uuid4().hex,  # 平台侧 1 小时内同 uuid 只成功一次：网络重试不会重复回复
        }
        if in_thread:
            body["reply_in_thread"] = True
        payload = self._request("POST", f"/open-apis/im/v1/messages/{message_id}/reply", json_body=body)
        return str((payload.get("data") or {}).get("message_id", ""))

    def send(self, receive_id_type: str, receive_id: str, msg_type: str, content: dict) -> str:
        body = {
            "receive_id": receive_id,
            "msg_type": msg_type,
            "content": json.dumps(content, ensure_ascii=False),
            "uuid": uuid_mod.uuid4().hex,
        }
        payload = self._request("POST", "/open-apis/im/v1/messages",
                                json_body=body, params={"receive_id_type": receive_id_type})
        return str((payload.get("data") or {}).get("message_id", ""))

    def create_card(self, card: dict) -> str:
        payload = self._request("POST", "/open-apis/cardkit/v1/cards", json_body={
            "type": "card_json", "data": json.dumps(card, ensure_ascii=False),
        })
        card_id = (payload.get("data") or {}).get("card_id")
        if not card_id:
            raise FeishuAPIError(-1, "missing card_id")
        return str(card_id)

    def update_card_text(self, card_id: str, element_id: str, content: str, sequence: int) -> None:
        self._request("PUT", f"/open-apis/cardkit/v1/cards/{card_id}/elements/{element_id}/content",
                      json_body={"content": content, "sequence": sequence})

    def card_settings(self, card_id: str, settings: dict, sequence: int) -> None:
        self._request("PATCH", f"/open-apis/cardkit/v1/cards/{card_id}/settings", json_body={
            "settings": json.dumps(settings, ensure_ascii=False), "sequence": sequence,
        })

    def add_reaction(self, message_id: str, emoji_type: str) -> str:
        payload = self._request("POST", f"/open-apis/im/v1/messages/{message_id}/reactions",
                                json_body={"reaction_type": {"emoji_type": emoji_type}})
        return str((payload.get("data") or {}).get("reaction_id", ""))

    def delete_reaction(self, message_id: str, reaction_id: str) -> None:
        self._request("DELETE", f"/open-apis/im/v1/messages/{message_id}/reactions/{reaction_id}")

    # ---- 新版文档（流程积木「汇总到飞书文档」用，见 jarvis/flows/feishu_doc.py） ----

    def create_document(self, title: str) -> str:
        payload = self._request("POST", "/open-apis/docx/v1/documents", json_body={"title": title})
        document_id = ((payload.get("data") or {}).get("document") or {}).get("document_id")
        if not document_id:
            raise FeishuAPIError(-1, "missing document_id")
        return str(document_id)

    def append_blocks(self, document_id: str, children: list[dict]) -> None:
        """追加到文档末尾；根块 id 即文档 id。单次 ≤50 块。"""
        self._request("POST", f"/open-apis/docx/v1/documents/{document_id}/blocks/{document_id}/children",
                      json_body={"children": children, "index": -1}, params={"document_revision_id": -1})

    def add_doc_member(self, document_id: str, open_id: str, perm: str = "full_access") -> None:
        self._request("POST", f"/open-apis/drive/v1/permissions/{document_id}/members",
                      json_body={"member_type": "openid", "member_id": open_id, "perm": perm},
                      params={"type": "docx", "need_notification": "false"})

    def doc_url(self, document_id: str) -> str:
        """文档链接：优先用元数据接口给的租户域名链接，取不到就拼通用链接（会跳到租户域名）。"""
        try:
            payload = self._request("POST", "/open-apis/drive/v1/metas/batch_query", json_body={
                "request_docs": [{"doc_token": document_id, "doc_type": "docx"}], "with_url": True})
            metas = (payload.get("data") or {}).get("metas") or []
            url = str(metas[0].get("url", "")) if metas and isinstance(metas[0], dict) else ""
        except FeishuAPIError:
            url = ""
        if url.startswith("https://"):
            return url
        web = "https://www.larksuite.com" if "larksuite" in self.domain else "https://www.feishu.cn"
        return f"{web}/docx/{document_id}"

    def download_resource(self, message_id: str, file_key: str, kind: str = "image") -> tuple[bytes, str]:
        """下载消息里的图片/文件；成功时响应是二进制流，失败时是 JSON 错误体。"""
        for attempt in (0, 1):
            token = self.tenant_token(force=attempt == 1)
            response = self._send("GET", f"/open-apis/im/v1/messages/{message_id}/resources/{file_key}",
                                  params={"type": kind}, auth=True, token=token)
            ctype = response.headers.get("content-type", "").split(";")[0].strip().lower()
            if response.status_code == 200 and ctype != "application/json":
                data = response.content
                if len(data) > MAX_RESOURCE_BYTES:
                    raise FeishuAPIError(-1, "resource too large", response.status_code)
                return data, ctype
            try:
                self._decode(response)
            except FeishuAPIError as exc:
                if exc.token_invalid and attempt == 0:
                    self.invalidate_token()
                    continue
                raise
            raise FeishuAPIError(-1, "unexpected resource response", response.status_code)
        raise FeishuAPIError(-1, "unreachable")  # pragma: no cover
