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
- The Electron renderer no longer has a server URL, direct backend `fetch`, authenticated header, token, or hardcoded credentials. The main process owns a safeStorage-encrypted, `0600` session file and a fixed operation whitelist; preload removes the legacy `jws_token` before renderer interaction.
- Sensitive scan found only the expected main-process token response parsing and preload removal of the legacy key; no renderer token/header/direct-fetch path and no `admin/admin` or `sk-` production value.

## Remaining concern

- The generated Web bundle still exceeds Vite's 500 kB advisory threshold; this predates the feature and is not a security regression. No production deployment or external network request was made.
