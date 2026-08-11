# JWS-Agent 共享 API Provider 设置实施计划

> **For Codex:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to execute this plan task-by-task. Every task requires a fresh implementer, an independent specification reviewer, and an independent code-quality reviewer. Use `superpowers:test-driven-development`, and do not enable production authentication migration until the compatible Electron client is ready.

**Goal:** 在服务器端统一、安全地管理 OpenAI、DeepSeek、阿里云百炼、SiliconFlow、自定义 OpenAI-compatible 中转及 SearXNG/Tavily/PandaScore；网页、macOS 悬浮窗、微信和 CLI 共享同一活动 generation，保存前探测，原子切换，可恢复且不向客户端回显密钥。

**Architecture:** `ProviderCatalog` 提供官方预设；`SecretStore` 以 Fernet 加密不可变 generation 并用 CAS manifest 原子提交；`SafeProviderTransport` 固定经验证 IP 且保留 Host/SNI；`ProviderProbe` 验证模型、非流式工具、流式文本和流式工具；`AgentRuntimeManager` 以 lease 保证在途回答使用完整旧代、新请求使用完整新代。FastAPI 提供带会话、CSRF、重新验证和节流的设置 API；Web 与 Electron 只消费脱敏目录和状态。

**Tech Stack:** FastAPI、Pydantic SecretStr、SQLite、cryptography/Fernet、httpx/httpcore、LangChain ChatOpenAI、React/Vitest、Electron/Node test、pytest。

**Source specifications:**

- `docs/superpowers/specs/2026-08-11-shared-api-provider-settings-design.md`
- `docs/superpowers/specs/2026-08-11-hermes-style-web-research-design.md`

**Dependency gate:** Task 1–2 可独立开始；Task 3 依赖 Hermes 搜索计划的模型/服务接口；Task 4 必须复用该 `SearchService`，不得复制搜索链。所有真实 Key 在聊天中均视为泄露，实施和测试不能读取、部署或回显它们。

---

## Task 1: 迁移随机会话、网页 CSRF 与桌面登录协议

**Files:**

- Create: `jarvis/auth.py`
- Create: `tests/test_session_store.py`
- Modify: `jarvis/config.py`
- Modify: `jarvis/server.py`
- Modify: `tests/conftest.py`
- Modify: `tests/test_auth.py`
- Modify: `tests/test_openai_api.py`
- Modify: `tests/test_threads.py`
- Modify: `tests/test_local_status.py`
- Modify: `tests/test_wechat_api.py`

**Interfaces:**

```python
class SessionStore:
    def create(self, client_type: Literal["web", "desktop"], credential_version: str) -> IssuedSession: ...
    def authenticate(self, raw_token: str, client_type: str | None = None) -> SessionRecord | None: ...
    def revoke(self, session_id: str) -> None: ...
    def revoke_all(self, credential_version: str) -> int: ...

def csrf_token(session_secret: bytes, raw_token: bytes, session_id: str) -> str: ...
def create_app(dependencies: AppDependencies | None = None) -> FastAPI: ...
```

1. Write failing tests for unique 256-bit tokens, SHA-256-only persistence, absolute 30-day expiry, per-session revocation, credential-version revocation and at-most-once-per-five-minute activity touches.

```python
def test_each_login_issues_unique_token_and_db_stores_only_digest(store):
    first = store.create("desktop", "v1")
    second = store.create("desktop", "v1")
    assert first.token != second.token
    assert first.token not in store.raw_database_bytes()
```

2. Add failing API tests: Web login sets only HttpOnly/SameSite=Strict cookie and returns no bearer; production HTTPS always adds `Secure`; a non-Secure cookie is allowed only when explicit development mode is enabled and the actual client address is `127.0.0.1` or `::1`; development mode from a non-loopback client and production HTTP both fail closed. Desktop login returns a token and sets no Web cookie; Web mutation requires deterministic HMAC CSRF; desktop bearer does not; logout revokes; auth/session responses are `no-store`; production startup fails closed without administrator variables; production refuses multiple workers.

3. Run RED.

```bash
.venv/bin/python -m pytest tests/test_session_store.py tests/test_auth.py tests/test_openai_api.py tests/test_threads.py tests/test_local_status.py tests/test_wechat_api.py -q
```

4. Implement SQLite-backed `SessionStore` and exact CSRF formula:

```python
hmac.new(
    session_secret,
    b"csrf-v1\0" + raw_token + b"\0" + session_id.encode("utf-8"),
    hashlib.sha256,
).hexdigest()
```

5. Refactor server construction behind `create_app()` so tests inject data directories and secrets without weakening production fail-closed behavior. Remove hardcoded credentials and deterministic global token. Derive Cookie `Secure` only from the trusted server deployment mode: production requires HTTPS and `Secure`; explicit development may omit it only for an actual loopback peer, never merely from `Host` or forwarded headers. Map all auth errors to stable codes; never expose exception text. Rate-limit login and settings sources without trusting forwarded IP headers unless the proxy itself is explicitly trusted.

6. Keep this backend migration disabled for production until Task 7's compatible desktop path is verified. Run GREEN.

```bash
.venv/bin/python -m pytest tests/test_session_store.py tests/test_auth.py tests/test_openai_api.py tests/test_threads.py tests/test_local_status.py tests/test_wechat_api.py -q
```

7. Commit.

```bash
git add jarvis/auth.py jarvis/config.py jarvis/server.py tests/conftest.py tests/test_session_store.py tests/test_auth.py tests/test_openai_api.py tests/test_threads.py tests/test_local_status.py tests/test_wechat_api.py
git commit -m "feat: add revocable web and desktop sessions"
```

## Task 2: 实现 ProviderCatalog 与加密 SecretStore

**Files:**

- Create: `jarvis/provider_settings/__init__.py`
- Create: `jarvis/provider_settings/models.py`
- Create: `jarvis/provider_settings/catalog.py`
- Create: `jarvis/provider_settings/secret_store.py`
- Create: `tests/test_provider_catalog.py`
- Create: `tests/test_secret_store.py`
- Modify: `pyproject.toml`

**Interfaces:**

```python
@dataclass(frozen=True)
class ConfigSnapshot:
    generation: int
    source: Literal["managed", "environment"]
    llm: LlmSettings
    integrations: Mapping[str, IntegrationSettings]

class SecretStore:
    def load(self) -> ConfigSnapshot: ...
    def prepare(self, snapshot: ConfigSnapshot) -> PreparedGeneration: ...
    def commit(self, prepared: PreparedGeneration, expected_generation: int) -> ConfigSnapshot: ...
    def restore_environment(self, target: ConfigTarget, expected_generation: int) -> ConfigSnapshot: ...

@dataclass(frozen=True)
class ActiveManifest:
    mode: Literal["environment", "managed"]
    generation: int
    active_generation: int | None
    previous_generation: int | None
    ciphertext_sha256: str | None
```

1. Write failing catalog tests for the five exact model entries and the three integration entries, official hosts, editable flags, HTTPS application URLs, and no keys/account data.

2. Write failing SecretStore tests for Fernet round trip, invalid/missing master key, immutable generation files, `0600`, SHA-256 manifest, temp-file fsync/rename/directory-fsync, compare-and-swap conflicts, in-process lock plus `fcntl.flock`, damaged-active recovery to previous, rollback as a new generation, environment-only operation and secret-free repr/JSON/errors. Cover a managed LLM with environment integrations, a managed integration with environment LLM, deleting one target while preserving other managed overrides, and deleting the final override into `mode="environment"` with nullable ciphertext fields but a monotonically increasing public generation.

```python
def test_generation_conflict_never_overwrites(store):
    candidate = store.prepare(snapshot(generation=3))
    with pytest.raises(ConfigConflict):
        store.commit(candidate, expected_generation=1)
    assert store.load().generation == 2
```

3. Run RED.

```bash
.venv/bin/python -m pytest tests/test_provider_catalog.py tests/test_secret_store.py -q
```

4. Add `cryptography==49.0.0` as a direct dependency and update the lockfile. Implement complete-generation encryption in `provider-generations/{generation}.enc`; each encrypted snapshot stores per-target source/override state. The manifest contains only `mode`, public generation, nullable active/previous encrypted generation and nullable ciphertext digest. `mode="environment"` must load without the master key; failed temp files are removed and retention keeps active, previous and a bounded audit set.

5. Implement fixed configuration precedence per target: each managed override wins only for its LLM/integration target, and every non-overridden target resolves from environment. `restore_environment(target, expected_generation)` removes only that target's override and creates the next generation; removing the final override atomically writes an environment-mode manifest. Provider-specific legacy Key fallback applies only to OpenAI and DeepSeek. Managed state without a valid master key fails closed. Environment-only state remains readable without a master key but is writable only when `JARVIS_SECRETS_KEY` is valid and `JARVIS_SETTINGS_WRITE_ENABLED=true`; otherwise settings stay read-only. This enables the first managed generation to be created safely from a pure environment deployment.

6. Run GREEN and inspect serialized failures for leaked values.

```bash
.venv/bin/python -m pytest tests/test_provider_catalog.py tests/test_secret_store.py -q
```

7. Commit.

```bash
git add jarvis/provider_settings pyproject.toml requirements.lock tests/test_provider_catalog.py tests/test_secret_store.py
git commit -m "feat: add encrypted provider configuration store"
```

## Task 3: 实现固定 IP 的 SafeProviderTransport 与四步 ProviderProbe

**Files:**

- Create: `jarvis/net/__init__.py`
- Create: `jarvis/net/safe_transport.py`
- Create: `jarvis/provider_settings/probe.py`
- Create: `tests/test_safe_provider_transport.py`
- Create: `tests/test_provider_probe.py`
- Modify: `jarvis/provider_settings/catalog.py`
- Modify: `pyproject.toml`

**Interfaces:**

```python
class SafeProviderTransportFactory:
    def clients_for(self, base_url: str, provider_id: str) -> ProviderClients: ...

class ProviderProbe:
    def test(self, candidate: LlmSettings) -> ProbeResult: ...

@dataclass(frozen=True)
class ProbeResult:
    ok: bool
    latency_ms: int
    model_id: str
    capabilities: frozenset[str]
    error_code: str | None = None
```

1. Write RED tests for official host allowlists; public custom HTTPS; rejection of userinfo/query/fragment, private/loopback/link-local/reserved/metadata or mixed DNS; DNS rebinding; fixed approved peer IP with original Host/TLS SNI; sync/async parity; `trust_env=False`; redirects/proxies disabled; and separation of the exact SearXNG loopback `:8888` exception from LLM transport.

2. Write RED Probe tests for `/models` success/unsupported manual model, authentication, 429, timeout, TLS and model-not-found mappings. Cover all required protocol paths: non-streaming forced tool call, streaming text with a normal terminator, and streaming forced tool call with incremental name/id/argument assembly.

```python
def test_probe_requires_streaming_tool_arguments_to_reassemble():
    result = probe.test(candidate_with_stub_chunks(tool_argument_chunks=["{\"x\"", ":1}"]))
    assert result.ok
    assert "streaming_tools" in result.capabilities
```

3. Run RED.

```bash
.venv/bin/python -m pytest tests/test_safe_provider_transport.py tests/test_provider_probe.py -q
```

4. Add exact direct dependency `httpcore==1.0.9`. Implement custom sync and async NetworkBackend adapters: select only previously approved IPs in `connect_tcp`, retain `server_hostname=original_host` in `start_tls`, and re-resolve/validate for new connections or expired DNS TTL. Never hand the validated hostname back to an ordinary resolver.

5. Ensure both Probe and future ChatOpenAI clients originate from the same factory. Return only stable codes, latency, capabilities and model IDs; discard raw response bodies/headers.

6. Run GREEN.

```bash
.venv/bin/python -m pytest tests/test_safe_provider_transport.py tests/test_provider_probe.py -q
```

7. Commit.

```bash
git add jarvis/net jarvis/provider_settings/catalog.py jarvis/provider_settings/probe.py pyproject.toml requirements.lock tests/test_safe_provider_transport.py tests/test_provider_probe.py
git commit -m "feat: validate and probe model providers safely"
```

## Task 4: 建立 generation 一致的 RuntimeBundle 与 lease 切换

**Files:**

- Create: `jarvis/runtime.py`
- Create: `tests/test_runtime_manager.py`
- Create: `tests/test_runtime_entrypoints.py`
- Modify: `jarvis/graph.py`
- Modify: `jarvis/server.py`
- Modify: `jarvis/wechat.py`
- Modify: `jarvis/cli.py`
- Modify: `scripts/check_smoke.py`
- Modify: `scripts/search_smoke.py`

**Interfaces:**

```python
@dataclass
class RuntimeBundle:
    generation: int
    model: BaseChatModel
    search_service: SearchService
    tools: tuple[BaseTool, ...]
    agent: CompiledGraph
    def close(self) -> None: ...
    async def aclose(self) -> None: ...

class AgentRuntimeManager:
    @contextmanager
    def acquire(self) -> Iterator[RuntimeBundle]: ...
    @asynccontextmanager
    async def acquire_async(self) -> AsyncIterator[RuntimeBundle]: ...
    def prepare(self, snapshot: ConfigSnapshot) -> RuntimeBundle: ...
    def commit(self, bundle: RuntimeBundle, expected_generation: int) -> None: ...
```

1. Write failing sync and async concurrency tests proving a bundle fixes model, SearchService, tool table and agent to one generation; candidate probe/build occurs outside the write lock; commit performs a second generation CAS; `acquire()` and `acquire_async()` observe only whole old/new bundles; and retired bundles run `close()`/`aclose()` only at lease count zero.

2. Add failing entrypoint tests for Web non-streaming/SSE, OpenAI-compatible non-streaming/streaming, history, delete, WeChat and CLI. Force sync exceptions, async task cancellation, client disconnects and generator cancellation and assert every sync/async lease releases in `finally` and retired async HTTP clients receive `aclose()`.

```python
def test_inflight_stream_keeps_old_generation_during_swap(manager):
    with manager.acquire() as old:
        manager.commit(bundle(generation=old.generation + 1), old.generation)
        assert old.search_service.generation == old.generation
    assert manager.current_generation == old.generation + 1
    assert old.closed
```

3. Run RED.

```bash
.venv/bin/python -m pytest tests/test_runtime_manager.py tests/test_runtime_entrypoints.py -q
```

4. Extract SQLite checkpoint ownership into one server-lifetime resource. Build each bundle with SafeProviderTransport clients and a fresh SearchService/cache/circuit state, then bind all search/entertainment tools through the Hermes plan's factory. Bundle close must not close the shared checkpointer.

5. Implement two-phase apply: read/CAS and snapshot under a short lock; Probe/build/encrypt outside it; re-CAS under write/file lock; commit manifest and perform an exception-free pointer assignment. If an unexpected post-manifest swap failure occurs, restore the old manifest in the same lock; if recovery also fails, enter degraded read-only mode and request controlled restart.

6. Run GREEN.

```bash
.venv/bin/python -m pytest tests/test_runtime_manager.py tests/test_runtime_entrypoints.py tests/test_wechat.py tests/test_openai_api.py -q
```

7. Commit.

```bash
git add jarvis/runtime.py jarvis/graph.py jarvis/server.py jarvis/wechat.py jarvis/cli.py scripts/check_smoke.py scripts/search_smoke.py tests/test_runtime_manager.py tests/test_runtime_entrypoints.py
git commit -m "feat: switch agent runtime by configuration generation"
```

## Task 5: 发布带重新验证、CAS 和脱敏的设置 API

**Files:**

- Create: `jarvis/provider_settings/service.py`
- Create: `jarvis/provider_settings/api.py`
- Create: `tests/test_provider_settings_api.py`
- Modify: `jarvis/server.py`
- Modify: `jarvis/wechat.py`
- Modify: `jarvis/config.py`
- Modify: `tests/test_wechat.py`
- Modify: `tests/test_wechat_api.py`

**Endpoints:**

```text
GET    /api/settings/providers
POST   /api/settings/llm/test
PUT    /api/settings/llm
DELETE /api/settings/llm
POST   /api/settings/integrations/{provider}/test
PUT    /api/settings/integrations/{provider}
DELETE /api/settings/integrations/{provider}
```

1. Write RED tests for authentication, Web CSRF, desktop bearer exemption, administrator re-verification, read-only flag, stable error codes, `no-store`, write throttling and provider path allowlist.

2. Write RED tests that GET never exposes Key, ciphertext, password, master key or tenant-bearing Base URL; Pydantic 422 never echoes SecretStr; same credential scope may explicitly keep a Key; provider/scheme/host/effective-port change must submit a new Key; `enabled=false` overrides environment; DELETE restores environment; stale generation returns `409 CONFIG_CONFLICT`; failed Probe does not write or swap; successful save returns the same generation now displayed by Dashboard.

```python
def test_failed_probe_leaves_disk_and_runtime_unchanged(client, active_generation):
    response = client.put("/api/settings/llm", json=invalid_candidate())
    assert response.json()["code"] == "TOOL_CALL_UNSUPPORTED"
    assert active_generation.on_disk() == active_generation.in_memory()
```

3. Run RED.

```bash
.venv/bin/python -m pytest tests/test_provider_settings_api.py -q
```

4. Implement SecretStr request models and a router driven only by `ProviderSettingsService`. Support exact integration bodies from the spec, fixed IDs `searxng/tavily/pandascore`, and the exact SearXNG URL validator. All mutations revalidate the administrator password and pass `expected_generation` into the two-phase service.

5. Apply the unified stable error mapping to existing chat/SSE/OpenAI/WeChat paths so exception classes and supplier messages never leak.

6. Run GREEN plus auth/runtime suites.

```bash
.venv/bin/python -m pytest tests/test_provider_settings_api.py tests/test_auth.py tests/test_runtime_manager.py tests/test_openai_api.py tests/test_wechat.py tests/test_wechat_api.py -q
```

7. Commit.

```bash
git add jarvis/provider_settings/service.py jarvis/provider_settings/api.py jarvis/server.py jarvis/wechat.py jarvis/config.py tests/test_provider_settings_api.py tests/test_wechat.py tests/test_wechat_api.py
git commit -m "feat: expose secure provider settings api"
```

## Task 6: 构建网页 API 设置中心

**Files:**

- Create: `web-src/src/ApiSettings.jsx`
- Create: `web-src/src/ApiSettings.test.jsx`
- Create: `web-src/src/api.test.js`
- Create: `web-src/src/Hud.settings.test.jsx`
- Modify: `web-src/src/api.js`
- Modify: `web-src/src/App.jsx`
- Modify: `web-src/src/Hud.jsx`
- Modify: `web-src/src/Panels.jsx`
- Modify: `web-src/src/WeChatConnect.jsx`
- Modify: `web-src/src/styles.css`

1. Write RED Vitest cases for catalog-driven choices/application links, empty Key input on every load, keep-existing only within the same credential scope, test/save/restore flows, input clearing in `finally`, 401 relogin, automatic CSRF on all Web mutations, 409 refresh, read-only controls, immediate header status refresh, keyboard escape/focus return and desktop-dialog/mobile-fullscreen layouts.

```jsx
it("never hydrates a configured key back into the DOM", async () => {
  render(<ApiSettings api={apiReturning({ key_configured: true })} />)
  expect(await screen.findByLabelText("API Key")).toHaveValue("")
  expect(document.body.textContent).not.toContain("configured-secret")
})
```

2. Run RED.

```bash
npm --prefix web-src test -- src/api.test.js src/ApiSettings.test.jsx src/Hud.settings.test.jsx
```

3. Centralize the Web API client. After login, fetch `/api/session` and hold CSRF only in module memory; attach it to every POST/PUT/DELETE. Move WeChat's direct fetches to this client.

4. Implement a catalog-driven two-tab center, visible labels/errors/focus, `noopener,noreferrer` links, password fields for Key/admin password, and `finally` clearing. Dashboard consumes only provider/model/generation/health.

5. Run GREEN and build production assets.

```bash
npm --prefix web-src test
npm --prefix web-src run build
```

6. Use a real browser to inspect wide and narrow layouts, keyboard navigation, login expiry, test failure and save success. Store only non-sensitive screenshots if documentation is updated.

7. Commit source and generated Web assets.

```bash
git add web-src/src jarvis/web
git commit -m "feat: add web provider settings center"
```

## Task 7: 将 Electron 悬浮窗迁到 main-process 安全会话与三页签设置

**Files:**

- Create: `desktop/server-api.js`
- Create: `desktop/server-api.test.js`
- Create: `desktop/session-store.js`
- Create: `desktop/session-store.test.js`
- Create: `desktop/settings-ui.js`
- Create: `desktop/settings-ui.test.js`
- Modify: `desktop/main.js`
- Modify: `desktop/preload.js`
- Modify: `desktop/renderer.js`
- Modify: `desktop/index.html`
- Modify: `desktop/wechat-ui.js`
- Modify: `desktop/wechat-ui.test.js`
- Modify: `desktop/package.json`
- Modify: `desktop/package-lock.json`

1. Add exact devDependency `"electron-builder": "26.15.3"`, `"test": "node --test *.test.js"` and `"dist:mac": "electron-builder --mac dir dmg --arm64"`. Configure `appId="cn.gkgeek.jws-agent"`, `productName="JWS Agent"`, runtime files `main.js`, `preload.js`, `renderer.js`, `index.html`, `wechat-ui.js`, `settings-ui.js`, `server-api.js` and `session-store.js`, arm64 `dir` and `dmg` targets, and artifact name `JWS-Agent-${version}-${arch}.${ext}`. Then write RED tests for safeStorage encrypted persistence, memory-only fallback when encryption is unavailable, server-origin change revocation, HTTPS/explicit loopback validation, no token in preload/renderer values, new login endpoint first, and fallback to legacy `/api/login` only on 404/405—not 401/429/network/TLS/timeout.

2. Write RED tests for narrow IPC method allowlists, request-scoped SSE and cancellation cleanup, `webSecurity:true`, `contextIsolation:true`, `nodeIntegration:false`, legacy `localStorage['jws_token']` deletion before showing the window, three settings tabs, Key/password non-persistence and ProviderCatalog-only external links.

```javascript
test("401 from desktop login never falls back", async () => {
  const calls = []
  await assert.rejects(() => login({ status: 401, calls }))
  assert.deepEqual(calls, ["/api/desktop/login"])
})
```

3. Run RED.

```bash
npm --prefix desktop test
```

4. Implement pure injectable HTTP/session modules outside Electron globals. Keep Token only in main-process memory plus safeStorage-encrypted file; when encryption is unavailable, retain only memory and require next-launch login. Origin changes delete the old token before any request.

5. Replace renderer generic fetch with narrow preload methods for login/logout/history/chat/dashboard/WeChat/settings. Main parses SSE and emits only request-scoped events. Set `webSecurity:true`; load renderer hidden, delete the legacy key, then show.

6. Build the basic/model/integration tabs with the same catalog and clearing rules as Web. External URLs pass a catalog-derived HTTPS allowlist before `shell.openExternal`.

7. Run GREEN and package/build smoke.

```bash
npm --prefix desktop test
npm --prefix desktop run dist:mac
test -d 'desktop/dist/mac-arm64/JWS Agent.app'
test -f 'desktop/dist/JWS-Agent-1.1.0-arm64.dmg'
codesign --verify --deep --strict 'desktop/dist/mac-arm64/JWS Agent.app'
```

8. Commit.

```bash
git add desktop
git commit -m "feat: secure desktop provider settings"
```

## Task 8: 跨入口闭环、文档与可复现构建

**Files:**

- Create: `deploy/systemd/jarvis-web.service.example`
- Create: `docs/deployment.md`
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `pyproject.toml`
- Modify: `requirements.lock`
- Modify: `jarvis/web/index.html`
- Modify: `jarvis/web/assets/*`
- Modify: `tests/test_runtime_entrypoints.py`

1. Extend RED integration tests to switch a stub generation and prove the next Web, Desktop, WeChat and fresh CLI request all report the same generation, while an already-running stream stays on the old one. Test restart recovery and rollback.

2. Add tracked-file/diff-only secret scanning fixtures and assert generated Web/Desktop assets contain no Key/password/token. Never inspect local `.env`, real server environment or encrypted production data.

3. Run RED.

```bash
.venv/bin/python -m pytest tests/test_runtime_entrypoints.py tests/test_secret_store.py -q
```

4. Document every required environment variable, systemd single worker, separate session/Fernet secrets, initial `JARVIS_SETTINGS_WRITE_ENABLED=false`, official API application links, custom relay disclosure, key rotation, SearXNG free default and rollback pairing of encrypted state with its master key. Update README screenshots only with synthetic data.

5. Ensure systemd explicitly starts one worker and persists application data outside the Git checkout. Regenerate reproducible Python and Web locks/builds.

6. Run the complete local gate.

```bash
.venv/bin/python -m pytest -q
npm --prefix web-src test
npm --prefix web-src run build
npm --prefix desktop test
npm --prefix desktop run dist:mac
test -d 'desktop/dist/mac-arm64/JWS Agent.app'
codesign --verify --deep --strict 'desktop/dist/mac-arm64/JWS Agent.app'
.venv/bin/python -m piptools compile --strip-extras --output-file requirements.lock pyproject.toml
git diff --exit-code requirements.lock
git diff --check
git status --short
```

7. Commit.

```bash
git add deploy/systemd docs/deployment.md .env.example README.md pyproject.toml requirements.lock jarvis/web tests/test_runtime_entrypoints.py
git commit -m "docs: complete shared provider deployment flow"
```

## Task 9: 兼容顺序上线、真实闭环验证与主分支推送

**Files:**

- Modify only files required by verified deployment failures.
- Keep production evidence free of secrets and outside tracked configuration.

1. Run an independent final specification review and code-quality review over the complete diff. Re-run every local gate from Task 8 and tracked-file/diff-only sensitive scan.

2. Record production application SHA, website/WeChat health and rollback commands without printing environment values. Build the exact arm64 Electron artifact first. If `/Applications/JWS Agent.app` exists, move it to the recoverable `/Applications/JWS Agent.previous.app` only after confirming that backup path is absent; then install with `ditto` and launch the installed bundle. Against the old server, verify main-process login negotiates via 404/405 fallback, safeStorage contains the only token copy, renderer localStorage is cleared and `webSecurity:true` chat works.

```bash
npm --prefix desktop ci
npm --prefix desktop test
npm --prefix desktop run dist:mac
test -d 'desktop/dist/mac-arm64/JWS Agent.app'
codesign --verify --deep --strict 'desktop/dist/mac-arm64/JWS Agent.app'
if [ -e '/Applications/JWS Agent.previous.app' ]; then
  exit 1
fi
if [ -d '/Applications/JWS Agent.app' ]; then
  mv '/Applications/JWS Agent.app' '/Applications/JWS Agent.previous.app'
fi
ditto 'desktop/dist/mac-arm64/JWS Agent.app' '/Applications/JWS Agent.app'
open '/Applications/JWS Agent.app'
```

3. In server secret storage, generate distinct random administrator credentials, `JARVIS_SESSION_SECRET` and `JARVIS_SECRETS_KEY` without echoing them. Set `JARVIS_SETTINGS_WRITE_ENABLED=false`. Do not reuse any key previously pasted into chat.

4. In one maintenance window, deploy the new backend plus built Web assets and SearXNG. Verify Web/Desktop re-login, session revocation, OpenAI-compatible APIs, WeChat, old environment-sourced model and read-only settings.

5. Enable `JARVIS_SETTINGS_WRITE_ENABLED=true` only after the compatibility checks pass. The user enters newly rotated Provider credentials through Web/Desktop UI or the server secret manager; no credential is requested or copied through chat. Default SearXNG/DDGS smoke remains usable without paid keys.

6. Verify model test/save, integration test/save, shared generation across Web/Desktop/WeChat, in-flight stream continuity, conflict rejection, failed-probe rollback, restart recovery, Chinese current-news search, extraction and SearXNG-to-DDGS fallback. Confirm service/container logs contain no sensitive material.

7. On failure, restore the recorded SHA and systemd environment, pair encrypted generations with the matching master key, keep `/var/lib/jarvis` and WeChat state, restart, and verify the old health path. Expect users to log in again if sessions were migrated.

8. After successful final review and production smoke, fast-forward `main`, push it, and confirm production SHA equals remote `main`.

```bash
git switch main
git merge --ff-only codex/shared-provider-settings
git push origin main
```

**Acceptance gate:** both clients can safely configure/test/save/restore; no secret is returned or persisted client-side; safe transport and probe tests pass; all entries share the same generation; in-flight streams survive swaps; production smoke and rollback exercise pass; pushed `main` matches the deployed SHA.
