# BLOCKED

无阻断项。

备注（非阻断）：
- README 快速开始第 4 节 `npm start`（macOS Electron 悬浮窗）是 GUI，无人值守环境无法验收；`cd desktop && npm install` 已亲手跑通（70 packages, exit 0）。属半托管范围，待领导亲验。
- 反向验证 12 路并发聊天时有 3 路 ReadTimeout：瓶颈为同一用户共享 runtime bundle 的 httpx `max_connections=10`（jarvis/provider_runtime.py，非本次白名单文件）。真实多用户各持独立 bundle，≤20 人正常使用不受影响；如需单用户更高并发，需裁决是否调该文件的连接上限。
