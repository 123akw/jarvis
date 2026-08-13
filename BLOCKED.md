# BLOCKED

## 线 A · 语音通话
# 待裁决清单

- **阻断上线验收：**本机 `.env` 与生产 `/opt/jarvis/.env` 均未配置 `TAVILY_API_KEY`。代码、109 条测试和无效 Key 反向 smoke 已完成，但在有效 Key 到位前无法得到任务书要求的真实查询 4/4，也不能部署到生产。下一步只需在上述两个运行环境安全注入同一有效 Key（不要提交到 Git），再运行 `scripts/search_smoke.py`。
- `PANDASCORE_TOKEN` 本机与生产也未配置，但它是可选项；电竞工具会按任务书回退 Tavily，不单独阻断上线。
- 连续阻断审计：第 2 轮仍确认本机与生产均无 Tavily Key；本轮继续完成了 PandaScore、评分冲突和 smoke 防假绿补强，尚未到停止阈值。
- 连续阻断审计：第 3 轮再次得到 `local_TAVILY_API_KEY_configured=False` 与 `production_TAVILY_API_KEY_configured=False`。已达到任务书停止阈值；交付已完成分支，但生产 main、服务和微信桥保持原状。

## 语音通话（voice-call 分支，2026-08-13）
- 无阻断项：任务 0/1/2 全部验收通过，硬指标达成。**无**。

## 线 B · 并发加固与遗留修复
# BLOCKED

无阻断项。

备注（非阻断）：
- README 快速开始第 4 节 `npm start`（macOS Electron 悬浮窗）是 GUI，无人值守环境无法验收；`cd desktop && npm install` 已亲手跑通（70 packages, exit 0）。属半托管范围，待领导亲验。
- 反向验证 12 路并发聊天时有 3 路 ReadTimeout：瓶颈为同一用户共享 runtime bundle 的 httpx `max_connections=10`（jarvis/provider_runtime.py，非本次白名单文件）。真实多用户各持独立 bundle，≤20 人正常使用不受影响；如需单用户更高并发，需裁决是否调该文件的连接上限。

## 线 C · README 焕新（readme-refresh 分支，2026-08-13）

无阻断项。**无**。

备注（非阻断）：规格 Task 4 Step 3 要求 push origin/main，与本线任务书「不许 git push」冲突，按任务书只落本地分支；视觉效果待领导亲验。
