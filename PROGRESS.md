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

## 任务 4：报错人话化 + 开箱走查（commit 见 docs）
- jarvis/wechat.py `_humanize_reply_failure`：超时类 → 「联网检索或模型响应超时了，稍后再把这条消息发我一次」；其他 → 人话 + 「让管理员在网页端检查模型与联网配置」。异常类名只进日志。新增 tests/test_wechat_errors.py 2 用例防回归。
- /api/chat 流式异常兜底补 `log.exception`（此前异常被吞、无法排障），用户文案维持既有人话。
- 走查（全新 venv 全流程亲手跑）：安装 `pip install -e ".[dev]"`、`cp .env.example .env`、browser extra + Chromium、`jarvis-web` 起服 → Owner 首登引导 → POST /api/admin/users 邀请 Member → Member 登录 → Member dashboard 租户隔离为空数据 → 微信状态接口 Owner 200 idle / Member 403 → CLI `--once "现在几点了"` 真实模型应答。全流程无断点。
- README 修订 3 处与实际不符/缺口：快速开始补首启必填的 Owner 三项（否则 fail closed 无法登录）；网页端一节补首位 Owner 来源与「账户设置→用户管理」邀请 Member 入口；验收一节补 concurrency_smoke.py。
- 半托管待领导亲验：desktop `npm start`（GUI 悬浮窗，无人值守无法验收；`npm install` 已跑通）。
