# README Live Screenshots Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 更新 README，并用三张 1600×1000 的真实生产截图展示主界面、多用户管理和每用户 Provider/API 设置。

**Architecture:** Playwright CLI 只操作当前生产网页并把截图写入 `docs/assets/readme/`。截图完成后先做尺寸、可读性和敏感信息检查，再修改 README 的上线状态、图片布局和操作说明；不改变生产账号、Provider 配置或用户数据。

**Tech Stack:** Markdown、PNG、Playwright CLI、Git、macOS `sips`。

## Global Constraints

- 只截取 `https://jws.gkgeek-set.cn` 当前生产页面。
- API Key、口令、Cookie、CSRF、二维码、微信联系人、真实对话和其他用户数据不得出现在图片或提交中。
- Provider 表单中的 API Key 与口令必须为空；不执行真实模型测试、不保存配置、不调用付费 API。
- 截图前后不创建、停用或修改用户，不改变服务器配置。
- 保留三张现有桌面图片；网页 PNG 必须为 1600×1000。
- 全部步骤由当前 Agent 内联执行，不创建子 Agent。

---

### Task 1: Capture production web screenshots

**Files:**
- Modify: `docs/assets/readme/web-dashboard.png`
- Create: `docs/assets/readme/web-provider-settings.png`
- Create: `docs/assets/readme/web-account-settings.png`

**Interfaces:**
- Consumes: 生产 Web 登录页、顶部“API 设置”和“账户设置”按钮。
- Produces: 三张 1600×1000 PNG，供 README 相对路径引用。

- [ ] **Step 1: Verify Playwright CLI prerequisite**

Run: `command -v npx >/dev/null 2>&1 && test -x "$HOME/.codex/skills/playwright/scripts/playwright_cli.sh"`

Expected: exit 0。

- [ ] **Step 2: Open a named headed session and log in**

Run the Playwright wrapper with a named session, open `https://jws.gkgeek-set.cn`, snapshot, fill the username and password refs, submit, then snapshot again. Credentials are used only for the live form and are never placed in repository files or shell logs.

Expected: the authenticated snapshot contains `admin · Owner`, `API 设置` and `账户设置`.

- [ ] **Step 3: Capture the dashboard**

Set the browser viewport to 1600×1000, wait for the authenticated dashboard, and write `docs/assets/readme/web-dashboard.png`.

Expected: the top navigation and dashboard are visible; no modal, QR code, API Key or password appears.

- [ ] **Step 4: Capture Provider settings**

Open `API 设置`, snapshot the modal, confirm the API Key and current-password inputs are empty, then write `docs/assets/readme/web-provider-settings.png`.

Expected: Provider, Base URL, model, blank secret fields, risk notice and action buttons are visible.

- [ ] **Step 5: Capture account settings**

Close Provider settings, open `账户设置`, expand `用户管理` without modifying any field, and write `docs/assets/readme/web-account-settings.png`.

Expected: current Owner identity and management controls are visible; password fields are empty and no extra account is created.

### Task 2: Validate screenshot privacy and image quality

**Files:**
- Inspect: `docs/assets/readme/*.png`

**Interfaces:**
- Consumes: Task 1 PNG files.
- Produces: approved screenshots with exact dimensions and no sensitive visual content.

- [ ] **Step 1: Verify dimensions and file types**

Run: `file docs/assets/readme/web-*.png` and `sips -g pixelWidth -g pixelHeight docs/assets/readme/web-*.png`.

Expected: every web PNG is 1600×1000 and recognized as PNG image data.

- [ ] **Step 2: Inspect all three screenshots visually**

Open each PNG with the local image viewer and check the visible account identity, empty password/API Key fields, modal cropping, text readability and absence of QR codes or conversation content.

Expected: all privacy and readability requirements pass; otherwise recapture only the failing image.

### Task 3: Update README content and image layout

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: the three approved PNG paths from Task 2.
- Produces: GitHub-renderable README with accurate 2026-08-13 production status and usage guidance.

- [ ] **Step 1: Update the production status copy**

Change the status date to 2026-08-13 and state that multi-user accounts and per-user Provider settings are deployed, while live paid-model and entertainment-result verification remains user-driven.

- [ ] **Step 2: Add the two-image feature table**

Immediately after `web-dashboard.png`, add a two-column HTML table referencing:

```html
<img src="docs/assets/readme/web-provider-settings.png" alt="JWS-Agent 每用户 Provider 与 API 设置" width="100%">
<img src="docs/assets/readme/web-account-settings.png" alt="JWS-Agent Owner 用户管理" width="100%">
```

- [ ] **Step 3: Add current online usage guidance**

Document that existing sessions must log in again after the account migration, the migrated Owner should immediately replace the temporary compatibility password, each user controls only their model Provider, and only Owner controls global search integrations. Preserve the non-commercial statement and exact developer names `陈文杰、钟俊琅`.

### Task 4: Verify, commit, and publish documentation

**Files:**
- Verify: `README.md`
- Verify: `docs/assets/readme/*.png`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: one clean documentation commit on `main`, pushed to `origin/main`.

- [ ] **Step 1: Validate README links and legal/security copy**

Run a local script that extracts every `docs/assets/readme/...` path from README and asserts the file exists. Run exact searches for `陈文杰、钟俊琅`, `禁止任何形式的商业使用`, `API Key 永不回显`, and the three new/updated web image paths.

Expected: all checks pass with zero missing files.

- [ ] **Step 2: Run formatting and secret scans**

Run `git diff --check` and scan tracked changes for credential-like assignments and known token prefixes while excluding explicit fake test fixtures.

Expected: zero formatting errors and zero production-secret matches.

- [ ] **Step 3: Commit and push**

Run:

```bash
git add README.md docs/assets/readme/web-dashboard.png \
  docs/assets/readme/web-provider-settings.png \
  docs/assets/readme/web-account-settings.png \
  docs/superpowers/plans/2026-08-13-readme-live-screenshots.md
git commit -m "docs: showcase multi-user provider settings"
git push origin main
```

Expected: `origin/main` equals the new local commit and the tracked worktree is clean.
