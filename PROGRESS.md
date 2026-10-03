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

## 线 C · README 焕新（readme-refresh 分支，2026-08-13）

### 任务 0：核对与开工（2026-08-13）
- 核对：生产首页 `curl -s -o /dev/null -w "%{http_code}" https://jws.gkgeek-set.cn` → 200；规格文件 docs/superpowers/plans/2026-08-13-readme-live-screenshots.md 存在（前 20 行已贴对话）；docs/assets/readme/ 现有 6 张图（3 桌面 + 3 旧网页图）。
- 理解：规格文件是截图与约束的法；README 已含多用户内容但缺语音，三张网页图需按生产实况重截 1600×1000；登录用仓库源码可见内置账号（docs/superpowers/plans/2026-08-11-wechat-bridge-closed-loop.md:293）；截图后登出不留会话。
- 顺序：任务 1 截图（含反向验证）→ 任务 2 README 产品介绍 + 语音怎么用 + 快速开始实跑 → 验收（尺寸/死链/diff 范围）→ 提交。
- 风险与处置：生产选择器与预期不符（先 snapshot 探明再截）；截图带敏感信息（逐张人工过检）；规格 Task 4 Step 3 要求 push origin/main 与任务书「不许 git push」冲突——以任务书为准，只落本地 readme-refresh 分支。
- 工具让步：规格写 Playwright CLI wrapper，改用等价 Python Playwright 脚本（同为 Playwright、同尺寸同约束）。

### 任务 1：三张生产截图（2026-08-13）
- 反向验证：先故意以 1600×900 截 dashboard → 校验脚本输出 `FAIL docs/assets/readme/web-dashboard.png 1600x900`、exit 1（红）；删除后按 1600×1000 重截三张 → 三行 PASS、exit 0（绿）。输出均已贴对话。
- 三张全为 2026-08-13 生产实况新截（旧网页图先删除再重拍，未拿旧图充数）；`file` 确认均为 PNG 1600×1000。
- 敏感信息人工过图结论：dashboard 用「＋新对话」空状态并收起真实线程侧栏（新对话不落服务端记录，已验证侧栏列表不变）；顶栏定位文本仅在浏览器端替换为演示值「上海市浦东新区」（服务器数据未动，README 图注已如实说明）；API 设置模态 API Key/口令输入框为空（仅占位符）；账户设置模态仅内置演示账号 admin、口令框全空。三图均无 key/口令/二维码/真实对话/真实定位。
- 生产只读纪律：未点微信二维码、未发消息、未保存设置、未创建/修改用户；每次会话结束点「⏻ 退出登录」，脚本内置禁词+空密文断言双保险。

### 任务 2：README 焕新（2026-08-13）
- 新增「产品介绍」：电梯陈述 + 7 项功能总览（网页对话/语音通话/微信桥/多用户与租户隔离/每用户 API 设置/桌面端/免费搜索链），非空白字符 335 ≤ 400。
- 语音：上线状态句、入口对比表新增「语音通话」行、快速开始§2 增「语音通话怎么用」（📞→授权麦克风→说话；拒授权自动降级打字通话，措辞对照 web-src/src/VoiceCall.jsx 实现）；微信语音一律写「开发中」。
- 图注与 alt 按规格对齐；两图特性表保持在 web-dashboard.png 之后。
- 快速开始亲手跑过（输出已贴对话）：venv 创建 ✓；依赖装入（按任务书用 requirements.lock + `-e . --no-deps` 等价替代 `-e ".[dev]"`，记录在案）✓；`cp .env.example .env` ✓；`jarvis-web`（临时端口 7893、一次性 dummy 配置）首页 200、未登录 API 401，验后停服 ✓；`jarvis --help` ✓；`jarvis --once "现在几点了"` 用 dummy key 走到模型调用点返回 401（规格禁真实付费调用，链路已证通）✓；`cd desktop && npm install`（70 packages）✓；`npm start` 初次报 Electron 缺二进制，正是 README FAQ 场景，`npm rebuild electron` + install.js 在本沙盒仍不落盘，从主仓同版本 38.8.6 复制 dist 后 Electron 正常启动，随即关闭 ✓。临时 .env 验后删除。
- 验收：README 引用的 6 张图逐一 ls 存在；产品介绍 7 项全覆盖；`陈文杰、钟俊琅`/`禁止任何形式的商业使用`/`API Key 永不回显` 均保留；`git diff --check` 无输出；内容提交范围仅 README.md 与 docs/assets/readme/**（PROGRESS/BLOCKED 另行单独提交）。

# 桌面语音通话（desktop-voice 分支，2026-08-13 开工）

## 任务 0 ✅（2026-08-13 实测）
- 基线复核：`cd desktop && node --test` → **36 pass, 0 fail, 0 skipped**，与任务书一致。Electron 缺二进制按 README FAQ 从主仓库同版本 38.8.6 复制 dist 后 `npx electron --version` → v38.8.6。
- 生产最小验证（desktop/tools/voice-check.js，26 行）：admin/admin → /api/desktop/login 换令牌 → wss 连 /api/voice/call（X-JWS-Token 头）→ init → user_text「用一句话报一下现在的时间」→ ready/turn_start/audio_start(pcm,24000,1)/tool now/11 个 token/turn_end 全链路，**音频字节 226256 > 0**，输出已贴对话。

### 协议要点与选定方案（≤10 行）
1. 鉴权：desktop 走 WS 握手头 `X-JWS-Token`（gateway.py:406-413），init 首帧仍必发 `{"type":"init","thread_id":"desktop-voice"}`，csrf 字段 desktop 不校验；未登录下行 error{code:unauthorized} 后 4401 关闭。
2. 上行：二进制=PCM16LE/16kHz/单声道帧（网页 100ms/1600 样本一帧）；JSON=user_text/interrupt/ping。下行：ready/asr_partial/asr_final/asr_fallback/turn_start/token/tool_start/tool_result/audio_start{format,sample_rate,channels}/tts_error/turn_end{interrupted}/error/pong + 二进制 TTS PCM（采样率见 audio_start，实测 24000）。
3. 令牌传递（实测定案）：渲染进程原生 `new WebSocket(wss://…/api/voice/call)`，主进程 `session.webRequest.onBeforeSendHeaders` 只对该精确 URL 注入 X-JWS-Token（Electron 38 实测可注入 WS 握手头，探针输出已验证）——令牌全程不进渲染进程，与现有 preload 零令牌纪律一致。
4. 桌面核心 voice-call.js 为 UMD 纯逻辑状态机（可注入 fake WebSocket/播放器/麦克风/识别器，node --test 直跑）；voice-audio.js 改写自 web-src/src/VoiceAudio.js + VoiceCall.jsx 播放段（文件头注明来源）。
5. 输入链路对齐网页三层降级：推流+服务端百炼（首选）→ asr_fallback/推流组件缺→Electron 内建 SpeechRecognition → 识别/麦克风没有→打字通话（语音答复）；本地 RMS VAD（0.04×2 帧）开口打断=停播+interrupt；断线自动重连 1 次，再断提示放弃。
6. 线程 desktop-voice（desktop 前缀，不污染网页记录）；麦克风权限：主进程 setPermissionRequestHandler 放行本窗口 media + macOS askForMediaAccess。

## 任务 1 ✅ 语音会话核心（2026-08-13，提交 6b9f09e）
- 新增 desktop/voice-call.js：UMD 纯逻辑状态机（行为对齐 web-src/src/VoiceCall.jsx，文件头注明来源）——init 首帧/字幕增量与定稿/本地 RMS VAD（0.04×2 帧）开口打断（interrupt 上行+停播+丢弃未定稿灰字）/asr_fallback→内建 SpeechRecognition→打字通话三层降级/tts_error 降级纯文字/断线自动重连一次再断放弃提示/unauthorized 触发过期回调不重连。依赖全注入，node --test 直跑。
- 新增 desktop/voice-audio.js：AudioWorklet 采集→16kHz 重采样→PCM16 每 100ms 一帧+帧级 RMS（改写自 web-src/src/VoiceAudio.js）；createPcmPlayer TTS PCM 排队播放（改写自 VoiceCall.jsx playChunk/stopPlayback），createContext 可注入。
- session.js 新增主进程专用 authToken()/voiceCallUrl()（webRequest 握手头注入用，令牌不进渲染进程），配 2 条单测。
- 验收：`node --test` → **52 pass, 0 fail, 0 skipped**（基线 36 + 新增 16 ≥8：鉴权失败不重连、字幕增量/定稿、打断丢弃未定稿、VAD 防误触、TTS 失败降级文字、降级链两级、麦克风被拒人话提示、asr_fallback 停帧切识别、断线重连一次后放弃、打字上行、audio_start 采样率+放空回听、挂断清场）。
- 反向验证（红→绿）：临时注释 bargeIn 里 `setInterim('')` 丢弃逻辑 → `打断丢弃未定稿字幕必须丢弃：'还没定稿的半句话' !== ''` 1 fail（红）；还原 → 52 pass（绿）。输出已贴对话。

## 任务 2 ✅ 面板 UI + 主进程接线 + 真机生产验收（2026-08-13）
- index.html：📞 按钮入 #phead；#voice 通话面板（听=青色脉冲/想=金色跳点/说=红色+均衡器条 + 字幕区灰字→金色定稿 + 工具 chips + 回答滚动 + 人话提示条 + 降级打字条 + ✋打断/📵挂断/—收起）；悬浮球新增 #calldot——通话中收起态红点呼吸指示。
- main.js：setupVoiceSession——setPermissionRequestHandler 只放行本窗口纯音频 media；webRequest.onBeforeSendHeaders 仅对 gateway().voiceCallUrl() 精确 URL 注入 X-JWS-Token；voice-mic-access IPC（macOS askForMediaAccess 首次弹系统授权，实测本机已 granted）。
- **修复既有阻断 bug**：Electron 38 默认沙箱化 preload 里 require('crypto')/相对模块直接失败（「Unable to load preload script…module not found: crypto」），**主仓库未改分支同样复现**（输出已贴对话）——app 实际起不来（登录/对话全挂）。按最小修改加 `sandbox:false`（contextIsolation/nodeIntegration 姿势不变）。
- 真机生产验收（npx electron . 真启动 + CDP 驱动真 UI，服务器 https://jws.gkgeek-set.cn）：
  - 测试环境说明（如实）：扬声器放 `say` 让麦克风拾音被 macOS/Chromium 回声消除压制（实测帧最大 RMS 0.022 < VAD 阈值 0.04，识别听不见）——这是「机器自放自收」特有现象，真人说话不受影响。故自动化改用 Chromium 假麦克风设备灌**真人声 WAV**（MiniMax 合成两句话+精确静音时间轴，`--use-fake-device-for-media-stream --use-file-for-fake-audio-capture --disable-features=AudioServiceOutOfProcess,AudioServiceSandbox`）；除麦克风硬件被替代外，getUserMedia→AudioWorklet→wss→百炼 ASR→agent→MiniMax TTS→AudioContext 播放全为生产真链路，未 mock 任何连接。
  - 通话时间轴（完整输出已贴对话）：0.4s ready→listening；说「你好贾维斯，给我讲一个简短的小故事」→ 2.5s 起灰字逐词（你好→你好贾维斯→…给我讲一个简短的小）→ 6.0s 定稿→thinking → 9.7s speaking（真 TTS 播放）→ **12.6s 音轨开口「等一下，先别说了」→ 13.5s 打断生效**（interrupt 上行、停播、回到 listening）→ 新回合定稿「等一下先别说了。」→ 贾维斯口语化回答「好的，我不说了。您随时吩咐。」并语音播出。
  - 链路统计：上行 552 帧音频（最大振幅 0.976）+ init + **interrupt×2**；下行 ready×1 / asr_partial×21 / asr_final×4 / turn_start×4 / audio_start×4 / token×147 / turn_end×4 + **TTS 音频 2,197,354 字节**。
  - 拒麦降级（模拟系统拒麦：getUserMedia 抛 NotAllowedError，其余全真）：人话提示「没拿到麦克风权限。语音识别已停用，可以在下面打字通话…」+ 打字条出现；打字「现在几点了，一句话告诉我」→ 3.3s 语音答复播放（音频 117,586 字节）+ 字幕「现在是下午三点三十八分。」；挂断后普通文字聊天实测回复「一切正常」——文字对话零影响。
  - 收起态指示：通话中点「—」收起为悬浮球 → #calldot computed display=block，截图红点可见；再展开回到通话面板，挂断后红点消失。
  - 截图（scratchpad/drive/shots/）：1-listening / 2-interim（灰字）/ 3-speaking（定稿+回答+打断按钮）/ 4-after-barge / 6-mic-denied / 7-typed-voice-reply / 9-ball-oncall（球+红点）。
- 「建议」层临场决定记录：任务书「拒绝麦克风时给人话提示」由核心状态机+真机模拟拒麦双重验证；真人拒授权路径逻辑相同（getUserMedia 同名错误），留领导亲验清单第 2 条。

## 任务 3 ✅ 领导亲验清单（写给领导，桌面端）
1. `cd desktop && npm start` → 点悬浮球展开 → 📞 → macOS 首次弹「访问麦克风」→ 允许 → 状态变「请讲，我在听」→ 直接说话（如「明天有什么安排」）→ 灰字实时爬 → 定稿金字 → 贾维斯口语化语音回答（红色说话态+均衡条）。
2. 回答播放中直接开口说新问题 → 半秒内停播进入你的新问题（开口打断）；也可点「✋ 打断」。
3. 拒绝授权路径：系统设置→隐私与安全性→麦克风→关掉 Electron（或首次弹窗点「不允许」）→ 再 📞 → 应见金色人话提示 + 底部打字条：打字照样语音答复；关掉面板后普通打字聊天完全不受影响。
4. 通话中点「—」收起 → 悬浮球右上角红点呼吸=通话仍在；点球展开回到通话面板。
5. 断网（关 Wi-Fi）→ 面板提示「正在自动重连…」，仍断则「通话连接已断开…请挂断后重新拨打」；恢复网络后重新 📞 即可。
6. 桌面通话记录在独立线程 desktop-voice，不会混进网页对话列表。

## 完成条件对账（desktop-voice）
- 硬指标 1 ✅：真连生产最小验证音频 226,256 字节 >0（任务 0，输出已贴）+ `node --test` 52 pass ≥44、0 fail 0 skip（输出已贴）。
- 硬指标 2 ✅：`git diff main --stat` 仅 desktop/**（11 个文件）+ PROGRESS.md；`grep -rn "sk-1deb\|sk-api" desktop/` 空（exit 1）。
- 反向验证 ✅：打断丢弃未定稿——注释丢弃逻辑 1 fail 红 → 还原 52 pass 绿（输出已贴对话）。
- 服务端零改动 ✅：jarvis/**、web-src/**、tests/**、scripts/** 一行未动（git diff 佐证）；桌面令牌鉴权按 gateway.py 现状直接可用，无需服务端改动。

# 网页↔桌面一体化接管（web-desktop-handoff 分支，2026-08-13）

## 任务 0 ✅ 基线核对 + 接管流程图
- 三基线亲测全对上：pytest `447 passed`（0 fail 0 skip）；web-src vitest `31 passed (8 files)`；desktop `node --test` `52 pass 0 fail 0 skip`。
- 现状核对：server.py:304 `/api/desktop/login` → `accounts.issue_desktop_and_openai`（换票端点照抄此链）；CSRF 模式=`_write_authorized`+`_csrf_deny`；desktop/session.js 令牌 safeStorage 加密落盘、main.js webRequest 主进程注入。全部与任务书一致。
- 接管流程（谁发票 / 谁换票 / 票怎么失效）：
  1. 网页（已登录 web 会话 + X-JWS-CSRF）→ POST /api/desktop/handoff → 服务端 `secrets.token_urlsafe(32)` 生成票，内存表记 `(sha256(票), user_id, now+60s)`，明文票只回给网页。
  2. 网页 → POST http://127.0.0.1:17789/wake {ticket}（Chrome PNA 预检 + Origin 白名单：生产域名与 http://localhost:*）→ 桌面主进程亮出悬浮窗/面板置顶。
  3. 桌面主进程（未登录时）→ POST 服务端 /api/desktop/handoff/exchange {ticket}（无会话、不收密码）→ 服务端查 hash 命中且未过期 → **换票即删（一次性）** → `issue_desktop_and_openai(user_id)` → 返回与 /api/desktop/login 同构令牌。
  4. 桌面主进程 safeStorage 加密落盘（复用 session.js 既有 persist），令牌不进渲染进程；面板转已登录。
  5. 失效三路：换到即删（二次换票 401）；60 秒过期（时间可注入测试）；服务重启内存清空全失效。过期/重复/未知票响应一律 401 不区分原因；票据/令牌不写日志。

## 任务 1 ✅ 服务端票据端点（提交 09ca72d）
- jarvis/server.py 仅顶部加 `hashlib`/`secrets` 两个 import + 文件末尾「# ---- 桌面接管 ----」区块（git diff 72 行纯新增，0 删改）；已有函数一行未动。
- POST /api/desktop/handoff（web 会话+CSRF，`_write_authorized` 照抄相邻端点，且只认 transport=web——桌面令牌不能领票防令牌自繁殖）→ {ticket, expires_in:60}；POST /api/desktop/handoff/exchange（无会话，只收 ticket，请求体带密码直接 422）→ 与 /api/desktop/login 同构响应。内存表 `{sha256(ticket): (user_id, expires_at)}`，带锁、惰性清过期。
- tests/test_desktop_handoff.py 8 条（超任务书 ≥6）：领票需登录 / CSRF 缺失 403 / 桌面令牌领票被拒 / 换票得可用令牌（X-JWS-Token 实调 /api/dashboard 200 + /api/session 显示 admin）/ 二次换票 401 / 过期 401（_handoff_now 可注入）/ 未知与重复响应同构+密码路径 422 / 票据令牌不落日志（caplog DEBUG 全量断言）。
- pytest 全量：**455 passed, 0 failed, 0 skipped**（基线 447+8，≥453 达标）。
- 反向验证 ✅：注释 `_handoff_tickets.pop(digest, None)  # 换票即删` 一行 → `2 failed（test_exchange_is_single_use 等）, 6 passed`；还原 → `8 passed`。输出已贴对话。

## 任务 2 ✅ 桌面本机唤起监听 + jws:// 协议（提交 4c8fb24）
- 新建 desktop/wake-server.js（纯 Node 无 Electron 依赖，node --test 直测）：只绑 127.0.0.1:17789；GET /ping→{app:"jws-desktop",loggedIn}；POST /wake {ticket?}→onWake 亮窗+未登录带票走 exchange；OPTIONS 预检回 `Access-Control-Allow-Private-Network: true`+严格 CORS；Origin 白名单=生产域名（设置里 server 的 origin）+`http://localhost:*`，不合法一律 403 无 CORS 头；无 Origin 也 403（安全>成功率）。EADDRINUSE→start 返回 {ok:false,reason:'port-in-use'}+onUnavailable 面板提示，不崩。
- desktop/session.js 新增 `exchange(ticket)`：与 login 同一条 safeStorage 加密落盘链、只发 {ticket} 不发密码；main.js 接线（gateway().exchange 只在主进程，令牌不进渲染进程）；jws:// 协议 setAsDefaultProtocolClient + open-url/second-instance best-effort，`parseHandoffUrl` 严格解析（host 必须 handoff、票据字符集/长度校验）。preload/renderer 只新增两个无令牌事件：handoff-authenticated（触发既有 loginController.init 重探活）与 wake-server-notice（端口占用人话提示）。
- desktop `node --test`：**63 pass, 0 fail, 0 skip**（基线 52+11 条新增，≥60 达标）：ping 结构与 CORS 头 / localhost:* 放行 / 6 种坏 Origin 403 / PNA 预检 / 真 session.js 网关换票入会话（落盘密文无明文+后续请求带 X-JWS-Token）/ 坏票与抛错不崩 / 无票只唤起不换票 / 端口占用降级 / 超限与坏 JSON 防御 / jws:// 解析。
- 反向验证 ✅：注释 `isAllowedWakeOrigin` 校验块 → `1 fail（origins…403）10 pass`；还原 → 63 pass。输出已贴对话。

## 任务 3 ✅ 网页入口 + 本地 e2e（提交 5af939c）
- web-src/src/desktopWake.js（纯逻辑：pingDesktop 800ms AbortSignal 超时、summonDesktop 四态 awakened/not-running/ticket-failed/wake-failed，not-running 时把票塞进 jws://handoff?ticket=）；DesktopHandoff.jsx（HUD 顶栏「⬒ 悬浮窗」入口：成功→「已在桌面亮出悬浮窗」，没在跑→隐藏 iframe 尝试 jws:// 后弹指引卡（启动命令/设置里勾开机自启/README 链接），领票失败与唤起失败各有单独人话提示）；api.js 加 desktopHandoffTicket()（带 CSRF）。Chat.jsx / Voice* 零改动。
- vitest：**37 passed (9 files)**（基线 31+6 条新增，≥34 达标）：三态 + wake-failed + 超时探活 + 冒充应用拒认。
- 本地 e2e（Playwright，全真链路：真 jarvis 服务 127.0.0.1:7789 + 真 wake-server.js/session.js 监听 17789 + vite dev localhost:5599 代理）：登录 admin → 点「悬浮窗」→ 页面反馈「已在桌面亮出悬浮窗」；网页侧流量 ping 200→POST /api/desktop/handoff 200→POST /wake 200；桌面侧日志：收票(长度43 明文不打印)→换令牌 {"ok":true}→X-JWS-Token 调 /api/dashboard HTTP 200 OK→/api/session authed=true username=admin→**同票二次换票 {"ok":false,"status":401}**。第二次点击（已登录态）：只唤起不换票，同样反馈成功。完整输出贴对话。
- 截图：scratchpad/e2e/shots/{1-login,2-hud,3-after-click}.png（3-after-click 顶栏可见「悬浮窗」按钮+「已在桌面亮出悬浮窗」反馈条）。
- 「建议」层临场决定：e2e 前端用 vite dev（scratchpad 内独立零 import 配置 + esbuild automatic JSX）而非 npm run build——因构建产物写死 ../jarvis/web 会污染白名单外文件；e2e 语义不变。requestSingleInstanceLock 采取「尽力拿锁但拿不到不退出」，不改变现有多实例行为（第二实例 17789 占用自动走降级提示）。

## 完成条件对账（web-desktop-handoff）
- 硬指标 1 ✅：e2e 全链路日志+截图（上）；pytest 455 ≥453、desktop 63 ≥60、vitest 37 ≥34，全部 0 fail 0 skip。
- 硬指标 2 ✅：`git diff main...HEAD` 中 jarvis/ 下仅 server.py（72 行纯追加：顶部 2 import+末尾区块）；accounts.py/tenancy.py/voice/wechat/Chat.jsx/Voice* 零改动；新增代码 grep "sk-1deb\|sk-api" 为 0。
- 两处反向验证红→绿 ✅（任务 1「换票即删」、任务 2「Origin 校验」，输出均贴对话）。
- 不新增运行时依赖 ✅（服务端 hashlib/secrets 标准库；桌面 node:http；网页零新依赖）。

# 体验升级三批次（对标豆包/腾讯元宝，2026-08-14）

依据当日产出的《贾维斯体验升级蓝图》按序交付三批共 14 项；基线 pytest 455 / vitest 37 / desktop 63，交付后 **pytest 491 / vitest 65 / desktop 67，全绿 0 失败**，前端产物已重建（jarvis/web）。

## 第一批 · 立竿见影
1. **Markdown 渲染引擎**：网页（web-src/src/markdown.js，marked+DOMPurify+highlight.js）与桌面（desktop/md-render.js 注入版同逻辑）替换 15 行手写正则——可点来源链接（新窗口+noopener，修复与系统提示词「≥2 可点击来源」的自相矛盾）、GFM 表格、代码高亮+语言标签+独立复制按钮、引用块/任务列表、流式未闭合代码块兼容、XSS 消毒；桌面外链经新 IPC open-external-link 交系统浏览器（http/https 校验）。回答正文组件 memo 化，流式只重渲染当前条。
2. **消息级操作**：AI 消息「复制/重新回答」、用户消息「复制/编辑」（填回输入框）、失败气泡「重试」。
3. **会话管理**：新端点 PATCH /api/thread 重命名（改名不打乱最近排序）；前端改名（✎ 行内编辑）、标题搜索、删除二次确认（3 秒回退）；桌面「清空」同样二次确认。
4. **悬浮球一键语音通话**：右键悬浮球直接展开并接通（mousedown 只认左键，右键不再误触发拖动/展开）。
5. **.env.example**：补 MINIMAX_API_KEY / DASHSCOPE_API_KEY / MINIMAX_TTS_VOICE 等语音变量说明。

## 第二批 · 管家灵魂
6. **日程主动提醒**（jarvis/reminders.py）：服务端 30s 扫描线程 + tenant_reminders_sent 记账表（每 owner/日程/when/通道只提醒一次，宽限 30 分钟不翻旧账）。三通道：微信主动推送（联系人发「提醒发给我」绑定，`wechat_push_target.json` 0600 落盘，context_token 随消息滚动；「取消提醒推送」解绑）、桌面系统 Notification（主进程每分钟领取 /api/reminders/pending）、网页金色弹条（30s 轮询）。JARVIS_REMINDERS_ENABLED=0 可关。
7. **任务台可交互**：REST 写接口 POST/PATCH/DELETE /api/todos、POST/DELETE /api/memos、POST/DELETE /api/schedule（auth+CSRF+租户隔离，Member 勾不到 Owner 的条目）；网页真复选框（可反悔取消勾选）+ 快速新增 + 悬停删除；桌面任务台待办同步真复选框（session.js 新 op todoPatch）。
8. **记忆管理面板**：新 tenant_profile 表 + profile_remember/list/forget 三工具（工具数 21→24，两处计数测试同步更新）；画像经 compose_system_prompt 注入每轮系统提示词（graph.py prompt 改可调用，无租户上下文安全回退）；网页顶栏「◉ 记忆」面板可查/可删/可手动补，空态引导「记住我…」。
9. **音色选择+语速**：TTSSession 支持 voice_id/speed（0.5–2.0 收敛）；新 tenant_prefs KV 表；网关按用户偏好实例化（无偏好保持零参调用，测试假工厂零改动）；GET/PUT /api/voice/settings + 8 音色目录；网页「⚙ API → 语音」页签（音色下拉+语速滑杆），网页/桌面通话共用。

## 第三批 · 可玩出圈
10. **微信总线**：光发链接=自动包装 web_extract 总结指令（带明确问题则原文直通）；群聊被 @贾维斯 才应答（JARVIS_WECHAT_GROUP_NAME 可改名，未被 @ 一律沉默）。
11. **人设工坊**：persona 偏好（称呼/人格/语气口头禅）注入系统提示词；MOSS 人格转正（登录页彩蛋→正式可切换）；GET/PUT /api/persona；「记忆与人设」面板合并管理。
12. **晨报电台**：MorningRadio 调度线程——每天设定时间用 Owner 自己的 Agent 生成晨报（独立 radio 线程），微信语音条+文字推送（复用发侧语音链路，失败降级纯文字）；成本护栏：通道不通不生成、生成后失败当日不重烧、过窗 2 小时作罢；GET/PUT /api/radio，UI 在「语音」页签（留空关闭）。
13. **文档上传**：POST /api/upload（JSON+base64，省 multipart 依赖；10MB/8000 字上限）；PDF 用 pypdf（新运行时依赖，零传递依赖）、docx 用标准库 zipfile 解析、txt/md 支持 gb18030 回退；网页输入框 📎 上传→解析→自动发出「通读并总结」消息，正文入线程记忆可追问；超长用户气泡限高滚动。

## 依赖与部署提醒（管理者）
- 新运行时依赖 2 个：**pypdf==6.16.0**（文档解析）、**pilk==0.2.4**（微信语音编解码，补上此前 BLOCKED 遗留的入依赖动作）；均已进 pyproject.toml 与 requirements.lock，生产 venv 需 `pip install -r requirements.lock`。
- 前端新增 npm 依赖：web-src（marked/dompurify/highlight.js），desktop（marked/dompurify/@highlightjs/cdn-assets，本地文件引用零 CDN）；**桌面端部署需在 desktop/ 重新 npm install**。
- jarvis/web 产物已随本轮重建提交（bundle 1.46MB，hljs 约 +240KB；code splitting 仍是后续项）。
- 微信「主动推送/晨报」的 sendmessage 无回复上下文（context_token 复用最近一条），**真机联调前按最坏情况预期需微调**——失败只 log.warning 降级，不影响原有收发。
- README 已同步：工具数 24、产品介绍补主动提醒/记忆人设/上传/微信总线；.env.example 补语音 key 与 JARVIS_WECHAT_GROUP_NAME / JARVIS_REMINDERS_ENABLED。

# 体验优化第二轮 + README 焕新（2026-08-14 晚）

## 生产热修（当日发现当日修）
- **存量库缺表事故**：第一轮的 tenant_prefs/tenant_profile/tenant_reminders_sent 建表挂在 schema v1 列表里，被版本门挡住只对全新库生效——生产升级后语音设置/记忆/人设 500、提醒扫描每 30s 报 OperationalError。已改为独立 **v2 迁移**（幂等），加存量库升级回归测试，热修已部署验证（提醒扫描周期零错误、桌面端真连生产拉到 8 音色）。教训入档：**加表必须开新 schema 版本，测试必须覆盖存量库升级路径**。

## 优化项（全部上线）
1. **工具调用透明化**：SSE tool_start/tool_result 带调用 id/成败/耗时/结果摘要（tests/test_chat_stream_events.py 锁契约）；网页 chips 中文名+图标+耗时，点开看结果，失败红色 ✗；按 id 精确配对修掉同名工具错配；桌面工具行与语音面板同步中文名。
2. **桌面「语音与晨报」设置块**：音色/语速/晨报时间直接在悬浮窗设置页改（session.js 新增 4 个白名单 op + 校验，node --test 17 条含新用例）；响应 ok 检查防 401 体渲染成 NaN。
3. **系统托盘**：程序化生成模板图标（macOS 自适配深浅），菜单=打开对话/语音通话/设置/退出；Windows 开机自启走 app.setLoginItemSettings（macOS 维持 LaunchAgent）。
4. **会话导出**：线程列表 ⤓ 一键导出该会话为 Markdown 文件。
5. **bundle 拆分**：three 系懒加载（React.lazy）+ manualChunks——主包 **1456KB → 246KB**，three 968KB 按需取、markdown 237KB 独立缓存；删除死代码 Reactor3D.jsx。
6. **亮色主题**：body.light 全套覆写（任务台/表格/代码高亮/弹条/各模态），顶栏 ☀/☾ 一键切换存 localStorage；登录页保持暗色电影感。
7. **JWS_SHOT 自检增强**：JWS_SHOT_WAIT/JWS_SHOT_SCROLL/JWS_SHOT_PROBE（探针曾直接定位生产 500）。

## README 焕新（内容 + 截图 8 张新拍）
- 隔离演示环境（临时数据目录+虚构演示数据+真 DeepSeek 一轮对话）Playwright 实拍 1600×1000：web-dashboard（Markdown 表格+可勾选任务台）、web-reminder（提醒弹条）、web-light-theme、web-memory（记忆与人设）、web-voice-settings、web-provider-settings（三页签）；桌面 JWS_SHOT 实拍 desktop-settings（含语音与晨报区块）。新增 4 张、更新 3 张，图注如实标注演示数据；无 key/口令/二维码/真实对话。
- 文案：状态行更新至 2026-08-14；产品介绍补工具透明/双主题/托盘/导出/右键直呼；「语音通话怎么用」补音色设置入口。
- 截图脚本坑位记录：本机 all_proxy 会弄崩 httpx（trust_env=False）；会话 cookie 带 Secure 标记，httpx 在 http 下不回传（浏览器/curl 的 localhost 例外会传），种数据需手动带 Cookie 头。

## 未做与原因（下轮候选）
- dmg/exe 打包安装器：需签名/公证链路，建议单独立项；划词取词：需辅助功能权限模拟 ⌘C，半成品风险高；生图/图片理解：等 Provider 侧配置多模态模型。

# 第三轮升级（feat/round3-upgrade 分支，2026-08-19 开工）

## 开工回执（任务 0 ✅ 2026-08-19）
- 目标：贾维斯从问答机→主动管家。六个任务：①vitest flaky 清零+版本自证 ②Heartbeat 主动唤醒 ③夜间记忆蒸馏 ④技能热加载 ⑤语音体验包（球三态+托盘重构）⑥划词悬浮条。
- 基线复核：pytest 493 passed 0 skipped（38s）✓；desktop node --test 68 pass 0 skipped ✓；vitest 70 passed（本轮未触发 flaky，书载约 1/3 概率挂 Chat.actions.test.jsx）✓。
- 顺序：按书 1→6，每任务全量三套回归+任务粒度提交；不合并 main、不推远端、不碰生产。
- 最大风险：任务 1 flaky 根因若在组件卸载时序而非测试本身，修「实现」可能越界——若确认属实现 bug 按书写 BLOCKED.md 裁决；任务 6 辅助功能权限路径无法自动化，降级路径全测、真机效果留领导亲验。

## 任务 1 ✅（2026-08-19）flaky 清零 + 版本自证
- flaky 根因在实现非测试：Chat.jsx「编辑」按钮 requestAnimationFrame(autoGrow) 在组件卸载后触发，boxRef.current=null 抛 TypeError 成为 unhandled error 污染测试进程（书里预判过此情形，属「建议」层临场决定：修实现加空守卫，比改测试掩盖诚实）。新增回归测试锁时序，红→绿已证。
- 版本自证：新 desktop/app-info.js（buildAppInfo git 短 hash+启动时刻、restartApp relaunch→exit 顺序锁定）；设置页底部显示版本行、托盘菜单加「重启贾维斯（当前 hash）」。反向验证：注释 relaunch→测试红→还原绿。
- 顺手修一处工具缺陷（建议层）：JWS_SHOT_SCROLL 滚动后未等重绘就 capturePage，截图永远是滚动前的帧——加 rAF+150ms 等待，截图已能拍到页面底部（output/task1-settings.png 见版本行）。
- 验收：vitest 连跑 5 次全绿；全量 pytest 493 / desktop 71（68+3）/ vitest 71（70+1），0 skipped。

## 任务 2 ✅（2026-08-19）Heartbeat 主动唤醒
- 新 jarvis/heartbeat.py：HeartbeatScanner（30 分钟一轮可调，JARVIS_HEARTBEAT_ENABLED=0 时 maybe_create 返回 None 线程根本不建）+ PendingOutbox（桌面/网页领取箱，领取即清）。server.py：lifespan 起停、_heartbeat_compose 用 Owner 自己的 Agent 独立 heartbeat 线程裁量、/api/reminders/pending 合并投递（桌面通知/网页弹条零客户端改动）。
- run() 增加 JARVIS_LOG_LEVEL 环境变量日志初始化（默认 WARNING 不变），后台线程推送才有可见证据。
- pytest 新增 8 条（到点双通道推送/PASS 与空判沉默/文件缺失或空不烧模型/开关与 interval 解析/微信挂了桌面照送/compose 异常不外抛/领取箱按用户清空/端点送达）。
- 实跑正向：隔离数据目录 + HEARTBEAT.md「立刻提醒我喝水」+ 5s 轮询，真实 DeepSeek 裁量，日志 6 条「heartbeat pushed: 该喝水了主人…」；反向：JARVIS_HEARTBEAT_ENABLED=0 复跑 30s，heartbeat 日志 0 行。
- 全量：pytest 501（493+8）/ desktop 71 / vitest 71，0 skipped。

## 任务 3 ✅（2026-08-19）夜间记忆蒸馏
- 新 jarvis/distill.py：NightlyDistiller 照 MorningRadio 模式——默认 03:00（JARVIS_DISTILL_TIME 可调，主要给实测）、2 小时补跑窗、distill_last_run 记账（同日只跑一次）、失败当日不重试、当日无对话不烧模型；parse_facts 护栏（PASS 即空、≤5 条、去符号头）。「当日对话」按语义落为「最近 24 小时更新过的日常线程」（03:00 蒸昨天的对话；radio/heartbeat/distill 服务线程除外），记录于此。
- server.py：_distill_collect（get_state 拼摘录、6000 字符封顶）/_distill_compose（Owner 自己的 Agent、独立 distill 线程）/_distill_remember（add_profile 内容级去重，与 profile_remember 工具同一存储）；随 JARVIS_REMINDERS_ENABLED 总开关起停。
- pytest 新增 6 条（到点写入画像/同日幂等零新条目/无对话不调模型/未到点与过窗/compose 失败当日不重试/解析护栏）。
- 实测（第二轮才干净）：第一轮发现聊天 agent 自己会调 profile_remember 污染证据、且蒸馏扫描赶在对话前空跑作罢——重做：3 轮真实对话后清空 tenant_profile 再等触发，4 条画像由蒸馏线程独立写回（日志 distill wrote 4 profile fact(s)、distill 线程在 tenant_threads），坐标见对话贴证。

## 任务 4 ✅（2026-08-19）技能热加载
- prompts.py：skills_dir（JARVIS_SKILLS_DIR 可覆盖）/load_skills（每轮现读现用，天然热更新；坏文件空文件安静跳过）/skill_sections 注入 compose_system_prompt；护栏 MAX_SKILLS=20、单条 2000 字符截断。skills/README.md 说明格式。
- pytest 新增 5 条（空目录静默/注入/热更新不重启/坏文件容错与目录名回退/数量与长度护栏）。
- 实测：隔离服务放「回答末尾带🦞」技能→回复「…有什么需要我效劳的？🦞」；rm SKILL.md 不重启再聊→回复无🦞。两轮输出已贴对话。

## 任务 5 ✅（2026-08-19）语音体验包（桌面端）
- 球通话态外显：新 desktop/voice-ball.js（phase→body 类，任何时刻至多一个态类，UMD 可测）；renderVoicePhase/endVoiceCall 接线；CSS 三态=听青色描边呼吸/想琥珀描边/说绿色脉冲——第一版外辉光被球窗（球+8px）裁掉肉眼难辨，改「描边+内辉光」后三态清晰（截图 output/task5-ball-{listening,thinking,speaking}.png，JWS_SHOT 新支持 JWS_SHOT_BALL_PHASE）。
- TTS 打断清缓冲**已具备**，证据：voice-call.js:78-81 bargeIn()→player.stop()；voice-audio.js:153-157 stop() 停掉全部已排 source、sources.clear()、nextTime=0——排队缓冲全部作废立即静音。本项零改动。
- 托盘重构：新 desktop/tray-setup.js（buildTrayMenuTemplate+wireTray）；main.js 去 setContextMenu，tray.on('click')→summon 切换悬浮窗、tray.on('right-click')→popUpContextMenu（#13820 阻塞主进程属官方已知，可接受）；测试锁死「绝不调用 setContextMenu」防回退。
- node --test 新增 6 条（voice-ball 3 + tray-setup 3），77 全绿；全量 pytest 512 / vitest 71。
- 领导亲验清单项：托盘左键应切换悬浮窗、右键弹菜单；通话中收起面板看球的三态变色。

## 任务 6 ✅（2026-08-19）划词悬浮工具条
- 新 desktop/quick-ask.js（纯逻辑）：buildQuickPrompt 三动作指令拼装（4000 字符截断）、quickAskPayload 取词决策（有辅助功能权限用模拟 ⌘C 抓的选中文字；无权限降级剪贴板+「去授权」提示；有权限没选中退剪贴板不算降级）、hotkeyFailureNotice 注册失败文案。
- main.js：默认快捷键 Alt+Q（settings.quickAskHotkey，security.js 白名单+校验+2 条新测试）；applyHotkeys 双键注册，划词键注册失败经 wake-server-notice 弹面板提示（不静默）+ 设置页状态行；triggerQuickAsk 用 osascript 模拟 ⌘C（System Events 正需要辅助功能权限）、180ms 后读剪贴板；quick-ask-authorize IPC 只在用户点「去授权」时调 isTrustedAccessibilityClient(true)，绝不启动即弹。
- UI：#quickbar 三按钮+预览+降级授权链接+关闭；设置页「划词问快捷键」行；JWS_SHOT_VIEW=quickbar 演示截图 output/task6-quickbar.png。
- node --test 新增 6 条（quick-ask 5 + security quickAskHotkey 1），83 全绿。
- 领导亲验清单项：任意 App 选中文字按 Alt+Q（首次需在弹条点「去授权」并在系统设置勾选辅助功能）。

## 完成条件对账（2026-08-19）
- 硬指标 1 ✅：一次连续运行 pytest **512** passed 0 skipped（基线 493，要求 ≥507）；desktop node --test **83** pass 0 skipped（基线 68，要求 ≥78）；vitest **71**（基线 70）且连跑 5 次 0 失败。
- 硬指标 2 ✅：git diff main...HEAD 仅落在 PROGRESS.md / desktop/ / jarvis/ / skills/ / tests/ / web-src/；deploy/、wechat/、.env* 改动数 0。
- 反向验证均已红→绿：任务1 注释 relaunch→测试红；任务2 ENABLED=0→日志 0 行；任务3 清表后蒸馏独立写回；任务4 删技能→🦞消失。

## 领导亲验清单（GUI 半托项）
1. 托盘图标：左键=切换悬浮窗展开/收起，右键=弹菜单（打开对话/语音通话/设置/重启贾维斯(带版本)/退出）。
2. 设置页底部可见「版本 <hash> · 本次启动 <时间>」；改代码后点托盘「重启贾维斯」应加载新版。
3. 语音通话中点「—」收起面板：悬浮球应随 听（青色描边呼吸）/想（琥珀）/说（绿色脉冲）变色。
4. 任意 App 选中一段文字按 Alt+Q：悬浮窗弹出划词条（翻译/解释/改写）；未授权辅助功能时用剪贴板内容并显示金色「去授权」链接。
5. data/HEARTBEAT.md 写一行关注事项（如「下午三点提醒我开会」），30 分钟内贾维斯应主动通知（微信绑定过「提醒发给我」则微信也收到）。

# 第四轮升级（2026-08-24）：语音唤醒 + 网页控悬浮窗 + 会议纪要

基线：pytest 512 / desktop node --test 83 / vitest 71。交付后 **pytest 542 / desktop 100 / vitest 82（连跑 5 次全绿）**，前端产物已重建（jarvis/web）。

## 任务 1 ✅ 语音唤醒「贾维斯」
- 桌面新模块 desktop/wake-word.js（UMD 纯逻辑）：本地 VAD 圈人声段（前置缓冲 3 帧防吃「贾」字、静音 600ms 收段、最长 3s 截断、短于 300ms 当噪声、送检后 4s 冷却）→ encodeWav → 服务端一次性识别；静音零请求零费用。
- 服务端 POST /api/voice/wake：复用微信语音线的 DashScopeASR（qwen3-asr-flash 文件级识别），wake_matched 归一化匹配（去标点空格、小写化），唤醒词表 JARVIS_WAKE_WORDS 可配（默认贾维斯+四个同音兜底+jarvis）；无 key 返回 ok:false 人话提示（桌面只提示一次）。
- renderer 接线：唤醒命中 → 亮窗展开 → startVoiceCall（与悬浮球右键同路）；通话/会议期间暂停判定防自吵醒。设置页新增开关（默认关），settings 白名单加 wakeWordEnabled（security.js）。
- 测试：pytest 新增 test_voice_wake.py 5 条（归一化匹配/env 覆盖/命中/无 key 降级/未登录+超长+坏编码守卫）；desktop wake-word.test.js 5 条（一段话只送检一次+WAV 头、短噪声丢弃、冷却窗、超长截断+识别抛错不炸、base64 可逆）。

## 任务 2 ✅ 网页端悬浮窗控制
- wake-server.js 新路由 POST /window {action: show|hide|quit}：沿用 Origin 白名单+PNA 预检；quit 先回响应再延迟 150ms 执行（网页能拿到结果）；非法 action 400 且绝不触发动作。
- main.js：setBallVisible（隐藏前先收成球再 win.hide，summon/托盘/接管唤起自动清隐藏态）；托盘菜单新增「显示/隐藏悬浮球」与「会议纪要（开始/停止）」。
- 服务端 GET/PUT /api/desktop/settings（tenant_prefs: desktop_ball_visible，PUT 走 CSRF）+ GET /api/desktop/commands（10 秒轮询：指令领取箱领取即清 + 顺带回带球显隐偏好；桌面只在偏好变化时应用、首轮只记基线，不跟托盘手动操作打架）。
- 网页「⚙ API → 桌面与会议」新页签：探活状态、显示/隐藏悬浮球（先写服务端偏好、再走本机 17789 快路径秒级生效；跨机 10 秒内下发）、二次确认的「彻底关闭桌面端」。
- 测试：pytest test_desktop_window.py（偏好读写+CSRF、指令领取即清）；desktop wake-server 新增 3 条（show/hide 同步执行+严格校验、quit 先响应后动作、Origin 白名单同 wake）；vitest desktopWake desktopWindow 3 条 + ProviderSettings.desktop 4 条。

## 任务 3 ✅ 会议纪要（实时转写 → 总结 → 发邮箱）
- 双路采集：voice-audio.js 抽出 startStreamCapture 共用管线，新增 startSystemAudioStream（getDisplayMedia：视频轨是门票拿到即停，无音频轨抛 NoSystemAudioError 降级只录麦克风）；main.js 开 macOS 回环三代特性开关（MacLoopbackAudioForScreenShare/MacSckSystemAudioLoopbackOverride/MacCatapSystemAudioLoopbackCapture）+ setDisplayMediaRequestHandler 只服务本窗口、audio:'loopback'；X-JWS-Token 注入扩到 meetingStreamUrl。
- 服务端 WS /api/meeting/stream（jarvis/voice/meeting_gateway.py）：二进制帧首字节声道头（0x00=我/0x01=对方），双路各一条百炼流式识别；与语音通话网关的关键差异——没有回合与 TTS，识别断线不降级浏览器而是自动重建续传（上限 6 次，长会议单条 WSS 会超时），彻底坏才一次性 asr_unavailable；正常 stop 先 finish-task 冲刷尾句。断线（合盖/崩溃）服务端照样完成总结+发邮件，已录内容不丢。
- 领域层 jarvis/meeting.py：MeetingSession（带说话人+时刻的转写，60k 字符护栏）/MeetingRegistry（每用户一场，冲突 4409）/CommandOutbox（桌面指令领取箱，照 PendingOutbox）。
- 总结与落库：_meeting_compose 照 _distill_compose 模板（独立 meeting 线程，已加进 _DISTILL_SERVICE_ALIASES 防夜间蒸馏二次咀嚼）；tenant_meetings 表走 **schema v3 独立版本号**（v2 存量库踩坑的铁律，含「删表删版本记录再连接可重建」的存量库升级回归测试）；无发言不烧模型不发信。
- 邮件 jarvis/mailer.py：标准库 smtplib+EmailMessage 零新依赖，465 SSL / 其他端口 STARTTLS，上游异常只留类名；默认收件人 JARVIS_MEETING_MAIL_TO=1539598158@qq.com，每用户 tenant_prefs meeting_mail_to 可覆盖；SMTP 未配置纪要照存、mail 帧带人话提示。
- 入口三条路：① 对话工具 meeting_start/meeting_stop（工具数 24→26，两处计数测试同步更新，SYSTEM_PROMPT 补规则）→ 指令箱 → 桌面 10 秒内领取；② 桌面 🎙 面板（实时双路字幕、段数计数、收起球上红点、结束后面板内渲染纪要+邮件结果）；③ 托盘菜单。REST：GET /api/meetings（列表+active）/GET /api/meetings/{id}/POST /api/meetings/{id}/email 重发/GET+PUT /api/meeting/settings。
- 网页：任务台新增「会议纪要」卡片（无会议整卡隐藏、监控中状态点、点开看纪要、一键重发邮件）；收件邮箱设置在「桌面与会议」页签。
- 测试：pytest test_meeting.py 19 条（纯逻辑 4 + 邮件 5 + 全链路 WS 10：双声道转写落库发信、并发冲突、空会议零成本、SMTP 未配置仍存档、识别彻底坏一次性通知、重发端点、收件人覆盖）；desktop meeting.test.js 7 条；vitest Panels 会议卡 4 条。

## 部署提醒（管理者）
- 生产 .env 新增（均可选）：JARVIS_SMTP_HOST/PORT/USER/PASSWORD/FROM、JARVIS_MEETING_MAIL_TO、JARVIS_WAKE_WORDS；QQ 邮箱发信用授权码。
- nginx 需为 **/api/meeting/stream** 增加与 /api/voice/call 同款的 WebSocket location 块（Upgrade 头 + 3600s 超时），否则会议推流会被掐。
- 数据库自动迁移 schema v3（tenant_meetings），升级前照例快照 accounts.sqlite3。
- 桌面端零新增 npm 依赖，但需重启加载新代码；会议纪要首次使用需授予「屏幕录制」权限（录对方声音），语音唤醒开关默认关。

## 领导亲验清单（GUI 半托项）
1. 桌面设置勾「语音唤醒」→ 喊「贾维斯」→ 悬浮球亮出并接通语音通话（首次需允许麦克风）。
2. 网页 ⚙ API → 桌面与会议：点「隐藏悬浮球」桌面球即消失，「显示悬浮球」回来；「彻底关闭桌面端」二次确认后应用退出。
3. 开一场飞书会议 → 对贾维斯说「监控会议」（或点 🎙）→ 面板双路字幕滚动（我/对方）→ 说「停止监控会议」→ 1539598158@qq.com 收到纪要邮件（需 .env 配好 SMTP）；网页任务台出现该会议可回看。
4. 若字幕只有「我」没有「对方」：按面板提示到 系统设置 → 隐私与安全性 → 屏幕录制 勾选本应用后重开会议监控。

# 第五轮升级（2026-08-25）：场景模式 + 情绪感知 + 视觉识别 + 说话人分离 + 唤醒修正

基线：pytest 542 / desktop 100 / vitest 82。交付后 **pytest 561 / desktop 102 / vitest 86**，README 新增 4 张实拍截图并重建前端产物。

## 修正与调整
- 语音唤醒「没生效」根因＝上一轮默认关闭：现改为**默认开启**（settings 缺省 wakeWordEnabled=true），设置页加运行状态行，VAD 阈值 0.04→0.025（唤醒场景人离麦更远）。真链路验证：MiniMax 合成「贾维斯」→ qwen3-asr-flash 识别逐字命中 → wake_matched=True。
- 会议纪要默认收件邮箱 1539598158→**1539598168@qq.com**（代码默认值/两处 .env/文档/测试同步）；发信账号维持 163 邮箱。

## 任务 1 ✅ 通话场景模式（对标豆包情景模式，网上调研后定稿 9 场景）
- jarvis/voice/scenes.py：管家/故事时间/晚安电台/解忧树洞/面试陪练/辩论擂台/英语陪练/口语翻译/玄学茶话；全部 TTS 朗读向提示词（口语、无符号）。butler 提示词与原 VOICE_STYLE_PROMPT 逐字一致（回归锁）。
- gateway：init 可带 scene、ready 帧回场景+开场白；{"type":"scene"} 通话中切换（下一回合生效）并存 tenant_prefs voice_scene；GET /api/voice/settings 回带 scenes 目录（不泄提示词正文）。
- 网页/桌面通话面板：场景芯片行，点击切换、高亮回执、开场白直接显示在回答区。

## 任务 2 ✅ 语气情绪感知（调研结论：qwen3-asr-flash 固定附带 7 类情绪，零额外配置）
- jarvis/voice/emotion.py：wav → annotations[0].emotion（surprised/neutral/happy/sad/disgusted/angry/fearful），无 key/失败安静返空。
- gateway：_AsrPipeline 攒本句音频尾部（≤15s），定稿后**异步旁路**送检（<0.4s 的丢弃不烧钱）；下行 {"type":"emotion"}，下一回合风格提示词追加「语气感知…自然照应…不要点破」；neutral 不注入。
- 会议纪要 prompt 新增「## 气氛与情绪」小节（文本推断，零成本）。
- UI：网页/桌面通话面板「😢 低落」徽标。

## 任务 3 ✅ 图片 / 短视频识别（调研结论：qwen3-vl-flash 与音频同端点同构 base64）
- jarvis/vision.py：describe_image（≤10MB，data URI）/describe_video（≤7MB 直传+fps=2，官方 base64 硬限）；截图文字逐字转录、无声提示；上游细节只留类名。
- /api/upload 按扩展名分流 image/video/document（响应加 kind），Chat 📎 accept 扩展，图片/视频各自的注入消息模板；JARVIS_DASHSCOPE_VL_MODEL 可换模型。

## 任务 4 ✅ 会议说话人分离（调研结论：实时全线不支持；离线可行）
- jarvis/voice/diarize.py：三段式——getPolicy 领临时存储凭证 → OSS 表单上传（48h 有效，全程出站 HTTP 不需要公网地址）→ paraformer-v2 + diarization_enabled 异步任务轮询 → sentences[].speaker_id。<10s 音频不烧任务；任何失败 DiarizeError。
- meeting_gateway 把「对方」声道 PCM 落盘 wav（懒打开、封顶 2 小时、data/meeting-audio/）；MeetingSession.relabel_others 按段落墙钟↔音频毫秒偏移对齐命中句子，≥2 人才把「对方」改写为 对方1/对方2；单人/失败保持原样。
- _meeting_finalize：分离（尽力）→ 总结 → 入库 → 发邮件；音频用完即删；纪要 message 附「已自动区分 N 位对方说话人」。

## 回归与截图
- pytest 新增 19（vision 7 / scenes+emotion 7 / diarize 5 含 finalize 集成与降级）；desktop +2（场景回执/情绪透传）；vitest +4（场景芯片交互/情绪徽标/图片/视频消息模板）。
- README：状态行更新至 08-25（四、五轮均已部署演示入口）；新增 4 张实拍图——web-meetings-card / web-desktop-meeting-settings（桌面探活为真实结果）/ web-voice-scenes / desktop-meeting（JWS_SHOT_VIEW=meeting 演示态，新支持 JWS_SHOT_USERDATA 隔离资料目录避免与常驻实例抢 Chromium 配置锁）。
- 新端点/协议：ready/scene/emotion 帧；GET /api/voice/settings 扩展字段。零新增运行时依赖。

## 部署提醒（管理者）
- 无新依赖、无 schema 变更、无 nginx 变更；.env 可选新增 JARVIS_DASHSCOPE_VL_MODEL。
- 说话人分离用百炼「临时存储」通道（官方标注勿用于重生产：48h 过期+限流；本项目内部使用频次没问题，重生产可换自有 OSS）。
- 桌面端本机重启生效：唤醒默认开启（首次亮麦克风权限）；会议「对方1/对方2」需真机开会（≥2 位对方发言）验收。

# 第六轮（2026-08-25）：性能优化 + 高强度审查修复 + 会议实时要点

基线：pytest 561 / desktop 102 / vitest 86。交付后 **pytest 566 / desktop 105 / vitest 86**。

## 性能与成本
- **服务线程成本泄漏（真 bug）**：heartbeat/蒸馏/晨报/会议纪要此前在同一 checkpoint 线程无限追加——heartbeat 每 30 分钟一轮整段重放历史给模型，成本持续爬坡。统一改 _service_invoke：alias 线程照常注册（UI/蒸馏豁免不变），每次调用一次性 checkpoint 上下文、用完即删（新测试锁行为：两次调用 id 不同+删除到位）。
- **迁移检查缓存**：TenantStore 每次开连接都重跑版本门（含一把全进程互斥锁）；改为每进程每库首连一次。诚实记录：单线程微基准差异在噪声内（~176µs/次量级），实际价值是每连接少 5 条查询并把全局锁移出稳态路径；「旧库升级」两条测试用 reset_migration_cache 模拟新进程首连。
- list_meetings 加 LIMIT 20（网页 30 秒轮询不再无界全量拉）；会议音频落盘改 1 秒批量写（事件循环上的同步磁盘写次数降 10 倍）；双路 ASR 收摊并行化（graceful stop 延迟减半）；通话/会议期间整个停掉唤醒采集（此前白跑一路音频图丢帧）。

## 审查修复（/code-review high，15 findings：10 CONFIRMED / 5 PLAUSIBLE，全部处置）
- 会议链路 6 连修：①stop-during-CONNECTING 僵尸会话（客户端连接未建立就喊停→彻底 dispose，ready 无法复活，测试锁）②ready 发送失败泄漏服务端注册表（移进 try/finally 保护区，否则永久 4409）③ASR 重连预算双计数+孤儿任务（stale-guard 忽略迟到旧会话报错、出结果即清零计数、重启时取消孤儿 reader）④建连补发缓冲乱序（先补发完再发布 session，voice/meeting 两个网关同修——开场句不再乱序进识别）⑤startMeeting 权限弹窗期间的重入与迟到采集流泄漏（meetingStarting 闸+每个 await 后校验会话存活，否则麦克风/录屏灯永远亮）⑥双声道灰字互相覆盖（按说话人分行）。
- 唤醒 4 连修：①带空格/标点的唤醒词永不匹配（词表与转写同一套归一化，测试锁「hey jarvis」）②登录过期后每句话弹登录面板抢焦点（唤醒送检走底层 api，401 安静暂停+人话提示，重新登录自动恢复）③并发 start 泄麦克风流（wakeStarting 闸+wakeWanted 期望态，弹窗空档被关掉的迟到流当场停）④通话/会议中改为整停整启。
- 其他：悬浮球离线偏好首轮即生效（基线从 null 改为 true，「桌面端在线后 10 秒内隐藏」的承诺兑现）；通话断线重连的 ready 不再用场景开场白冲掉正在看的回答（sawReady，测试锁）；录音写盘失败改「就地停录保留半截」而非换新文件截断重录（对齐基准不被重置，分离标签不会张冠李戴）；情绪检测任务持引用+最多一件在途+挂断取消（防 GC 半途回收与堆积）；emotion 的 pcm_to_wav 复用 wechat_voice 唯一实现；VOICE_STYLE_PROMPT 单源化到 scenes.py；删除 session.js 两个无调用方的白名单算子。
- 已知取舍（不修，记录）：同账号多台桌面端时 /api/desktop/commands 谁先轮询谁领走，会议指令可能被错的机器执行——按设备路由需要设备标识体系，下轮候选。清理债下轮候选：DashScope HTTP 客户端三处雷同、两网关握手/管道去重、唤醒逻辑抽 jarvis/voice/wake.py、CommandOutbox 与 PendingOutbox 合并。

## 创新：会议实时要点（对标飞书妙记/通义听悟）
- 会中每新增 ≥6 段发言且间隔 ≥90 秒（双闸防成本螺旋，单件在途），取最近 3200 字转写增量小结成 3-5 条「到目前为止的要点」，下行 live_points 帧；信息太少模型答 PASS 静默。桌面面板「⚡ 实时要点」金框滚动更新。pytest 2 条（节流触发/PASS 静默）+ desktop 1 条。

## 部署提醒（管理者）
- 无新依赖、无 schema/nginx 变更；桌面端本机重启生效。

# 第七轮（2026-08-25）：多说话人与兼容性 + 纪要三件套（追问/导入待办/改名）

基线：pytest 566 / desktop 105 / vitest 86。交付后 **pytest 570 / desktop 105 / vitest 88**。

## 市场调研结论（六家对标：腾讯会议/飞书妙记/通义听悟/讯飞听见/Zoom/钉钉闪记，来源全列 PROGRESS 调研档）
- **「系统级采集任意软件通话」是公开空白**：六家全绑自家会议生态或麦克风录音，没有一家能录微信语音通话（讯飞 PC 内录是唯一理论路径且未产品化）——我们的系统回环双流采集正是差异化定位，本轮把文案从「飞书」泛化为任何出声软件并加了自检手段。
- 三个最值钱的借鉴点：①讯飞式轻量声纹注册（个人可用，会后划选发言即存声纹）②待办三件套一键进任务系统（飞书/钉钉/Zoom 均证明是留存抓手）③实时纪要+带引用追问共用一条流水线（上轮实时要点已就位）。

## 三人以上说话人（用户问的设计题，落地答案）
- 架构本就支持 N 人：双声道（我/对方）→ 离线 paraformer-v2 diarization 按 speaker_id 编号 对方1/2/3…（新增三方会回归测试）；MEETING_PROMPT 升级：多方观点分别归属、新增「参会人」行、**从上下文推断称呼**（被点名回应/自报家门 → 「对方2（张总）」，推不出保持编号，禁止编造）。
- 改名兜底（对标妙记）：PATCH /api/meetings/{id}/speaker 把「对方N」全局改真名（转写+纪要同改，正则防「对方1」误伤「对方10」、括号注记一并吸收，测试锁）；网页会议详情内嵌改名小表单。
- **真声纹注册（自动真名）路线已设计未实施**：需本地说话人 embedding 模型（CAM++/ECAPA，onnxruntime 依赖）+ 声纹库余弦匹配 + 「会后划选发言→这是张三」注册入口；属独立立项体量，列入下轮候选。

## 纪要三件套（新功能）
- **⇩ 导入待办**：extract_todos 解析纪要「待办事项」（兼容 —/-/– 连接符），POST /api/meetings/{id}/todos 只导「负责人含我/空」的条目（别人任务不导）、内容级去重、期限拼进内容；测试锁 found/mine/imported 语义。
- **💬 就这场会议追问**：会议详情一键把「纪要+转写(截 6000 字)」注入当前对话线程（Hud injected → Chat 自动发出），后续连续追问走线程记忆——对标腾讯元宝导入/妙记问答。
- **✎ 说话人改名**：见上。
- 桌面会议面板**双路电平柱**（青=我/金=对方）+ 系统声道 30 秒无声一次性提醒——跨软件兼容性的现场自检器。

## 部署提醒（管理者）
- 无新依赖、无 schema 变更（update_meeting_texts 走既有表）；前端产物已重建。

# 飞书机器人渠道（2026-10-02，worktree 分支）

基线：pytest 570 passed。交付后 **pytest 629 passed**（新增 59 条飞书用例，0 失败）。

## 架构选择
- **长连接（WebSocket）模式**收 `im.message.receive_v1`：服务器只需出公网，免公网回调/域名/内网穿透，适合宝塔部署。
- **不引入 lark-oapi**，自写协议层：官方 SDK 装后 46MB / 10727 个文件、新增 pycryptodome 等依赖；其 `ws.Client` 在导入时抓全局事件循环、`start()` 永久阻塞且无 `stop()`，无法随 FastAPI lifespan 启停。协议（`/callback/ws/endpoint` 取址 + pbbp2.Frame 二进制帧 + ping/pong + ack）按官方 SDK 1.7.3 源码实现；帧编解码约 100 行，与官方 SDK 序列化的黄金向量逐字节一致（双向交叉验证）。WS 用锁文件里已有的 `websockets==15.0.1` 同步客户端（改为显式依赖，**零新装包**）。
- 文档核实（open.feishu.cn 官方 llms 文档，2026-10）：3 秒内 ack 否则重推；重复推送按 `message_id` 去重而非 `event_id`；token 最长 2 小时、剩余 <30 分钟再取会发新 token；回复同人/同群 5 QPS；CardKit 流式卡片单卡 10 次/秒、sequence 严格递增、10 分钟自动关流式；发 Markdown 推荐 post+md 标签。

## 已实现（jarvis/channels/feishu/）
- frame.py 帧编解码；ws.py 长连接（立即 ack、分片合包、心跳与平台下发参数、抖动重连、握手错误分类、凭据错误 10 分钟慢重试）；api.py（token 缓存/提前 10 分钟刷新/失效重试一次、回复/发送/卡片/表情/资源下载/机器人信息）；bindings.py（open_id↔用户绑定、一次性 6 位绑定码 sha256 落盘 0600、每小时错 5 次锁定）；bridge.py（去重、15 分钟旧消息丢弃、群聊只认 @机器人、忽略机器人发信、按发信人绑定的用户租户跑 Agent、线程 fs-p/fs-g/fs-t 隔离、流式卡片→富文本→纯文本→直发会话四级降级、长回复 6000 字分段且代码块不断、图片走 qwen3-vl、链接即总结、人话报错）；routes.py（status/bind-code/unbind）；`python -m jarvis.channels.feishu` 管理 CLI。
- server.py 只加 4 处：1 行 import、lifespan 里 `feishu.start()` / `feishu.shutdown()`、模块级 `feishu.register(...)`。wechat.py 仅给 `_ReplyDispatcher` 加可选线程名参数（向后兼容）以便复用。
- 真网络佐证：伪造凭据打真飞书，token 接口回 10014、长连接取址回 1000040345，路径与错误分类均正确。反向验证：关掉去重/@过滤/token 重试/ack/绑定校验/卡片降级任一项，对应用例均变红。

## 待办
- 凭证到位后跑 `scripts/feishu_smoke.py --live`（后台操作清单见 docs/channels.md「飞书机器人」与 BLOCKED.md）。后续项：飞书语音（opus 转码接百炼 ASR）、提醒/Heartbeat 推送到飞书、网页/桌面飞书设置面板。

# 第八轮（2026-10-02）：性能 + 语音延迟 + 飞书接入（c108808，已上线）

- 后端卡顿五项：有界历史、checkpoint 旧版本清理、模型超时与连接池重配（单用户上限 10→32）、客户端断开即停、定位移出首字节路径；真实首 token 2889ms → 1023ms。
- 前端 / 桌面：流式 Markdown 增量渲染修掉 O(n²)、token 按帧合并、three.js 懒加载失效修复、桌面主进程去同步（git/osascript 改异步）。
- 语音：判停 800 → 500ms（实测 -300ms）、首句逗号即送 TTS、续说不抢答、回声抑制、开口预热；新增 `DASHSCOPE_ASR_MAX_SILENCE_MS`、`JARVIS_HISTORY_CHAR_BUDGET`。
- 飞书机器人渠道（见上节）；部署时离线裁剪 checkpoint + VACUUM，库 6.4MB → 0.3MB。
- 基线 pytest 657 / vitest 100 / desktop 117。

# 第九轮（2026-10-02）：网页界面改版（166d342，已上线）

- 「安静未来感」设计系统（`--jv-*` 设计 token，暗 / 亮两套），顶栏精简为头像菜单，⌘K 命令面板直达会话与全部设置。
- 「今日」板合并日程 / 待办 / 备忘 / 会议纪要（宽屏常驻、窄屏浮层、手机底部抽屉）。
- AI 存在感光球 Presence（CSS 首屏 + WebGL 6KB 懒加载）贯穿登录页、空态与语音通话；登录页重做并保留 MOSS 形态，登录页 JS 1282 → 352KB。
- README 精简为首页 + `docs/` 七篇；桌面端修复未 ready 退出、单实例锁失效、dev 版 `jws://` 拉起欢迎页。
- 基线 pytest 657 / vitest 133 / desktop 124。

# 第十轮（2026-10-02）：全面 QA（6053d95，已上线）

- 后端：工具异常一律转文本（修线程永久中毒）、`calc` 防 `9**9**9` 冻住全站、同线程并发串行防丢答案、入参边界与中文错误 JSON、停机 aclose 泄漏。
- 后台线程：微信长轮询兜底 + 指数退避 + 单条消息隔离；四个定时线程合并为 `PeriodicWorker`（兜底、重启不复活旧线程、取不到 Owner 限频告警）；心跳周期夹到 60–86400 秒。
- 存储：连接及时关闭（232 条 ResourceWarning → 0）、迁移检查缓存、审计表索引、上传先按长度拦截；启动时校验服务器时区。
- 网页：键盘焦点与弹窗焦点陷阱、今日板打磨、飞书绑定面板、出错与上传说人话、弱口令横幅（`/api/session` 的 `password_weak`）；pypdf → 6.19.0、urllib3 → 2.8.0。
- 基线 pytest 765 / vitest 184 / desktop 124。

# 第十一轮（2026-10-02）：进场动画 + 首批新功能 + 桌面改版 + 安全加固

- 进场动画「唤醒」（`web-src/src/intro/awaken/`）：方案 A 粒子汇聚 + 方案 B 光幕结合，三方案并行原型后由用户选定；IntroGate 统一跳过 / 8s 兜底 / 每会话一次 / reduced-motion 不播；光球全局时钟 presenceClock 让交接花纹连续，登录卡收到 `jv:intro-done` 后才入场，播放期间预取 PresenceGL。gzip 约 9KB，60fps。
- 新功能（`docs/proposals/2026-10-feature-ideas.md` 首批 3 项）：一句话速记（纯前端中文时间解析 `quickAdd.js`）、记忆回执（SSE `tool_result.memory` + `/api/memory*`）、今日简报卡（`jarvis/briefing.py`，`/api/brief`，每人每天 ≤1 次模型）。无 schema 变更，全部用 tenant_prefs。
- 桌面端改版：与网页同一套 token，悬浮光球三态，设置新增主题项；空闲 CPU 13.9% → 6.1%。
- 安全：cryptography 45.0.7 → 50.0.2（旧密文兼容回归测试，pip-audit 0 条）；建号 / 改口令弱口令 400、重名 409；SessionJanitor 每 6 小时清过期会话；Heartbeat 静默时段 `JARVIS_HEARTBEAT_QUIET_HOURS` 与 24 小时去重。
- 基线 pytest 898 / vitest 304 / desktop 137。

# 第十二轮（2026-10-02）：手机端修抖 + 语音拟人化 + 回答拟人化 + ⌘K 翻旧账 + 可操作提醒

- 手机端上滑抖动（实测定位两处根因）：流式输出时「离底 <80px 即贴底」每帧把手指拽回；`content-visibility:auto` 估高 160px 在 WebKit 上回填跳动（实测 7 跳 542px）。新 `followScroll.js` 按手势判断跟随（下拖 / 滚轮上 / PageUp 立即松手，手指在屏或惯性中不写 scrollTop），content-visibility 仅保留给桌面非 Safari；修后 Chromium（模拟 Safari）与 WebKit 均 0 跳动、0 次程序写入。另：`viewport.js` 让 `.hud` 贴合 visualViewport（键盘不遮输入栏）、触屏输入 16px、点击区 44px、安全区、底部抽屉手柄、手机去 backdrop-filter、长用户消息折叠。
- 语音（`jarvis/voice/spoken.py`）：口语化规则 + TTS 前文本规整（时间 / 温度 / 日期 / 百分比读法，去 Markdown 与网址）；打断回报 `played_ms`，网关下发 `cut` 截断字幕并在下一回合告知「说到哪被打断」；工具慢 0.7s 先发 `filler` 垫话；情绪 / 场景影响 TTS 语气与语速；默认 TTS speech-2.8-turbo（首包 183–265ms）；延迟打点。网页、桌面端通话都已跟进新帧。
- 回答拟人化（`jarvis/prompts.py`、`graph.py`、`tools/*`）：提示词按六区重写；每轮在用户消息前注入「此刻」（日期星期时段时区 + 本地今日概况，30s 缓存、0.3s 超时、不写 checkpoint）；递归上限 24 + 剩余 ≤6 步提醒收尾；`guard_tool_call` 兜底联网预算与重复查询；天气临时错误退避重试一次；工具说明与回执改写；芯片文案说人话。评测（`scripts/eval_persona.py`，21 条）：工具调用 35 → 27、调 now 9 → 0、列表行 37 → 11、加粗 43 → 6。
- ⌘K 直接吩咐（F1）+ 翻旧账（F10）：`jarvis/history_index.py` 租户 schema v4（消息索引 + 同步水位，FTS5 trigram，短词退回 LIKE，后台回填 `JARVIS_HISTORY_BACKFILL`），`GET /api/history/search`，新工具 `recall_history`（第 27 项），⌘K「历史对话」分组跳转并定位消息；`UndoToast.jsx` 抽出共用。
- 可操作的提醒（F5）+ 送达与免打扰（F6）：`jarvis/delivery.py`，`POST /api/reminders/{id}/snooze|done`（幂等，完成优先），网页弹条 / 桌面通知 / 微信 / 飞书回复均可「稍后 / 完成」且跨渠道去重；设置中心「主动找你」；提醒、晨报、巡检可推送飞书；免打扰只拦巡检、结束后合并。复用 `tenant_reminders_sent` 与 tenant_prefs，无表结构变更。
- 调研：`docs/proposals/2026-10-round12-roadmap.md`（下一轮建议「手机上的贾维斯」PWA + 推送、「有人味的管家」惦记回访与接通先开口）。
- 基线 pytest 1069 / vitest 347 / desktop 149。

# 第十三轮（2026-10-02）：智能体工坊（依据 10-02 会议纪要）

- 方向：面向不懂技术的人的插件拼接平台。用户口径（两次修正后）：**先进插件市场挑插件 → 生成专属账号和口令 → 用现有登录页登录 → 进去就是按所选插件形成的智能体**；现有页面保持不变；前端删除 MOSS。方案与接口契约：`docs/proposals/2026-10-round13-platform.md`，调研与演示：`docs/proposals/2026-10-round13-research.md`、`docs/demo/round13-pitch.md`。
- 地基（a8d2be7）：`routes.js` 顶层页面 `/market`、`/flows`、`/p/<slug>`，`qr.jsx`（qrcode-generator），服务端三类路径回 index.html。注意：worktree 代理基于 origin/main，本地未推送的地基要让代理先 merge。
- 后端·平台与市场：`jarvis/plugins/`（22 插件、8 职业、规则 + 模型推荐，模型只许选清单 id）、`jarvis/platforms.py`（租户 schema v5 `tenant_platforms`；`/api/market/catalog|recommend|signup`、`/api/platform`、`/api/p/{slug}`；signup 不种 cookie，Owner 代开不受开关限制，游客受 `JARVIS_MARKET_SIGNUP` / 邀请码 / IP 限流 / 总量上限约束）、`jarvis/pwa.py`（manifest、纯 zlib 光球图标、sw.js）。**账号级智能体**：`build_agent(tool_names=…)` + `RuntimeBundle.platform_rev`，平台账号只绑定所选插件的工具（+ now/calc），提示词加「智能体身份」段；Owner 与无平台账号不变。
- 后端·流程引擎：`jarvis/flows/`（租户 schema v6 `tenant_flows`、`tenant_flow_runs`；9 个积木；`POST /api/flows/{id}/run` SSE；公开结果页 `/r/{token}` 服务端渲染、全转义、CSP 禁脚本、30 天）；飞书 `FeishuAPI` 增加建文档 / 追加块 / 加协作者，没权限降级为发消息。
- 前端：`market/`（市场、帮我推荐、起名、结果页账号口令卡与存成图片）、`flows/`（节点式编辑器、信号流动的试运行动画、结果卡二维码、运行历史）、`platform/`（智能体品牌化主页、智能体设置、分享卡、`/p/<slug>` 品牌登录、PWA 注入），菜单与 ⌘K 入口。
- 删除 MOSS：登录页切换 / 3D 机器人 / 台词语音、人设 MOSS 人格（旧数据按 jarvis）；移除 three / @react-three/*，前端产物 1.68MB → 0.71MB；登录页支持 `?u=` 预填用户名。
- 本机端到端联调（临时数据目录、真实 DeepSeek）：Owner 在市场用一句话描述推荐 → 生成「奶茶店小管家」账号 → `?u=` 登录 → 智能体自称其名、没装的技能直说并给替代、日程正常；流程「上新文案」3 秒跑完并生成结果页。联调发现并修正：回答里「平台 / 智能平台市场」统一为「智能体 / 智能体市场」。
- 基线 pytest 1178 / vitest 417 / desktop 149。

# 第十四轮（2026-10-02）：插件独立封装 + 开源导入 + 办公插件 + 体验修复 + 桌面正式 App

- 用户反馈：①「学习助手」主页快捷问题出现「火锅」「奶茶店」；②扫码进新账号看到 admin 的历史（线上库核对：新账号 0 会话 0 索引，服务端没串；是手机浏览器留着 admin 登录、`?u=` 被忽略）；③插件要独立封装互不影响、能从 GitHub / 开源导入，加 PDF、Excel 等；④参考 Codex / ChatGPT 插件体系；⑤网页点悬浮窗拉不起来。契约：`docs/proposals/2026-10-round14-plugins.md`。
- 体验修复：`?u=` 与当前账号不一致时先确认再切换、登录即作废本浏览器旧会话；`accountStorage.js` 本地数据按账号区分；`jarvis/platform_home.py` 按名称 / 介绍 / 职业 / 插件用模型生成问候与 4 个快捷问题（tenant_prefs 存签名，规则兜底）。
- 插件框架：`jarvis/plugins/{loader,manifest,importer,routes,sandbox,sandbox_runner,settings,skills}.py`；22 个插件迁成 `jarvis/plugins/packs/<id>/plugin.json`（目录快照测试保证接口不变）；隔离五条（坏包只影响自己、超时与人话、冲突拒绝、设置命名空间、第三方子进程 `python -I -B` + rlimit + 最小环境）；Owner 导入 GitHub / Gitee / zip（信任预览、固定 commit、启停、卸载、检查更新）；兼容 Agent Plugins 标准 plugin.json、`skills/*/SKILL.md`、`.agents/plugins/marketplace.json` 插件源；状态存 `plugins/_state.json`，无表结构变更。
- 文件空间与办公插件：`jarvis/files.py`（每账号 200MB / 单文件 20MB / 30 天，路由 /api/files）；对话附件存原件并带 `［附件：… · file_id=…］` 标记（气泡里显示为 📎 小标签）；内置 pdf / excel / word 插件包与 `excel_out` / `word_out` 积木；新依赖 openpyxl 3.1.5、python-docx 1.2.0。
- 生态：`docs/plugins.md`、`examples/plugin-template/`（MIT-0）、示例插件 unit_convert / lottery / text_check / moments_coach、`examples/marketplace/`、调研 `docs/proposals/2026-10-round14-ecosystem.md`。
- 桌面端：Chrome 本地网络访问实测为根因（`loopback-network` 权限待询问时请求直接失败）；网页探活带 `targetAddressSpace: 'loopback'`、按权限给指引、没启动时自动 `jws://` 并轮询接管；`npm run pack:mac` / `install:mac` 打包安装 `~/Applications/贾维斯.app`（`cn.gkgeek.jws`，ad-hoc 签名，与开发版共用 userData）；对话下载链接由主进程带令牌下载。
- 本机联调（真实模型）：从 zip 导入「单位换算」→ 开「报销小助手」（excel + unit_convert + todo）→「3 斤半是多少公斤」走第三方子进程答对；上传报销表按部门汇总，金额全对并给出下载链接；问 PDF 合并时说明未装并给替代。联调发现并修：插件工具芯片显示英文名（改为插件名，网页 / 语音 / 飞书都带 label）、用户气泡露出附件标记。
- 基线 pytest 1296 / vitest 461 / desktop 166 / examples 62。

# 第十五轮（2026-10-02）：市场做首页 + 参考 Codex 重做插件目录 + MCP 接入 + 官方开源插件

- 用户要求：①智能体市场参考 Codex 重做、提升体验；②用导入能力做平台自己的开源工具（技能 + MCP）；③登录页改 `/login`，插件市场作为主域名首页。契约：`docs/proposals/2026-10-round15-market.md`（地基 829a0a5：routes.js 路径常量与 loginHref，先推送再派代理）。
- 路由：`/` 市场、`/login` 登录、`/app` 主应用；未登录访问 /app、/flows 跳 `/login?next=`；`safeNext` 只接受站内路径；服务端 `/market`、`/?u=` 302 到新地址（保留参数），旧二维码可用；进场动画只在 `/` 首次播；`pageTitle` 按路由设标题。
- 市场前端（market/：Catalog、PluginCard、PluginDetail、Featured、TopBar 等）：调研 OpenAI 插件文档与 codex 源码中的插件目录、Raycast、App Store；顶栏搜索（⌘K / `/`）、精选套装、来源 × 类型 × 分类筛选、`?plugin=<id>` 详情抽屉（能做什么 / 试试这样问 / 需要什么 / 来源 / 同类推荐）、工具箱排序与类型分布、三态（骨架 / 空 / 错误）。
- MCP（`jarvis/plugins/mcp_client.py` 自写客户端、`mcp.py`）：streamable-http + sse，拒绝 stdio；`${KEY}` 只在 url / headers；配置 `plugins/_config.json`（0600，AES-GCM，主密钥 JARVIS_SECRETS_KEY）；工具清单存档 + 指纹，变化即 needs_review；工具名 `<id>__<tool>`，30 秒超时、8000 字截断、按外部资料包裹；管理员「MCP 服务」页签：配置、测试、确认变更、直接添加 MCP 服务。无新依赖。
- 官方开源插件（MIT-0，`jarvis/plugins/packs/LICENSE`）：新增 15 技能、5 计算工具（纯标准库，政策依据对过 gov.cn）、4 MCP（deepwiki、context7 免 Key；amap、kuaidi100 需 Key）；根目录 `.agents/plugins/marketplace.json` 列出全部 49 个插件（插件源 jws-agent-official）。Owner 不再默认注入内置技能（避免挤满注入额度）。
- 本机联调（真实模型）：`/` 市场 → DeepWiki 详情 → 管理员代开「开源小帮手」（deepwiki + 周报技能 + 金额大写 + 待办）→ `/login?u=` 登录 → `/app`；DeepWiki 后台自动发现 3 个工具，智能体通过 MCP 列出 python-sdk 文档 12 个章节；金额大写、周报技能正常。联调发现并修：详情页露出 MCP 英文工具名（新增 plugin.json `tool_labels` 与目录 `tool_info`）、「联网」需求重复。
- 基线 pytest 1482 / vitest 504 / desktop 166 / examples 62。

# 第十六轮（2026-10-02）：市场返回入口与账号菜单修复

- 用户反馈：①进入主应用或登录页后回不到市场；②市场里已登录时点头像没反应、无法退出。
- 修复：登录页标志与「← 逛逛智能体市场」链接回 `/`；主应用顶栏加「智能体市场」按钮（≤380px 隐藏）；市场头像改为账号菜单（进入我的智能体 / 我的流程 / 退出登录，退出后留在市场；菜单底色不透明，避开父级 backdrop-filter）。线上只读冒烟通过。

# 第十七轮（2026-10-03）：插件市场去冗余改版 + 拖拽加入 + 进场动画每次刷新都播

- 用户要求：市场「太冗余、布局不行」，参考苹果、华为、Anthropic、ChatGPT 的版面；插件要能拖动加入；任务较大，多派代理。契约：`docs/proposals/2026-10-round17-market.md`（地基 5ddfa51：`market/dnd/` 接口桩，先推送再派代理）。
- 四个代理并行：调研（`docs/design/2026-10-market-references.md` + 36 张参考截图）、版面去冗余（Market / Hero / Featured / Catalog / PluginCard / TopBar / market.css）、拖拽（`market/dnd/` 自写 Pointer Events 引擎 + Toolbox）、详情与结果页（PluginDetail / Brand / Result，样式拆到 detail.css、flow-pages.css）。
- 版面：首屏信息块 11 → 6、同屏实心主按钮 4 → 1、1440 整页高 4085 → 3072px；「一句话推荐」并进搜索框（像一句话时回车即推荐）；来源 / 类型收进「筛选」（手机底部抽屉）；管理员「插件管理」移进头像菜单；紧凑行卡 + 单徽标优先级；令牌化字号 / 间距 / 圆角 / 阴影 / 时长。
- 拖拽：`DndRoot({onAdd, canAdd, onReorder, onRemove})`、`useDragSource`、`useDockDrop`、`flyToDock`；鼠标移动 5px 起拖、触摸长按 450ms 起拖（期间移动 8px 视为滚动）；拒绝态说明原因（已在工具箱 / 需要配置 / 暂不可用）；抽屉排序、拖出移除、Dock 图标上拖移除，5 秒撤销（`onAdd(ids, {restore})` 去重追加再挪回原位）；键盘与读屏替代齐全；零新依赖。集成时修：Dock 上方的用法提示会盖住起名步骤提示与生成报错（改为提示让位）。
- 进场动画：由「只在市场首页、每会话一次、减弱动态时不播」改为每次整页打开 / 刷新都播（市场、登录、主应用、流程页；品牌智能体入口 `/p/<slug>` 不播；减弱动态时 awaken 自降级为 ≤1s 静态淡入；`?intro=off` 仍可关）。
- 本机真后端联调 22 项全过（`output/round17-e2e/`，含桌面与手机录屏）：各页进场动画、拖入 / 接收态、点 + 飞入、重复与需配置被拒、整套拖入（2 → 10）、抽屉排序、移除撤销回原位、Dock 拖出与撤销、单击卡片开详情、生成账号并登录（智能体插件顺序 = 抽屉里排的顺序）、手机快速滑动不误触、手机长按拖入。
- 基线 pytest 1482 / vitest 558 / desktop 166 / examples 62。
- 已上线（2026-10-03 01:18，43fd073，bundle 部署，GitHub 推送成功）：部署前用 sqlite backup API 备份 `jarvis.db` / `accounts.sqlite3`（`*.pre-round17-20261003-0118.bak`，在 /var/lib/private/jarvis）；`.env` 照例 600；editable 导入路径指向 /opt/jarvis。线上只读冒烟：`/`、刷新、`/login`、`/app` 都播进场动画；首页 37 张插件卡、8 个套装，1440 与 390 宽均无横向溢出；游客拖入接收态 over、点 + 加入；管理员头像菜单含「插件管理」；页面无报错。无新依赖、无表结构变更。

# 第十八轮（2026-10-03）：流程画布（参考 Dify / Langflow）+ 一句话生成 + 模板 + 定时运行 + 新手引导

- 用户要求：「我的流程」参考 Langflow、Dify 自己搭工具流与输出，加插件与模组拼工作流；做完要好用、方便，有新手引导，只出现一次、可跳过、可重复触发；按复杂度多派代理。契约：`docs/proposals/2026-10-round18-flows.md`（地基 2c2083b：tenant schema v7〔`tenant_flows.graph`、`tenant_flow_triggers`〕、`graph.py` 结构校验与旧流程换算、extras / onboarding 接线、`/flows/<id>`、v2 接口、`@xyflow/react@12.12.0`）。
- 六个代理：调研（`docs/design/2026-10-flows-references.md`，15 条结论转给各代理）、引擎（`graph.py` 规整与校验、`executor.py` 拓扑执行 / 条件激活与跳过传播 / 变量渲染 / 插件工具 / 防注入 / foreach / 结果页 / preflight / `run_headless`、`nodes.py` 节点目录、`config_hash`）、好用层（24 个模板、一句话生成〔校验失败喂回重试一次〕、定时运行〔工作日跳节假日、busy 顺延、过期不补跑、连续失败 5 次暂停〕）、画布（React Flow 画布、拖 / 点 / 出口「+」/ 拖线到空白四种加节点、插入变量 chip、检查清单、运行面板逐节点、结果已过期、2 秒自动保存、撤销重做、整理、手机列表编辑）、列表页（首页一句话生成 / 模板 / 流程卡片缩略图、运行记录、定时弹层）、新手引导（聚光灯引擎、按账号存服务端、四套引导、头像菜单 / ⌘K / 设置入口）。中途六个代理因网络流中断停过一次，四个续跑、两个重开。
- 集成时修：自动暂停的定时仍在流程卡片上显示（带暂停原因，用户自己关掉的不显示）；连续失败只在第一次与暂停时各通知一次。决定：自动保存（已保存过的流程 2 秒防抖）、条件比较默认去空白不分大小写、「试试这些」用固定列表、布局参数 240 / 80 / 40。
- 已知限制：流程里的核心联网工具用全局搜索配置（没按账号区分）；核心工具的失败文字会当正常结果传下去（插件工具的失败能识别）；开始节点上传的文件只给提取出的正文，Excel / PDF 文件类工具暂不能在流程里用（模板改由 AI 汇总前 60 行）。
- 本机真后端 + 真模型联调 15 项全过（`output/round18-e2e/`，桌面与手机录屏）：主应用 / 流程首页 / 画布引导每步都找到目标、看过不再自动出现、可重看、换设备不再弹；一句话生成 2.3 秒出预览 → 画布 → ⌘S 换真 id → 运行 4 节点全过（5.4 秒）；「顾客消息分流回复」模板走退款分支、另一支 2 节点跳过（13 秒）；定时设为工作日 08:00，拨到点后后台 30 秒内跑完并排下次到 10 月 8 日（跳过国庆）；运行记录手动 + 定时两条；手机首页无溢出、列表式编辑可用。
- 基线 pytest 1722 / vitest 707 / desktop 166 / examples 62。
- 已上线（2026-10-03 20:23，f041df9，bundle 部署，GitHub 推送成功）：部署前 sqlite backup API 备份 `jarvis.db` / `accounts.sqlite3`（`*.pre-round18-20261003-2023.bak`）；`.env` 照例 600；editable 导入路径指向 /opt/jarvis。tenant schema v7 在首个登录请求时自动迁移（`tenant_flows.graph` 列、`tenant_flow_triggers` 表已就位）。线上只读冒烟：节点目录四组（基础 4 / 插件工具 52 / 技能 15 / 积木 9）、模板 24 个（精选 3）、一句话生成真模型 1.3 秒出草稿、/flows 四个引导锚点在、画布新草稿 3 个节点、引导在流程页与手机市场都会自动出现（未点击，不留记录）、手机无横向溢出、无页面报错与服务端异常。无新 Python 依赖；前端新增 @xyflow/react（仅画布懒加载块）。

# 第十九轮（2026-10-03）：流程文件直通 + 工具失败就停下 + 联网按账号设置

- 用户要求：把第十八轮留下的三点做了。
- 文件直通（一个代理）：开始节点文件字段原件存文件空间（同名同内容一天内复用；只有被引用或是办公文件才存），新变量 `{{start.<key>_file}}`；`preflight` 与 `convert_args` 检查文件参数接错；compose 纳入要 file_id 的工具并能修补；模板「Excel 报表分析成 Word」改走 excel_summary，新增「几份 PDF 合成一份」「Word 文档润色后另存」；画布变量选择器的「原文件」项、运行面板与运行记录的原件链接。
- 工具失败（主控）：`jarvis/tools/failure.py`（`ToolFailure` str 子类 + `public` 人话）；天气 / 定位天气 / 翻旧账 / 联网搜索与参数校验 / 网页提取 / 文娱搜索、Excel / PDF / Word 插件的失败都打标记；执行器工具节点识别后 node_error。对话不受影响（仍是原话）。
- 联网按账号（主控）：`FlowDeps.user_tool` 钩子 + `server._flow_user_tool`：执行联网类工具时借账号运行时、用其 `search_service` 现做同名工具；测试 / 旧式运行时原样返回。
- 顺带修：运行面板没动过的输入框显示字段默认值（必填检查也算默认值）。
- 本机真后端联调：Excel 模板 120 行随机数据，excel_summary 逐区合计与独立计算一致（华东 159596.41 / 华北 156098.81 / 西南 154463.27 / 华南 85199.64），Word 表格一致，AI 占比正确；没有定位时「按定位查天气」让流程停在那一步、AI 不再执行；本机没配搜索时联网节点停下并说「联网搜索还没配置好」。
- 基线 pytest 1756 / vitest 718 / desktop 166 / examples 62。
- 已上线（2026-10-03 21:12，2180fe5，bundle 部署，GitHub 推送成功）：部署前备份 `*.pre-round19-20261003-2112.bak`；`.env` 600；editable 导入路径正确；无表结构变更、无新依赖。线上只读冒烟：模板 26 个（含「几份 PDF 合成一份」「Word 文档润色后另存」），「Excel 报表分析成 Word」走 excel_summary → word_out；节点目录带「原文件」变量；一句话生成「上传销售表格按区域汇总写成 Word」真模型 5.7 秒，excel_summary 的 file_id 填 `{{start.sheet_file}}`；/flows 正常、无页面报错。

# 第二十轮（2026-10-03）：流程接进对话与消息 + 发送前确认 / 试跑 / 重跑 + 管理后台

- 用户要求：下一轮建议里的 1（流程接进对话与消息）、2（让新手敢用：发送前确认、单节点试跑、一键重跑）、3（管理后台：用量花费、配额、告警），按复杂度派代理。契约 `docs/proposals/2026-10-round20-flows-ops.md`（地基 1a37187：schema v8〔运行表重建 + 触发 / 确认 / 用量 / 配额 / 告警表〕、approvals / hooks / usage 空实现与接线、`/approve/<id>` 与 `/admin` 路由）。
- 五个代理：引擎（确认节点暂停与恢复、ApprovalSweeper、单节点试跑〔副作用只预演〕、重跑、文件引用输入、run_headless 的 source / waiting / quota、用量钩子）、对话与触发（`flow_list` / `flow_run` 工具、消息触发接飞书与微信、链接触发）、流程前端（确认节点 UI、`/approve` 确认页、首页等你确认、试跑、重跑、触发方式三页签）、用量后端（UsageCallback 记账、配额、告警与渠道巡检、管理接口）、管理后台前端（概览、趋势 SVG、类别、账号表与配额弹层、告警、入口）。
- 集成时修 / 定：一句话生成认识确认节点（原有 KeyError 隐患）；新模板「群通知先确认再发飞书」；确认通知始终注入 Notifier；定时流程撞上配额本次跳过不算失败；流式用量参数只对已知支持的服务商开；流程列表带 hooks 小标记；对话芯片「运行流程 / 我的流程」；智能体提示词说明能跑流程；确认后接着跑沿用原来源；「发送前确认」排在「结束」前；引导文案改「触发方式」。
- 已知限制：飞书里的图片 / 文件还不能作为消息触发流程的文件输入；市场推荐、主页生成、DashScope 识图与语音识别 / 合成不计入账号用量；估算单价需按实际模型设。
- 本机真后端 + 真模型联调 10 项全过（`output/round20-e2e/`）：对话里「帮我跑一下『群通知确认』流程…」→ 运行了流程、停在确认并给链接；确认页改内容同意 → 跑完、待办是改后的内容、来源仍是「对话里」；试跑「记到待办」只预演；链接触发 200 ok、错令牌 404；给 bob 设每天 1 次模型调用，第二句被拦「今天的用量到上限了…」，管理员收到「「bob」今天的模型调用次数用完了」告警，/admin 显示 bob 的用量。
- 基线 pytest 1897 / vitest 799 / desktop 166 / examples 62。

