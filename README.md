# 贾维斯（JWS-Agent）

私人管家：LangGraph ReAct agent 底座，SQLite 持久记忆（重启不忘事），13 项本地技能——时间、计算器、天气（Open-Meteo 免 key）、备忘、带时间的日程、可勾选的待办、白名单系统查询。中文交互，模型走 OpenAI 兼容接口，默认 DeepSeek。终端和网页端（钢铁侠 HUD 风格，流式回复+工具调用实时可视）双入口。

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
│       └── system.py     # 白名单系统查询
├── tests/                # 单元测试（不碰大模型，确定性判定）
├── scripts/              # 验收脚本（真模型冒烟 / 跨进程记忆）
└── data/                 # 运行时数据（gitignore）
```

## 快速开始

```bash
python3 -m venv .venv
.venv/bin/pip install -e ".[dev]"
cp .env.example .env      # 填入 DEEPSEEK_API_KEY

.venv/bin/jarvis-web      # 网页端 → http://127.0.0.1:7789
.venv/bin/jarvis          # 或终端对话，输 quit 退出
.venv/bin/jarvis --once "现在几点了"   # 单发一句
.venv/bin/jarvis --thread work        # 换一条独立记忆线程
```

网页端：登录后进入对话界面——左栏会话历史（新对话/按日分组/悬停删除），刷新和换设备后历史自动回放；回复逐字流式输出、实时显示工具调用、Markdown 渲染、生成中可停止、悬停可复制；右栏日程/待办/备忘每轮对话后自动刷新。问天气不用报城市：浏览器定位优先，IP 双源（ip-api/美团）兜底。终端与网页共用同一套记忆数据库。

## 验收

```bash
.venv/bin/python -m pytest -q            # 13 条单元测试，0 跳过
.venv/bin/python scripts/check_smoke.py  # 真模型冒烟：必须真的调用了工具
.venv/bin/python scripts/check_memory.py # 两个独立进程先后对话，记忆必须接上
```

## 桌面悬浮窗（macOS）

```bash
cd desktop && npm install && npm start
```

- 屏幕右侧出现 **MOSS 红瞳悬浮球**：置顶所有窗口、全工作区可见、按住外圈可拖拽。
- **点红瞳** → 原地向左展开快捷对话面板：最近历史 + 流式问答（独立 `desktop` 会话线程，不打扰网页端记录）；Enter 发送，`—` 收起回悬浮球，`↺` 清空快捷对话。
- 默认连 `https://jws.gkgeek-set.cn`；要改服务器地址，在面板开发者工具里执行 `localStorage.setItem('jws_server','http://127.0.0.1:7789')`。
- 若 `npm install` 后启动报缺二进制（npm 拦截了 Electron 安装脚本）：`npm rebuild electron`，仍不行就 `node node_modules/electron/install.js`。

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
