# 贾维斯（JWS-Agent）

私人管家：LangGraph ReAct agent 底座，SQLite 持久记忆（重启不忘事），20 项工具——时间、计算器、天气（Open-Meteo 免 key）、备忘、日程、待办、系统查询，以及带来源的实时网页、电影评分、电竞比分和票务搜索。中文交互，模型走 OpenAI 兼容接口，默认 DeepSeek。终端和网页端（钢铁侠 HUD 风格，流式回复+工具调用实时可视）双入口。

## 项目结构

```
JWS-Agent/
├── pyproject.toml        # 包定义、依赖、jarvis / jarvis-web 两个命令行入口
├── .env.example          # 环境变量模板（复制为 .env 填 key）
├── jarvis/               # 主包
│   ├── config.py         # 路径、环境变量、模型参数（唯一配置入口）
│   ├── prompts.py        # 人设与系统提示词
│   ├── graph.py          # LangGraph agent 组装（模型+工具+记忆）
│   ├── cli.py            # 终端入口（交互式 / --once 单发）
│   ├── server.py         # 网页端后端：SSE 流式聊天 + 仪表盘接口
│   ├── web/index.html    # HUD 单页前端（零构建，纯 HTML/CSS/JS）
│   └── tools/            # 工具包，一个领域一个模块
│       ├── __init__.py   # TOOLS 注册表（新工具在这登记）
│       ├── clock.py      # 时间
│       ├── calc.py       # 计算器（ast 白名单求值）
│       ├── weather.py    # 天气与三日预报（Open-Meteo，免 key）
│       ├── memo.py       # 备忘增查删（data/memos.json）
│       ├── schedule.py   # 日程：带 YYYY-MM-DD HH:MM 时间点
│       ├── todo.py       # 待办：增/列表/勾完成
│       ├── search.py     # Tavily 实时网页/新闻搜索（来源、时间、缓存与边界）
│       ├── entertainment.py # 电影评分、电竞比分、票务搜索
│       └── system.py     # 白名单系统查询
├── tests/                # 单元测试（不碰大模型，确定性判定）
├── scripts/              # 验收脚本（真模型冒烟 / 跨进程记忆）
└── data/                 # 运行时数据（gitignore）
```

## 快速开始

```bash
python3 -m venv .venv
.venv/bin/pip install -e ".[dev]"
cp .env.example .env      # 填入 DEEPSEEK_API_KEY 和 TAVILY_API_KEY

.venv/bin/jarvis-web      # 网页端 → http://127.0.0.1:7789
.venv/bin/jarvis          # 或终端对话，输 quit 退出
.venv/bin/jarvis --once "现在几点了"   # 单发一句
.venv/bin/jarvis --thread work        # 换一条独立记忆线程
```

网页端：登录后进入对话界面——左栏会话历史（新对话/按日分组/悬停删除），刷新和换设备后历史自动回放；回复逐字流式输出、实时显示工具调用、Markdown 渲染、生成中可停止、悬停可复制；右栏日程/待办/备忘每轮对话后自动刷新。问天气不用报城市：浏览器定位优先，IP 双源（ip-api/美团）兜底。终端与网页共用同一套记忆数据库。

## 验收

```bash
.venv/bin/python -m pytest -q            # 全量单元测试，必须 0 失败、0 跳过
.venv/bin/python scripts/check_smoke.py  # 真模型冒烟：必须真的调用了工具
.venv/bin/python scripts/check_memory.py # 两个独立进程先后对话，记忆必须接上
.venv/bin/python scripts/search_smoke.py # 真模型四类实时查询：JSON 输出，必须 4/4
```

## 实时娱乐搜索

`TAVILY_API_KEY` 是实时公开信息的主搜索源；免费额度和密钥在 [Tavily 控制台](https://app.tavily.com/home) 管理。工具固定使用 Basic 深度、Safe Search、最多 5 条结果、12 秒超时和 5 分钟进程内缓存。结果会保留查询时间、标题、摘要与 HTTP(S) 来源，并把网页文本视为不可信资料而非 Agent 指令。

- `web_search`：近期新闻、娱乐动态和一般公开网页。
- `movie_ratings`：分别查询豆瓣、IMDb、Rotten Tomatoes、Metacritic，不合并不同量表。
- `esports_scores`：配置 `PANDASCORE_TOKEN` 时优先结构化比分，否则自动回退可信电竞网页。
- `ticket_search`：优先大麦、秀动、猫眼/淘票票、携程、Ticketmaster；只给公开价和深链接，不登录、占座、下单或支付。

票务的展示价、起价和票面价都不是最终成交价，库存、手续费与最终价格以平台结算页为准。`httpx` 作为直接依赖，为 Tavily/PandaScore 提供固定超时、可测试 transport 和明确的 HTTP 错误处理。

反向验收可临时注入无效搜索密钥，命令必须非零退出并在 JSON 的工具输出中出现“联网搜索认证失败”；随后恢复 `.env` 中的真实 Key 再运行正常 4/4 验收：

```bash
TAVILY_API_KEY=invalid-smoke-key .venv/bin/python scripts/search_smoke.py
.venv/bin/python scripts/search_smoke.py
```

## 桌面悬浮窗（macOS）

```bash
cd desktop && npm install && npm start
```

- 屏幕右侧出现 **MOSS 红瞳悬浮球**：置顶所有窗口、全工作区可见、按住外圈可拖拽。
- **点红瞳** → 原地向左展开快捷对话面板：最近历史 + 流式问答（独立 `desktop` 会话线程，不打扰网页端记录）；Enter 发送，`—` 收起回悬浮球，`↺` 清空快捷对话。
- 面板右上 **⚙ 设置**：全局唤醒快捷键（默认 `⌥Space`，可换预设/自定义/停用）、开机自启（LaunchAgent 实现，`~/Library/LaunchAgents/com.jws.jarvis.desktop.plist`）、服务器地址（默认 `https://jws.gkgeek-set.cn`）。
- 若 `npm install` 后启动报缺二进制（npm 拦截了 Electron 安装脚本）：`npm rebuild electron`，仍不行就 `node node_modules/electron/install.js`。

## 个人微信桥接

默认使用网页内置桥接：登录网页后点击顶栏 **微信**，生成二维码并用专用微信小号扫码确认。扫码后桥接在服务器进程内持续收发消息，浏览器和电脑都可以关闭；每个联系人使用独立的 `wx-<联系人>` 记忆线程。桌面悬浮窗也可在 **设置 → 个人微信** 中完成同一操作。

微信 Token 只保存在 `JARVIS_DATA_DIR/wechat_token`（权限 `0600`），不会返回前端。服务重启会自动恢复连接；登录态失效时页面会提示重新扫码。群聊和非文本消息默认忽略。

命令行备用桥仍位于 `wechat/ilink_gateway.py`。**不要让备用桥与网页内置桥同时连接同一个微信账号**，否则可能重复拉取或回复消息。第三方个人号接入存在账号风险，请使用专用小号，勿群发或营销。

## 加一个新工具（三步）

1. 在 `jarvis/tools/` 里建模块，用 `@tool` 写函数，docstring 用中文说清用途（模型靠它决定何时调用）。
2. 在 `jarvis/tools/__init__.py` import 并加入 `TOOLS`。
3. 在 `tests/` 补确定性单元测试；需要新行为规则时改 `jarvis/prompts.py`。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | 无（必填） | 模型 API key |
| `JARVIS_BASE_URL` | `https://api.deepseek.com` | OpenAI 兼容接口地址，换厂商改这里 |
| `JARVIS_MODEL` | `deepseek-chat` | 模型名（本项目实际用 deepseek-v4-flash） |
| `JARVIS_DATA_DIR` | `<项目根>/data` | 记忆库与备忘的存放目录 |
| `JARVIS_PORT` | `7789` | 网页端监听端口 |
| `TAVILY_API_KEY` | 无（实时搜索必填） | Tavily Basic 网页/新闻搜索密钥；缺失时明确报未配置 |
| `PANDASCORE_TOKEN` | 无（可选） | PandaScore 结构化电竞数据；缺失或失败时回退 Tavily |
