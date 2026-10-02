# 开发与测试

[← 返回 README](../README.md) · [功能](features.md) · [部署](deployment.md) · [配置](configuration.md) · [微信与飞书](channels.md) · [架构](architecture.md) · [FAQ](faq.md)

**目录**：[验收与测试](#验收与测试) · [前端与桌面端测试](#前端与桌面端测试) · [项目结构](#项目结构)

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
# 飞书：默认离线自检；--live 真连（需 FEISHU_APP_ID/SECRET，见 docs/channels.md「飞书机器人」）
.venv/bin/python scripts/feishu_smoke.py
```

验收含义：

1. `pytest -q`：全量确定性单元测试应为 0 失败。
2. `check_smoke.py`：真实模型回答“现在几点了”，且必须产生实际工具调用。
3. `check_memory.py`：两个独立 CLI 进程先后对话，验证第二次能读取第一次写入的 SQLite 历史。
4. `search_smoke.py`：默认由离线 stub 覆盖 SearXNG/DDGS 风格的免费链结果，JSON 应为 4/4，并包含查询时间与可追溯来源；`--live` 才进行真实模型/provider 验收，Tavily 与 PandaScore 仍为可选项。
5. `concurrency_smoke.py`：自动起一个隔离数据目录的本地服务并引导 Owner，3 路真实聊天并发时 20 次 `/api/dashboard` 的 P95 必须小于 2 秒，且聊天全部真实完成才退出 0。

飞书机器人的后台配置与 `--live` 冒烟注意事项见 [微信与飞书](channels.md#飞书机器人)。

## 前端与桌面端测试

```bash
cd web-src && npx vitest run   # 网页端（React + Vite）
cd desktop && node --test      # macOS 桌面端（Electron）
```

当前测试基线（第九轮，2026-10-02）：**pytest 657 / vitest 133 / desktop 124**，全部通过。网页端源码在 `web-src/`，`npm run build` 的产物输出到 `jarvis/web/` 并随仓库提交。

## 项目结构

```text
JWS-Agent/
├── jarvis/
│   ├── config.py          # 环境变量、模型与数据路径
│   ├── graph.py           # LangGraph ReAct Agent + SQLite checkpointer
│   ├── heartbeat.py       # Heartbeat 主动唤醒（关注清单巡检+双通道推送）
│   ├── distill.py         # 夜间记忆蒸馏（最近一天对话 → 长期画像）
│   ├── server.py          # FastAPI、登录、SSE、仪表盘与兼容接口
│   ├── cli.py             # 交互式与单发 CLI
│   ├── wechat.py          # Web 服务内置个人微信桥
│   ├── channels/feishu/   # 飞书机器人（长连接收事件、流式卡片回复、账号绑定）
│   ├── voice/             # 语音通话、会议转写、场景与情绪、说话人分离
│   ├── search/            # SearchService 与搜索 provider
│   ├── plugins/           # 插件框架：加载器、导入、子进程沙箱、MCP 客户端；packs/ 是 49 个官方插件（MIT-0）
│   ├── platforms.py       # 智能体工坊：市场开号、智能体（平台）存储、按插件绑定工具
│   ├── platform_home.py   # 智能体主页的问候与快捷问题
│   ├── flows/             # 积木流程：存储、执行器、积木、公开结果页
│   ├── files.py           # 文件空间（对话附件与工具生成的文件）
│   ├── history_index.py   # 翻旧账：跨会话全文检索
│   ├── web/               # 零构建的网页端（web-src 构建产物）
│   └── tools/             # 27 项核心工具及注册表
├── web-src/               # 网页端 React + Vite 源码
├── desktop/               # macOS Electron 悬浮球与设置页（npm run pack:mac / install:mac 打包为 贾维斯.app）
├── .agents/plugins/       # 官方插件源 marketplace.json（兼容 Codex / ChatGPT 插件源格式）
├── examples/              # 插件模板（MIT-0）、示例插件、示例插件源
├── skills/                # 技能热加载目录（放 SKILL.md 即生效）
├── wechat/                # 命令行备用网关
├── deploy/searxng/        # 可选的本地 SearXNG Compose（AGPL-3.0）
├── tests/                 # 确定性单元测试
├── scripts/               # 真模型、记忆与实时搜索验收脚本
├── docs/                  # 详细文档（本目录）
│   └── assets/readme/     # README 产品截图
├── pyproject.toml
└── .env.example
```

各轮开发与验收记录见 [`PROGRESS.md`](../PROGRESS.md)，面向用户的更新见 [`CHANGELOG.md`](../CHANGELOG.md)。
