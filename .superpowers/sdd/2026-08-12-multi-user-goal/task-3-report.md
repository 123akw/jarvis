# Task 3 report — multi-user UI and desktop session boundary

Status: complete for the Task 3 scope.

## RED → GREEN

- RED: `web-src/src/AccountSettings.test.jsx` initially could not resolve the absent account settings module; `desktop/session.test.js` initially could not resolve the absent main-process session gateway.
- GREEN: Account settings covers signed-in username/role, Member management absence, Owner create/password clearing, own password re-login, and admin 401 handoff (**4 passed**). The existing Web CSRF test was extended for its write response.
- RED: an explicit `nodeIntegration:false` wiring assertion failed against the initial BrowserWindow options.
- GREEN: `desktop/auth.test.js` now verifies the narrow IPC wiring, preload legacy-token cleanup before renderer scripts, initial fail-closed login overlay, `webSecurity:true`, and lack of renderer fetch/header/token paths. `desktop/session.test.js` verifies URL allowlisting, safeStorage encryption/mode `0600`, 401 removal, restoration and fail-closed unavailable encryption.

## Acceptance

- `node --test desktop/*.test.js` → **11 passed**.
- `npm --prefix web-src test -- --run` → **10 passed**.
- `npm --prefix web-src run build` → succeeded; generated `jarvis/web` assets updated. Existing Vite bundle-size warning remains.
- `.venv/bin/python -m pytest tests/test_{accounts,auth,threads,tenant_isolation,wechat,wechat_api,openai_api}.py -q` → **75 passed**, one pre-existing FastAPI/TestClient deprecation warning.
- `git diff --check` → succeeded.

## Security and delivery notes

- Web retains the full server session object, shows username/role, sends CSRF on every account write, and routes 401 back to the app login boundary. Only Owner sees WeChat and user-management controls; the server remains the enforcement boundary.
- The Electron renderer may display/edit the allowlisted self-hosted server endpoint, but has no direct backend `fetch`, authenticated header, token, ciphertext, or hardcoded credentials. The main process owns a safeStorage-encrypted, `0600` session file and a fixed operation whitelist; preload removes the legacy `jws_token` before renderer interaction.
- Sensitive scan found only the expected main-process token response parsing and preload removal of the legacy key; no renderer token/header/direct-fetch path and no `admin/admin` or `sk-` production value.

## Remaining concern

- The generated Web bundle still exceeds Vite's 500 kB advisory threshold; this predates the feature and is not a security regression. No production deployment or external network request was made.

## Review fix round 1

- RED: desktop security/IPC/login-controller modules were absent; request bodies, sender frames, navigation, persistence ordering, origin binding and incremental SSE contracts failed **8 desktop tests**. Web logout CSRF cleanup, password-change notice persistence, failed reset retention and logout fail-closed behavior failed **5 tests**.
- Desktop GREEN: every IPC handler now verifies the current local `index.html` main frame; navigation and new windows are denied; settings, credentials and every API operation have exact schemas, fixed `desktop` thread and bounded fields. Login atomically persists origin-bound safeStorage ciphertext before publishing the in-memory token; persistence/decrypt/server-switch failures fail closed.
- Streaming GREEN: main parses SSE incrementally with per-event, total-byte and event-count limits and forwards only parsed events on one fixed IPC channel. Renderer paints tokens as they arrive, can cancel, and returns 401 to the login overlay. The first unauthenticated launch automatically expands while preserving allowlisted self-hosted server configuration.
- Web GREEN: all account writes carry CSRF; any 401 or logout attempt clears CSRF. Password-change reason survives AccountSettings unmount into Login; all Owner actions, reset failure retention, narrow long usernames and Member WeChat hiding are covered.
- Reviewer Important 1 pushback: the desktop server endpoint remains visible/editable because the Task 3 brief and self-hosted product flow require it, and an endpoint is not an authentication secret. Renderer still cannot perform backend `fetch`, construct auth headers, or access token/ciphertext; all network and authentication authority remains in validated main-process handlers.
- Focused final verification: `node --test desktop/*.test.js` → **30 passed**; `npm --prefix web-src test -- --run` → **16 passed**; Web build and the specified Python account/auth/thread/tenant/WeChat/OpenAI suite passed. The existing FastAPI TestClient deprecation and Vite bundle-size advisories remain unchanged.

## Review fix round 2

- RED: the focused Desktop regression run produced **4 failures**: ordinary requests had no shared 401 boundary, stream 401 resolved after prompting instead of terminating through that boundary, and the invalid-legacy-server recovery/save-failure gateway path did not exist.
- GREEN: dashboard, history, thread deletion, coding sync and WeChat requests now share one authenticated request wrapper. A 401 expands the fail-closed login overlay and raises a typed authentication error, so deletion cannot render success, coding cannot hide expiration, and dashboard does not mislabel expiration as a network failure. Re-login permits a clean retry.
- Server repair: applying a validated HTTPS endpoint no longer constructs the invalid legacy endpoint. It clears any live/stale credential, builds a fresh gateway for the validated origin, then persists and publishes it; persistence failure leaves gateway authority unpublished and the repair retryable.
- Streaming: stream 401 now has one responsibility point, which prompts once and rejects with the same typed authentication error; the renderer no longer prompts a second time.
- Focused final verification: `node --test desktop/*.test.js` → **33 passed**; `node --check desktop/main.js`, `node --check desktop/renderer.js`, and `git diff --check` succeeded. Web and Python were not rerun because this round changed only Desktop code and this report.

## Final whole-branch fix wave

- RED contracts covered unsafe copied bootstrap placeholders, cross-account/source login throttling, raw Electron event exposure, and concurrent legacy backup publication.
- GREEN: `.env.example` now leaves secrets empty and bootstrap rejects documented placeholders; login throttling uses bounded normalized identity buckets plus a shared source spray budget; preload event subscriptions expose only approved primitive values; legacy backups publish complete `0600` files atomically through unique temporary files.
- README now identifies both SQLite databases, legacy JSON snapshots and the independent WeChat token, with stopped-service/SQLite-safe backup and explicit rollback mapping.
- Focused verification: `.venv/bin/python -m pytest tests/test_accounts.py tests/test_tenant_isolation.py -q` → **44 passed**, one existing TestClient deprecation warning; `node --test desktop/preload-api.test.js desktop/auth.test.js` → **3 passed**; `git diff --check` succeeded.
