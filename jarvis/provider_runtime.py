"""Safe Provider transport, compatibility probe and leased Agent runtimes."""
from __future__ import annotations

import asyncio
from contextlib import contextmanager
from dataclasses import dataclass
import ipaddress
import json
import logging
import socket
import sqlite3
import threading
import time
from typing import Any, Callable, Iterator, Sequence
from urllib.parse import urljoin, urlsplit

import httpcore
import httpx
from langchain_openai import ChatOpenAI

from jarvis import config
from jarvis.graph import LLM_MAX_RETRIES, LLM_TIMEOUT, SqliteSaver, build_agent
from jarvis.provider_settings import ProviderSettingsError, ResolvedLLM, SecretStore, normalize_base_url
from jarvis.search.fetcher import _SystemResolver, _is_public_address, _parse_ip
from jarvis.search.providers import DDGSProvider, SearXNGProvider, TavilyProvider
from jarvis.search.service import SearchService

log = logging.getLogger(__name__)


class _PinnedSyncBackend(httpcore.NetworkBackend):
    def __init__(self, resolver=None, backend=None):
        self.resolver = resolver or _SystemResolver()
        self.backend = backend or httpcore.SyncBackend()

    def _approved(self, host: str, port: int, timeout: float | None) -> str:
        try:
            literal = ipaddress.ip_address(host)
            answers = (str(literal),)
        except ValueError:
            answers = tuple(self.resolver.resolve(host, port, timeout or 10.0))
        if not answers:
            raise OSError("DNS_BLOCKED")
        normalized = []
        for answer in answers:
            address = _parse_ip(answer)
            if not _is_public_address(address):
                raise OSError("DNS_BLOCKED")
            if str(address) not in normalized: normalized.append(str(address))
        return normalized[0]

    def connect_tcp(self, host, port, timeout=None, local_address=None, socket_options=None):
        return self.backend.connect_tcp(self._approved(host, port, timeout), port, timeout, local_address, socket_options)

    def connect_unix_socket(self, path, timeout=None, socket_options=None):
        raise OSError("unix sockets are disabled")

    def sleep(self, seconds):
        return self.backend.sleep(seconds)


class _PinnedAsyncBackend(httpcore.AsyncNetworkBackend):
    def __init__(self, resolver=None, backend=None):
        self.resolver = resolver or _SystemResolver()
        self.backend = backend or httpcore.AnyIOBackend()

    async def _approved(self, host: str, port: int, timeout: float | None) -> str:
        def resolve():
            try:
                literal = ipaddress.ip_address(host)
                return (str(literal),)
            except ValueError:
                return tuple(self.resolver.resolve(host, port, timeout or 10.0))
        answers = await asyncio.to_thread(resolve)
        if not answers: raise OSError("DNS_BLOCKED")
        normalized = []
        for answer in answers:
            address = _parse_ip(answer)
            if not _is_public_address(address): raise OSError("DNS_BLOCKED")
            if str(address) not in normalized: normalized.append(str(address))
        return normalized[0]

    async def connect_tcp(self, host, port, timeout=None, local_address=None, socket_options=None):
        approved = await self._approved(host, port, timeout)
        return await self.backend.connect_tcp(approved, port, timeout, local_address, socket_options)

    async def connect_unix_socket(self, path, timeout=None, socket_options=None):
        raise OSError("unix sockets are disabled")

    async def sleep(self, seconds):
        return await self.backend.sleep(seconds)


# 每个用户 runtime 的模型连接池上限。同一 Owner 的网页/桌面/微信/语音/后台服务
# 共用一个 bundle：此前实际上限是 httpcore 默认的 10，第 11 路流式请求要排队等
# 前面某一路「整段回答」结束才能拿到连接（且池等待无超时）。
RUNTIME_MAX_CONNECTIONS = 32
KEEPALIVE_EXPIRY_SECONDS = 30.0   # 空闲长连接 30 秒后弃用，避免复用被 NAT 静默掐断的连接


def safe_http_clients(*, resolver=None, timeout: float | httpx.Timeout = 20.0,
                      max_connections: int = 10) -> tuple[httpx.Client, httpx.AsyncClient]:
    """Build clients whose pools pin approved DNS answers while preserving Host/SNI.

    注意：transport 自带连接池时 httpx.Client(limits=...) 不会生效，连接上限与
    keep-alive 过期必须直接配在 httpcore 池上（此前传的 Limits 一直被静默忽略）。
    """
    pool_limits = {
        "max_connections": max_connections,
        "max_keepalive_connections": max_connections,
        "keepalive_expiry": KEEPALIVE_EXPIRY_SECONDS,
    }
    sync_transport = httpx.HTTPTransport(retries=0)
    sync_transport._pool = httpcore.ConnectionPool(  # type: ignore[attr-defined]
        network_backend=_PinnedSyncBackend(resolver=resolver), retries=0, http2=False, **pool_limits,
    )
    async_transport = httpx.AsyncHTTPTransport(retries=0)
    async_transport._pool = httpcore.AsyncConnectionPool(  # type: ignore[attr-defined]
        network_backend=_PinnedAsyncBackend(resolver=resolver), retries=0, http2=False, **pool_limits,
    )
    return (
        httpx.Client(transport=sync_transport, timeout=timeout, follow_redirects=False, trust_env=False),
        httpx.AsyncClient(transport=async_transport, timeout=timeout, follow_redirects=False, trust_env=False),
    )


def close_async_client(client: Any) -> None:
    """在同步代码里关闭 httpx.AsyncClient，任何调用上下文都不留下未 await 的协程。

    此前三处写法都是 ``asyncio.run(client.aclose())`` + 吞掉 RuntimeError：在运行中的
    事件循环里（lifespan 停机）asyncio.run 直接抛错，但 aclose() 协程已经创建，
    于是每次重启 journal 里都有一条 ``coroutine 'AsyncClient.aclose' was never awaited``，
    客户端也并没有真正关上。现在：没有运行中的循环就地 asyncio.run；在循环里则交给
    一个短命线程用它自己的循环关闭（最多等 5 秒，绝不阻塞停机）。
    """
    aclose = getattr(client, "aclose", None)
    if not callable(aclose) or getattr(client, "is_closed", False) is True:
        return

    def run() -> None:
        try:
            asyncio.run(aclose())
        except Exception:
            pass  # 关闭失败只是少释放几条空闲连接

    try:
        asyncio.get_running_loop()
    except RuntimeError:
        run()
        return
    worker = threading.Thread(target=run, name="jarvis-aclose", daemon=True)
    worker.start()
    worker.join(timeout=5.0)


def _provider_error(response: httpx.Response) -> None:
    if response.is_redirect: raise ProviderSettingsError("INVALID_URL", "Provider 返回了不允许的重定向")
    if response.status_code in {401, 403}: raise ProviderSettingsError("PROVIDER_AUTH", "Provider 认证失败")
    if response.status_code == 404: raise ProviderSettingsError("MODEL_NOT_FOUND", "模型或接口不存在")
    if response.status_code == 429: raise ProviderSettingsError("RATE_LIMITED", "Provider 触发频率限制", status=429)
    if response.status_code >= 400: raise ProviderSettingsError("APPLY_FAILED", "Provider 响应异常")


class ProviderProbe:
    """Exercise the exact non-stream/stream text and tool contracts used by JARVIS."""

    def __init__(self, client_factory: Callable[[], tuple[httpx.Client, httpx.AsyncClient]] = safe_http_clients,
                 clock: Callable[[], float] = time.monotonic):
        self.client_factory = client_factory
        self.clock = clock

    def test(self, candidate: ResolvedLLM) -> dict[str, Any]:
        started = self.clock()
        client, async_client = self.client_factory()
        try:
            headers = {"Authorization": f"Bearer {candidate.api_key}", "Content-Type": "application/json"}
            models: list[str] = []
            model_url = urljoin(candidate.base_url.rstrip("/") + "/", "models")
            response = client.get(model_url, headers={"Authorization": headers["Authorization"]})
            if response.status_code not in {404, 405}:
                _provider_error(response)
                body = response.json()
                if isinstance(body, dict) and isinstance(body.get("data"), list):
                    models = [row["id"] for row in body["data"] if isinstance(row, dict) and isinstance(row.get("id"), str)][:100]
            chat_url = urljoin(candidate.base_url.rstrip("/") + "/", "chat/completions")
            tool = {"type": "function", "function": {"name": "jws_probe", "description": "compatibility probe", "parameters": {"type": "object", "properties": {"ok": {"type": "boolean"}}, "required": ["ok"]}}}
            common = {"model": candidate.model, "messages": [{"role": "user", "content": "Call jws_probe with ok=true."}], "tools": [tool], "tool_choice": {"type": "function", "function": {"name": "jws_probe"}}, "max_tokens": 32, "temperature": 0}
            nonstream = client.post(chat_url, headers=headers, json={**common, "stream": False})
            _provider_error(nonstream)
            payload = nonstream.json()
            calls = (((payload.get("choices") or [{}])[0].get("message") or {}).get("tool_calls") or []) if isinstance(payload, dict) else []
            if not any(isinstance(call, dict) and (call.get("function") or {}).get("name") == "jws_probe" for call in calls):
                raise ProviderSettingsError("TOOL_CALL_UNSUPPORTED", "Provider 不支持强制工具调用")
            text_ok = self._stream_has(client, chat_url, headers, {"model": candidate.model, "messages": [{"role": "user", "content": "Reply OK."}], "stream": True, "max_tokens": 8}, expect_tool=False)
            tool_ok = self._stream_has(client, chat_url, headers, {**common, "stream": True}, expect_tool=True)
            return {"ok": True, "latency_ms": int((self.clock() - started) * 1000), "models": models,
                    "non_stream_tool": True, "stream_text": text_ok, "stream_tool": tool_ok}
        except ProviderSettingsError:
            raise
        except httpx.TimeoutException:
            raise ProviderSettingsError("TIMEOUT", "Provider 请求超时") from None
        except httpx.TransportError:
            raise ProviderSettingsError("DNS_BLOCKED", "Provider 网络地址不可用") from None
        except (ValueError, TypeError, KeyError, json.JSONDecodeError):
            raise ProviderSettingsError("APPLY_FAILED", "Provider 返回格式不兼容") from None
        finally:
            client.close()
            close_async_client(async_client)

    def _stream_has(self, client: httpx.Client, url: str, headers: dict[str, str], body: dict[str, Any], *, expect_tool: bool) -> bool:
        found = False
        with client.stream("POST", url, headers=headers, json=body) as response:
            _provider_error(response)
            for line in response.iter_lines():
                if not line.startswith("data:"): continue
                data = line[5:].strip()
                if data == "[DONE]": break
                if len(data) > 256 * 1024: raise ProviderSettingsError("APPLY_FAILED", "Provider 流事件过大")
                event = json.loads(data)
                delta = ((event.get("choices") or [{}])[0].get("delta") or {})
                if expect_tool:
                    found = found or any((item.get("function") or {}).get("name") == "jws_probe" for item in delta.get("tool_calls", []) if isinstance(item, dict))
                else:
                    found = found or bool(delta.get("content"))
        if not found:
            code = "TOOL_CALL_UNSUPPORTED" if expect_tool else "APPLY_FAILED"
            raise ProviderSettingsError(code, "Provider 流式响应不兼容")
        return True


@dataclass
class RuntimeBundle:
    user_id: str
    generation: int
    agent: Any
    search_service: Any
    model: Any = None
    sync_client: Any = None
    async_client: Any = None
    leases: int = 0
    retired: bool = False
    closed: bool = False
    platform_rev: int = 0   # 建 bundle 时该账号智能平台的版本号；平台改了就重建（工具子集随之变）

    def close(self) -> None:
        if self.closed: return
        self.closed = True
        for item in (self.search_service, self.sync_client):
            close = getattr(item, "close", None)
            if callable(close):
                try: close()
                except Exception: pass
        close_async_client(self.async_client)


def _platform_revision(user_id: str) -> int:
    try:
        from jarvis.platforms import revision
        return revision(user_id)
    except Exception:
        return 0


_PLATFORM_LOOKUP_FAILED: set[str] = set()


def _platform_tool_names(user_id: str):
    """该账号智能平台允许的工具名；没有平台返回 None，绑定完整工具集。

    读库失败（如库被锁）时这一次先按完整工具集建，并记下来让下次 acquire 重建再查。"""
    try:
        from jarvis.platforms import agent_tool_names
        return agent_tool_names(user_id)
    except Exception as exc:
        log.warning("platform tools lookup failed: %s", type(exc).__name__)
        _PLATFORM_LOOKUP_FAILED.add(user_id)
        return None


class AgentRuntimeManager:
    """Cache bundles by user/generation and retire them only after all leases finish."""

    def __init__(self, store: SecretStore, *, factory: Callable[[str, ResolvedLLM, dict[str, dict[str, Any]]], RuntimeBundle] | None = None,
                 probe: ProviderProbe | None = None, checkpointer=None):
        self.store = store
        self.probe = probe or ProviderProbe()
        self._lock = threading.RLock()
        self._bundles: dict[str, RuntimeBundle] = {}
        self._factory = factory or self._default_factory
        self._checkpointer = checkpointer or SqliteSaver(sqlite3.connect(str(config.db_path()), check_same_thread=False))

    def _default_factory(self, user_id: str, llm: ResolvedLLM, integrations: dict[str, dict[str, Any]]) -> RuntimeBundle:
        sync_client, async_client = safe_http_clients(timeout=LLM_TIMEOUT, max_connections=RUNTIME_MAX_CONNECTIONS)
        # timeout 必须显式传给 ChatOpenAI：不传时 openai SDK 以 None 覆盖客户端超时，请求永不超时
        model = ChatOpenAI(model=llm.model, base_url=llm.base_url, api_key=llm.api_key,
                           temperature=0, http_client=sync_client, http_async_client=async_client,
                           timeout=LLM_TIMEOUT, max_retries=LLM_MAX_RETRIES)
        searxng = integrations["searxng"]
        tavily = integrations["tavily"]
        service = SearchService([
            SearXNGProvider(endpoint_getter=lambda: searxng["base_url"] if searxng["enabled"] else ""),
            DDGSProvider(),
            TavilyProvider(api_key_getter=lambda: tavily["api_key"] if tavily["enabled"] else ""),
        ])
        service.generation = llm.generation
        pandascore = integrations["pandascore"]
        agent = build_agent(search_service=service, model=model, checkpointer=self._checkpointer,
                            pandascore_token_getter=lambda: pandascore["api_key"] if pandascore["enabled"] else "",
                            tool_names=_platform_tool_names(user_id))
        return RuntimeBundle(user_id, llm.generation, agent, service, model, sync_client, async_client)

    def _new(self, user_id: str, llm: ResolvedLLM | None = None) -> RuntimeBundle:
        resolved = llm or self.store.resolved_llm(user_id)
        revision = _platform_revision(user_id)   # 先取版本再建：建的途中平台又改了，下次 acquire 会再重建
        bundle = self._factory(user_id, resolved, self.store.integration_values())
        bundle.platform_rev = -1 if user_id in _PLATFORM_LOOKUP_FAILED else revision
        _PLATFORM_LOOKUP_FAILED.discard(user_id)
        return bundle

    @contextmanager
    def acquire(self, user_id: str) -> Iterator[RuntimeBundle]:
        resolved = self.store.resolved_llm(user_id)
        with self._lock:
            bundle = self._bundles.get(user_id)
            if (bundle is None or bundle.generation != resolved.generation
                    or bundle.platform_rev != _platform_revision(user_id)):
                candidate = self._new(user_id, resolved)
                old = self._bundles.get(user_id)
                self._bundles[user_id] = candidate
                if old:
                    old.retired = True
                    if old.leases == 0: old.close()
                bundle = candidate
            bundle.leases += 1
        try:
            yield bundle
        finally:
            with self._lock:
                bundle.leases -= 1
                if bundle.retired and bundle.leases == 0: bundle.close()

    def test_llm(self, candidate: ResolvedLLM) -> dict[str, Any]:
        return self.probe.test(candidate)

    def apply_llm(self, user_id: str, candidate: dict[str, Any], *, expected_generation: int,
                  keep_existing_key: bool = False) -> tuple[ResolvedLLM, dict[str, Any]]:
        current = self.store.resolved_llm(user_id)
        if current.generation != expected_generation:
            from jarvis.provider_settings import ConfigConflict
            raise ConfigConflict()
        provider = str(candidate.get("provider", "")).strip().lower()
        base = normalize_base_url(provider, str(candidate.get("base_url", "")))
        key = str(candidate.get("api_key", "") or "")
        if not key and keep_existing_key and credential_origin(current) == f"{provider}|{urlsplit(base).scheme}://{urlsplit(base).hostname}:{urlsplit(base).port or 443}":
            key = current.api_key
        probe_candidate = ResolvedLLM(provider, base, str(candidate.get("model", "")).strip(), key, expected_generation + 1, "managed")
        result = self.probe.test(probe_candidate)
        candidate_bundle = self._new(user_id, probe_candidate)
        try:
            committed = self.store.commit_llm(user_id, {**candidate, "api_key": key}, expected_generation=expected_generation,
                                              keep_existing_key=keep_existing_key)
            with self._lock:
                old = self._bundles.get(user_id)
                candidate_bundle.generation = committed.generation
                self._bundles[user_id] = candidate_bundle
                if old:
                    old.retired = True
                    if old.leases == 0: old.close()
            return committed, result
        except Exception:
            candidate_bundle.close()
            raise

    def restore_llm(self, user_id: str, *, expected_generation: int) -> ResolvedLLM:
        # Build environment before committing so a broken env cannot replace a good runtime.
        env = self.store._environment_llm()
        probe = self.probe.test(ResolvedLLM(env.provider, env.base_url, env.model, env.api_key, expected_generation + 1, "environment"))
        del probe
        candidate_bundle = self._new(user_id, ResolvedLLM(env.provider, env.base_url, env.model, env.api_key, expected_generation + 1, "environment"))
        try:
            committed = self.store.delete_llm(user_id, expected_generation=expected_generation)
            with self._lock:
                old = self._bundles.get(user_id); candidate_bundle.generation = committed.generation
                self._bundles[user_id] = candidate_bundle
                if old:
                    old.retired = True
                    if old.leases == 0: old.close()
            return committed
        except Exception:
            candidate_bundle.close(); raise

    def invalidate_search(self) -> None:
        with self._lock:
            old = list(self._bundles.values()); self._bundles.clear()
            for bundle in old:
                bundle.retired = True
                if bundle.leases == 0: bundle.close()

    def close(self) -> None:
        with self._lock:
            bundles = list(self._bundles.values()); self._bundles.clear()
        for bundle in bundles: bundle.close()


def credential_origin(llm: ResolvedLLM) -> str:
    parsed = urlsplit(llm.base_url)
    return f"{llm.provider}|{parsed.scheme}://{parsed.hostname}:{parsed.port or 443}"


__all__ = ["AgentRuntimeManager", "ProviderProbe", "RuntimeBundle", "safe_http_clients"]


def probe_integration(name: str, candidate: dict[str, Any]) -> dict[str, Any]:
    """Run one bounded read-only health request without returning upstream data."""
    started = time.monotonic()
    client = async_client = None
    try:
        if name == "searxng":
            base = str(candidate.get("base_url", "")).rstrip("/")
            if base in {"http://127.0.0.1:18888", "http://[::1]:18888"}:
                client = httpx.Client(timeout=12, trust_env=False, follow_redirects=False)
            else:
                client, async_client = safe_http_clients(timeout=12)
            response = client.get(base + "/search", params={"q": "JWS health", "format": "json", "safesearch": 1})
        elif name == "tavily":
            client, async_client = safe_http_clients(timeout=12)
            response = client.post("https://api.tavily.com/search", headers={"Authorization": f"Bearer {candidate.get('api_key', '')}"},
                                   json={"query": "JWS health", "search_depth": "basic", "max_results": 1, "include_answer": False})
        elif name == "pandascore":
            client, async_client = safe_http_clients(timeout=12)
            response = client.get("https://api.pandascore.co/matches", headers={"Authorization": f"Bearer {candidate.get('api_key', '')}"}, params={"per_page": 1})
        else:
            raise ProviderSettingsError("INVALID_URL", "未知联网 Provider")
        _provider_error(response)
        response.json()
        return {"ok": True, "latency_ms": int((time.monotonic() - started) * 1000)}
    except ProviderSettingsError:
        raise
    except httpx.TimeoutException:
        raise ProviderSettingsError("TIMEOUT", "联网 Provider 请求超时") from None
    except httpx.TransportError:
        raise ProviderSettingsError("DNS_BLOCKED", "联网 Provider 网络地址不可用") from None
    except (ValueError, TypeError, json.JSONDecodeError):
        raise ProviderSettingsError("APPLY_FAILED", "联网 Provider 返回格式无效") from None
    finally:
        if client is not None: client.close()
        if async_client is not None: close_async_client(async_client)


__all__.append("probe_integration")
