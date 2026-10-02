# 配置参考

[← 返回 README](../README.md) · [功能](features.md) · [部署](deployment.md) · [微信与飞书](channels.md) · [架构](architecture.md) · [开发与测试](development.md) · [FAQ](faq.md)

**目录**：[环境变量](#环境变量) · [语音与其他可选项](#语音与其他可选项) · [搜索与正文提取链](#搜索与正文提取链) · [多用户 Provider / API 设置](#多用户-provider--api-设置)

## 环境变量

把 `.env.example` 复制为 `.env` 后不要直接启动。首先填入真实的模型 API key、唯一 Owner 的 `JARVIS_ADMIN_USERNAME`、强且唯一的 `JARVIS_ADMIN_PASSWORD`，并用密码学安全随机源生成至少 32 字节的 `JARVIS_SESSION_SECRET`（例如 `openssl rand -hex 32`）。留空、示例占位符或过短 secret 都会 fail closed，不会创建 Owner。

| 变量 | 必需 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `JARVIS_PROVIDER` | 否 | `deepseek` | 环境回退模型 Provider：`openai`、`deepseek`、`bailian`、`siliconflow` 或 `custom` |
| `JARVIS_API_KEY` | 启动模型必需 | 无 | 当前环境回退 Provider 的通用 API key；不会返回前端 |
| `DEEPSEEK_API_KEY` | 否 | 无 | DeepSeek 兼容旧配置；`JARVIS_API_KEY` 为空且 Provider 为 DeepSeek 时使用 |
| `JARVIS_BASE_URL` | 否 | `https://api.deepseek.com` | OpenAI 兼容接口基址 |
| `JARVIS_MODEL` | 否 | 代码回退为 `deepseek-chat` | 模型名；仓库 `.env.example` 当前示例为 `deepseek-v4-flash` |
| `JARVIS_DATA_DIR` | 否 | `<项目根>/data` | SQLite 记忆、本地日程/待办/备忘、会话元数据和微信 Token 的目录 |
| `JARVIS_PORT` | 否 | `7789` | Web 服务监听端口 |
| `JARVIS_ADMIN_USERNAME` | 首次启动必需 | 无 | 首次数据库初始化时创建的唯一 Owner 用户名 |
| `JARVIS_ADMIN_PASSWORD` | 首次启动必需 | 无 | 首次数据库初始化时创建的 Owner 口令；只存 Argon2id 哈希 |
| `JARVIS_SESSION_SECRET` | 是 | 无 | 至少 32 字节随机值，用于会话与 CSRF；缺失或过短时网页登录会 fail closed，并在日志里记一条 WARNING 说明原因 |
| `JARVIS_SETTINGS_WRITE_ENABLED` | 否 | `false` | 设为 `true` 才允许网页/桌面写入 Provider 设置 |
| `JARVIS_SECRETS_KEY` | 设置写入必需 | 无 | URL-safe Base64 编码的随机 32 字节主密钥（不是 hex）；仅在服务器保存，不得轮换或丢失。格式不对时设置中心保持只读，日志 WARNING 会给出解码长度 |
| `JARVIS_SEARCH_BACKENDS` | 否 | `searxng,ddgs,tavily` | 搜索 provider 降级顺序；名称不能重复 |
| `SEARXNG_BASE_URL` | 否 | 无 | 本地 Compose 可设为 `http://127.0.0.1:18888`；未配置或不健康时继续 DDGS |
| `JARVIS_EXTRACT_BACKENDS` | 否 | `trafilatura,playwright` | 正文提取降级顺序；Playwright 未安装时明确跳过 |
| `TAVILY_API_KEY` | 否 | 无 | 可选 Tavily 搜索密钥；未配置不影响 SearXNG/DDGS 免费链，仓库与演示入口均不保证已配置 |
| `PANDASCORE_TOKEN` | 否 | 无 | 可选 PandaScore 结构化电竞数据 Token；缺失或失败时回退默认网页搜索链 |
| `JARVIS_REMINDERS_ENABLED` | 否 | `1` | 设为 `0` 关闭日程提醒、晨报电台与夜间记忆蒸馏的后台线程 |
| `JARVIS_HEARTBEAT_ENABLED` | 否 | `1` | 设为 `0` 关闭 Heartbeat 主动唤醒（线程根本不启动） |
| `JARVIS_HEARTBEAT_INTERVAL` | 否 | `1800` | Heartbeat 扫描周期（秒） |
| `JARVIS_HEARTBEAT_QUIET_HOURS` | 否 | `23:00-08:00` | Heartbeat 静默时段（可跨午夜，`off` 关闭）：期间整轮跳过、不调模型；24 小时内相同或高度相似的心跳只推一次。日程到点提醒不受影响 |
| `JARVIS_DISTILL_TIME` | 否 | `03:00` | 夜间记忆蒸馏触发时刻（HH:MM，过点 2 小时窗口内可补跑） |
| `JARVIS_SKILLS_DIR` | 否 | `<项目根>/skills` | 技能热加载目录，放 `<名>/SKILL.md` 即生效 |
| `JARVIS_SMTP_HOST` / `JARVIS_SMTP_PORT` | 发邮件必需 / 否 | 无 / `465` | 会议纪要发信的 SMTP 服务器；465 走 SSL，其他端口走 STARTTLS。未配置时纪要仍生成保存，只是不发邮件 |
| `JARVIS_SMTP_USER` / `JARVIS_SMTP_PASSWORD` | 发邮件必需 | 无 | 发信账号与授权码（QQ 邮箱用「设置→账户」生成的授权码，不是登录密码） |
| `JARVIS_SMTP_FROM` | 否 | 同 `JARVIS_SMTP_USER` | 发件人地址 |
| `JARVIS_MEETING_MAIL_TO` | 否 | `1539598168@qq.com` | 会议纪要默认收件邮箱；每用户可在网页「设置中心 → 桌面与会议」覆盖 |
| `JARVIS_WAKE_WORDS` | 否 | `贾维斯,佳维斯,…,jarvis` | 语音唤醒词匹配表（逗号分隔，含同音兜底） |
| `JARVIS_DASHSCOPE_VL_MODEL` | 否 | `qwen3-vl-flash` | 聊天发图/短视频的视觉理解模型（同用 `DASHSCOPE_API_KEY`） |
| `JARVIS_LOG_LEVEL` | 否 | `WARNING` | 设为 `INFO` 可看到心跳/提醒/蒸馏等后台线程的推送日志 |
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | 启用飞书必需 | 无 | 飞书企业自建应用凭证；两项都填才建立长连接，缺任一项飞书渠道保持 disabled |
| `FEISHU_DOMAIN` | 否 | `https://open.feishu.cn` | 国际版 Lark 填 `https://open.larksuite.com` |
| `FEISHU_STREAMING_CARD` | 否 | `1` | 设为 `0` 关闭流式卡片，改用普通 Markdown 消息回复 |

飞书开发者后台的配置步骤见 [微信与飞书 · 飞书机器人](channels.md#飞书机器人)。

## 语音与其他可选项

以下变量来自 [`.env.example`](../.env.example) 与第八轮性能优化，均为可选；语音相关 key 都缺时语音功能自动降级（浏览器识别 + 纯文字），不影响文字聊天。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `MINIMAX_API_KEY` | 无 | 语音通话 TTS（MiniMax） |
| `DASHSCOPE_API_KEY` | 无 | 阿里百炼：通话与会议的服务端流式识别、微信语音识别、情绪感知、图片 / 短视频识别（含飞书发图）、会议说话人分离 |
| `MINIMAX_TTS_VOICE` / `MINIMAX_TTS_MODEL` | `male-qn-qingse` / `speech-02-turbo` | 语音答复音色与模型 |
| `JARVIS_DASHSCOPE_ASR_MODEL` | `qwen3-asr-flash` | 微信语音消息识别模型（同用 `DASHSCOPE_API_KEY`） |
| `JARVIS_WECHAT_GROUP_NAME` | `贾维斯` | 群聊里 @ 贾维斯的名字，被 @ 才会在群里应答 |
| `JARVIS_HISTORY_CHAR_BUDGET` | `30000` | 每轮送模型的历史字符预算（按轮次边界裁剪，checkpoint 全量历史不动）；`0` 关闭裁剪 |
| `DASHSCOPE_ASR_MAX_SILENCE_MS` | `500` | 语音通话判停静音阈值（毫秒，有效范围 200–6000） |

## 搜索与正文提取链

> 搜索默认按 `SearXNG → DDGS → 可选 Tavily` 降级，正文提取默认按 `Trafilatura → 可选 Playwright` 降级。私有演示入口已启用本机 SearXNG，并在不可用时回退无需付费 key 的 DDGS；不保证 Tavily 或 PandaScore 已配置。自建 SearXNG、Tavily key 和 PandaScore token 都是可选增强，不是上线前置条件。

自建 SearXNG 的步骤见 [`deploy/searxng/README.md`](../deploy/searxng/README.md)；来源、时间戳与安全边界见 [架构说明](architecture.md#实时搜索与正文提取的来源边界)。

## 多用户 Provider / API 设置

- 网页 **头像菜单 → 设置中心 → 模型 API**（也可 ⌘K 直达）与桌面端 **设置 → 模型 API** 都可以选择 OpenAI、DeepSeek、阿里云百炼、SiliconFlow 或自定义 OpenAI 兼容 HTTPS 地址。官方 Provider 只接受其官方 API 主机；自定义中转禁止 HTTP、URL 凭据、查询参数和片段。
- 每个用户只管理自己的模型 Provider、Base URL、模型名和 Key；Owner 额外管理全局 SearXNG、Tavily 与 PandaScore。Member 无法读取或修改其他账号配置，也不能管理全局联网数据源。
- API Key 永不回显到网页或桌面端。托管设置使用 AES-GCM 加密并按用户、Provider、Origin 与 generation 绑定；每次测试、保存或恢复都要求当前账号口令，修改采用 generation 冲突保护。
- Provider 设置保存后只影响当前账号的新 Agent 会话；已经打开的网页、桌面窗口或旧登录会话应退出并重新登录，再新建对话验证模型切换。
- 测试连接会真实发送极少量非流式工具调用、流式文本和流式工具调用，可能产生少量模型费用。第三方中转可读取问题、上下文、工具调用和输出，建议只使用独立、低额度、可吊销的 Key。
- “恢复环境配置”会切回 `.env` 中的回退 Provider。未同时配置写入开关和主密钥时，设置中心保持只读，原环境配置仍可正常使用。

如需开启设置写入，先在服务器生成一次主密钥并只写入 `.env`：

```bash
python -c "import base64,secrets; print(base64.urlsafe_b64encode(secrets.token_bytes(32)).decode())"
# 把输出填入 JARVIS_SECRETS_KEY，并设置：
JARVIS_SETTINGS_WRITE_ENABLED=true
```

主密钥不得提交、打印到日志或发送到前端；丢失后既有托管 Key 无法解密。正式变更前应连同 `JARVIS_DATA_DIR/provider-active.json`、`provider-generations/` 和 `provider-audit.jsonl` 一起备份。

多用户隔离、备份与升级回滚流程见 [部署指南](deployment.md#多用户备份与回滚)。
