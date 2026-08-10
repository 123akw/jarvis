# 贾维斯（JWS-Agent）

终端里的私人管家：LangGraph ReAct agent 底座，SQLite 持久记忆（重启不忘事），本地工具（查时间、备忘增查删、白名单系统查询），中文交互。模型走 OpenAI 兼容接口，默认 DeepSeek。

## 项目结构

```
JWS-Agent/
├── pyproject.toml        # 包定义、依赖、jarvis 命令行入口
├── .env.example          # 环境变量模板（复制为 .env 填 key）
├── jarvis/               # 主包
│   ├── config.py         # 路径、环境变量、模型参数（唯一配置入口）
│   ├── prompts.py        # 人设与系统提示词
│   ├── graph.py          # LangGraph agent 组装（模型+工具+记忆）
│   ├── cli.py            # 终端入口（交互式 / --once 单发）
│   └── tools/            # 工具包，一个领域一个模块
│       ├── __init__.py   # TOOLS 注册表（新工具在这登记）
│       ├── clock.py      # 时间
│       ├── memo.py       # 备忘增查删（data/memos.json）
│       └── system.py     # 白名单系统查询
├── tests/                # 单元测试（不碰大模型，确定性判定）
├── scripts/              # 验收脚本（真模型冒烟 / 跨进程记忆）
└── data/                 # 运行时数据（gitignore）：jarvis.db、memos.json
```

## 快速开始

```bash
python3 -m venv .venv
.venv/bin/pip install -e ".[dev]"
cp .env.example .env      # 填入 DEEPSEEK_API_KEY
.venv/bin/jarvis          # 进入对话，输 quit 退出
.venv/bin/jarvis --once "现在几点了"   # 单发一句
.venv/bin/jarvis --thread work        # 换一条独立记忆线程
```

## 验收

```bash
.venv/bin/python -m pytest -q            # 13 条单元测试，0 跳过
.venv/bin/python scripts/check_smoke.py  # 真模型冒烟：必须真的调用了工具
.venv/bin/python scripts/check_memory.py # 两个独立进程先后对话，记忆必须接上
```

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
