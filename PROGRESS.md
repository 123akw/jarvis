# PROGRESS（2026-08-13 双线并行交付合并）

## 线 A · 语音通话
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

# 语音升级（voice-upgrade 分支，2026-08-13 开工）——服务端 ASR + 推流字幕 + 口语化

## 任务 0 ✅（2026-08-13 实测）
- 基线复核：`.venv/bin/python -m pytest tests/ -q` → 408 passed, 0 failed, 0 skipped；`cd web-src && npx vitest run` → 24 passed。与任务书一致。
- `.env` 核验：**无 DASHSCOPE_API_KEY**（仅 DEEPSEEK/JARVIS_BASE_URL/JARVIS_MODEL/MINIMAX 四项）→ 按任务书走「无 key」路线：asr.py 架构 + fake 注入单测、前端推流、字幕 UI、口语化全部照做；asr_smoke --live 与反向 key 验证标注「待 key」，已记 BLOCKED.md。
- 百炼协议已按官方文档核实（help.aliyun.com/zh/model-studio/paraformer-client-events + paraformer-server-events）：run-task/finish-task 指令、task-started/result-generated（sentence.text + sentence_end + heartbeat）/task-finished/task-failed 事件、二进制音频帧直接上行。

### 选定方案（≤10 行）
1. jarvis/voice/asr.py：直连百炼 WebSocket（无 dashscope SDK，零新依赖），paraformer-realtime-v2，PCM16/16kHz 单声道。
2. gateway：二进制帧→ASR 转发；增量下行 asr_partial（字幕灰字）、定稿下行 asr_final 并开回合；ASR 连不上→一次 asr_fallback，前端切浏览器识别。
3. ASR 会话工厂仿 create_tts_session 可整体替换，fake 路径单测覆盖断连降级/增量字幕/打断丢弃未定稿。
4. 前端：AudioWorklet 采集+重采样 16kHz PCM16 每 100ms 一帧上行；本地 RMS VAD 播放中检测人声≈200ms 触发打断（停播+interrupt）。
5. 字幕：识别中灰字（asr_partial）→定稿实字（asr_final），回答 token 滚动；不支持推流/收到 asr_fallback→退回 SpeechRecognition 旧路。
6. 口语化：gateway 在语音回合注入一次性 system 指令（≤3 句/先结论/口语化/不念 URL 代码表格），回合结束用 RemoveMessage 从 checkpoint 摘除，文字模式零残留。
7. voice_smoke 增强：--live 自起本地服务走真 agent+真 TTS，打印「说完→首音频」全链路毫秒数，阈值 3500ms。
8. ASR WSS 地址可配（DASHSCOPE_ASR_WSS_URL，默认 dashscope.aliyuncs.com/api-ws/v1/inference）；新文档出现 workspace 子域网关，待 key 实测后如需切换记 PROGRESS。

## 任务 1 ✅ 服务端流式识别（2026-08-13）
- 新增 jarvis/voice/asr.py：百炼 paraformer-realtime-v2 WebSocket 直连（run-task/finish-task/result-generated/task-failed 全协议，零新依赖，websockets 已在锁文件）；key 只从环境变量读，异常不带上游细节。
- gateway.py 新增 _AsrPipeline：二进制帧→百炼；建连期先攒帧（上限 ~10s）接上后按序补发；asr_partial 增量字幕 / asr_final 定稿自动开回合 / 任何一环坏掉一次 asr_fallback 降级浏览器识别（音频此后静默丢弃，user_text 通道不受影响）；interrupt 丢弃未定稿文字并下发空 asr_partial 清字幕。
- 中途 key 到位（管理者注入 .env）：「待 key」项全部当场补齐——
  - `asr_smoke.py --live`（TTS 合成回环防假绿）：识别会话建立 230ms，首个识别结果 225ms，**识别文字「明天上午九点提醒我参加项目周会。」与原句重合率 100%**，EXIT=0。
  - 反向验证：`DASHSCOPE_API_KEY=sk-invalid-smoke-key` → 「FAIL：语音识别连接失败」EXIT=1（红）；还原 → 100% 重合 EXIT=0（绿）。
  - 默认网关 wss://dashscope.aliyuncs.com/api-ws/v1/inference 实测可用；模型维持 paraformer-realtime-v2（识别 100% 中文无误，无需换模型）。
- 验收：pytest tests/test_voice* → 26 passed（新增 ASR 协议 6 条 + 网关 6 条：增量字幕、定稿开回合、建连攒帧、连接失败降级、中途断连降级、打断丢弃未定稿）；全量 419 passed, 0 failed, 0 skipped（基线 408 + 11）。
- 协议变更：旧「二进制帧→asr_unavailable 错误」按任务书移除，对应测试改写为 test_binary_uplink_falls_back_without_asr_key（同一意图：无服务端识别时明确降级，不是删测试）。

## 任务 2 ✅ 前端推流 + 字幕 + 打断（2026-08-13）
- 新增 web-src/src/VoiceAudio.js：AudioWorklet 采集 → 线性插值重采样 16kHz → PCM16 每 100ms 一帧（与后端格式对齐），帧级 RMS 随帧回调供 VAD；worklet 源码内联 Blob 装载，零新 npm 依赖。
- VoiceCall.jsx 三层输入链路逐级降级：推流+服务端识别（首选）→ asr_fallback/推流组件缺失退浏览器 SpeechRecognition → 识别 API/麦克风没有退打字通话。字幕：asr_partial 灰字增量 → asr_final 实字定稿，回答 token 滚动跟随；打断=本地 RMS VAD 连续 2 帧（约 200ms，预算 500ms 内）→ 停播+interrupt，另有 asr_partial 兜底打断与手动按钮；状态动效：听（脉冲）/想（跳点）/说（均衡器条）。
- 验收：npx vitest run → 31 passed 0 failed 0 skipped（基线 24 + 新增 7 ≥4：帧上行、字幕增量、VAD 打断、VAD 防误触、asr_fallback 降级、麦克风被拒降级、状态机）。
- Playwright 无头（.venv 装 playwright+chromium，本地验收工具不进依赖文件；须 channel="chromium" 新 headless——旧 headless shell 的 getUserMedia 直接 NotSupportedError，实测踩坑）：真后端（临时数据目录引导 Owner）+ vite dev 代理（零 import 配置放 scratchpad，不碰 vite.config.js）。链路「登录→通话→（无 key 后端）推流→asr_fallback→浏览器识别→模拟识别事件→灰字字幕→定稿→真 DeepSeek→真 MiniMax TTS 播放→模拟开口→打断 TTS 停」全绿 EXIT=0，浏览器侧「说完→开始播放」2811ms。截图：
  - /private/tmp/claude-501/-Users-chenwenjie-JWS-Agent/cdd0a890-bca4-421a-95c8-848fa9e7165a/scratchpad/shots/voice_subtitle_interim.png
  - /private/tmp/claude-501/-Users-chenwenjie-JWS-Agent/cdd0a890-bca4-421a-95c8-848fa9e7165a/scratchpad/shots/voice_reply_speaking.png
  - /private/tmp/claude-501/-Users-chenwenjie-JWS-Agent/cdd0a890-bca4-421a-95c8-848fa9e7165a/scratchpad/shots/voice_after_barge_in.png
- 界限说明：jarvis/web 构建产物不在本任务白名单，未重新构建/提交；上线前管理者需 `cd web-src && npm run build`（产物目录 jarvis/web）再部署。

## 任务 3 ✅ 语音回答口语化 + 全链路延迟（2026-08-13）
- gateway 语音回合注入一次性 system 指令（VOICE_STYLE_PROMPT：≤3 句/先结论/口语化/不念 URL 代码表格 Markdown/数字时间中文口语），带专属 id，回合结束（含被打断）用 RemoveMessage 从 checkpoint 摘除——字幕仍显示 agent 完整文字（token 事件不动），语音只读 speakable() 口语版。
- speakable() 实现增强（签名不变）：裸 URL →「（链接略）」、Markdown 表格行不出声；segment.py 新增 FirstFastSegmenter（只加类不改旧签名）：首句 24 字内软标点提前开口，解决「整段只有末尾句号导致 TTS 等全程」——全链路实测 3477ms → 2552/2593ms。
- 单测：注入+摘除（FakeAgent 记录 stream 输入与 update_state）、真 langgraph InMemorySaver 检查点上验证摘除后仅剩 human/ai、文字模式 /api/chat 输入零注入零状态修补、FirstFastSegmenter 两条、speakable 两条。反向验证：临时摘掉注入 → test_voice_turn_injects_style_prompt_then_scrubs_it 红；还原 → 14 passed 绿。
- voice_smoke --live 增强：TTS 直连测首包后，再拉起真实本地服务走完整通话回合（真 DeepSeek + 真 MiniMax），打印「说完→首音频」毫秒数，阈值 3500ms。
- 验收实测：TTS 首包 286ms；全链路「说完→首音频」2593ms ≤3500ms，EXIT=0；回答样例「给您一句：蜜蜂采蜜时，翅膀每秒要扇动两百多次……」（1 句、口语、先结论）。Playwright E2E 复跑（含新链路）浏览器侧 2317ms，PASS。
- 最终全量：pytest 426 passed 0 failed 0 skipped（基线 408+18）；vitest 31 passed 0 failed 0 skipped（基线 24+7）。
- 硬指标 2 佐证：`git diff main -- jarvis/voice/tts.py jarvis/wechat.py jarvis/server.py README.md docs/` 输出为空；segment.py diff 仅新增 FirstFastSegmenter，无既有签名改动。
- 新增依赖：运行时 0；本地验收工具 playwright（.venv 内 pip 装，不进 pyproject/requirements——仅判卷用，生产不跑浏览器）。

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

## 任务 1 ✅ 后端语音网关（2026-08-13，提交 d8e5fa6）
- 新增 jarvis/voice/{segment,tts,gateway}.py；server.py 只动了顶部 1 行 import + 末尾「# ---- 语音 ----」区块（已有函数零改动，git diff 可复核）。
- /api/voice/call：cookie 会话鉴权 + init 消息带 CSRF（防跨站 WebSocket 劫持，向 /api/chat 的安全姿势看齐）；未登录回错误帧并以 4401 关闭；也支持桌面端 x-jws-token。
- 回合语义：user_text 开新回合并立即打断在途回合（取消 agent 流 + 关 TTS 连接 + turn_end interrupted=true）；TTS 连接失败或中途 task_failed → 下行一次 tts_error，文字流照走不断。
- agent 复用 _bundle_for/tenant_scope/heal_dangling_tool_calls（照 /api/chat 抄法），工具/记忆/多租户与文字聊天完全一致；对话写入同一记忆库，挂断后网页回放。
- 验收：pytest tests/test_voice* → 15 passed（含未登录拒绝、坏 CSRF 拒绝、TTS 失败降级、打断、二进制上行 asr_unavailable、TTS 协议单测、切句单测）。
- voice_smoke --live：会话建立 539ms，音频 309848 字节，首包延迟 369ms ≤2500ms，退出码 0。反向验证：MINIMAX_API_KEY=invalid-smoke-key 复跑 →「会话建立：失败」退出码 1；还原后 418ms / 348856 字节 / 383ms，退出码 0。
- 全量回归：393 passed（基线 378 + 新增 15），8 failed 仍全在 tests/test_tools.py，与基线一致、无新增失败名。

## 任务 2 ✅ 网页通话 UI（2026-08-13，提交 f2dba79 + 麦克风探测修正）
- VoiceCall.jsx/css：Chat 加通话按钮；进入通话即 getUserMedia 申请麦克风（任务书原文「申请麦克风」，同时解决无头 Chromium 里 SpeechRecognition 静默不报错的问题），被拒给人话提示且打字通话可用、文字聊天不受影响。
- 识别：Web Speech API zh-CN 连续 + interim，说话停顿 isFinal 自动断句上行；播放中检测到开口即上行 interrupt 并清本地播放队列（打断）；Chrome 静音自动停止后自动重启识别。
- 播放：PCM16/24kHz 二进制帧经 Web Audio API 排队播放，边收边播；可视状态：接通中/请讲（录音中）/思考中/回答中（播放中），工具调用有 chips。
- 浏览器覆盖：桌面 Chrome/Edge 与 Android Chrome 走完整语音；Firefox/无识别 API/麦克风被拒统一降级「打字通话、语音答复」（「按住说话」不可行的原因见任务 0 第 8 条）。
- 验收：cd web-src && npx vitest run → 24 passed（新增 VoiceCall 6 条 ≥3）；npm run build 产物已提交进 jarvis/web。
- Playwright（.venv 装 playwright+chromium，仅本地验收工具，不进依赖文件）：登录→点通话→通话面板可见→无麦克风权限显示降级提示 → 截图 voice_call_degraded.png；加场全链路真实往返（打字通话→真 DeepSeek agent→真 MiniMax TTS→浏览器收到音频 10240 字节）→ 截图 voice_call_roundtrip.png，退出码 0。
- 新增依赖清单：运行时 0 个；本地验收工具 playwright（pip 装在 .venv，不写入 pyproject/requirements——理由：只有判卷用，生产不跑浏览器）。

## 部署材料（管理者合并后统一上线，本执行者未碰生产、未改 nginx）
1. nginx：`/www/server/panel/vhost/nginx/jws.gkgeek-set.cn.conf` 的 server{} 里、现有 `location /` 之前加：

   ```nginx
   location /api/voice/call {
       proxy_pass http://127.0.0.1:7789;
       proxy_http_version 1.1;
       proxy_set_header Upgrade $http_upgrade;
       proxy_set_header Connection "upgrade";
       proxy_set_header Host $host;
       proxy_set_header X-Real-IP $remote_addr;
       proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
       proxy_set_header X-Forwarded-Proto $scheme;
       proxy_read_timeout 3600s;   # 通话是长连接，默认 60s 会掐断
       proxy_send_timeout 3600s;
       proxy_buffering off;
   }
   ```

   然后 `nginx -t && systemctl reload nginx`（同机还有 bloghouduan / ecoversion 两个现役站点，别碰它们的 conf）。
2. 代码：合并 voice-call → main 后服务器 `cd /opt/jarvis && git pull`（GitHub 卡死走 git bundle 兜底流程）。前端产物 jarvis/web 已随分支提交，服务器不需要 npm。
3. 依赖：无新增运行时依赖。确认生产 venv 有 websockets（uvicorn 的 WS 支持靠它）：`cd / && /opt/jarvis/.venv/bin/python -c "import websockets"`；缺了 `.venv/bin/pip install -r requirements.lock`，再按黑屏事故铁律 editable 重装 `pip install -e . --no-deps --no-build-isolation` 并在 `cd /` 下验证 jarvis.server 指向 /opt/jarvis。
4. 密钥：确认 `/opt/jarvis/.env` 含 `MINIMAX_API_KEY`（systemd EnvironmentFile 注入，不进 Git）。
5. 重启：`systemctl restart jarvis-web`。
6. 验收：服务器 `cd /opt/jarvis && .venv/bin/python scripts/voice_smoke.py --live` 首包延迟应 ≤2500ms 且退出 0；浏览器登录 https://jws.gkgeek-set.cn → 📞 → 授麦克风 → 语音对话、开口打断；拒授麦克风应出现打字通话降级提示且文字聊天正常。

## 线 B · 并发加固与遗留修复
# PROGRESS

## 任务 0：现状核对（2026-08-13）
- 基线实测：`pytest tests/ -q` → 378 passed, 8 failed, 0 skipped；8 个全是 tests/test_tools.py::test_memo_*，报 TenantScopeError，与任务书一致。
- `grep -n "暂时无法应答" jarvis/wechat.py` → 378 行命中 `f"（贾维斯暂时无法应答：{type(exc).__name__}）"`，与任务书一致。
- 目标顺序：1) 修 8 个红测试到 386/0/0 → 2) 微信入队+4 线程池、同发信人串行 → 3) 并发冒烟 P95<2s → 4) 报错人话化 + README 走查。
- 最大风险：微信改异步入队后原有同步断言测试的兼容；smoke 脚本真实起服务、真实模型的引导链路。

## 任务 1：8 个红测试 → 全绿（commit 1f9f2d6）
- tests/test_tools.py 新增 `owner_scope` fixture（AccountStore 引导 Owner + tenant_scope），8 个 memo 用例挂上。
- 落盘契约适配：memos.json → accounts.sqlite3 的 tenant_memos 表（参照 tests/test_tenant_isolation.py 现有写法），断言仍验真实落盘内容，非放水。
- jarvis/tenancy.py、jarvis/accounts.py、jarvis/tools/memo.py 零改动（git diff main 为空）。
- 反向验证：去掉 test_memo_add_then_list 的作用域 → TenantScopeError 红；还原 → 386/0/0 绿。

## 任务 2：微信多用户不互卡（commit bb026e2）
- jarvis/wechat.py 新增 `_ReplyDispatcher`：ThreadPoolExecutor 上限 `REPLY_WORKERS=4`，按发信人独占队列消费（同人严格串行、异人并行）。
- `_handle_updates_response` 在有活动轮询会话（`_confirm_login`/`resume_on_boot` 建立 dispatcher）时入队即返回；长轮询线程只收发不算。设计取舍：无会话的直接调用（现有单测/协议探针路径）保持内联同步处理——这让 22 个原有 test_wechat 用例零改动全绿，生产路径永远走异步入队。
- 新增 tests/test_wechat_concurrency.py 4 用例：B 不等 A 的 3 秒慢回复（时间+顺序断言）、同人保序、并发上限 ≤4 且真并行 ≥2、断开后 dispatcher 拒收。
- 反向验证：REPLY_WORKERS 临时改 1 → 2 用例红（B 等 A、无并行）；还原 4 → 390/0/0 绿。

## 任务 3：网页并发冒烟与治理（commit ad11241）
- 新建 scripts/concurrency_smoke.py：自动找空闲端口（或 JARVIS_PORT）、隔离临时数据目录、env 引导 Owner 并登录、3 路真实模型聊天 + 并发 20 次 /api/dashboard，打印全部延迟与 P95；聊天必须真实完成（token+done）且 P95<2000ms 才退出 0，防打假服务。
- 冒烟暴露真 bug：sync SSE 生成器由 AnyIO 默认线程池逐段恢复，`tenant_scope` 的 contextvar 跨 Context reset 抛 ValueError——真实服务上每次聊天结尾必报错（进程内直跑不复现，故单测从未拦住）。
- 治理（任务书预授权方向「agent 调用挪独立线程池」）：jarvis/server.py 新增 `jarvis-agent` 专用线程池（启动配置 JARVIS_AGENT_WORKERS，默认 8），`_stream_from_agent_thread` 让整段流式在同一线程运行、事件经 asyncio 队列回传；/api/chat 与 /v1/chat/completions 流式路径同修。长聊天不再与 dashboard 抢 AnyIO 票。
- 验收：3 路聊天全部真实完成，dashboard P95 = 70ms，EXIT=0。
- 反向验证：--chats 12 → P95 劣化 70ms→202ms（约 3 倍），且 3 路聊天 ReadTimeout、1 路 129.7s，脚本 EXIT=1 测得出问题。瓶颈是单用户共享 bundle 的 httpx max_connections=10 + agent 池 8 工位；真实多用户各持独立 bundle，≤20 人正常使用不受此约束。
- 已知取舍：客户端断开后 pump 线程会把当轮 agent 流跑完才释放（与旧行为一致量级，≤20 人可接受）。

## 线 C · 微信语音（wechat-voice 分支，2026-08-13 开工）

### 任务 0 ✅（2026-08-13 实测）
- 基线复核：`.venv/bin/python -m pytest tests/ -q` → **408 passed, 0 failed, 0 skipped**（18.59s），与任务书一致。
- 探针日志实测：`ssh root@1.12.67.169 "journalctl -u jarvis-web | grep 'non-text probe'"` → **空输出**，领导还没发语音；「等语音样本」已记 BLOCKED.md，先按自适应结构实现（key 名可配置），样本到位后一处改齐。
- `.env` 核验（只看 key 名）：有 DEEPSEEK/MINIMAX 等 4 项，**无 DASHSCOPE_API_KEY** → 识别侧写到「音频字节就绪」为止，真实百炼调用留接口，单测用注入 fake ASR；已记 BLOCKED.md。
- 理解：收侧=解析语音 item→下载→silk 解码→ASR→现有回复链路（文首标注识别内容）；发侧=speakable→MiniMax TTS(pcm/24k)→silk 编码→sendmessage 语音 item→再发文字；任一发语音环节失败→只发文字+log.warning。顺序：任务 1 收侧 → 任务 2 发侧 → 任务 3 亲验清单。
- 最大风险：iLink 语音收发报文结构均未见实样，收发两侧都按可配置结构实现（env 可改 key 名/类型号），真机报文到位后小步修正。
- 新依赖 pilk（silk v3 编解码，仅此一个）：本机实测 encode(tencent=True) 出 `\x02#!SILK_V3` 头、decode 带/不带 0x02 前缀均可、get_duration 返回 ms。仅装入 .venv；requirements.lock/pyproject 不在我的白名单，入锁由管理者合并时定夺（已记 BLOCKED.md 备注）。
- 【当日追更】管理者中途送达 DASHSCOPE_API_KEY（已追加进本 worktree .env）：识别侧限制解除，百炼真实调用已实现并实测通过（见任务 1），BLOCKED.md 对应条目改为已解除。

### 任务 1 ✅ 收语音→听懂→文字回复（2026-08-13）
- 新建 jarvis/wechat_voice.py：find_voice_item（自适应解析：配置 key 精确匹配 → 「key 名含 voice 且值为 dict」兜底；type==1 文本 item 永不误判）→ download_voice（内嵌 base64 优先，其次 URL 下载，key 名均可配）→ decode_to_wav（wav 透传 / silk v3 经 pilk 解成 16k wav）→ DashScopeASR。
- 百炼端点实测（真实 key）：`POST dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation` + 模型 `qwen3-asr-flash` + base64 data URI 上行 → HTTP 200；候选 `qwen-audio-asr` 已下线（400 Model not exist），故默认模型定 qwen3-asr-flash（JARVIS_DASHSCOPE_ASR_MODEL/URL 可覆盖）。
- 收侧全链路实测：MiniMax TTS 合成「明天上午九点提醒我参加项目评审会。」→ encode_silk（8975 字节）→ VoicePipeline.transcribe（真 pilk 解码 + 真百炼）→ 识别文字与原文逐字一致。
- 回复形态：识别文字走现有 _reply 链路（同租户/同记忆线程），文首标注「（语音识别）你说的是：「…」」；识别链路任一环失败回固定文案「这段语音我没听清，麻烦再说一次或打字」，绝不沉默。
- 新依赖理由（每个一行）：pilk——微信语音 silk v3 编解码，纯 C 扩展无传递依赖，收发两侧共用。
- 验收：tests/test_wechat_voice.py 21 条（fake 下载/解码/ASR 注入，无网络），覆盖成功、识别失败、解码失败、下载失败四路 + 结构自适应/可配置/真 pilk 往返/百炼客户端解析。全量 429 passed（408 基线 + 21 新增）0 failed 0 skipped。
- 反向验证（红→绿）：`git stash push jarvis/wechat.py`（回退到无语音处理的基线）→ 失败路 2 条测试红（TypeError: 无 voice_pipeline 参数）→ `git stash pop` → 2 passed 绿。

### 任务 2 ✅ 语音回复（2026-08-13）
- 发侧：synthesize_pcm（speakable 净化 → MiniMax 流式 TTS wss → 24k PCM，工作池线程内独立事件循环）→ encode_silk（pilk tencent 变体，`\x02#!SILK_V3` 头）→ build_voice_items（item type/key 名全可配，默认 type=34 + voice_item{voice_data,format,duration}，实样到位改默认值一处）→ 走既有 sendmessage 合同（client_id/base_info）。
- 降级：合成/编码/发送任一环失败 → log.warning 一行分类（synthesis/encode | send | unexpected）→ 只发文字，文字必达。
- 验收：单测覆盖语音+文字双发、合成失败降级、语音发送网络失败降级、语音 send 合同；smoke `scripts/wechat_voice_smoke.py` 实跑：TTS 1100ms、wav 291502 字节（afinfo 验证 WAVE/24kHz/6.07s 可播放）、silk 16105 字节、时长 6072ms、PASS 退出 0。
- 反向验证（红→绿）：`MINIMAX_API_KEY=invalid-smoke-key` 跑 smoke → 「TTS 合成：失败（语音合成连接失败）」FAIL 退出 1；还原 → PASS 退出 0（wav 305990 字节 / silk 16835 字节 / 6373ms）。
- 体验取舍：语音回复文本截断 280 字（JARVIS_WECHAT_VOICE_MAX_REPLY_CHARS 可调）——微信单条语音约 60s 上限，超长答案语音念开头、全文在文字条里。

### 任务 3 ✅ 真机联调材料（半托，待管理者部署后领导执行）
领导亲验清单：
1. 对微信里的贾维斯说一段正常语音（如「明天上午九点提醒我开会」）→ 应收到两条回复：一条语音（可点播）+ 一条文字（文首带「（语音识别）你说的是：「…」」）。
2. 发一段含糊/环境噪音的语音 → 应收到文字「这段语音我没听清，麻烦再说一次或打字」。
3. 若只收到文字没有语音 → 属预期降级（发语音失败自动只发文字），请管理者查 `journalctl -u jarvis-web | grep "degraded to text"` 看分类。
4. 若语音一直没被识别 → 请管理者取 `journalctl -u jarvis-web | grep "non-text probe"` 的脱敏结构发回，按实样改 JARVIS_WECHAT_VOICE_* 配置或 wechat_voice.py 顶部默认值（一处改齐）。
部署提醒（管理者）：生产 venv 需安装 pilk；生产 .env 需注入 DASHSCOPE_API_KEY；语音收发报文结构未经真机验证，首次联调按第 4 条闭环。

## 任务 4：报错人话化 + 开箱走查（commit 见 docs）
- jarvis/wechat.py `_humanize_reply_failure`：超时类 → 「联网检索或模型响应超时了，稍后再把这条消息发我一次」；其他 → 人话 + 「让管理员在网页端检查模型与联网配置」。异常类名只进日志。新增 tests/test_wechat_errors.py 2 用例防回归。
- /api/chat 流式异常兜底补 `log.exception`（此前异常被吞、无法排障），用户文案维持既有人话。
- 走查（全新 venv 全流程亲手跑）：安装 `pip install -e ".[dev]"`、`cp .env.example .env`、browser extra + Chromium、`jarvis-web` 起服 → Owner 首登引导 → POST /api/admin/users 邀请 Member → Member 登录 → Member dashboard 租户隔离为空数据 → 微信状态接口 Owner 200 idle / Member 403 → CLI `--once "现在几点了"` 真实模型应答。全流程无断点。
- README 修订 3 处与实际不符/缺口：快速开始补首启必填的 Owner 三项（否则 fail closed 无法登录）；网页端一节补首位 Owner 来源与「账户设置→用户管理」邀请 Member 入口；验收一节补 concurrency_smoke.py。
- 半托管待领导亲验：desktop `npm start`（GUI 悬浮窗，无人值守无法验收；`npm install` 已跑通）。
