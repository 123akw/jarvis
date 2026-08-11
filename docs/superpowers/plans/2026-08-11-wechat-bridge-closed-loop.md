# Personal WeChat Bridge Closed-Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a production-ready personal WeChat bridge on `jws.gkgeek-set.cn` that supports QR login, persistent connection, private text-message round trips through J.A.R.V.I.S., restart recovery, and explicit disconnect.

**Architecture:** A single bridge state machine lives in `jarvis/wechat.py` and is exposed through three authenticated FastAPI endpoints. The React website and Electron settings page are status clients only; neither receives the WeChat token nor runs a local gateway. Production continues to run as the existing `jarvis-web.service` behind Nginx.

**Tech Stack:** Python 3.14, FastAPI, httpx, segno, LangGraph, pytest, React 19, Vite 7, Vitest, Testing Library, Electron 38, systemd, Nginx.

## Global Constraints

- The production target is `https://jws.gkgeek-set.cn` on `root@1.12.67.169:/opt/jarvis`.
- WeChat credentials must remain only in `JARVIS_DATA_DIR/wechat_token` with mode `0600`.
- API responses, logs, browser storage, HTML, and build artifacts must never contain `bot_token`.
- Group chats and non-text messages remain ignored.
- Only one QR polling generation and one message polling worker may own the active state.
- `wechat/ilink_gateway.py` remains a fallback and must not run concurrently with the built-in bridge for the same account.
- Production rollback must preserve `/var/lib/jarvis`.
- Completion requires automated tests, frontend build, online health checks, a real QR scan, a real reply, and restart recovery.

---

### Task 1: Specify the WeChat bridge state machine with failing tests

**Files:**
- Create: `tests/test_wechat.py`
- Reference: `jarvis/wechat.py`

**Interfaces:**
- Consumes: `WeChatBridge(agent_getter, chunk_text, data_dir_getter, client_factory, thread_factory, sleeper)`.
- Produces: executable specifications for `status()`, `connect()`, `disconnect()`, `resume_on_boot()`, `shutdown()`, `_poll_qrcode()`, `_handle_updates_response()`, and `_split_reply()`.

- [ ] **Step 1: Add deterministic fakes and the first state tests**

```python
import httpx
from types import SimpleNamespace

from jarvis.wechat import WeChatBridge


class FakeResponse:
    def __init__(self, payload=None, status_code=200):
        self.payload = payload or {}
        self.status_code = status_code

    def raise_for_status(self):
        if self.status_code >= 400:
            raise httpx.HTTPStatusError("failed", request=None, response=None)

    def json(self):
        return self.payload


class DeferredThread:
    created = []

    def __init__(self, target, args=(), daemon=False):
        self.target, self.args, self.daemon = target, args, daemon
        self.started = False
        self.__class__.created.append(self)

    def start(self):
        self.started = True

    def run(self):
        self.target(*self.args)


class FakeClient:
    def __init__(self, get_responses=(), post_responses=(), sent=None):
        self.get_responses = list(get_responses)
        self.post_responses = list(post_responses)
        self.get_calls = []
        self.post_calls = []
        self.sent = sent if sent is not None else []

    def get(self, url, **kwargs):
        self.get_calls.append((url, kwargs))
        return self.get_responses.pop(0)

    def post(self, url, **kwargs):
        self.post_calls.append((url, kwargs))
        if url.endswith("/sendmessage"):
            text = kwargs["json"]["msg"]["item_list"][0]["text_item"]["text"]
            self.sent.append(text)
        return self.post_responses.pop(0) if self.post_responses else FakeResponse({"ret": 0})

    def close(self):
        pass


def make_bridge(tmp_path, client, reply="收到"):
    agent_calls = []

    class FakeAgent:
        def invoke(self, state, config):
            agent_calls.append({
                "text": state["messages"][0]["content"],
                "thread_id": config["configurable"]["thread_id"],
            })
            return {"messages": [SimpleNamespace(content=reply)]}

    DeferredThread.created.clear()
    bridge = WeChatBridge(
        agent_getter=lambda: FakeAgent(),
        chunk_text=lambda content: str(content),
        data_dir_getter=lambda: tmp_path,
        client_factory=lambda: client,
        thread_factory=DeferredThread,
        sleeper=lambda _seconds: None,
    )
    bridge.agent_calls = agent_calls
    return bridge


def make_connected_bridge(tmp_path):
    bridge = make_bridge(tmp_path, FakeClient())
    bridge._generation = 1
    bridge._set(state="connected")
    (tmp_path / "wechat_token").write_text("saved", encoding="utf-8")
    return bridge


def test_connect_returns_svg_qr_and_is_idempotent(tmp_path):
    client = FakeClient(get_responses=[FakeResponse({
        "ret": 0,
        "qrcode": "qr-id",
        "qrcode_img_content": "https://liteapp.weixin.qq.com/q/example?x=1",
    })])
    bridge = make_bridge(tmp_path, client)
    first = bridge.connect()
    second = bridge.connect()
    assert first["state"] == second["state"] == "waiting"
    assert first["qr_uri"].startswith("data:image/svg+xml")
    assert len(DeferredThread.created) == 1
    assert len(client.get_calls) == 1


def test_stale_qr_worker_cannot_replace_new_generation(tmp_path):
    bridge = make_bridge(tmp_path, FakeClient())
    bridge._generation = 4
    bridge._set(state="waiting")
    bridge._confirm_login(3, "stale-token")
    assert bridge.status()["state"] == "waiting"
    assert not (tmp_path / "wechat_token").exists()
```

- [ ] **Step 2: Run the state tests and verify RED**

Run: `.venv/bin/python -m pytest tests/test_wechat.py -q`

Expected: collection or assertion failure because `WeChatBridge` and its generation-safe methods do not exist.

- [ ] **Step 3: Add message, invalid-token, disconnect, and resume specifications**

```python
def test_private_text_invokes_contact_thread_and_sends_chunked_reply(tmp_path):
    sent = []
    client = FakeClient(sent=sent)
    bridge = make_bridge(tmp_path, client, reply="甲" * 3100)
    bridge._handle_updates_response(client, "token", {
        "get_updates_buf": "next",
        "msgs": [{
            "message_type": 1,
            "from_user_id": "contact-123456789012@example",
            "context_token": "ctx",
            "item_list": [{"type": 1, "text_item": {"text": "你好"}}],
        }],
    })
    assert bridge.agent_calls[0]["thread_id"] == "wx-123456789012"
    assert [len(item) for item in sent] == [1500, 1500, 100]


def test_group_and_non_text_messages_are_ignored(tmp_path):
    client = FakeClient()
    bridge = make_bridge(tmp_path, client)
    bridge._handle_updates_response(client, "token", {"msgs": [
        {"message_type": 1, "from_user_id": "g@im.chatroom", "item_list": []},
        {"message_type": 2, "from_user_id": "person", "item_list": []},
    ]})
    assert bridge.agent_calls == []


def test_unauthorized_update_clears_token_and_returns_idle(tmp_path):
    bridge = make_connected_bridge(tmp_path)
    bridge._handle_unauthorized(bridge._generation)
    assert bridge.status()["state"] == "idle"
    assert "重新扫码" in bridge.status()["error"]
    assert not (tmp_path / "wechat_token").exists()


def test_disconnect_and_resume_manage_persisted_token(tmp_path):
    (tmp_path / "wechat_token").write_text("saved", encoding="utf-8")
    bridge = make_bridge(tmp_path, FakeClient())
    assert bridge.resume_on_boot()["state"] == "connected"
    assert bridge.disconnect()["state"] == "idle"
    assert not (tmp_path / "wechat_token").exists()
```

- [ ] **Step 4: Run the expanded suite and verify RED for each new behavior**

Run: `.venv/bin/python -m pytest tests/test_wechat.py -q`

Expected: failures name the missing state-machine, message-routing, chunking, and lifecycle behavior.

### Task 2: Implement the generation-safe server bridge

**Files:**
- Replace: `jarvis/wechat.py`
- Test: `tests/test_wechat.py`

**Interfaces:**
- Consumes: iLink endpoints `get_bot_qrcode`, `get_qrcode_status`, `getupdates`, and `sendmessage`.
- Produces: module wrappers `init()`, `status()`, `connect()`, `disconnect()`, `resume_on_boot()`, and `shutdown()` backed by one `WeChatBridge` instance.

- [ ] **Step 1: Implement the bridge constructor and public state API**

```python
class WeChatBridge:
    def __init__(self, agent_getter=None, chunk_text=None, data_dir_getter=None,
                 client_factory=None, thread_factory=None, sleeper=None):
        self._agent_getter = agent_getter
        self._chunk_text = chunk_text
        self._data_dir_getter = data_dir_getter or config.data_dir
        self._client_factory = client_factory or (lambda: httpx.Client(trust_env=False))
        self._thread_factory = thread_factory or threading.Thread
        self._sleep = sleeper or time.sleep
        self._lock = threading.RLock()
        self._state = {"state": "idle", "qr_uri": "", "error": "", "since": ""}
        self._generation = 0
        self._updates_stop = threading.Event()
        self._updates_thread = None
```

`connect()` must change the state to `loading` while holding the lock, release the lock for the network request, validate `ret`, `qrcode`, and `qrcode_img_content`, create the SVG URI with `segno.make(scan_url).svg_data_uri(scale=4, border=2)`, and start one deferred QR worker for the current generation.

- [ ] **Step 2: Implement scan confirmation and persisted-token recovery**

`_poll_qrcode(generation, qrcode)` must ignore stale generations, tolerate read timeouts, accept only `status == "confirmed"` with a non-empty `bot_token`, and expire after 180 seconds. `_confirm_login()` must re-check the generation before writing the token with mode `0600` and starting the updates worker.

- [ ] **Step 3: Implement message routing, reply chunking, and send failure isolation**

```python
@staticmethod
def _split_reply(text: str, limit: int = 1500) -> list[str]:
    text = text.strip()
    return [text[i:i + limit] for i in range(0, len(text), limit)] or ["（贾维斯没有生成文本回复。）"]
```

`_handle_updates_response()` must update the buffer, accept only private text messages, invoke the Agent under `wx-<last 12 identifier characters>`, and send every chunk using the original `context_token`. Each `sendmessage` response must be checked independently so one send failure cannot terminate updates polling.

- [ ] **Step 4: Implement stop, disconnect, invalid-token, and shutdown behavior**

`disconnect()` increments the generation, signals the existing worker, clears its reference, deletes the token, and returns `idle`. `shutdown()` signals workers without deleting the token. A `401` from `getupdates` deletes the token and returns `idle` with a rescan message.

- [ ] **Step 5: Run backend tests GREEN and refactor without changing behavior**

Run: `.venv/bin/python -m pytest tests/test_wechat.py -q`

Expected: all bridge tests pass.

- [ ] **Step 6: Commit the backend state machine**

```bash
git add jarvis/wechat.py tests/test_wechat.py pyproject.toml
git commit -m "feat: 完成个人微信桥接状态机"
```

### Task 3: Protect and lifecycle-manage the FastAPI endpoints

**Files:**
- Create: `tests/test_wechat_api.py`
- Modify: `jarvis/server.py`

**Interfaces:**
- Consumes: module wrappers from `jarvis.wechat`.
- Produces: authenticated `/api/wechat/status`, `/api/wechat/connect`, and `/api/wechat/disconnect`; startup recovery and shutdown signaling.

- [ ] **Step 1: Write endpoint authorization and delegation tests**

```python
def test_wechat_endpoints_require_login():
    client = TestClient(server.app)
    assert client.get("/api/wechat/status").status_code == 401
    assert client.post("/api/wechat/connect").status_code == 401
    assert client.post("/api/wechat/disconnect").status_code == 401


def test_authenticated_wechat_endpoints_delegate(monkeypatch):
    client = TestClient(server.app)
    token = client.post("/api/login", json={"username": "admin", "password": "admin"}).json()["token"]
    monkeypatch.setattr(server.wechat, "status", lambda: {"state": "idle"})
    monkeypatch.setattr(server.wechat, "connect", lambda: {"state": "waiting"})
    monkeypatch.setattr(server.wechat, "disconnect", lambda: {"state": "idle"})
    headers = {"X-JWS-Token": token}
    assert client.get("/api/wechat/status", headers=headers).json()["state"] == "idle"
    assert client.post("/api/wechat/connect", headers=headers).json()["state"] == "waiting"
    assert client.post("/api/wechat/disconnect", headers=headers).json()["state"] == "idle"


def test_app_lifespan_resumes_and_shuts_down_wechat(monkeypatch):
    calls = []
    monkeypatch.setattr(server.wechat, "resume_on_boot", lambda: calls.append("resume"))
    monkeypatch.setattr(server.wechat, "shutdown", lambda: calls.append("shutdown"))
    with TestClient(server.app):
        assert calls == ["resume"]
    assert calls == ["resume", "shutdown"]
```

- [ ] **Step 2: Run endpoint tests and verify RED where lifecycle handling is absent**

Run: `.venv/bin/python -m pytest tests/test_wechat_api.py -q`

Expected: endpoint assertions pass only where existing code is complete; the new shutdown/lifespan assertion fails.

- [ ] **Step 3: Replace deprecated startup hook with a FastAPI lifespan**

```python
@asynccontextmanager
async def lifespan(_app: FastAPI):
    wechat.resume_on_boot()
    yield
    wechat.shutdown()


app = FastAPI(title="J.A.R.V.I.S.", lifespan=lifespan)
```

Initialize the bridge callbacks after `_get_agent` and `_chunk_text` exist, while ensuring imports do not start network traffic.

- [ ] **Step 4: Run endpoint and full Python suites GREEN**

Run: `.venv/bin/python -m pytest tests/test_wechat_api.py -q && .venv/bin/python -m pytest -q`

Expected: every Python test passes and the FastAPI `on_event` deprecation warning is gone.

- [ ] **Step 5: Commit the API lifecycle changes**

```bash
git add jarvis/server.py tests/test_wechat_api.py
git commit -m "feat: 接通微信桥 API 生命周期"
```

### Task 4: Complete and test the React QR flow

**Files:**
- Create: `web-src/src/WeChatConnect.test.jsx`
- Create: `web-src/src/Hud.wechat.test.jsx`
- Modify: `web-src/package.json`
- Modify: `web-src/package-lock.json`
- Modify: `web-src/vite.config.js`
- Modify: `web-src/src/WeChatConnect.jsx`
- Modify: `web-src/src/Hud.jsx`
- Modify: `web-src/src/styles.css`
- Regenerate: `jarvis/web/index.html`
- Regenerate: `jarvis/web/assets/index-*.js`
- Regenerate: `jarvis/web/assets/index-*.css`

**Interfaces:**
- Consumes: authenticated relative API routes and state fields `state`, `qr_uri`, `error`, and `since`.
- Produces: an accessible HUD button and modal covering idle, loading, waiting, connected, and error states.

- [ ] **Step 1: Add the test command, jsdom environment, and UI dev dependencies**

Add `"test": "vitest run"` and dev dependencies `vitest`, `jsdom`, `@testing-library/react`, `@testing-library/user-event`, and `@testing-library/jest-dom`; add `test: { environment: 'jsdom' }` to `vite.config.js`; run `npm install` in `web-src` to update the lockfile.

- [ ] **Step 2: Write the failing HUD entry test**

```jsx
it('opens the personal WeChat dialog from the HUD header', async () => {
  render(<Hud onLogout={() => {}} />)
  await userEvent.click(screen.getByRole('button', { name: '接入个人微信' }))
  expect(screen.getByRole('dialog', { name: '接入个人微信' })).toBeInTheDocument()
})
```

Mock `Chat`, `Panels`, `Threads`, and `MossMini` so the test isolates HUD composition.

- [ ] **Step 3: Run the HUD test and verify RED**

Run: `cd web-src && npm test -- Hud.wechat.test.jsx`

Expected: no button named “接入个人微信” exists.

- [ ] **Step 4: Write modal state and authentication-expiry tests**

```jsx
it('renders a live QR returned by the bridge', async () => {
  global.fetch = vi.fn().mockResolvedValue({
    status: 200,
    json: async () => ({ state: 'waiting', qr_uri: 'data:image/svg+xml,qr', since: '13:30:00' }),
  })
  render(<WeChatConnect onClose={() => {}} onExpired={() => {}} />)
  const qr = await screen.findByRole('img', { name: '微信登录二维码' })
  expect(qr).toHaveAttribute('src', 'data:image/svg+xml,qr')
})

it('reports expired authentication and clears polling on unmount', async () => {
  const expired = vi.fn()
  const clear = vi.spyOn(global, 'clearInterval')
  global.fetch = vi.fn().mockResolvedValue({ status: 401 })
  const view = render(<WeChatConnect onClose={() => {}} onExpired={expired} />)
  await waitFor(() => expect(expired).toHaveBeenCalledTimes(1))
  view.unmount()
  expect(clear).toHaveBeenCalled()
})
```

- [ ] **Step 5: Implement the HUD entry, modal accessibility, and polling cleanup**

Add a header button with `aria-label="接入个人微信"`, render `<WeChatConnect onClose={() => setWxOpen(false)} onExpired={onLogout} />` when open, add `role="dialog"`, `aria-modal="true"`, and `aria-label="接入个人微信"`, and keep one two-second timer per mounted modal.

- [ ] **Step 6: Add responsive modal and QR styles**

Use a fixed backdrop above HUD drawers, a maximum 480px card, a 260px white QR frame, keyboard-visible buttons, and a mobile rule that keeps the QR within `min(72vw, 260px)`.

- [ ] **Step 7: Run UI tests and production build GREEN**

Run: `cd web-src && npm test && npm run build`

Expected: Vitest passes and Vite writes the new hashed assets under `jarvis/web`.

- [ ] **Step 8: Commit the website flow and build output**

```bash
git add web-src jarvis/web
git commit -m "feat: 上线网页微信扫码入口"
```

### Task 5: Complete and verify the Electron settings flow

**Files:**
- Create: `tests/test_desktop_wechat.py`
- Modify: `desktop/index.html`
- Modify: `desktop/renderer.js`

**Interfaces:**
- Consumes: desktop `api()` helper with `X-JWS-Token` authentication.
- Produces: `#wx-area`, `#wx-state`, generated QR display, one settings-scoped poll timer, and disconnect/reconnect controls.

- [ ] **Step 1: Write failing desktop structure and lifecycle tests**

```python
def test_desktop_settings_contains_wechat_controls():
    html = Path("desktop/index.html").read_text(encoding="utf-8")
    assert 'id="wx-area"' in html
    assert 'id="wx-state"' in html


def test_desktop_settings_starts_and_stops_wechat_polling():
    source = Path("desktop/renderer.js").read_text(encoding="utf-8")
    assert "wxTimer = setInterval(pollWx, 2000)" in source
    assert "clearInterval(wxTimer)" in source
    assert "pollWx()" in source
```

- [ ] **Step 2: Run the desktop tests and verify RED**

Run: `.venv/bin/python -m pytest tests/test_desktop_wechat.py -q`

Expected: missing HTML controls and timer lifecycle assertions fail.

- [ ] **Step 3: Add settings markup, styling, and guarded rendering**

Add a “个人微信” settings section containing `#wx-area` and `#wx-state`; style a white 220px QR frame and consistent connect/disconnect buttons. `renderWx()` must return safely if the controls are absent and must set image `alt` text.

- [ ] **Step 4: Start polling on settings open and stop it on back**

`openSettings()` calls `pollWx()` immediately, clears any previous timer, then assigns `wxTimer = setInterval(pollWx, 2000)`. The back handler clears the timer and sets it to `null`.

- [ ] **Step 5: Verify desktop tests and JavaScript syntax GREEN**

Run: `.venv/bin/python -m pytest tests/test_desktop_wechat.py -q && node --check desktop/renderer.js && node --check desktop/main.js`

Expected: all checks pass.

- [ ] **Step 6: Commit the desktop flow**

```bash
git add desktop/index.html desktop/renderer.js tests/test_desktop_wechat.py
git commit -m "feat: 接通桌面端微信扫码设置"
```

### Task 6: Repair the fallback gateway and document the default path

**Files:**
- Modify: `wechat/ilink_gateway.py`
- Modify: `wechat/README.md`
- Modify: `README.md`
- Test: `tests/test_wechat_gateway.py`

**Interfaces:**
- Consumes: verified iLink contract where `qrcode_img_content` is an HTTPS URL on `liteapp.weixin.qq.com`, not Base64 image data.
- Produces: `write_qr_png(content: str, path: Path) -> None`, a working fallback QR image, and documentation that prioritizes the website bridge.

- [ ] **Step 1: Write a failing QR rendering regression test**

```python
def test_write_qr_png_encodes_ilink_url(tmp_path):
    out = tmp_path / "wechat-login.png"
    write_qr_png("https://liteapp.weixin.qq.com/q/test?x=1", out)
    assert out.read_bytes().startswith(b"\x89PNG\r\n\x1a\n")
```

Change `login()` to call this function with `data.get("qrcode_img_content") or data["qrcode"]`.

- [ ] **Step 2: Run the gateway test and verify RED**

Run: `.venv/bin/python -m pytest tests/test_wechat_gateway.py -q`

Expected: the current Base64 decoding path fails.

- [ ] **Step 3: Generate the fallback PNG with segno and update documentation**

Use `segno.make(qrcode_img_content or qrcode).save(png, scale=8, border=2)`. Document the website workflow, token location, dedicated-account warning, fallback command, and prohibition on running both bridges simultaneously.

- [ ] **Step 4: Run gateway and full suites GREEN**

Run: `.venv/bin/python -m pytest tests/test_wechat_gateway.py -q && .venv/bin/python -m pytest -q`

- [ ] **Step 5: Commit gateway and documentation changes**

```bash
git add wechat README.md tests/test_wechat_gateway.py
git commit -m "fix: 修复备用微信网关二维码生成"
```

### Task 7: Perform local integration verification

**Files:**
- Verify: all changed files

**Interfaces:**
- Consumes: completed local implementation.
- Produces: a clean test/build report and a release commit ready for production.

- [ ] **Step 1: Run whitespace, Python, frontend, and desktop checks**

```bash
git diff --check
.venv/bin/python -m pytest -q
cd web-src && npm test && npm run build
cd .. && node --check desktop/renderer.js && node --check desktop/main.js
```

- [ ] **Step 2: Start a local server and exercise authenticated status APIs**

Run the server on port `7790`, log in with the existing admin credential, verify unauthenticated status is `401` and authenticated status is `idle`. Generate one live QR, assert the JSON keys are a subset of `state`, `qr_uri`, `error`, and `since`, then immediately call disconnect so the temporary QR worker exits.

- [ ] **Step 3: Use Playwright to verify the website dialog**

Open the local site, log in, click “接入个人微信”, confirm the accessible dialog and generate button, generate a live QR, verify the image renders, then disconnect so the temporary QR worker exits.

- [ ] **Step 4: Review the final diff and commit build changes if Vite changed hashes**

```bash
git status --short
git diff --check
git add jarvis/web
git commit -m "build: 刷新微信接入前端产物"
```

Skip the final commit only when `git status --short` shows no build changes.

### Task 8: Deploy, expose the QR, and complete the real online loop

**Files:**
- Deploy: local Git branch to `origin/main`
- Deploy: `root@1.12.67.169:/opt/jarvis`
- Create after QR generation: `/Users/chenwenjie/Desktop/贾维斯-微信登录二维码.svg`

**Interfaces:**
- Consumes: verified release commits and existing SSH/systemd access.
- Produces: a healthy online bridge and a fresh QR shown both in the website dialog and on the local desktop.

- [ ] **Step 1: Record the rollback SHA and production health**

```bash
ssh root@1.12.67.169 'cd /opt/jarvis && git rev-parse HEAD && systemctl is-active jarvis-web.service'
curl -fsS https://jws.gkgeek-set.cn/api/session
```

Expected baseline: SHA `01eb549a05e1bd1b1470b532f164228cb3dc0312`, service `active`, and `{"authed":false}`.

- [ ] **Step 2: Push release commits and fast-forward production**

```bash
git push origin main
ssh root@1.12.67.169 'cd /opt/jarvis && git fetch origin && git merge --ff-only origin/main && .venv/bin/pip install -e .'
```

- [ ] **Step 3: Restart and check production**

```bash
ssh root@1.12.67.169 'systemctl restart jarvis-web.service && systemctl is-active jarvis-web.service && journalctl -u jarvis-web.service -n 60 --no-pager'
curl -fsS https://jws.gkgeek-set.cn/api/session
```

If health fails, switch `/opt/jarvis` back to the recorded SHA, reinstall the editable package, restart `jarvis-web.service`, and re-run both checks. Do not modify `/var/lib/jarvis`.

- [ ] **Step 4: Generate the online QR and save a desktop copy**

Log into the production website, call `POST /api/wechat/connect`, obtain `qr_uri`, show it in the open website dialog, decode the SVG data URI, and write it to `/Users/chenwenjie/Desktop/贾维斯-微信登录二维码.svg` with mode `0600`.

- [ ] **Step 5: Pause for the user to scan and confirm connection**

Tell the user the site is online and provide the clickable desktop SVG. Poll `GET /api/wechat/status` until it changes from `waiting` to `connected`, without displaying credentials.

- [ ] **Step 6: Verify a real message round trip and restart recovery**

Ask the user to send `贾维斯微信闭环测试 2026-08-11` from another contact and confirm the reply arrives. Restart `jarvis-web.service`, verify status returns to `connected`, then ask for `重启后闭环测试` and confirm the second reply.

- [ ] **Step 7: Report completion**

Report the deployed commit, automated test counts, website URL, systemd health, QR scan status, first reply status, and restart-recovery status. Leave the bridge connected unless the user asks to disconnect.
