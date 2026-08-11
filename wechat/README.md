# 贾维斯 · 个人微信接入（iLink Bot API）

参考 Hermes Agent 的接入路子：**不用逆向协议、不用整个 Hermes 框架**，直接对接腾讯 2026 年
官方开放的个人号 Bot API（iLink / 微信 ClawBot，纯 HTTP/JSON、无需公网）。项目默认由贾维斯
Web 服务内置这座桥；本目录保留命令行备用方案。

## 默认方式：网站扫码

1. 打开并登录 `https://jws.gkgeek-set.cn`。
2. 点击顶栏 **微信**。
3. 点击“生成二维码，开始接入”。
4. 用专用微信小号扫一扫并在手机端确认。
5. 状态变为“微信已连接”后，从另一个联系人给该小号发消息即可测试。

桥接在服务器上持续运行，网页和电脑可以关闭。Token 只保存在服务器的
`JARVIS_DATA_DIR/wechat_token`，服务重启后自动恢复；桌面悬浮窗的
**设置 → 个人微信** 使用同一桥接状态。

## 备用方式：独立命令行网关

只有不使用网站内置桥时才运行 `ilink_gateway.py`。

### 架构

```
个人微信  ⇄  iLink Bot API  ⇄  ilink_gateway.py（桥，跑在你 Mac 或服务器）
                                      ⇩  /v1/chat/completions
                              贾维斯服务器（含记忆/工具/定位）
```

贾维斯侧已就绪：`/v1/chat/completions`（OpenAI 兼容，Bearer 令牌鉴权，已实测真连 DeepSeek）。
微信桥每个微信联系人对应一条独立记忆线程（`wx-<用户>`），和网页/桌面互不干扰。

### 用法

```bash
cd wechat
cp .env.example .env      # 填 JARVIS_TOKEN（下面拿）、按需填白名单
../.venv/bin/python ilink_gateway.py   # 终端出二维码 → 微信扫码确认
```

拿 JARVIS_TOKEN：
```bash
curl -s -X POST https://jws.gkgeek-set.cn/api/login \
  -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin"}'
# 复制返回的 token 字段填进 .env
```

## ⚠ 风险（务必先读）

- 个人号 Bot 是腾讯**可随时调整或终止**的服务，第三方接入存在**封号风险**。
- **强烈建议用专用小号**，别用主号；别群发、别高频、别拿去做营销。
- 群聊默认不响应（`WX_GROUP=false`）；私聊默认全放行，可用 `WX_ALLOW` 收窄到白名单。
- iLink 协议字段依据社区实测文档整理，腾讯若调整协议需同步更新脚本。
- **不要同时运行网站内置桥和独立网关连接同一个账号**，避免重复拉取或回复。

## 配置项（.env）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `JARVIS_URL` | `https://jws.gkgeek-set.cn` | 贾维斯服务器地址 |
| `JARVIS_TOKEN` | 无（必填） | 会话令牌，见上 |
| `WX_ALLOW` | 空 | 允许对话的 from_user_id 白名单，逗号分隔；空=私聊全放行 |
| `WX_GROUP` | `false` | 是否响应群聊 |
