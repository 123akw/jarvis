# BLOCKED

只列**当前仍未解决**的事项（2026-10-02 第十三轮整理）。已解决的历史条目见 git 历史与 [`PROGRESS.md`](PROGRESS.md)；解决一条就删一条。

## 需要用户操作

1. **把生产 Owner 口令从 `admin/admin` 改掉。** 第十一轮起新设口令必须通过策略（≥8 位、非常见口令、非用户名加数字），但按要求**不强制修改**已有口令，只在网页顶部弹弱口令提醒。登录后在「账户设置 → 修改口令」更换。
2. **轮换飞书 App Secret（如果还没换过）。** 第八轮接入时 Secret 曾在聊天里出现过。在飞书开发者后台重置后，同步更新 `/opt/jarvis/.env` 与本机 `.env` 的 `FEISHU_APP_SECRET`，再重启服务。新值不要再贴进聊天。
3. **开通飞书 `cardkit:card:write` 权限（推荐，可选）。** 第八轮上线时没开，流式卡片会自动降级成普通消息。开通后要在「版本管理与发布」重新发布一次。已开通的话删掉这条。
4. **可选：Tavily / PandaScore key。** 本机与生产都没配 `TAVILY_API_KEY`、`PANDASCORE_TOKEN`。不影响使用：搜索走 SearXNG → DDGS，电竞回退网页搜索。需要时把 key 注入两边 `.env`（不要提交），再跑 `scripts/search_smoke.py --live`。
5. **决定市场自助开号的模式。** 生产默认 `JARVIS_MARKET_SIGNUP=off`：只有管理员登录后能在 `/market` 帮人开号。比赛现场要让观众自己扫码开号时，设 `invite`（配 `JARVIS_MARKET_INVITE_CODE`，二维码可带上）或 `open`，并按人数调大 `JARVIS_MARKET_SIGNUP_PER_IP` / `JARVIS_MARKET_SIGNUP_MAX`。每个新账号都会用服务器默认模型的额度。
6. **飞书文档积木的权限（可选）。** 「汇总到飞书文档」需要应用开通 `docx:document`（或 `docx:document:create`）与 `docs:permission.member:create` 并重新发布；没开时自动降级为发飞书消息。
7. **第十三轮真机验证。** 「存成图片」在 iOS Safari 长按保存；生成的账号在手机上扫码登录；流程运行进度经 nginx 是否逐步到达（已设 `X-Accel-Buffering: no`）；「添加到主屏幕」。
8. **第十二轮真机验证。** 本机只能用仿真与单测覆盖的部分：
   - **iPhone**（Safari 与「添加到主屏幕」两种）：键盘弹起时输入栏贴住键盘、顶栏不被顶走（`web-src/src/viewport.js`）；刘海 / 底部横条安全区；真实惯性滚动下上滑不被拽回。
   - **语音打断**：外放与耳机各试一次，看开口打断是否灵敏、播放回声是否误打断（门槛见 `VoiceCall.jsx` 的 `bargeThreshold`）；「⋯ 已打断」截断位置是否大致对得上；垫话出现的时机与频率体感。
   - **飞书提醒推送**：确认机器人有 `im:message:send_as_bot` 权限、用户在应用可用范围内；建一条 2 分钟后的日程，看私聊是否收到，回「稍后」应 10 分钟后收到「再次提醒」，网页与桌面不再弹原来那次。
   - **微信回复提醒**：提醒到点后 30 分钟内回「好了」应得到「不再提醒」；超过 30 分钟回「稍后」应按普通聊天处理。

## 需要外部条件

1. **微信语音消息的真实报文结构。** 生产 `journalctl -u jarvis-web | grep 'non-text probe'` 至今为空，iLink 语音结构仍未采到样本。收发两侧按可配置结构实现（`JARVIS_WECHAT_VOICE_*`，见 `.env.example`），识别不出时降级为「没听清」/纯文字。有人给机器人发一条语音后，按探针日志把配置或 `jarvis/wechat_voice.py` 顶部默认值一处改齐。
2. **微信主动推送（日程提醒 / 晨报 / Heartbeat）真机验证。** sendmessage 没有回复上下文，复用最近一条 `context_token`，需要真实联系人发「提醒发给我」绑定后观察一次。失败只记 WARNING 并降级，不影响正常收发。
3. **Chrome 私网访问（PNA）政策变化。** 网页唤起本机悬浮窗依赖 `Access-Control-Allow-Private-Network` 预检。如果 Chrome 改成强制用户授权，会多出一次授权弹窗，代码无需改动，留意即可。

## 技术债

- **通过一句话描述生成的智能体没有职业**，流程页的「为你推荐」模板分组就不出现（只列全部模板）。可以让推荐顺带推断职业并在开号时带上。

1. **桌面端没有打包签名（dmg / exe）。** 未打包的 dev 版上 `jws://` 协议注册只是 best-effort；macOS 通知上的「稍后 / 完成」按钮也要签名包并在 Info.plist 设 `NSUserNotificationAlertStyle=alert` 才会显示（dev 版点通知走悬浮窗里的提醒条）。需要签名与公证链路，建议单独立项。
2. **飞书语音消息。** opus 转码后接百炼 ASR，需要真实样本。（提醒 / 晨报 / 巡检推送到飞书已在第十二轮补上。）
3. **LangGraph `create_react_agent` 已弃用**（V2.0 移除）。`jarvis/graph.py` 需要迁移到 `langchain.agents.create_agent`，升级 LangGraph 2.x 之前必须做。
4. **步数用尽时的英文兜底。** 递归上限已设为 24，并在剩余步数 ≤6 时提醒模型收尾；模型仍无视提醒时，LangGraph 会写入一句英文「Sorry, need more steps…」，网页实时流里只见工具芯片、历史回放显示英文。彻底解决要在 server 的流式出口统一识别并替换成中文。
5. **语音还可以再快。** 第十二轮实测「说完 → 首音频」约 1.1–2.1 秒，主要卡在模型首 token。剩下收益最大的两项：ASR 中间结果稳定时投机启动模型（定稿不同就丢弃并回滚 checkpoint，带副作用的工具必须等定稿）；TTS 连接预建复用（部分回合 tts_ready 要 0.8–1.0 秒）。
6. **本机主 `.venv` 和 `requirements.lock` 不一致。** 缺 ddgs、trafilatura、lxml 等锁定包，部分版本偏低。测试靠假实现兜底能通过，但会掩盖真实依赖问题。建议 `.venv/bin/pip install -r requirements.lock` 重新对齐。
7. **`JARVIS_AGENT_WORKERS` 在 import 时读取**，早于 `run()` 里的 `load_env()`。本机直接跑 `jarvis-web` 时写在 `.env` 里不生效（生产经 systemd EnvironmentFile 注入，不受影响）。要修需要把线程池改成懒创建。
8. **Heartbeat 去重发生在模型生成之后**，每轮仍要调用一次模型；所有送达渠道都关掉时巡检也照常调模型。想进一步省钱，可以先确认有可用渠道、并把最近 24 小时已推送的内容注入提示词让模型直接回 PASS（`server._heartbeat_compose`）。
9. **测试里约 20 条 sqlite 连接未关闭的 ResourceWarning**，来自测试创建、随后被回收的 Agent 检查点连接。不影响结果，生产单例 Agent 也不受影响。
