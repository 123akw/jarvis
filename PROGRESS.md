# PROGRESS

## 任务 0：现状核对（2026-08-13）
- 基线实测：`pytest tests/ -q` → 378 passed, 8 failed, 0 skipped；8 个全是 tests/test_tools.py::test_memo_*，报 TenantScopeError，与任务书一致。
- `grep -n "暂时无法应答" jarvis/wechat.py` → 378 行命中 `f"（贾维斯暂时无法应答：{type(exc).__name__}）"`，与任务书一致。
- 目标顺序：1) 修 8 个红测试到 386/0/0（只改测试侧，tenancy/memo 实现零改动）→ 2) 微信 _handle_updates_response 入队+4 线程池、同发信人串行 → 3) scripts/concurrency_smoke.py 网页并发冒烟，P95<2s → 4) 报错人话化 + README 走查。
- 最大风险：任务 2 改微信消息处理为异步入队后，原有 test_wechat 同步断言可能依赖"处理完才返回"，需要在新测试里用事件/等待收敛而不是放宽断言；其次 smoke 脚本要真实起服务、真实模型，端口与账号引导是易断点。
- memo 落盘契约已变：memos.json → accounts.sqlite3 的 tenant_memos 表，两条落盘断言按新契约适配（不是放水，参照 tests/test_tenant_isolation.py 现有写法）。
