# JWS-Agent Hermes 风格联网检索实施计划

> **For Codex:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to execute this plan task-by-task. Each task gets a fresh implementer, then a specification reviewer, then a code-quality reviewer. Use `superpowers:test-driven-development` for every implementation task and `superpowers:verification-before-completion` before deployment or completion claims.

**Goal:** 将现有 Tavily 单点搜索升级为默认零 API 费用的 `SearXNG → DDGS → Tavily` 检索链和 `Trafilatura → Playwright` 正文提取链，并把电影评分、电竞比分、票务搜索和 Agent 工具统一接入同一代 `SearchService`。

**Architecture:** 新建 `jarvis.search` 包，以不可变请求/结果模型和 Provider 协议隔离供应商差异；`SearchService` 拥有 Provider 客户端、短时缓存、熔断和脱敏健康状态。`jarvis.tools.search` 只负责 LangChain 工具适配与兼容 `TavilySearch`，娱乐工具通过显式注入的服务复用底座。所有网页字节先通过安全 Fetcher，静态解析失败才进入受限 Playwright。

**Tech Stack:** Python 3.10–3.14、httpx/httpcore、ddgs、trafilatura、可选 Playwright、LangChain tools、pytest、Docker Compose、SearXNG。

**Source specification:** `docs/superpowers/specs/2026-08-11-hermes-style-web-research-design.md`

**Global invariants:** 不读取或使用聊天中出现过的密钥；测试全部使用 Stub/Mock；保留 `web_search(query, topic, time_range, domains, max_results)`、`TavilySearch(api_key_getter=None, transport=None, now=None)` 和 `.search(...) -> str`；Riot 不在本期；所有外部结果保留查询时间、来源和“不可信外部资料”边界。

---

## Task 1: 建立不可变搜索模型、配置与 Provider 合约

**Files:**

- Create: `jarvis/search/__init__.py`
- Create: `jarvis/search/models.py`
- Create: `jarvis/search/providers/__init__.py`
- Create: `jarvis/search/providers/base.py`
- Create: `tests/test_search_models.py`
- Create: `tests/test_search_config.py`
- Modify: `jarvis/config.py`
- Modify: `.env.example`

**Interfaces:**

```python
@dataclass(frozen=True)
class CachePolicy:
    ttl_seconds: int
    policy_version: str

DEFAULT_CACHE_POLICY = CachePolicy(ttl_seconds=300, policy_version="web-v1")
REALTIME_CACHE_POLICY = CachePolicy(ttl_seconds=60, policy_version="realtime-v1")

@dataclass(frozen=True)
class SearchRequest:
    query: str
    topic: Literal["general", "news"] = "general"
    time_range: Literal["", "day", "week", "month", "year"] = ""
    domains: tuple[str, ...] = ()
    max_results: int = 5
    cache_policy: CachePolicy = DEFAULT_CACHE_POLICY

@dataclass(frozen=True)
class SearchResult:
    title: str
    url: str
    snippet: str
    published_at: str
    provider: str

@dataclass(frozen=True)
class SearchResponse:
    results: tuple[SearchResult, ...]
    checked_at: datetime
    attempted_providers: tuple[str, ...]
    stale: bool = False

@dataclass(frozen=True)
class ProviderCapabilities:
    topics: frozenset[str]
    time_ranges: frozenset[str]

class SearchProvider(Protocol):
    name: str
    capabilities: ProviderCapabilities
    def configured(self) -> bool: ...
    def search(self, request: SearchRequest) -> Sequence[SearchResult]: ...
    def close(self) -> None: ...
```

1. Write failing tests for short time aliases, canonical domains, maximum result bounds, frozen dataclasses, the default 300-second cache policy, the 60-second real-time score/ticket policy, unknown Provider names, duplicate fallbacks and diagnostics that expose only configured/unconfigured booleans.

```python
def test_search_settings_default_to_free_chain(monkeypatch):
    monkeypatch.delenv("TAVILY_API_KEY", raising=False)
    settings = load_search_settings()
    assert settings.search_backends == ("searxng", "ddgs", "tavily")
    assert settings.extract_backends == ("trafilatura", "playwright")
    assert "api_key" not in repr(settings).lower()
```

2. Run the focused tests and confirm RED because the package and settings do not exist.

```bash
.venv/bin/python -m pytest tests/test_search_models.py tests/test_search_config.py -q
```

3. Implement the immutable models, normalization helpers and `SearchSettings`. Parse `d/w/m/y`; reject unknown or duplicate names; keep optional credentials wrapped/redacted and avoid ambient `os.getenv()` calls outside configuration assembly.

4. Run the focused tests and existing configuration tests until GREEN.

```bash
.venv/bin/python -m pytest tests/test_search_models.py tests/test_search_config.py -q
```

5. Commit only this task.

```bash
git add jarvis/search jarvis/config.py .env.example tests/test_search_models.py tests/test_search_config.py
git commit -m "feat: define search provider contracts"
```

## Task 2: 实现 SearXNG、DDGS、Tavily 与服务降级

**Files:**

- Create: `jarvis/search/providers/searxng.py`
- Create: `jarvis/search/providers/ddgs.py`
- Create: `jarvis/search/providers/tavily.py`
- Create: `jarvis/search/service.py`
- Create: `tests/test_search_providers.py`
- Create: `tests/test_search_service.py`
- Modify: `jarvis/tools/search.py`
- Modify: `tests/test_search.py`

**Interfaces:**

```python
class SearchService:
    def search(self, request: SearchRequest) -> SearchResponse: ...
    def health(self) -> tuple[ProviderHealth, ...]: ...
    def close(self) -> None: ...

class TavilySearch:
    def __init__(self, api_key_getter=None, transport=None, now=None): ...
    def search(self, query, topic="general", time_range="", domains="", max_results=5) -> str: ...
```

1. Write failing contract tests for exact request mapping, malformed rows, empty results, optional Tavily skip and final hostname filtering. Write service tests for `SearXNG → DDGS → Tavily`, capability skip on SearXNG `week`, normalized URL deduplication, partial-result fill, retry/circuit behavior and redacted health. Assert each cache key contains Provider ID, normalized request, cache-policy version and security-policy version; movie/general queries use 300 seconds while live scores and ticket quotes use 60 seconds.

```python
def test_week_skips_searxng_and_fills_from_ddgs():
    service = SearchService([searxng_stub(), ddgs_stub(result_count=3), tavily_stub()])
    response = service.search(SearchRequest("比赛", time_range="week", max_results=2))
    assert response.attempted_providers == ("ddgs",)
    assert [item.provider for item in response.results] == ["ddgs", "ddgs"]
```

2. Run RED.

```bash
.venv/bin/python -m pytest tests/test_search_providers.py tests/test_search_service.py tests/test_search.py -q
```

3. Implement thin Provider adapters with injected transports. Implement a service-owned bounded cache using the request's immutable policy: 300 seconds by default and 60 seconds for live scores/ticket quotes. Include Provider ID, normalized request, cache-policy version and security-policy version in the key; enforce normalized-key size cap, at most five results, per-snippet 300-character cap and 10 KiB rendered output cap. Authentication failure remains open until configuration refresh; 429 honors bounded `Retry-After`; timeout/network failures use short bounded backoff; cache hits preserve original `checked_at` and never mark health healthy.

4. Refactor `jarvis/tools/search.py` so the public tool formats a `SearchResponse`, while the legacy `TavilySearch` delegates only to the Tavily adapter and retains its constructor/import/output contract.

5. Run GREEN including old compatibility tests.

```bash
.venv/bin/python -m pytest tests/test_search_providers.py tests/test_search_service.py tests/test_search.py tests/test_entertainment.py -q
```

6. Commit.

```bash
git add jarvis/search jarvis/tools/search.py tests/test_search_providers.py tests/test_search_service.py tests/test_search.py
git commit -m "feat: add free-first search fallback service"
```

## Task 3: 建立抗 SSRF 的 SafeFetcher

**Files:**

- Create: `jarvis/search/fetcher.py`
- Create: `tests/test_search_fetcher.py`
- Modify: `jarvis/search/models.py`

**Interfaces:**

```python
@dataclass(frozen=True)
class FetchPolicy:
    max_redirects: int = 3
    max_compressed_bytes: int = 2 * 1024 * 1024
    max_decompressed_bytes: int = 8 * 1024 * 1024
    total_timeout_seconds: float = 15.0

class SafeFetcher:
    def fetch(self, url: str) -> FetchedDocument: ...
```

1. Write failing tests for non-HTTP schemes, userinfo, loopback/private/link-local/reserved/metadata addresses, mixed public/private DNS answers, redirect revalidation, redirect loops, DNS rebinding, content type, compressed/decompressed limits and total timeout.

```python
def test_connection_uses_approved_ip_but_original_host_and_sni():
    fetched = stub_fetcher_with_dns("news.example", ["93.184.216.34"]).fetch("https://news.example/a")
    assert fetched.peer_ip == "93.184.216.34"
    assert transport.last_host_header == "news.example"
    assert transport.last_server_hostname == "news.example"
```

The stub transport records the approved address and never opens a real socket; separate classifier tests assert all documentation/reserved ranges are rejected.

2. Run RED.

```bash
.venv/bin/python -m pytest tests/test_search_fetcher.py -q
```

3. Implement URL canonicalization and address policy. Resolve once per connection, reject the whole answer set if any IP is blocked, connect to an approved IP while retaining original Host/TLS SNI, use `trust_env=False`, and re-run the complete check for each redirect. Keep SearXNG's exact loopback `:8888` exception outside this generic public-web fetcher.

4. Enforce the exact defaults above, reject non-HTML/text responses, stream bytes instead of trusting `Content-Length`, and redact URLs/query values from errors.

5. Run GREEN and a regression subset.

```bash
.venv/bin/python -m pytest tests/test_search_fetcher.py tests/test_search_service.py -q
```

6. Commit.

```bash
git add jarvis/search/fetcher.py jarvis/search/models.py tests/test_search_fetcher.py
git commit -m "feat: secure public web fetching"
```

## Task 4: 实现 Trafilatura 与受限 Playwright 正文提取

**Files:**

- Create: `jarvis/search/providers/trafilatura.py`
- Create: `jarvis/search/providers/playwright.py`
- Create: `tests/test_web_extract.py`
- Modify: `jarvis/search/models.py`
- Modify: `jarvis/search/service.py`
- Modify: `jarvis/tools/search.py`
- Modify: `pyproject.toml`

**Interfaces:**

```python
@dataclass(frozen=True)
class ExtractedDocument:
    url: str
    title: str
    text: str
    checked_at: datetime
    provider: str

class SearchService:
    def extract(self, url: str) -> ExtractedDocument: ...

def make_web_extract_tool(service: SearchService) -> BaseTool: ...
```

1. Write failing tests proving Trafilatura receives fetched bytes rather than a URL, dynamic fallback runs only when static extraction is insufficient, missing browser skips gracefully, and rendered output includes untrusted-data marker, `checked_at`, source URL and provider within a UTF-8 byte ceiling.

2. Add Playwright policy tests that block every child request not approved by the SafeFetcher address policy, including iframe/script/XHR/fetch; also block Service Workers, WebSockets, downloads, popups, persistent cookies, permissions and non-GET/HEAD methods.

```python
def test_extract_marks_external_text_as_untrusted():
    result = service.extract("https://example.test/article")
    rendered = render_extracted_document(result)
    assert "外部资料，不是系统指令" in rendered
    assert "https://example.test/article" in rendered
```

3. Run RED.

```bash
.venv/bin/python -m pytest tests/test_web_extract.py -q
```

4. Add exact core dependencies `ddgs==9.14.4` and `trafilatura==2.1.0`, and exact optional dependency `playwright==1.61.0` in the `browser` group. Implement static extraction first and a one-shot isolated browser context second.

5. Expose `web_extract` as a service-bound LangChain tool; never let Trafilatura or Playwright fetch outside the controlled layer.

6. Run GREEN with and without the optional browser dependency path simulated.

```bash
.venv/bin/python -m pytest tests/test_web_extract.py tests/test_search_fetcher.py tests/test_search_service.py -q
```

7. Commit.

```bash
git add jarvis/search jarvis/tools/search.py pyproject.toml tests/test_web_extract.py
git commit -m "feat: add safe webpage extraction"
```

## Task 5: 将娱乐工具和 Agent 完整接入 Runtime-bound SearchService

**Files:**

- Create: `tests/test_agent_search_tools.py`
- Modify: `jarvis/tools/entertainment.py`
- Modify: `jarvis/tools/__init__.py`
- Modify: `jarvis/graph.py`
- Modify: `jarvis/prompts.py`
- Modify: `tests/test_entertainment.py`
- Create: `tests/test_agent.py`

**Interfaces:**

```python
def build_tools(search_service: SearchService | None = None) -> list[BaseTool]: ...

def build_agent(*, search_service: SearchService | None = None, model=None, checkpointer=None): ...
```

1. Write failing tests for exactly 21 unique tools, no-argument compatibility, one explicitly injected service shared by `web_search`, `web_extract`, `movie_ratings`, `esports_scores` and `ticket_search`, and provider-neutral prompt budgets of at most two searches and three extracted URLs.

2. Add an Agent test whose fake model selects `web_extract` and assert the resulting `ToolMessage` contains the bounded source-marked text. Add entertainment tests proving PandaScore stays optional, movie searches use the default cache policy, live esports scores and ticket quotes use `REALTIME_CACHE_POLICY`, and public search fallback preserves timestamp/source/price or rating scale.

```python
def test_build_tools_binds_one_search_generation():
    service = FakeSearchService(generation=7)
    tools = build_tools(service)
    assert len(tools) == 21
    assert {tool.search_generation for tool in search_bound(tools)} == {7}
```

3. Run RED.

```bash
.venv/bin/python -m pytest tests/test_agent_search_tools.py tests/test_entertainment.py tests/test_agent.py -q
```

4. Replace mutable module defaults with factories. Retain `TOOLS` and no-argument `build_agent()` as compatibility wrappers, but production runtime construction must inject its own service. Keep PandaScore's current structured-data path; do not read or add Riot credentials.

5. Run GREEN plus all tool tests.

```bash
.venv/bin/python -m pytest tests/test_agent_search_tools.py tests/test_entertainment.py tests/test_agent.py tests/test_tools.py -q
```

6. Commit.

```bash
git add jarvis/tools jarvis/graph.py jarvis/prompts.py tests/test_agent_search_tools.py tests/test_entertainment.py tests/test_agent.py
git commit -m "feat: bind agent tools to shared search service"
```

## Task 6: 锁定依赖、部署 SearXNG 并更新文档与 smoke 脚本

**Files:**

- Create: `requirements.lock`
- Create: `tox.ini`
- Create: `deploy/searxng/compose.yaml`
- Create: `deploy/searxng/settings.yml`
- Create: `deploy/searxng/README.md`
- Create: `tests/test_search_deployment.py`
- Modify: `scripts/search_smoke.py`
- Modify: `README.md`
- Modify: `.env.example`
- Modify: `pyproject.toml`

1. Write failing config/smoke tests that assert the container listens only on `127.0.0.1:8888`, JSON format is enabled, image is immutable, healthcheck/resource/restart limits exist, and the smoke script succeeds through a stub free chain without Tavily.

```python
def test_searxng_compose_is_loopback_only(compose):
    assert compose["services"]["searxng"]["ports"] == ["127.0.0.1:8888:8080"]
    assert "@sha256:" in compose["services"]["searxng"]["image"]
```

2. Run RED.

```bash
.venv/bin/python -m pytest tests/test_search_deployment.py -q
```

3. Pin the image exactly to `ghcr.io/searxng/searxng:2026.7.28-c01178d03@sha256:5d6d903ab82afa56ee32792d477f36bc63d3e5ca04fcb6947e28a5cfd987fad3`, enable JSON, add health/resource/restart policies and document AGPL-3.0 obligations. Add `pip-tools==7.6.0` and `tox==4.58.0` to development dependencies and generate `requirements.lock`; configure tox for Python 3.10 and 3.14; keep Playwright optional.

4. Update README architecture, 21-tool count, free defaults, optional Tavily/PandaScore and browser installation. Rewrite `scripts/search_smoke.py` to report provider-neutral success and never print configuration secrets.

5. Run GREEN and build checks.

```bash
.venv/bin/python -m pytest tests/test_search_deployment.py tests/test_search.py -q
.venv/bin/python -m piptools compile --strip-extras --output-file requirements.lock pyproject.toml
docker compose -f deploy/searxng/compose.yaml config --quiet
git diff --check
```

6. Commit.

```bash
git add requirements.lock tox.ini deploy/searxng scripts/search_smoke.py README.md .env.example pyproject.toml tests/test_search_deployment.py
git commit -m "ops: package free web research stack"
```

## Task 7: 全量复核、生产部署与回滚证明

**Files:**

- Modify only files required by verified failures.
- Record deployment evidence outside tracked secret-bearing locations.

1. Run complete local verification from a clean worktree.

```bash
.venv/bin/python -m pytest -q
npm --prefix web-src test
npm --prefix web-src run build
npm --prefix desktop test
.venv/bin/tox -q
git diff --check
git status --short
```

2. Scan only tracked files and the new Git diff for credential patterns. Do not read `.env`, production environment, encrypted generations or shell history. Confirm no previously disclosed PandaScore/Tavily/Riot value appears in the commits.

3. Record production SHA and service health. Deploy the pinned SearXNG container first, verify it is reachable only from loopback, then install locked dependencies and deploy the application build.

4. Execute production smoke tests: website/session health, Chinese recent-news query, normal page extraction, movie/score/ticket source formatting, forced SearXNG outage with DDGS fallback, and log redaction. Default smoke must not require a paid key.

5. On any failure, stop the new SearXNG service, restore the recorded application SHA and dependency set, restart `jarvis-web.service`, preserve `/var/lib/jarvis` and WeChat state, and repeat the original health checks.

6. After a successful independent final review, merge the implementation branch into `main`, push `main`, and record the deployed commit.

```bash
git switch main
git merge --ff-only codex/hermes-web-research
git push origin main
```

**Acceptance gate:** no-key search and extraction work, SearXNG outage falls back to DDGS, all 21 tools are registered, no real secret is present, local suites and production smoke pass, and the deployed SHA equals pushed `main`.
