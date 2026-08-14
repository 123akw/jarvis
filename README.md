<div align="center">

# J.A.R.V.I.S. / JWS-Agent

### 一个真正记得住、随时叫得到、能够采取行动的私人 AI 管家

[![Python 3.10+](https://img.shields.io/badge/Python-3.10%2B-3776AB?logo=python&logoColor=white)](https://www.python.org/)
[![LangGraph](https://img.shields.io/badge/LangGraph-Agent-1C3C3C)](https://github.com/langchain-ai/langgraph)
[![FastAPI](https://img.shields.io/badge/FastAPI-SSE-009688?logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com/)
[![Electron](https://img.shields.io/badge/Electron-Desktop-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![macOS](https://img.shields.io/badge/macOS-Desktop-000000?logo=apple&logoColor=white)](https://www.apple.com/macos/)
![Non-Commercial](https://img.shields.io/badge/License-Non--Commercial-E5484D)

把聊天、语音通话、持久记忆、日程待办和可追溯的实时搜索放进同一个 Agent：既能在网页和终端里使用，也能常驻为 macOS 悬浮球，还可以桥接个人微信。

**私有部署 / 演示入口：[`https://jws.gkgeek-set.cn`](https://jws.gkgeek-set.cn)**

**[快速开始](#快速开始)**

这是项目维护者的私有部署或演示入口，不是公共 SaaS，也不承诺持续在线；桌面端可在设置中改为你自己的服务器地址。截至 **2026-08-13**，多用户隔离、Owner 用户管理、每用户 Provider / API 设置、网页语音通话（📞）、`jarvis-web` 与 SearXNG 已部署并通过最小线上验收；微信语音消息支持仍在开发中。SearXNG 仅监听服务器 loopback `127.0.0.1:18888`，不可从公网直接访问，搜索失败时可回退 DDGS。这里的状态说明不代表维护者已经替访问者执行过实时娱乐搜索或验证过任何具体结果。

> **非商用项目：仅供学习、研究与个人非商业用途。禁止未经授权的商业部署、商业集成、付费分发或收费服务。**

> 本声明只描述 JWS-Agent 自身的使用范围。可选部署中的第三方 SearXNG 采用独立的 AGPL-3.0；二者不能互相替代。详见 [`deploy/searxng/README.md`](deploy/searxng/README.md)。

</div>

## 产品介绍

贾维斯（JWS-Agent）是一个可私有部署的中文 AI 管家：记得住你说过的话，管得了日程待办，查得到带来源的实时信息；网页、桌面、终端、微信，随时叫得到。

- **网页对话**：流式聊天（完整 Markdown 渲染：可点来源链接 / 表格 / 代码高亮），消息可重答、编辑重发、失败重试；配可勾选、可增删的今日日程 / 待办 / 备忘任务台，支持上传 PDF / Word / TXT 文档解析追问。
- **语音通话**：网页端点 📞 直接开口说话，贾维斯用语音回答；音色与语速每用户可选。
- **主动提醒**：日程到点自动推送——微信（对贾维斯说「提醒发给我」绑定）、桌面系统通知、网页弹条三通道；可选每天定时的「晨报电台」语音条。
- **记忆与人设**：长期记忆画像可查可删（「记住我…/忘记…」），称呼、语气可自定义，J.A.R.V.I.S. ↔ MOSS 双人格切换。
- **微信桥**：扫码接入个人微信即可对话；发链接即总结，群聊被 @ 才应答；语音消息开发中。
- **多用户与租户隔离**：Owner 邀请制开号，各账号对话、记忆、日程完全隔离。
- **每用户 API 设置**：各自选择模型 Provider 与 Key，密钥加密存储、永不回显。
- **桌面端**：macOS 常驻悬浮球，⌥Space 一键唤出快捷聊天。
- **免费搜索链**：SearXNG → DDGS 免费降级，结果带时间与来源；Tavily 可选。

![JWS-Agent 网页端任务台与对话界面](docs/assets/readme/web-dashboard.png)

<table>
  <tr>
    <td align="center"><strong>每个账号独立的 Provider / API 设置</strong></td>
    <td align="center"><strong>Owner 用户管理与角色控制</strong></td>
  </tr>
  <tr>
    <td><img src="docs/assets/readme/web-provider-settings.png" alt="JWS-Agent 每用户 Provider 与 API 设置" width="100%"></td>
    <td><img src="docs/assets/readme/web-account-settings.png" alt="JWS-Agent Owner 用户管理" width="100%"></td>
  </tr>
</table>

以上网页截图为 2026-08-13 私有演示部署的真实界面：主界面采用新对话空状态并收起历史列表，定位等个人信息已替换为演示内容，API Key、口令、二维码与真实对话均未进入图片。

<table>
  <tr>
    <td align="center"><strong>随时叫得到的桌面悬浮球</strong></td>
    <td align="center"><strong>原地展开的流式聊天窗</strong></td>
    <td align="center"><strong>快捷键、外观与微信设置</strong></td>
  </tr>
  <tr>
    <td><img src="docs/assets/readme/desktop-orb.png" alt="JWS-Agent macOS 桌面悬浮球" width="100%"></td>
    <td><img src="docs/assets/readme/desktop-chat.png" alt="JWS-Agent 桌面快捷聊天窗" width="100%"></td>
    <td><img src="docs/assets/readme/desktop-settings.png" alt="JWS-Agent 桌面设置页" width="100%"></td>
  </tr>
</table>

## 为什么是 JWS-Agent

- **持久记忆**：LangGraph 的 SQLite checkpointer 把对话状态落到本地数据库，进程重启后仍可沿同一线程继续。
- **多入口，同一套能力**：网页端、macOS 桌面悬浮窗、终端 CLI 和个人微信都连接同一个 Agent 与 24 项工具。
- **不仅回答，也能行动**：可增删备忘和日程、维护待办、查询天气与系统状态，并按需调用实时搜索工具。
- **实时信息可追溯**：搜索结果保留查询时间、摘要和 HTTP(S) 来源；电影评分分平台呈现，票务只提供公开信息与深链接。
- **多用户与个人模型配置**：每个账号拥有独立对话、记忆、日程、待办和模型 Provider；Owner 统一管理全局联网数据源。
- **面向私有部署**：模型地址、模型名、数据目录和服务端口均可配置；记忆、备忘、日程、待办和微信 Token 留在你的运行环境中。

> 搜索默认按 `SearXNG → DDGS → 可选 Tavily` 降级，正文提取默认按 `Trafilatura → 可选 Playwright` 降级。私有演示入口已启用本机 SearXNG，并在不可用时回退无需付费 key 的 DDGS；不保证 Tavily 或 PandaScore 已配置。自建 SearXNG、Tavily key 和 PandaScore token 都是可选增强，不是上线前置条件。

## 一个 Agent，四种入口

| 能力 | 网页端 | 桌面悬浮窗 | 终端 CLI | 个人微信 |
| --- | --- | --- | --- | --- |
| 中文自然语言对话与 24 项工具 | ✅ | ✅ | ✅ | ✅（文本消息） |
| 流式展示 | ✅ SSE 逐字输出并展示工具调用 | ✅ SSE 逐字输出并展示工具调用 | — 单次完整返回 | — 消息式回复 |
| 语音通话 | ✅ 📞 实时语音问答，可降级打字通话 | — | — | 🚧 语音消息开发中 |
| 记忆线程 | 每个会话独立 `thread_id` | 固定 `desktop` 线程 | 默认 `main`，可用 `--thread` 指定 | 每个联系人独立 `wx-<联系人>` 线程 |
| 日程、待办、备忘 | 对话操作 + 任务台展示 | 对话操作 + 日程 / 待办任务台展示 | 对话操作 | 对话操作 |
| 实时搜索 | ✅ 免费默认可用 | ✅ 免费默认可用 | ✅ 免费默认可用 | ✅ 免费默认可用 |
| 天气定位 | 浏览器定位优先，公网 IP 兜底 | 使用服务端已有定位；也可直接说城市 | 使用服务端已有定位；也可直接说城市 | 使用服务端已有定位；也可直接说城市 |
| 会话历史管理 | 新建、回放、删除 | 最近历史、清空快捷线程 | 由线程持久化 | 由联系人线程持久化 |
| 个人微信扫码管理 | 顶栏“微信” | 设置 → 个人微信 | — | 自身即消息入口 |
| Provider / API 设置 | 每个账号独立设置模型 | 设置中独立设置模型 | 使用当前 Owner 配置 | 使用唯一 Owner 配置 |

四种入口共享服务端同一套 `SearchService` 后端与降级链。默认 DDGS 无需付费 key；希望优先控制搜索实例时可选自建 SearXNG，但它不是使用实时搜索的必要条件。

## 它可以怎样帮你

下面是调用方式示例，回答中的实时内容以实际查询结果为准，不预填会过期的价格、比分或评分。

**1. 晨报**

> 你：给我今日晨报，带上天气、今天的安排、待办、编程进度和 Git 情况。
>
> J.A.R.V.I.S.：读取当前定位、三日天气、本地日程、未完成待办与桌面端同步的编程进度和 Git 情况，整理成一份晨间摘要。

**2. 日程与待办**

> 你：明天下午 3 点提醒我做项目复盘，再加一条待办：整理会议材料。
>
> J.A.R.V.I.S.：分别写入日程和待办；之后可继续询问、勾选完成或删除。

**3. 持久记忆**

> 你：记住我周三要交电费。
>
> 你（重启程序后）：我让你记过什么？
>
> J.A.R.V.I.S.：在同一线程中读取 SQLite 检查点并接续上下文。

**4. 娱乐新闻**

> 你：查一下最近一周的娱乐新闻，列出重点、查询时间和来源。
>
> J.A.R.V.I.S.：调用 `web_search`，基于带时间戳和链接的公开搜索资料整理回答。

**5. 分平台电影评分**

> 你：查这部电影在豆瓣、IMDb、Rotten Tomatoes 和 Metacritic 的评分。
>
> J.A.R.V.I.S.：分别给出各平台量表、评价人数和来源，不把不同分制合并成“综合分”。

**6. 电竞比分 / 票务查询**（PandaScore 与 Tavily 均为可选增强）

> 你：查某战队最近一场比赛的比分、赛事和来源。
>
> 你：再找一下某场演出的正规购票入口。
>
> J.A.R.V.I.S.：比分优先使用已配置的 PandaScore 结构化数据，失败或未配置时回退网页搜索；票务只列公开展示价或明确无可靠公开价，并给出平台深链接，不登录、不占座、不下单。

### 上线后可这样测试

- “查最近一周的娱乐新闻，列出来源，并注明资料截至时间。”
- “查这部电影在豆瓣、IMDb、Rotten Tomatoes 和 Metacritic 的评分，分平台列出量表、评价人数、来源和查询时间。”
- “查某俱乐部最近一场比赛的比分、赛事、比赛时间和来源。”
- “查某场演出的正规票务平台入口和公开报价，注明查询时间。”

这些问题用于检查实时搜索、来源与时间信息是否正常返回。公开网页、评分、比分和票价都可能变化，应打开原始来源复核；票务工具只查询和提供链接，不登录、不占座、不下单。

## 工作原理

```mermaid
flowchart LR
  U[用户] --> W[网页端]
  U --> D[桌面悬浮窗]
  U --> C[终端 CLI]
  U --> X[个人微信]
  W & D & C & X --> A[FastAPI + LangGraph Agent]
  A --> M[DeepSeek / OpenAI 兼容模型]
  A --> T[24 项工具]
  A --> S[(SQLite 持久记忆)]
  T --> L[本地日程·待办·备忘]
  T --> Q[SearchService]
  Q --> P[SearXNG → DDGS → 可选 Tavily]
  Q --> R[Trafilatura → 可选 Playwright]
  T --> E[天气·可选 PandaScore]
```

### 24 项工具如何分层

| 层级 | 工具 | 作用与数据边界 |
| --- | --- | --- |
| 基础与上下文（6） | `now`、`calc`、`weather`、`weather_here`、`my_location`、`coding_status` | 时间与白名单计算；Open-Meteo 天气无需 key；定位和编程状态保存在本地数据目录 |
| 个人信息管理（12） | `memo_add/list/del`、`schedule_add/list/del`、`todo_add/list/done`、`profile_remember/list/forget` | 备忘、日程、待办与长期记忆画像在 `JARVIS_DATA_DIR` 下持久化；画像条目注入每轮系统提示词，网页「记忆」面板可查可删 |
| 系统查询（1） | `sys_query` | 只执行代码允许的白名单系统查询 |
| 实时信息（5） | `web_search`、`web_extract`、`movie_ratings`、`esports_scores`、`ticket_search` | SearchService 统一调度免费优先搜索与有界正文提取；Tavily、PandaScore 和 Playwright 都是可选增强；工具不会代替用户完成交易 |

### 流式、线程与记忆

- 网页和桌面端调用 FastAPI `/api/chat`，服务端以 `text/event-stream` 返回 `token`、`tool_start`、`tool_result`、`done` 或 `error` 事件。
- 每次 Agent 调用都带 `thread_id`。网页会话、桌面固定线程、CLI 自定义线程和微信联系人线程相互隔离，避免不同入口的上下文串线。
- `JARVIS_DATA_DIR/jarvis.db` 保存 LangGraph 检查点；`accounts.sqlite3` 保存账号、会话、审计以及按 Owner 隔离的线程/备忘/待办/日程/位置元数据。两个 SQLite 文件都是完整备份的一部分。
- 服务还提供带 Bearer 鉴权的 `/v1/chat/completions` OpenAI 兼容接口，供微信备用网关等客户端接入；它不是完整的 OpenAI API 实现。

### 实时搜索与正文提取的来源边界

- `SearchService` 默认依次尝试本地 SearXNG、DDGS 和显式配置的可选 Tavily。仓库提供的 SearXNG Compose 只监听 `127.0.0.1:18888`；生产审计发现 8888 已被 BT-Panel 占用，因此改用确认空闲的 18888。未启动或未配置时会自动继续 DDGS。
- 截至 2026-08-13，私有演示部署的 `jarvis-web`、多用户与 Provider 设置接口、SearXNG 已通过最小线上验收和 HTTP 可达性验证；这只确认服务链路健康，不代表已经替用户运行 `search_smoke.py --live` 或执行上述娱乐搜索示例。
- 静态正文优先由 Trafilatura 有界提取；只有安装 browser extra 和 Chromium 后，动态页面才可回退 Playwright。提取器限制响应体与输出长度，并拒绝 loopback、私网和其他不安全目标。
- 每次搜索输出记录查询时间、provider、标题、摘要与有效 HTTP(S) 来源。网页文本被标记为外部资料而不是 Agent 指令，但公开网页仍可能过时或有误；重要信息应打开原始链接复核。
- `TAVILY_API_KEY` 与 `PANDASCORE_TOKEN` 都可选。PandaScore 配置后可优先提供结构化电竞数据，缺失或失败时回退默认网页搜索链。
- 电影评分按平台和分制分开；票务价格只代表公开展示价、起价或票面价，库存、手续费和最终成交价以平台结算页为准。

## 快速开始

### 运行要求

- Python 3.10 或更高版本。
- Node.js 与 npm：仅桌面端需要。
- macOS：当前 Electron 悬浮窗使用 LaunchAgent、全局快捷键和 macOS 窗口行为，桌面端按 macOS 设计；Web 与 CLI 后端本身是 Python 应用。
- 一个 OpenAI 兼容模型的 API key；默认配置面向 DeepSeek，也可使用 OpenAI、百炼、SiliconFlow 或自定义 HTTPS 中转。

### 1. 安装 Python 环境

在项目根目录执行：

```bash
python3 -m venv .venv
.venv/bin/pip install -e ".[dev]"
cp .env.example .env
```

然后至少填写 `JARVIS_API_KEY` 或与 `JARVIS_PROVIDER` 对应的兼容密钥；同时必须填好 `JARVIS_ADMIN_USERNAME`、`JARVIS_ADMIN_PASSWORD` 与 `JARVIS_SESSION_SECRET`（可用 `openssl rand -hex 32` 生成）——这三项留空时首次启动不会创建 Owner，网页端会 fail closed 无法登录。请勿提交 `.env`。实时网页查询默认可使用 DDGS，无需付费搜索 key。若已启动仓库提供的本地 SearXNG，可按下文配置其 loopback 地址；Tavily 仅在你主动选择该可选增强时才需要 key。

默认静态提取不需要浏览器。需要处理动态页面时，改用 browser extra 并单独安装 Chromium：

```bash
.venv/bin/pip install -e ".[dev,browser]"
.venv/bin/python -m playwright install chromium
.venv/bin/python -c "from playwright.sync_api import sync_playwright; p=sync_playwright().start(); b=p.chromium.launch(); b.close(); p.stop()"
```

最后一条只启动并关闭本机 Chromium，不访问任何 URL。未安装 Playwright 或 Chromium 时，静态提取仍可用，动态回退会明确跳过。

### 2. 启动网页端

```bash
.venv/bin/jarvis-web
```

默认监听 `http://127.0.0.1:7789`。首位 Owner 在首次启动时由 `.env` 中的 `JARVIS_ADMIN_USERNAME`/`JARVIS_ADMIN_PASSWORD` 自动创建；用它登录后，在顶栏「账户设置」的「用户管理」里可邀请 Member（没有公开注册入口），Member 用被分配的用户名口令登录即可，各自的数据完全隔离。登录后可创建和删除会话、查看历史、停止生成、复制回复，并在任务台查看日程、待办和备忘；后端每轮对话后继续使用同一条线程记忆。

**语音通话怎么用**：点输入框旁的 **📞** 进入通话，浏览器会申请麦克风授权；同意后直接开口说话，说话停顿自动断句，贾维斯边生成边用语音回答并同步文字字幕。拒绝授权或浏览器不支持语音识别时，自动降级为「打字通话」——输入文字，贾维斯照样用语音回答；关闭通话面板后，文字聊天完全不受影响。微信语音消息支持仍在开发中。

### 私有部署的运行时 secret

仓库提供的 SearXNG Compose 从仓库外的 root-only 运行时文件读取随机 secret，不把实际 secret 写入仓库、README 或命令参数。生产环境应限制该文件及 Docker socket 仅由 root 管理；Docker 管理员仍处在运行时 secret 的信任边界内。文件位置、权限、生成方式和 Compose 启动检查详见 [`deploy/searxng/README.md`](deploy/searxng/README.md)，请勿打印或提交实际值。

### 3. 使用终端

```bash
.venv/bin/jarvis
.venv/bin/jarvis --once "现在几点了"
.venv/bin/jarvis --thread work
```

交互模式输入 `quit` 或 `exit` 退出。`--once` 单发一句后结束；`--thread` 可将工作、生活等上下文拆为不同记忆线程。

### 4. 启动 macOS 桌面悬浮窗

先确保可访问一个正在运行的 JWS-Agent Web 服务，再执行：

```bash
cd desktop
npm install
npm start
```

首次启动会自动展开登录面板，可在登录面板或设置页把服务器地址改为 HTTPS 私有部署地址；只在设置 `JWS_DESKTOP_DEV=1` 时允许本机 `http://127.0.0.1` / `[::1]` 开发地址。桌面端会要求输入用户名和口令，认证 Token 只由 Electron 主进程保存于系统加密存储，渲染界面无法读取。悬浮球置顶并跨工作区显示，点击后向左展开快捷聊天；默认全局唤醒键为 `⌥Space`，也可修改或停用。开机自启通过 `~/Library/LaunchAgents/com.jws.jarvis.desktop.plist` 实现。

## 环境变量

把 `.env.example` 复制为 `.env` 后不要直接启动。首先填入真实的模型 API key、唯一 Owner 的 `JARVIS_ADMIN_USERNAME`、强且唯一的 `JARVIS_ADMIN_PASSWORD`，并用密码学安全随机源生成至少 32 字节的 `JARVIS_SESSION_SECRET`（例如 `openssl rand -hex 32`）。留空、示例占位符或过短 secret 都会 fail closed，不会创建 Owner。

| 变量 | 必需 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `JARVIS_PROVIDER` | 否 | `deepseek` | 环境回退模型 Provider：`openai`、`deepseek`、`bailian`、`siliconflow` 或 `custom` |
| `JARVIS_API_KEY` | 启动模型必需 | 无 | 当前环境回退 Provider 的通用 API key；不会返回前端 |
| `DEEPSEEK_API_KEY` | 否 | 无 | DeepSeek 兼容旧配置；`JARVIS_API_KEY` 为空且 Provider 为 DeepSeek 时使用 |
| `JARVIS_BASE_URL` | 否 | `https://api.deepseek.com` | OpenAI 兼容接口基址 |
| `JARVIS_MODEL` | 否 | 代码回退为 `deepseek-chat` | 模型名；仓库 `.env.example` 当前示例为 `deepseek-v4-flash` |
| `JARVIS_DATA_DIR` | 否 | `<项目根>/data` | SQLite 记忆、本地日程/待办/备忘、会话元数据和微信 Token 的目录 |
| `JARVIS_PORT` | 否 | `7789` | Web 服务监听端口 |
| `JARVIS_ADMIN_USERNAME` | 首次启动必需 | 无 | 首次数据库初始化时创建的唯一 Owner 用户名 |
| `JARVIS_ADMIN_PASSWORD` | 首次启动必需 | 无 | 首次数据库初始化时创建的 Owner 口令；只存 Argon2id 哈希 |
| `JARVIS_SESSION_SECRET` | 是 | 无 | 至少 32 字节随机值，用于会话与 CSRF；缺失时网页登录会 fail closed |
| `JARVIS_SETTINGS_WRITE_ENABLED` | 否 | `false` | 设为 `true` 才允许网页/桌面写入 Provider 设置 |
| `JARVIS_SECRETS_KEY` | 设置写入必需 | 无 | URL-safe Base64 编码的随机 32 字节主密钥；仅在服务器保存，不得轮换或丢失 |
| `JARVIS_SEARCH_BACKENDS` | 否 | `searxng,ddgs,tavily` | 搜索 provider 降级顺序；名称不能重复 |
| `SEARXNG_BASE_URL` | 否 | 无 | 本地 Compose 可设为 `http://127.0.0.1:18888`；未配置或不健康时继续 DDGS |
| `JARVIS_EXTRACT_BACKENDS` | 否 | `trafilatura,playwright` | 正文提取降级顺序；Playwright 未安装时明确跳过 |
| `TAVILY_API_KEY` | 否 | 无 | 可选 Tavily 搜索密钥；未配置不影响 SearXNG/DDGS 免费链，仓库与演示入口均不保证已配置 |
| `PANDASCORE_TOKEN` | 否 | 无 | 可选 PandaScore 结构化电竞数据 Token；缺失或失败时回退默认网页搜索链 |

## 多用户 Provider / API 设置

- 网页顶栏 **⚙ API** 与桌面端 **设置 → 模型 API** 都可以选择 OpenAI、DeepSeek、阿里云百炼、SiliconFlow 或自定义 OpenAI 兼容 HTTPS 地址。官方 Provider 只接受其官方 API 主机；自定义中转禁止 HTTP、URL 凭据、查询参数和片段。
- 每个用户只管理自己的模型 Provider、Base URL、模型名和 Key；Owner 额外管理全局 SearXNG、Tavily 与 PandaScore。Member 无法读取或修改其他账号配置，也不能管理全局联网数据源。
- API Key 永不回显到网页或桌面端。托管设置使用 AES-GCM 加密并按用户、Provider、Origin 与 generation 绑定；每次测试、保存或恢复都要求当前账号口令，修改采用 generation 冲突保护。
- Provider 设置保存后只影响当前账号的新 Agent 会话；已经打开的网页、桌面窗口或旧登录会话应退出并重新登录，再新建对话验证模型切换。
- 测试连接会真实发送极少量非流式工具调用、流式文本和流式工具调用，可能产生少量模型费用。第三方中转可读取问题、上下文、工具调用和输出，建议只使用独立、低额度、可吊销的 Key。
- “恢复环境配置”会切回 `.env` 中的回退 Provider。未同时配置写入开关和主密钥时，设置中心保持只读，原环境配置仍可正常使用。

如需开启设置写入，先在服务器生成一次主密钥并只写入 `.env`：

```bash
python -c "import base64,secrets; print(base64.urlsafe_b64encode(secrets.token_bytes(32)).decode())"
# 把输出填入 JARVIS_SECRETS_KEY，并设置：
JARVIS_SETTINGS_WRITE_ENABLED=true
```

主密钥不得提交、打印到日志或发送到前端；丢失后既有托管 Key 无法解密。正式变更前应连同 `JARVIS_DATA_DIR/provider-active.json`、`provider-generations/` 和 `provider-audit.jsonl` 一起备份。

## 多用户、备份与回滚

- Owner 可在网页账户设置中修改自己的口令，并创建、停用、改角色或重置 Member/Owner 口令；没有公开注册入口。Member 不会看到用户管理入口，服务端仍会强制 Owner 权限。
- 从旧版单账号部署升级时，已有网页登录会话会被撤销；请使用迁移后的唯一 Owner 重新登录，并立即把迁移或运维阶段使用的临时兼容口令改成独立强口令。不要在 README、截图、工单或聊天中记录真实账号与口令。
- 每个账号的 Agent 运行时、对话线程、检查点命名空间、备忘、待办、日程、定位和模型 Provider 都按用户隔离；CLI 与个人微信固定使用唯一 active Owner 的配置。
- 升级前必须先停止所有 Web、Desktop、CLI 和微信桥进程，再完整复制 `JARVIS_DATA_DIR`。若不能停服，必须对 `jarvis.db` 和 `accounts.sqlite3` 分别使用 SQLite backup API/等价的一致性快照，不得在运行中直接 `cp` SQLite 文件。
- `jarvis.db` 是 Agent 检查点；`accounts.sqlite3` 是账号/会话/租户元数据。升级前的 `threads.json`、`memos.json`、`todos.json`、`schedule.json`、`location.json`、`local_status.json` 是仅归属 Owner 的 legacy 输入：迁移不改写原文件，并为每个实际存在的文件创建同目录 `0600` 快照 `<原文件名>.tenant-v1.bak`。
- `wechat_token` 只是唯一 active Owner 的微信桥登录态；它不在 SQLite 中，不参与 legacy 导入，升级/回滚时都不得删除、改名或覆盖。
- 若升级失败：先停服并保留失败现场，恢复旧程序；用升级前快照恢复 `jarvis.db`；将每个 `<name>.tenant-v1.bak` 复制回对应 `<name>`（如 `memos.json.tenant-v1.bak` → `memos.json`）；若升级前已有 `accounts.sqlite3` 则恢复其快照，否则把新文件移到隔离目录保留而不要删除；`wechat_token` 原样保留。恢复或重试升级后，预期 Web/Desktop/OpenAI 会话全部重新登录；微信 Token 若未失效可自动恢复，否则再扫码。
- 个人微信固定属于唯一 active Owner。即使网页端误显示入口，后端也会在没有唯一 Owner 时拒绝连接、状态与写入。

## 个人微信桥接

从你自己的 Web 部署登录后，可点击顶栏 **微信** 生成二维码，并用本人手机上的微信扫码确认；桌面端也可在 **设置 → 个人微信** 管理同一桥接状态。仍建议先使用专用或测试账号评估兼容性与账号风险，再由部署者决定是否使用常用账号。连接由服务器进程维持，关闭浏览器或桌面窗口不会主动断开；服务重启会尝试恢复。

- Token 仅保存在 `JARVIS_DATA_DIR/wechat_token`，权限为 `0600`，不会返回前端；二维码、Token、`.env` 都不得入库或公开分享。
- 每个联系人使用独立的 `wx-<联系人>` 线程；群聊和非文本消息默认忽略。
- 个人号第三方桥接存在登录态失效、协议变化和账号风险。建议优先使用专用或测试账号，不要高频发送；是否使用常用账号及相关风险由部署者自行评估，**禁止群发营销**。
- 登录态失效时，在网页或桌面设置中重新生成二维码并扫码。
- 命令行备用桥位于 `wechat/ilink_gateway.py`；不要让备用桥和网页内置桥同时连接同一微信账号，否则可能重复拉取或回复消息。

备用方式的具体变量和白名单配置见 [`wechat/README.md`](wechat/README.md)。

## 验收与测试

确定性单元测试不调用真实大模型或外部搜索服务。`search_smoke.py` 默认也使用内置 stub，验证四类问题的路由、来源和脱敏，且无需任何付费 key；只有显式传入 `--live` 才使用当前配置的模型与 provider。`check_memory.py` 会重建默认 `data/jarvis.db` 以验证跨进程记忆。

```bash
.venv/bin/python -m pytest -q
.venv/bin/python scripts/check_smoke.py
.venv/bin/python scripts/check_memory.py
.venv/bin/python scripts/search_smoke.py
# 可选：显式进行真实模型/provider 验收
.venv/bin/python scripts/search_smoke.py --live
# 可选：多用户并发验收（自起本地服务并调用真实模型，产生少量模型费用）
.venv/bin/python scripts/concurrency_smoke.py
```

验收含义：

1. `pytest -q`：全量确定性单元测试应为 0 失败。
2. `check_smoke.py`：真实模型回答“现在几点了”，且必须产生实际工具调用。
3. `check_memory.py`：两个独立 CLI 进程先后对话，验证第二次能读取第一次写入的 SQLite 历史。
4. `search_smoke.py`：默认由离线 stub 覆盖 SearXNG/DDGS 风格的免费链结果，JSON 应为 4/4，并包含查询时间与可追溯来源；`--live` 才进行真实模型/provider 验收，Tavily 与 PandaScore 仍为可选项。
5. `concurrency_smoke.py`：自动起一个隔离数据目录的本地服务并引导 Owner，3 路真实聊天并发时 20 次 `/api/dashboard` 的 P95 必须小于 2 秒，且聊天全部真实完成才退出 0。

## 项目结构

```text
JWS-Agent/
├── jarvis/
│   ├── config.py          # 环境变量、模型与数据路径
│   ├── graph.py           # LangGraph ReAct Agent + SQLite checkpointer
│   ├── server.py          # FastAPI、登录、SSE、仪表盘与兼容接口
│   ├── cli.py             # 交互式与单发 CLI
│   ├── wechat.py          # Web 服务内置个人微信桥
│   ├── web/               # 零构建的网页端
│   └── tools/             # 24 项工具及注册表
├── desktop/               # macOS Electron 悬浮球与设置页
├── wechat/                # 命令行备用网关
├── tests/                 # 确定性单元测试
├── scripts/               # 真模型、记忆与实时搜索验收脚本
├── docs/assets/readme/    # README 产品截图
├── pyproject.toml
└── .env.example
```

## FAQ

<details>
<summary><strong>为什么搜索没有使用本地 SearXNG？</strong></summary>

先按 [`deploy/searxng/README.md`](deploy/searxng/README.md) 静态检查并启动本地服务，再把 `SEARXNG_BASE_URL` 设为 `http://127.0.0.1:18888` 后重启 Python 服务。未配置或健康检查失败时，SearchService 会按顺序继续 DDGS，而不是把 SearXNG 声称为在线；需要时可另行配置可选 Tavily。天气使用 Open-Meteo，不依赖这些搜索 provider。

</details>

<details>
<summary><strong>npm install 后提示缺少 Electron 二进制怎么办？</strong></summary>

某些 npm 配置会阻止 Electron 安装脚本。先在 `desktop/` 下执行：

```bash
npm rebuild electron
```

仍失败再执行：

```bash
node node_modules/electron/install.js
```

</details>

<details>
<summary><strong>询问“这里的天气”却提示没有定位怎么办？</strong></summary>

在网页端允许浏览器定位；服务端只在尚无定位时尝试公网 IP 城市级兜底，内网地址或外部定位服务失败时可能拿不到位置。也可以在问题中直接写城市名，例如“深圳未来三天天气”。

</details>

<details>
<summary><strong>个人微信失效后怎样恢复？</strong></summary>

打开网页顶栏“微信”或桌面端“设置 → 个人微信”，重新生成二维码并扫码。若使用命令行备用桥，先确认它没有与内置桥同时连接同一账号，再按 `wechat/README.md` 重新认证。

</details>

<details>
<summary><strong>可以把默认 Web 服务直接暴露到公网吗？</strong></summary>

不建议直接暴露。当前 `jarvis-web` 默认只监听 `127.0.0.1`，首次启动必须通过环境变量创建唯一 Owner，并使用 Argon2id、可撤销会话、CSRF 和登录限流；仓库不再提供固定账号或开发口令。公网部署仍应使用 HTTPS 反向代理、限制网络入口、配置强随机 `JARVIS_SESSION_SECRET` 与 Owner 口令、定期备份 `JARVIS_DATA_DIR`，并按组织要求补充日志审计、依赖更新和边界防护。

</details>

## 共同开发与使用声明

本项目由陈文杰、钟俊琅共同开发。

本项目仅供学习、研究与个人非商业用途。未经两位开发者书面授权，禁止任何形式的商业使用、付费分发、商业部署、商业集成或以本项目为基础提供收费服务。

项目引用的第三方依赖与服务仍分别适用其各自的许可证、服务条款与品牌规则；上述声明不改变第三方组件的授权范围，也不授予本项目除第三方组件既有权利之外的任何商业使用权。
