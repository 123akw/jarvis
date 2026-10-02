# 部署指南

[← 返回 README](../README.md) · [功能](features.md) · [配置](configuration.md) · [微信与飞书](channels.md) · [架构](architecture.md) · [开发与测试](development.md) · [FAQ](faq.md)

**目录**：[运行要求](#运行要求) · [安装](#1-安装-python-环境) · [网页端](#2-启动网页端) · [终端](#3-使用终端) · [桌面端](#4-启动-macos-桌面悬浮窗) · [运行时 secret](#私有部署的运行时-secret) · [多用户、备份与回滚](#多用户备份与回滚) · [演示入口与上线状态](#演示入口与上线状态)

## 运行要求

- Python 3.10 或更高版本。
- Node.js 与 npm：仅桌面端需要。
- macOS：当前 Electron 悬浮窗使用 LaunchAgent、全局快捷键和 macOS 窗口行为，桌面端按 macOS 设计；Web 与 CLI 后端本身是 Python 应用。
- 一个 OpenAI 兼容模型的 API key；默认配置面向 DeepSeek，也可使用 OpenAI、百炼、SiliconFlow 或自定义 HTTPS 中转。

## 1. 安装 Python 环境

在项目根目录执行：

```bash
python3 -m venv .venv
.venv/bin/pip install -e ".[dev]"
cp .env.example .env
```

然后至少填写 `JARVIS_API_KEY` 或与 `JARVIS_PROVIDER` 对应的兼容密钥；同时必须填好 `JARVIS_ADMIN_USERNAME`、`JARVIS_ADMIN_PASSWORD` 与 `JARVIS_SESSION_SECRET`（可用 `openssl rand -hex 32` 生成）——这三项留空时首次启动不会创建 Owner，网页端会 fail closed 无法登录。请勿提交 `.env`。实时网页查询默认可使用 DDGS，无需付费搜索 key。若已启动仓库提供的本地 SearXNG，可按 [配置参考](configuration.md#环境变量) 配置其 loopback 地址；Tavily 仅在你主动选择该可选增强时才需要 key。全部变量见 [配置参考](configuration.md)。

默认静态提取不需要浏览器。需要处理动态页面时，改用 browser extra 并单独安装 Chromium：

```bash
.venv/bin/pip install -e ".[dev,browser]"
.venv/bin/python -m playwright install chromium
.venv/bin/python -c "from playwright.sync_api import sync_playwright; p=sync_playwright().start(); b=p.chromium.launch(); b.close(); p.stop()"
```

最后一条只启动并关闭本机 Chromium，不访问任何 URL。未安装 Playwright 或 Chromium 时，静态提取仍可用，动态回退会明确跳过。

## 2. 启动网页端

```bash
.venv/bin/jarvis-web
```

默认监听 `http://127.0.0.1:7789`。首位 Owner 在首次启动时由 `.env` 中的 `JARVIS_ADMIN_USERNAME`/`JARVIS_ADMIN_PASSWORD` 自动创建；用它登录后，在右上角头像菜单「账户设置」的「用户管理」里可邀请 Member（没有公开注册入口），Member 用被分配的用户名口令登录即可，各自的数据完全隔离。登录后可创建和删除会话、查看历史、停止生成、复制回复，并在「今日」板查看日程、待办和备忘；后端每轮对话后继续使用同一条线程记忆。

语音通话、会议纪要、语音唤醒、通话场景与情绪、发图片 / 视频的用法见 [功能详解 · 使用指南](features.md#使用指南)。

## 3. 使用终端

```bash
.venv/bin/jarvis
.venv/bin/jarvis --once "现在几点了"
.venv/bin/jarvis --thread work
```

交互模式输入 `quit` 或 `exit` 退出。`--once` 单发一句后结束；`--thread` 可将工作、生活等上下文拆为不同记忆线程。

## 4. 启动 macOS 桌面悬浮窗

先确保可访问一个正在运行的 JWS-Agent Web 服务，再执行：

```bash
cd desktop && npm install && npm start
```

首次启动会自动展开登录面板，可在登录面板或设置页把服务器地址改为 HTTPS 私有部署地址；只在设置 `JWS_DESKTOP_DEV=1` 时允许本机 `http://127.0.0.1` / `[::1]` 开发地址。桌面端会要求输入用户名和口令，认证 Token 只由 Electron 主进程保存于系统加密存储，渲染界面无法读取。悬浮球置顶并跨工作区显示，点击后向左展开快捷聊天；默认全局唤醒键为 `⌥Space`，也可修改或停用。

**打包成 Mac 应用（推荐日常使用）**：

```bash
cd desktop && npm install
npm run pack:mac                 # 出 desktop/out/贾维斯-darwin-arm64/贾维斯.app（ad-hoc 签名，已声明 jws:// 协议）
npm run install:mac              # 退出开发版 → 装到 ~/Applications/贾维斯.app → 登记 jws:// → 打开
npm run install:mac -- --login   # 同上，并打开「开机自启」
```

打包版与 `npm start` 共用 `~/Library/Application Support/jws-desktop`（登录态、设置、单实例锁），首次启动如弹出钥匙串提示「贾维斯想要使用 jws-desktop Safe Storage」，点「始终允许」即可沿用原登录态（ad-hoc 签名每次重新打包都会再问一次；设 `JWS_SIGN_IDENTITY` 用固定证书签名可免）。开机自启：打包版登记为系统登录项（系统设置 → 通用 → 登录项），开发版仍用 `~/Library/LaunchAgents/com.jws.jarvis.desktop.plist`。

**网页「桌面悬浮窗」一键唤起**：网页先探测本机 `127.0.0.1:17789`，在跑就直接唤起并接管登录态；探不到会带一次性票据打开 `jws://handoff`，把装好的贾维斯拉起来并在约 6 秒内自动完成接管。浏览器限制：Chrome / Edge 142+ 首次会询问是否允许本网站访问「此设备上的应用」，点「允许」（拒绝过的话在地址栏左侧网站设置里改回允许）；Safari 不允许 https 网页直连本机，只能经 `jws://` 由系统打开，询问「是否允许此网页打开“贾维斯”」时点「允许」。

`npm install` 后提示缺少 Electron 二进制时，见 [FAQ](faq.md#npm-install-后提示缺少-electron-二进制怎么办)。

## 私有部署的运行时 secret

仓库提供的 SearXNG Compose 从仓库外的 root-only 运行时文件读取随机 secret，不把实际 secret 写入仓库、README 或命令参数。生产环境应限制该文件及 Docker socket 仅由 root 管理；Docker 管理员仍处在运行时 secret 的信任边界内。文件位置、权限、生成方式和 Compose 启动检查详见 [`deploy/searxng/README.md`](../deploy/searxng/README.md)，请勿打印或提交实际值。

是否可以把默认 Web 服务直接暴露到公网，见 [FAQ](faq.md#可以把默认-web-服务直接暴露到公网吗)。

## 多用户、备份与回滚

- Owner 可在网页账户设置中修改自己的口令，并创建、停用、改角色或重置 Member/Owner 口令；没有公开注册入口。Member 不会看到用户管理入口，服务端仍会强制 Owner 权限。
- 新设口令（建用户、重置口令、本人改口令）必须至少 8 位，且不能是常见弱口令、用户名或用户名加数字；不合格时接口直接返回原因。已有账号不受影响、照常登录，弱口令只在网页顶部提示尽快修改。改口令接口与设置页二次验证共用限速，防止拿到会话的人反复猜当前口令。
- 过期会话与吊销超过 7 天的会话由后台线程每 6 小时清理一次（启动 1 分钟后先清一次），不影响任何仍有效的登录。
- 从旧版单账号部署升级时，已有网页登录会话会被撤销；请使用迁移后的唯一 Owner 重新登录，并立即把迁移或运维阶段使用的临时兼容口令改成独立强口令。不要在 README、截图、工单或聊天中记录真实账号与口令。
- 每个账号的 Agent 运行时、对话线程、检查点命名空间、备忘、待办、日程、定位和模型 Provider 都按用户隔离；CLI 与个人微信固定使用唯一 active Owner 的配置。
- 升级前必须先停止所有 Web、Desktop、CLI 和微信桥进程，再完整复制 `JARVIS_DATA_DIR`。若不能停服，必须对 `jarvis.db` 和 `accounts.sqlite3` 分别使用 SQLite backup API/等价的一致性快照，不得在运行中直接 `cp` SQLite 文件。
- `jarvis.db` 是 Agent 检查点；`accounts.sqlite3` 是账号/会话/租户元数据。升级前的 `threads.json`、`memos.json`、`todos.json`、`schedule.json`、`location.json`、`local_status.json` 是仅归属 Owner 的 legacy 输入：迁移不改写原文件，并为每个实际存在的文件创建同目录 `0600` 快照 `<原文件名>.tenant-v1.bak`。
- `wechat_token` 只是唯一 active Owner 的微信桥登录态；它不在 SQLite 中，不参与 legacy 导入，升级/回滚时都不得删除、改名或覆盖。
- 若升级失败：先停服并保留失败现场，恢复旧程序；用升级前快照恢复 `jarvis.db`；将每个 `<name>.tenant-v1.bak` 复制回对应 `<name>`（如 `memos.json.tenant-v1.bak` → `memos.json`）；若升级前已有 `accounts.sqlite3` 则恢复其快照，否则把新文件移到隔离目录保留而不要删除；`wechat_token` 原样保留。恢复或重试升级后，预期 Web/Desktop/OpenAI 会话全部重新登录；微信 Token 若未失效可自动恢复，否则再扫码。
- 个人微信固定属于唯一 active Owner。即使网页端误显示入口，后端也会在没有唯一 Owner 时拒绝连接、状态与写入。

Provider 主密钥相关文件（`provider-active.json`、`provider-generations/`、`provider-audit.jsonl`）的备份要求见 [配置参考](configuration.md#多用户-provider--api-设置)。

## 演示入口与上线状态

**私有部署 / 演示入口：[`https://jws.gkgeek-set.cn`](https://jws.gkgeek-set.cn)**

这是项目维护者的私有部署或演示入口，不是公共 SaaS，也不承诺持续在线；桌面端可在设置中改为你自己的服务器地址。这里的状态说明不代表维护者已经替访问者执行过实时娱乐搜索或验证过任何具体结果。

- **2026-10-02**：第八轮（后端卡顿修复、流式渲染优化、语音延迟优化、飞书机器人长连接接入）已上线演示入口；测试基线 pytest 657 / vitest 100 / desktop 117。
- **截至 2026-08-25**：多用户隔离、Owner 用户管理、每用户 Provider / API 设置、网页语音通话（📞）、日程主动提醒、记忆与人设面板、文档上传解析、亮色主题、第三轮升级（Heartbeat 主动唤醒、夜间记忆蒸馏、技能热加载、划词工具条）、第四轮升级（语音唤醒「贾维斯」、会议纪要自动邮件、网页控悬浮窗）与第五轮升级（通话场景模式、语气情绪感知、图片/短视频识别、会议说话人分离）均已合并主干并部署到上述演示入口，全量回归全绿；会议纪要与语音唤醒已经过真机验收（真实飞书会议 → 纪要自动送达邮箱）。微信语音消息的真机联调仍在进行中。
- SearXNG 仅监听服务器 loopback `127.0.0.1:18888`，不可从公网直接访问，搜索失败时可回退 DDGS。
- 截至 2026-08-13，私有演示部署的 `jarvis-web`、多用户与 Provider 设置接口、SearXNG 已通过最小线上验收和 HTTP 可达性验证；这只确认服务链路健康，不代表已经替用户运行 `search_smoke.py --live` 或执行上述娱乐搜索示例。

各轮详细交付记录见 [`PROGRESS.md`](../PROGRESS.md)。
