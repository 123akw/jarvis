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

## 任务 4：报错人话化 + 开箱走查（commit 见 docs）
- jarvis/wechat.py `_humanize_reply_failure`：超时类 → 「联网检索或模型响应超时了，稍后再把这条消息发我一次」；其他 → 人话 + 「让管理员在网页端检查模型与联网配置」。异常类名只进日志。新增 tests/test_wechat_errors.py 2 用例防回归。
- /api/chat 流式异常兜底补 `log.exception`（此前异常被吞、无法排障），用户文案维持既有人话。
- 走查（全新 venv 全流程亲手跑）：安装 `pip install -e ".[dev]"`、`cp .env.example .env`、browser extra + Chromium、`jarvis-web` 起服 → Owner 首登引导 → POST /api/admin/users 邀请 Member → Member 登录 → Member dashboard 租户隔离为空数据 → 微信状态接口 Owner 200 idle / Member 403 → CLI `--once "现在几点了"` 真实模型应答。全流程无断点。
- README 修订 3 处与实际不符/缺口：快速开始补首启必填的 Owner 三项（否则 fail closed 无法登录）；网页端一节补首位 Owner 来源与「账户设置→用户管理」邀请 Member 入口；验收一节补 concurrency_smoke.py。
- 半托管待领导亲验：desktop `npm start`（GUI 悬浮窗，无人值守无法验收；`npm install` 已跑通）。
