# 进度记录

## 开工回执（2026-08-10）
- 目标：终端版私人管家「贾维斯」——LangGraph 底座，多轮对话 + SQLite 持久记忆 + 4 类本地工具（时间/备忘增查删/白名单系统查询），中文交互。
- 顺序：任务0 环境核验（已过）→ 任务1 先写 tests/ 与 scripts/ 判卷（此刻应全红）→ 任务2 实现 jarvis/ 包 → 三连验收 + 两项反向验证。
- 领导追加裁决：模型用 deepseek-v4-flash（已验证在 /models 列表里），key 已入 .env（.gitignore 已排除）。
- 最大风险：langgraph 1.2.10 的 create_react_agent 参数名（prompt/checkpointer）与文档可能有出入——实现阶段以运行时报错为准调整，tests/scripts 冻结不动。
- 预算：真实模型请求 ≤50 次，实时在本文件记账。

## 任务 0 ✅（2026-08-10）
- python3 = 3.14.6 ✓；git init ✓；.venv 装齐 5 个白名单依赖，langgraph 1.2.10 导入 OK ✓。
- curl /models 返回 deepseek-v4-flash、deepseek-v4-pro，key 有效 ✓。
- 模型请求计数：0（curl 不算对话请求）。

## 任务 1 ✅（2026-08-10，提交 ae73f05）
- 13 条单元测试 + check_smoke.py + check_memory.py，实现未写时 13 条全红（已贴输出）。自此 tests/ 与 scripts/ 冻结。

## 任务 2 ✅（2026-08-10）
- jarvis/ 三件套完成。走过一个弯路：本机 all_proxy 是 SOCKS 代理，httpx 缺 socksio 直接崩——没有加依赖，改为 build_agent 里摘掉 all_proxy 走已有 HTTP 代理（这是「建议」层的临场决定，记录于此）。
- 三连验收一次连续全过：pytest 13 passed 0 skipped；check_smoke PASS（真实工具调用 1 次）；check_memory PASS（跨进程 10 条历史）。
- 反向验证均红→绿：坏 key 冒烟退出码 1→还原 0；摘 checkpointer 记忆检查退出码 1→还原 0。
- 模型请求计数：约 23 次（冒烟 3 轮 ×2、记忆 4 轮 ×4、坏 key 1），远低于 50 上限。
- 验收残留的 data/ 测试数据已清空，交付时贾维斯记忆为白纸。

## 架构规范化 ✅（2026-08-10，领导追加指令）
- 新增 pyproject.toml（可 pip install -e .，注册 `jarvis` 命令）、README.md、.env.example。
- 分层：config.py（路径/环境/模型参数）、prompts.py（人设）、tools/ 拆包（clock/memo/system 各一模块，__init__ 注册 TOOLS 并保住 `from jarvis.tools import ...` 老路径）。
- tests/ 与 scripts/ 一行未动；重构后三连验收全过（13 passed、冒烟 PASS、记忆 PASS）。
- 模型请求计数：累计约 29 次。

## 联网娱乐搜索开工回执（2026-08-11）
- 目标：让贾维斯以带来源和查询时间的方式回答实时娱乐、电影评分、电竞比分与票务报价。
- 顺序：通用 Tavily 搜索 → 三个娱乐垂直工具 → Agent 路由与全量回归 → 生产 smoke 与部署。
- 基线：74 passed、0 skipped；16 个工具；工作区开工时干净。
- 最大风险：生产没有 `TAVILY_API_KEY`，真实联网 smoke 在密钥到位前无法通过。
- 约束：不改微信桥/UI/数据库/systemd/nginx，不自动购票，不抓登录态或绕验证码。
- 任务 1 ✅：`tests/test_search.py` 13 passed；通用 Tavily 搜索、缓存、边界与错误映射完成。
- 任务 2 ✅：电影评分、电竞比分、票务搜索及 PandaScore→Tavily 回退完成；搜索专项 23 passed；工具总数由 16 增至 20。
- 任务 3 ✅：Agent 路由/来源/价格/提示注入约束、配置文档、`httpx` 直接依赖与四问 JSON smoke 完成；全量 100 passed、0 skipped，工具数 20，`git diff --check` 无输出。
- 任务 4 反向验收 ✅：`TAVILY_API_KEY=invalid-smoke-key` 运行四问 smoke，JSON 为 0/4、进程退出码 1，四类工具均显示“联网搜索认证失败”，没有假绿。
- 依赖安装 ✅：本地 `.venv/bin/pip install -e .` 成功，`httpx>=0.27` 已作为直接依赖解析。
- 当前阻断：本机与生产均确认没有 `TAVILY_API_KEY`；等待安全注入有效 Key 后才能执行真实 4/4、提交、推送和服务器部署。
- 完成条件审计补强 ✅：修复 PandaScore 的 LoL 别名、未来赛程遮挡已结束比分、战队 ID 被对手覆盖；同一电影平台冲突评分会显式标注。
- smoke 防假绿 ✅：最终 URL 必须来自工具结果、票务必须两个不同平台、单问最多 2 次 Tavily、红绿 smoke 使用独立会话；票务固定问题覆盖“哪里买”。
- 当前回归：108 passed、0 skipped，工具数 20，`git diff --check` 无输出；Tavily 官方参考页确认当前请求字段与 Bearer 鉴权格式。
- 当前版本反向验收复跑：run_id `b42251558a7c46448c0d69295a30f14e`，0/4、退出码 1，四类查询均明确认证失败且无假绿。
- 评分精度补强 ✅：Rotten Tomatoes 同页影评人分/观众分不会误报为来源冲突；同平台不同页面数值不一致仍会告警。当前全量 109 passed、0 skipped。
- 票务来源取舍：保持中国大陆可信售票域白名单优先；未额外放开任意“官方页”泛搜，因为无法可靠判定冒牌站点，按“真实可追溯 > 覆盖”让步。
- 上线前只读检查 ✅：生产 `jarvis-web`=active、`wechat_token`=present、`/api/wechat/status`=connected，仓库仍在 main@342d4a2；证明部署通道正常，部署后仍须复验。
- 第 3 轮阻断审计：本机/生产 Tavily Key 仍均未配置，达到任务书停止阈值。按例外交付已完成的 `codex/entertainment-search` 分支；未做真实 4/4、未 fast-forward 生产、未重启服务。
- 领导后续明确授权：缺 Key 状态下先合并并推送 Git `main`；这不等于生产部署，真实 4/4 与服务器上线仍等待 Key。
- Git 主分支合并 ✅：`codex/entertainment-search` 已 fast-forward 到 `main` 并推送 `origin/main`；合并后 109 passed、工具数 20，本地功能分支已删除，远端功能分支保留用于追溯。

# 语音通话（voice-call 分支，2026-08-13 开工）

## 任务 0 ✅（2026-08-13 实测）
- 基线复核：`.venv/bin/python -m pytest tests/ -q` → 378 passed, 8 failed，8 个失败全在 tests/test_tools.py（对方地界），与任务书完全一致。
- t2a_v2 HTTP 实测：`POST https://api.minimaxi.com/v1/t2a_v2`（speech-02-turbo）→ HTTP 200 / 1040ms，base_resp status_code=0，audio 35124 字节。
- t2a_v2 WSS 实测：`wss://api.minimaxi.com/ws/v1/t2a_v2` → 381ms connected_success，429ms task_started，719ms 首个音频块，共 55917 字节。注意：服务端音频事件名为 `task_continued`，音频为 hex 编码；无取消事件，打断=直接关 WebSocket。
- 国内站文档中心核查（platform.minimaxi.com/docs/llms.txt 全量索引）：只有 TTS（HTTP+WebSocket）、克隆、视频/图片/音乐生成；**无 ASR、无 Realtime 语音对话 API**。故维持级联架构，不改 Realtime。

### 选定链路（≤10 行）
1. 浏览器 Web Speech API（zh-CN，连续+interim）做语音转文字，说话停顿自动出 final。
2. 前端把 final 文本经 WebSocket `/api/voice/call` 上行（cookie 会话 + init 消息带 CSRF）。
3. 后端复用该用户 agent（_bundle_for/tenant_scope，照 /api/chat 抄法）流式生成回答。
4. 回答按句切分（jarvis/voice/segment.py），逐句送 MiniMax TTS WSS（speech-02-turbo，pcm/24kHz/单声道）。
5. hex 音频解码后以二进制帧下行，浏览器 Web Audio API 排队播放，边收边播。
6. 打断：新语音/interrupt 到达 → 取消 agent 流+关 TTS WebSocket+清播放队列。
7. TTS 连不上或中途失败 → 下行 tts_error，一路降级纯文字不断流。
8. 无 ASR 的浏览器：无服务端 ASR 可兜底（任务 0 已证实国内站没有），降级为通话态内打字输入、语音答复（替代任务书「按住说话」，因为按住录的音没有任何服务端能转文字）。
- 依赖：零新增运行时依赖（websockets==15.0.1 已在 requirements.lock）。Playwright 仅本地验收用，不进依赖文件。
