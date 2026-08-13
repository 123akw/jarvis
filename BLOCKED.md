# BLOCKED

## 线 C · 微信语音

## 线 A · 语音通话
# 待裁决清单

- **阻断上线验收：**本机 `.env` 与生产 `/opt/jarvis/.env` 均未配置 `TAVILY_API_KEY`。代码、109 条测试和无效 Key 反向 smoke 已完成，但在有效 Key 到位前无法得到任务书要求的真实查询 4/4，也不能部署到生产。下一步只需在上述两个运行环境安全注入同一有效 Key（不要提交到 Git），再运行 `scripts/search_smoke.py`。
- `PANDASCORE_TOKEN` 本机与生产也未配置，但它是可选项；电竞工具会按任务书回退 Tavily，不单独阻断上线。
- 连续阻断审计：第 2 轮仍确认本机与生产均无 Tavily Key；本轮继续完成了 PandaScore、评分冲突和 smoke 防假绿补强，尚未到停止阈值。
- 连续阻断审计：第 3 轮再次得到 `local_TAVILY_API_KEY_configured=False` 与 `production_TAVILY_API_KEY_configured=False`。已达到任务书停止阈值；交付已完成分支，但生产 main、服务和微信桥保持原状。

## 语音通话（voice-call 分支，2026-08-13）
- 无阻断项：任务 0/1/2 全部验收通过，硬指标达成。**无**。

## 线 C · 微信语音（wechat-voice 分支，2026-08-13）
- **等语音样本**：生产 `journalctl -u jarvis-web | grep 'non-text probe'` 至今为空（领导未发语音），iLink 语音报文实结构未知。收/发两侧均按「item type 未知 + voice_item 含下载凭证」的可配置结构实现（JARVIS_WECHAT_VOICE_* 环境变量可改 key 名与类型号）；样本到位后按实测一处改齐。
- ~~缺 DASHSCOPE_API_KEY~~ **已解除（2026-08-13 当日）**：管理者送达 key 并追加进 worktree .env。百炼真实调用已实现（qwen3-asr-flash + multimodal-generation 端点，实测 HTTP 200、识别文字逐字正确）；无 key 环境仍安全降级「没听清」。生产 .env 需同步注入该 key（管理者部署项）。
- 备注（非阻断）：新依赖 pilk 仅装在本地 .venv；requirements.lock / pyproject.toml 不在本线白名单，生产部署前需管理者把 `pilk` 加入依赖并在服务器 venv 安装，否则收侧解码/发侧编码会走「没听清」/纯文字降级（不会崩）。

## 线 B · 并发加固与遗留修复
# BLOCKED

无阻断项。

备注（非阻断）：
- README 快速开始第 4 节 `npm start`（macOS Electron 悬浮窗）是 GUI，无人值守环境无法验收；`cd desktop && npm install` 已亲手跑通（70 packages, exit 0）。属半托管范围，待领导亲验。
- 反向验证 12 路并发聊天时有 3 路 ReadTimeout：瓶颈为同一用户共享 runtime bundle 的 httpx `max_connections=10`（jarvis/provider_runtime.py，非本次白名单文件）。真实多用户各持独立 bundle，≤20 人正常使用不受影响；如需单用户更高并发，需裁决是否调该文件的连接上限。

## 线 D · 网页语音升级

## 线 A · 语音通话
# 待裁决清单

- **阻断上线验收：**本机 `.env` 与生产 `/opt/jarvis/.env` 均未配置 `TAVILY_API_KEY`。代码、109 条测试和无效 Key 反向 smoke 已完成，但在有效 Key 到位前无法得到任务书要求的真实查询 4/4，也不能部署到生产。下一步只需在上述两个运行环境安全注入同一有效 Key（不要提交到 Git），再运行 `scripts/search_smoke.py`。
- `PANDASCORE_TOKEN` 本机与生产也未配置，但它是可选项；电竞工具会按任务书回退 Tavily，不单独阻断上线。
- 连续阻断审计：第 2 轮仍确认本机与生产均无 Tavily Key；本轮继续完成了 PandaScore、评分冲突和 smoke 防假绿补强，尚未到停止阈值。
- 连续阻断审计：第 3 轮再次得到 `local_TAVILY_API_KEY_configured=False` 与 `production_TAVILY_API_KEY_configured=False`。已达到任务书停止阈值；交付已完成分支，但生产 main、服务和微信桥保持原状。

## 语音通话（voice-call 分支，2026-08-13）
- 无阻断项：任务 0/1/2 全部验收通过，硬指标达成。**无**。

## 语音升级（voice-upgrade 分支，2026-08-13）
- ~~待 key：`.env` 无 DASHSCOPE_API_KEY~~ → **已解除**：管理者当日注入 key 到 .env，`asr_smoke.py --live` 真连百炼识别回环 100% 重合、坏 key 红→绿闭环（见 PROGRESS 任务 1）。默认网关 `wss://dashscope.aliyuncs.com/api-ws/v1/inference` 实测可用，无需切 workspace 子域。
- 生产上线提醒（管理者动作，非本执行者地界）：`/opt/jarvis/.env` 也需注入 `DASHSCOPE_API_KEY`，否则线上自动走 asr_fallback→浏览器识别降级通道（通话不中断，但识别质量回到旧水平）。
- 上线提醒 2（界限所致）：jarvis/web 构建产物不在本任务白名单、未重建未提交；合并后上线前需 `cd web-src && npm ci && npm run build`（产物写入 jarvis/web）再部署，否则线上跑的还是旧版通话 UI（旧 UI 对新网关兼容：无二进制上行，走 user_text 老路）。
- 交付时点阻断项：**无**。

## 线 B · 并发加固与遗留修复
# BLOCKED

无阻断项。

备注（非阻断）：
- README 快速开始第 4 节 `npm start`（macOS Electron 悬浮窗）是 GUI，无人值守环境无法验收；`cd desktop && npm install` 已亲手跑通（70 packages, exit 0）。属半托管范围，待领导亲验。
- 反向验证 12 路并发聊天时有 3 路 ReadTimeout：瓶颈为同一用户共享 runtime bundle 的 httpx `max_connections=10`（jarvis/provider_runtime.py，非本次白名单文件）。真实多用户各持独立 bundle，≤20 人正常使用不受影响；如需单用户更高并发，需裁决是否调该文件的连接上限。
