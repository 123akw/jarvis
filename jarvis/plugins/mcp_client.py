"""最小 MCP 客户端（第十五轮，契约见 docs/proposals/2026-10-round15-market.md 第 2 节）。

只做贾维斯用得到的客户端子集：``initialize`` → ``notifications/initialized`` → ``tools/list``（翻页）
→ ``tools/call``，会话结束时 ``DELETE``。传输：

- ``streamable-http``（MCP 2025-03-26 起的标准远程传输）：每条请求一次 POST，响应是 JSON 或一段 SSE；
  服务器给的 ``Mcp-Session-Id`` 之后每次带上；会话过期（404）由调用方重建；
- ``sse``（2024-11-05 的老式远程传输）：GET 一条长连接收消息，第一条 ``endpoint`` 事件给出 POST 地址；
- 本地 ``stdio`` 一律不支持（服务器上没有 node / uvx，也不该在服务器上跑第三方命令）。

为什么不用官方 ``mcp`` 包：它 2.x 依赖 httpx2 / opentelemetry / jsonschema（rpds-py 编译扩展）/ pyjwt 等一串新包，
1.x 已转维护线，langchain-mcp-adapters 又锁在 ``mcp<2``；而且它只有 async 接口，要在工具线程里另起事件循环。
我们只要上面四个方法，用现成的同步 httpx 写三百行更好控：限时、限大小、不跟随跨站跳转、不走系统代理。

所有失败都抛 :class:`McpError`，message 是给人看的中文（不含密钥、不含完整 URL 查询串）。
"""
from __future__ import annotations

import ipaddress
import itertools
import json
import logging
import queue
import threading
import time
from urllib.parse import urljoin, urlsplit

import httpx

log = logging.getLogger(__name__)

PROTOCOL_VERSION = "2025-06-18"
CLIENT_INFO = {"name": "JWS-Agent", "title": "贾维斯", "version": "15"}
DEFAULT_TIMEOUT = 30.0
CONNECT_TIMEOUT = 8.0
MAX_RESPONSE_BYTES = 4 * 1024 * 1024
MAX_TOOLS = 64
MAX_PAGES = 10
MAX_REDIRECTS = 3
TRANSPORTS = ("streamable-http", "sse")
_BLOCKED_HOSTS = {"metadata.google.internal", "metadata", "169.254.169.254", "100.100.100.200"}


class McpError(Exception):
    """MCP 调用失败；message 给人看，code 给程序分支用。"""

    def __init__(self, message: str, code: str = "MCP_ERROR"):
        super().__init__(message)
        self.message, self.code = message, code


class SessionExpired(McpError):
    def __init__(self):
        super().__init__("MCP 会话已过期", "SESSION_EXPIRED")


def host_of(url: str) -> str:
    try:
        return (urlsplit(url).hostname or "").lower()
    except ValueError:
        return ""


def display_url(url: str) -> str:
    """给人看的地址：scheme://host[:port]/path，查询串只留「?…」（里面常有 Key）。"""
    try:
        parts = urlsplit(url)
    except ValueError:
        return ""
    port = f":{parts.port}" if parts.port else ""
    return f"{parts.scheme}://{parts.hostname or ''}{port}{parts.path}" + ("?…" if parts.query else "")


def check_url(url: str) -> str:
    """服务地址的基本检查：http(s)、有主机名、不带账号密码、不指向云厂商元数据地址。"""
    text = str(url or "").strip()
    if not text or len(text) > 1000:
        raise McpError("服务地址不能为空，也不能太长", "BAD_URL")
    try:
        parts = urlsplit(text)
        parts.port  # noqa: B018  端口写错会在这里抛 ValueError
    except ValueError:
        raise McpError("服务地址写法不对", "BAD_URL") from None
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise McpError("服务地址要以 https:// 开头（本地 stdio 服务不支持）", "BAD_URL")
    if parts.username or parts.password:
        raise McpError("服务地址里不要带账号密码，请改用请求头", "BAD_URL")
    host = parts.hostname.lower()
    if host in _BLOCKED_HOSTS:
        raise McpError("这个地址不能连接", "BAD_URL")
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        address = None
    if address is not None and (address.is_link_local or address.is_multicast or address.is_unspecified):
        raise McpError("这个地址不能连接", "BAD_URL")
    return text


def _same_origin(a: str, b: str) -> bool:
    pa, pb = urlsplit(a), urlsplit(b)
    return (pa.scheme, pa.hostname, pa.port) == (pb.scheme, pb.hostname, pb.port)


def _status_error(status: int) -> McpError:
    if status in (401, 403):
        return McpError(f"MCP 服务拒绝了访问（{status}），多半是 Key 不对、过期或没有开通", "AUTH")
    if status == 404:
        return McpError("MCP 服务地址不对（404），检查一下地址", "NOT_FOUND")
    if status == 405:
        return McpError("这个地址不接受 MCP 请求（405），确认填的是 MCP 服务地址", "BAD_URL")
    if status == 429:
        return McpError("MCP 服务说请求太频繁了（429），稍后再试", "RATE_LIMIT")
    if status >= 500:
        return McpError(f"MCP 服务自己出错了（{status}），稍后再试", "UPSTREAM")
    return McpError(f"MCP 服务返回错误（{status}）", "UPSTREAM")


def _network_error(exc: Exception) -> McpError:
    if isinstance(exc, httpx.ConnectTimeout):
        return McpError("连接 MCP 服务超时", "TIMEOUT")
    if isinstance(exc, httpx.TimeoutException):
        return McpError("MCP 服务响应超时", "TIMEOUT")
    if isinstance(exc, httpx.ConnectError):
        return McpError("连不上 MCP 服务（网络不通或地址不对）", "CONNECT")
    return McpError("和 MCP 服务通信时网络出错", "NETWORK")


def _rpc_error(error) -> McpError:
    if not isinstance(error, dict):
        return McpError("MCP 服务返回了看不懂的错误", "RPC")
    message = " ".join(str(error.get("message") or "").split())[:200]
    code = error.get("code")
    if code == -32601:
        return McpError("MCP 服务不支持这个操作", "RPC")
    if code == -32602:
        return McpError(f"参数不对：{message}" if message else "参数不对", "INVALID_PARAMS")
    return McpError(f"MCP 服务报错：{message}" if message else "MCP 服务报错", "RPC")


# ---------- SSE 解析 ----------

def iter_sse(lines, *, deadline: float | None = None):
    """把一行行文本解析成 (event, data)。``deadline`` 到了就抛超时。"""
    event, data = "", []
    for line in lines:
        if deadline is not None and time.monotonic() > deadline:
            raise McpError("等待 MCP 服务的回复超时", "TIMEOUT")
        if line == "":
            if data:
                yield event or "message", "\n".join(data)
            event, data = "", []
            continue
        if line.startswith(":"):
            continue
        field, _, value = line.partition(":")
        value = value[1:] if value.startswith(" ") else value
        if field == "event":
            event = value
        elif field == "data":
            data.append(value)
    if data:
        yield event or "message", "\n".join(data)


def _limited_lines(response: httpx.Response, limit: int = MAX_RESPONSE_BYTES):
    size = 0
    for line in response.iter_lines():
        size += len(line) + 1
        if size > limit:
            raise McpError("MCP 服务返回的内容太大了", "TOO_LARGE")
        yield line


def _read_body(response: httpx.Response, limit: int = MAX_RESPONSE_BYTES) -> bytes:
    chunks, size = [], 0
    for chunk in response.iter_bytes():
        size += len(chunk)
        if size > limit:
            raise McpError("MCP 服务返回的内容太大了", "TOO_LARGE")
        chunks.append(chunk)
    return b"".join(chunks)


# ---------- 会话 ----------

class McpSession:
    """一个 MCP 服务的客户端会话（线程安全：并发调用各发各的 POST）。"""

    def __init__(self, url: str, *, transport: str = "streamable-http", headers: dict | None = None,
                 timeout: float = DEFAULT_TIMEOUT, label: str = ""):
        if transport not in TRANSPORTS:
            raise McpError("只支持远程 streamable-http / sse 服务，本地 stdio 服务不支持", "UNSUPPORTED")
        self.url = check_url(url)
        self.transport = transport
        self.headers = {str(k): str(v) for k, v in (headers or {}).items()}
        for key, value in self.headers.items():
            if "\n" in key or "\r" in key or "\n" in value or "\r" in value:
                raise McpError("请求头里不能有换行", "BAD_HEADER")
        self.timeout = float(timeout)
        self.label = label or host_of(url)
        self.session_id = ""
        self.protocol_version = ""
        self.server_info: dict = {}
        self.instructions = ""
        self.initialized = False
        self.closed = False
        self._ids = itertools.count(1)
        self._init_lock = threading.Lock()
        self._client = httpx.Client(timeout=httpx.Timeout(self.timeout, connect=CONNECT_TIMEOUT),
                                    follow_redirects=False, trust_env=False,
                                    headers={"User-Agent": "JWS-Agent-MCP/15"})
        # 老式 sse 传输
        self._sse_endpoint = ""
        self._sse_thread: threading.Thread | None = None
        self._sse_response = None
        self._sse_waiters: dict = {}
        self._sse_lock = threading.Lock()
        self._sse_error: McpError | None = None

    # ---- 对外 ----

    def initialize(self, deadline: float | None = None) -> dict:
        with self._init_lock:
            if self.initialized:
                return self.server_info
            deadline = deadline or time.monotonic() + self.timeout
            if self.transport == "sse":
                self._sse_open(deadline)
            result = self._request("initialize", {
                "protocolVersion": PROTOCOL_VERSION, "capabilities": {}, "clientInfo": dict(CLIENT_INFO),
            }, deadline=deadline, initializing=True)
            if not isinstance(result, dict):
                raise McpError("MCP 服务的握手回复不对", "PROTOCOL")
            self.protocol_version = str(result.get("protocolVersion") or PROTOCOL_VERSION)[:20]
            info = result.get("serverInfo")
            self.server_info = {k: str(info.get(k))[:80] for k in ("name", "title", "version") if isinstance(info, dict) and info.get(k)}
            self.instructions = str(result.get("instructions") or "")[:2000]
            self._notify("notifications/initialized", deadline=deadline)
            self.initialized = True
            return self.server_info

    def list_tools(self, deadline: float | None = None) -> list[dict]:
        deadline = deadline or time.monotonic() + self.timeout
        self.initialize(deadline)
        tools, cursor = [], None
        for _ in range(MAX_PAGES):
            result = self._request("tools/list", {"cursor": cursor} if cursor else {}, deadline=deadline)
            page = result.get("tools") if isinstance(result, dict) else None
            if not isinstance(page, list):
                raise McpError("MCP 服务的工具清单格式不对", "PROTOCOL")
            tools.extend(item for item in page if isinstance(item, dict) and isinstance(item.get("name"), str))
            cursor = result.get("nextCursor")
            if not cursor or len(tools) >= MAX_TOOLS:
                break
        return tools[:MAX_TOOLS]

    def call_tool(self, name: str, arguments: dict, deadline: float | None = None) -> dict:
        deadline = deadline or time.monotonic() + self.timeout
        self.initialize(deadline)
        result = self._request("tools/call", {"name": name, "arguments": arguments or {}}, deadline=deadline)
        if not isinstance(result, dict):
            raise McpError("MCP 服务的回复格式不对", "PROTOCOL")
        return result

    def close(self) -> None:
        if self.closed:
            return
        self.closed = True
        if self.transport == "streamable-http" and self.session_id:
            try:
                self._client.delete(self.url, headers=self._headers(), timeout=3.0)
            except Exception:
                pass
        response = self._sse_response
        if response is not None:
            try:
                response.close()
            except Exception:
                pass
        try:
            self._client.close()
        except Exception:
            pass

    # ---- JSON-RPC ----

    def _headers(self, *, initializing: bool = False) -> dict:
        headers = dict(self.headers)
        headers["Accept"] = "application/json, text/event-stream"
        headers["Content-Type"] = "application/json"
        if self.session_id:
            headers["Mcp-Session-Id"] = self.session_id
        if self.protocol_version and not initializing:
            headers["MCP-Protocol-Version"] = self.protocol_version
        return headers

    def _remaining(self, deadline: float) -> float:
        left = deadline - time.monotonic()
        if left <= 0:
            raise McpError("等待 MCP 服务的回复超时", "TIMEOUT")
        return left

    def _request(self, method: str, params: dict, *, deadline: float, initializing: bool = False):
        request_id = next(self._ids)
        message = {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params}
        if self.transport == "sse":
            reply = self._sse_request(message, deadline)
        else:
            reply = self._post(message, deadline, expect_id=request_id, initializing=initializing)
        if "error" in reply:
            raise _rpc_error(reply["error"])
        return reply.get("result")

    def _notify(self, method: str, *, deadline: float) -> None:
        message = {"jsonrpc": "2.0", "method": method}
        try:
            if self.transport == "sse":
                self._sse_post(message, deadline)
            else:
                self._post(message, deadline, expect_id=None)
        except McpError as exc:
            log.info("mcp notify %s failed: %s", method, exc.code)

    def _post(self, message: dict, deadline: float, *, expect_id, initializing: bool = False) -> dict:
        url = self.url
        for _ in range(MAX_REDIRECTS + 1):
            timeout = httpx.Timeout(min(self.timeout, self._remaining(deadline)), connect=CONNECT_TIMEOUT)
            try:
                with self._client.stream("POST", url, json=message, headers=self._headers(initializing=initializing),
                                         timeout=timeout) as response:
                    if response.status_code in (301, 302, 303, 307, 308):
                        target = urljoin(url, response.headers.get("location", ""))
                        if not _same_origin(url, target):
                            raise McpError(f"服务地址跳转到了别的网站（{host_of(target)}），请直接填写那个地址", "REDIRECT")
                        url = self.url = target
                        continue
                    return self._handle(response, deadline, expect_id, initializing=initializing)
            except McpError:
                raise
            except httpx.HTTPError as exc:
                raise _network_error(exc) from None
        raise McpError("服务地址跳转次数太多", "REDIRECT")

    def _handle(self, response: httpx.Response, deadline: float, expect_id, *, initializing: bool) -> dict:
        status = response.status_code
        if status == 404 and self.session_id and not initializing:
            raise SessionExpired()
        if status >= 400:
            raise _status_error(status)
        if initializing:
            session = response.headers.get("mcp-session-id", "")
            if session:
                if len(session) > 200 or any(ord(ch) < 0x21 or ord(ch) > 0x7E for ch in session):
                    raise McpError("MCP 服务给的会话号不合法", "PROTOCOL")
                self.session_id = session
        if expect_id is None:
            return {}
        if status == 202:
            raise McpError("MCP 服务没有返回结果", "PROTOCOL")
        ctype = response.headers.get("content-type", "").split(";")[0].strip().lower()
        if ctype == "text/event-stream":
            for _event, data in iter_sse(_limited_lines(response), deadline=deadline):
                try:
                    payload = json.loads(data)
                except ValueError:
                    continue
                for item in payload if isinstance(payload, list) else [payload]:
                    found = self._dispatch(item, expect_id)
                    if found is not None:
                        return found
            raise McpError("MCP 服务没把结果发完就断开了", "PROTOCOL")
        body = _read_body(response)
        try:
            payload = json.loads(body)
        except ValueError:
            raise McpError("MCP 服务返回的不是 JSON（确认填的是 MCP 服务地址）", "PROTOCOL") from None
        for item in payload if isinstance(payload, list) else [payload]:
            found = self._dispatch(item, expect_id)
            if found is not None:
                return found
        raise McpError("MCP 服务的回复里没有这次请求的结果", "PROTOCOL")

    def _dispatch(self, item, expect_id) -> dict | None:
        """一条服务器消息：是本次请求的回复就返回；服务器发来的请求（ping 等）顺手答复；通知忽略。"""
        if not isinstance(item, dict):
            return None
        if "method" in item:
            if "id" in item:
                self._answer_server_request(item)
            return None
        if item.get("id") == expect_id and ("result" in item or "error" in item):
            return item
        return None

    def _answer_server_request(self, item: dict) -> None:
        if item.get("method") == "ping":
            reply = {"jsonrpc": "2.0", "id": item["id"], "result": {}}
        else:   # 采样、征询、roots……贾维斯都不提供
            reply = {"jsonrpc": "2.0", "id": item["id"], "error": {"code": -32601, "message": "Method not found"}}

        def send():
            try:
                if self.transport == "sse":
                    self._sse_post(reply, time.monotonic() + 5)
                else:
                    self._client.post(self.url, json=reply, headers=self._headers(), timeout=5.0)
            except Exception:
                pass
        threading.Thread(target=send, daemon=True, name="jarvis-mcp-reply").start()

    # ---- 老式 SSE 传输 ----

    def _sse_open(self, deadline: float) -> None:
        ready = threading.Event()
        headers = {k: v for k, v in self.headers.items()}
        headers["Accept"] = "text/event-stream"

        def reader():
            try:
                timeout = httpx.Timeout(None, connect=CONNECT_TIMEOUT, read=300.0)
                with self._client.stream("GET", self.url, headers=headers, timeout=timeout) as response:
                    self._sse_response = response
                    if response.status_code >= 400:
                        raise _status_error(response.status_code)
                    for event, data in iter_sse(response.iter_lines()):
                        if self.closed:
                            return
                        if event == "endpoint":
                            target = urljoin(self.url, data.strip())
                            if not _same_origin(self.url, target):
                                raise McpError("MCP 服务给的消息地址指向了别的网站，已拒绝", "PROTOCOL")
                            self._sse_endpoint = target
                            ready.set()
                            continue
                        try:
                            payload = json.loads(data)
                        except ValueError:
                            continue
                        for item in payload if isinstance(payload, list) else [payload]:
                            if not isinstance(item, dict):
                                continue
                            if "method" in item:
                                if "id" in item:
                                    self._answer_server_request(item)
                                continue
                            with self._sse_lock:
                                waiter = self._sse_waiters.pop(item.get("id"), None)
                            if waiter is not None:
                                waiter.put(item)
                    raise McpError("MCP 服务断开了连接", "CLOSED")
            except McpError as exc:
                self._sse_error = exc
            except httpx.HTTPError as exc:
                self._sse_error = _network_error(exc)
            except Exception:
                self._sse_error = McpError("和 MCP 服务的长连接出错", "NETWORK")
            finally:
                ready.set()
                with self._sse_lock:
                    waiters, self._sse_waiters = self._sse_waiters, {}
                for waiter in waiters.values():
                    waiter.put(None)

        self._sse_thread = threading.Thread(target=reader, daemon=True, name="jarvis-mcp-sse")
        self._sse_thread.start()
        if not ready.wait(self._remaining(deadline)):
            raise McpError("连接 MCP 服务超时（没收到消息地址）", "TIMEOUT")
        if not self._sse_endpoint:
            raise self._sse_error or McpError("MCP 服务没有给出消息地址", "PROTOCOL")

    def _sse_post(self, message: dict, deadline: float) -> None:
        if self._sse_error:
            raise self._sse_error
        try:
            response = self._client.post(self._sse_endpoint, json=message, headers=self._headers(),
                                         timeout=httpx.Timeout(min(self.timeout, self._remaining(deadline)),
                                                               connect=CONNECT_TIMEOUT))
        except httpx.HTTPError as exc:
            raise _network_error(exc) from None
        if response.status_code == 404:
            raise SessionExpired()
        if response.status_code >= 400:
            raise _status_error(response.status_code)

    def _sse_request(self, message: dict, deadline: float) -> dict:
        waiter: queue.Queue = queue.Queue(maxsize=1)
        with self._sse_lock:
            self._sse_waiters[message["id"]] = waiter
        try:
            self._sse_post(message, deadline)
            try:
                reply = waiter.get(timeout=self._remaining(deadline))
            except queue.Empty:
                raise McpError("等待 MCP 服务的回复超时", "TIMEOUT") from None
        finally:
            with self._sse_lock:
                self._sse_waiters.pop(message["id"], None)
        if reply is None:
            raise self._sse_error or McpError("MCP 服务断开了连接", "CLOSED")
        return reply


# ---------- 结果 → 文字 ----------

def result_text(result: dict) -> tuple[str, bool]:
    """tools/call 的结果 → (文字, 是否出错)。图片 / 音频只留占位说明。"""
    parts: list[str] = []
    for item in result.get("content") or []:
        if not isinstance(item, dict):
            continue
        kind = item.get("type")
        if kind == "text":
            parts.append(str(item.get("text") or ""))
        elif kind in ("image", "audio"):
            parts.append(f"[{'图片' if kind == 'image' else '音频'}内容，已略过]")
        elif kind == "resource":
            resource = item.get("resource") if isinstance(item.get("resource"), dict) else {}
            if isinstance(resource.get("text"), str):
                parts.append(resource["text"])
            else:
                parts.append(f"[资源 {str(resource.get('uri') or '')[:200]}]")
        elif kind == "resource_link":
            parts.append(f"[链接 {str(item.get('name') or '')[:80]}：{str(item.get('uri') or '')[:300]}]")
    if not any(p.strip() for p in parts) and result.get("structuredContent") is not None:
        try:
            parts = [json.dumps(result["structuredContent"], ensure_ascii=False)]
        except (TypeError, ValueError):
            parts = []
    return "\n".join(p for p in parts if p).strip(), bool(result.get("isError"))


__all__ = ["McpError", "McpSession", "PROTOCOL_VERSION", "SessionExpired", "TRANSPORTS", "check_url",
           "display_url", "host_of", "iter_sse", "result_text"]
