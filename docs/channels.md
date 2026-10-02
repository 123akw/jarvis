# 微信与飞书

[← 返回 README](../README.md) · [功能](features.md) · [部署](deployment.md) · [配置](configuration.md) · [架构](architecture.md) · [开发与测试](development.md) · [FAQ](faq.md)

**目录**：[个人微信桥接](#个人微信桥接) · [飞书机器人](#飞书机器人) · [飞书开发者后台清单](#飞书开发者后台需要做的操作清单)

## 个人微信桥接

从你自己的 Web 部署用 Owner 登录后，可在右上角头像菜单（或 ⌘K 命令面板）点 **接入个人微信** 生成二维码，并用本人手机上的微信扫码确认；桌面端也可在 **设置 → 个人微信** 管理同一桥接状态。仍建议先使用专用或测试账号评估兼容性与账号风险，再由部署者决定是否使用常用账号。连接由服务器进程维持，关闭浏览器或桌面窗口不会主动断开；服务重启会尝试恢复。

- Token 仅保存在 `JARVIS_DATA_DIR/wechat_token`，权限为 `0600`，不会返回前端；二维码、Token、`.env` 都不得入库或公开分享。
- 每个联系人使用独立的 `wx-<联系人>` 线程；群聊和非文本消息默认忽略。
- 个人号第三方桥接存在登录态失效、协议变化和账号风险。建议优先使用专用或测试账号，不要高频发送；是否使用常用账号及相关风险由部署者自行评估，**禁止群发营销**。
- 登录态失效时，在网页或桌面设置中重新生成二维码并扫码。
- 命令行备用桥位于 `wechat/ilink_gateway.py`；不要让备用桥和网页内置桥同时连接同一微信账号，否则可能重复拉取或回复消息。

备用方式的具体变量和白名单配置见 [`wechat/README.md`](../wechat/README.md)。个人微信固定属于唯一 active Owner，相关升级与回滚注意事项见 [部署指南](deployment.md#多用户备份与回滚)。

## 飞书机器人

服务进程内置飞书桥（`jarvis/channels/feishu/`）：用**长连接（WebSocket）**接收 `im.message.receive_v1` 事件，服务器只需能访问公网，**不需要公网回调地址、域名或内网穿透**，适合宝塔等直接部署。未配置 `FEISHU_APP_ID` / `FEISHU_APP_SECRET` 时整条渠道不启动（相关变量见 [配置参考](configuration.md#环境变量)）。

- **对话**：单聊直接发；群聊只响应 @机器人 的消息（机器人发的消息一律忽略，防止互相回复成环）。单聊、群聊、群话题分别使用 `fs-p-*` / `fs-g-*` / `fs-t-*` 独立线程，并且都落在**发信人绑定的贾维斯账号**的租户里（同一个群里每个人各自一条记忆线）。
- **回复**：优先用流式卡片——先出「思考中…」，调用工具时显示「正在调用工具：…」，答案以打字机效果写出；缺卡片权限时自动降级为 Markdown 富文本（期间给原消息加「敲键盘」表情），再不行降级纯文本；超长回复卡片放第一段、其余按 6000 字分条续发，代码块不截断。发一条链接即自动读文总结；发图片（或图文）会先用 `DASHSCOPE_API_KEY` 的 qwen3-vl 识别再回答。语音消息暂未支持（会回复提示）。
- **可靠性**：收到事件后只解析入队并立即 ack（官方要求 3 秒内）；按官方建议以 `message_id` 去重（`event_id` 也记），丢弃 15 分钟前的旧消息；`tenant_access_token` 缓存、提前 10 分钟刷新、失效自动重取；断线按平台下发的参数抖动重连。
- **绑定**（飞书机器人对整个企业可见，所以未绑定的人只会收到绑定指引）：先为贾维斯账号领 6 位绑定码（10 分钟有效、一次性），再在飞书**私聊**机器人发送 `绑定 123456`；发 `解绑` 可解除。同一飞书账号每小时最多输错 5 次。

  ```bash
  # 管理员在服务器上为某个用户发码
  .venv/bin/python -m jarvis.channels.feishu bind-code <用户名>
  .venv/bin/python -m jarvis.channels.feishu bindings          # 查看已绑定
  # 或任何用户自己用接口领码（桌面令牌免 CSRF）
  TOKEN=$(curl -s -X POST https://<你的域名>/api/desktop/login -H 'Content-Type: application/json' \
    -d '{"username":"<用户名>","password":"<口令>"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')
  curl -s -X POST https://<你的域名>/api/feishu/bind-code -H "X-JWS-Token: $TOKEN"
  ```

  接口：`GET /api/feishu/status`（连接状态 + 本人是否已绑定）、`POST /api/feishu/bind-code`、`POST /api/feishu/unbind`，鉴权与微信接口一致。

### 飞书开发者后台需要做的操作（清单）

1. 打开 [飞书开发者后台](https://open.feishu.cn/app) → **创建企业自建应用**（名称如「贾维斯」，上传头像）。
2. **凭证与基础信息** → 复制 App ID / App Secret，写入服务器 `.env` 的 `FEISHU_APP_ID` / `FEISHU_APP_SECRET`（不要提交到 Git）。
3. **添加应用能力** → 添加 **机器人**。
4. **权限管理** → 开通以下权限：

   | 权限 | 用途 | 是否必需 |
   | --- | --- | --- |
   | `im:message.p2p_msg:readonly` 读取用户发给机器人的单聊消息 | 收单聊 | 必需 |
   | `im:message.group_at_msg:readonly` 接收群聊中 @机器人消息事件 | 收群聊 @ | 群聊必需 |
   | `im:message:send_as_bot` 以应用的身份发消息 | 回复 | 必需 |
   | `im:message:readonly` 获取单聊、群组消息 | 下载用户发来的图片 | 图片识别需要 |
   | `cardkit:card:write` 创建与更新卡片 | 流式卡片 | 推荐（缺失自动降级） |
   | `im:message.reactions:write_only` 发送、删除消息表情回复 | 降级模式的「打字中」表情 | 可选 |

   也可以用一个 `im:message`（获取与发送单聊、群组消息）覆盖后四项中的消息类权限。**不需要**「获取群组中所有消息」这类敏感权限。
5. 在服务器上先让长连接在线：启动贾维斯服务，或运行 `.venv/bin/python scripts/feishu_smoke.py --live`（后台规定：保存长连接订阅方式时必须有在线连接）。
6. **事件与回调 → 事件配置** → 订阅方式选 **使用长连接接收事件** 并保存 → **添加事件**：消息与群组 → **接收消息 v2.0**（`im.message.receive_v1`）。
7. **版本管理与发布** → 创建版本，设置**可用范围**（哪些人能私聊机器人）→ 申请发布，企业管理员审核通过后生效。之后每次增改权限都要**重新发布版本**才生效。
8. 跑 `scripts/feishu_smoke.py --live`，按提示在飞书里私聊机器人发一句话，应收到卡片回声；然后按上面的「绑定」步骤绑定账号，单聊对话、拉进群 @它 验证。

> [!WARNING]
> 长连接是**集群模式**——同一个应用若同时有多个进程在连（例如本机冒烟脚本和线上服务），每条消息只会随机推给其中一个；冒烟时先停线上服务或用测试应用。每个应用最多 50 条长连接。
