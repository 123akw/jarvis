# BLOCKED

只列**当前仍未解决**的事项（2026-10-02 第十一轮整理）。已解决的历史条目见 git 历史与 [`PROGRESS.md`](PROGRESS.md)；解决一条就删一条。

## 需要用户操作

1. **部署第十一轮时升级服务器上的 cryptography。** 锁文件已从 45.0.7 升到 50.0.2（pip-audit 13 条漏洞清零）。服务器执行 `/opt/jarvis/.venv/bin/pip install cryptography==50.0.2`（有 cp311-abi3 manylinux 轮子，清华镜像可用），`cd / && /opt/jarvis/.venv/bin/python -c "import cryptography; print(cryptography.__version__)"` 确认后重启 `jarvis-web`。新旧版本加解密双向兼容、已存的 Provider Key 不用重新填写（见 `tests/test_crypto_compat.py`）；不升级服务也能跑，只是漏洞还在。
2. **把生产 Owner 口令从 `admin/admin` 改掉。** 第十一轮起新设口令必须通过策略（≥8 位、非常见口令、非用户名加数字），但按要求**不强制修改**已有口令，只在网页顶部弹弱口令提醒。登录后在「账户设置 → 修改口令」更换。
3. **轮换飞书 App Secret（如果还没换过）。** 第八轮接入时 Secret 曾在聊天里出现过。在飞书开发者后台重置后，同步更新 `/opt/jarvis/.env` 与本机 `.env` 的 `FEISHU_APP_SECRET`，再重启服务。
4. **开通飞书 `cardkit:card:write` 权限（推荐，可选）。** 第八轮上线时没开，流式卡片会自动降级成普通消息。开通后要在「版本管理与发布」重新发布一次。已开通的话删掉这条。
5. **可选：Tavily / PandaScore key。** 本机与生产都没配 `TAVILY_API_KEY`、`PANDASCORE_TOKEN`。不影响使用：搜索走 SearXNG → DDGS，电竞回退网页搜索。需要时把 key 注入两边 `.env`（不要提交），再跑 `scripts/search_smoke.py --live`。

## 需要外部条件

1. **微信语音消息的真实报文结构。** 生产 `journalctl -u jarvis-web | grep 'non-text probe'` 至今为空，iLink 语音结构仍未采到样本。收发两侧按可配置结构实现（`JARVIS_WECHAT_VOICE_*`，见 `.env.example`），识别不出时降级为「没听清」/纯文字。有人给机器人发一条语音后，按探针日志把配置或 `jarvis/wechat_voice.py` 顶部默认值一处改齐。
2. **微信主动推送（日程提醒 / 晨报 / Heartbeat）真机验证。** sendmessage 没有回复上下文，复用最近一条 `context_token`，需要真实联系人发「提醒发给我」绑定后观察一次。失败只记 WARNING 并降级，不影响正常收发。
3. **Chrome 私网访问（PNA）政策变化。** 网页唤起本机悬浮窗依赖 `Access-Control-Allow-Private-Network` 预检。如果 Chrome 改成强制用户授权，会多出一次授权弹窗，代码无需改动，留意即可。

## 技术债

1. **桌面端没有打包签名（dmg / exe）。** 未打包的 dev 版上 `jws://` 协议注册只是 best-effort；需要签名与公证链路，建议单独立项。
2. **飞书渠道后续项。** 语音消息（opus 转码后接百炼 ASR，需要真实样本）；日程提醒 / Heartbeat 推送到飞书（目前只推微信与桌面 / 网页）。
3. **LangGraph `create_react_agent` 已弃用**（V2.0 移除）。`jarvis/graph.py` 需要迁移到 `langchain.agents.create_agent`，升级 LangGraph 2.x 之前必须做。
4. **本机主 `.venv` 和 `requirements.lock` 不一致。** 缺 ddgs、trafilatura、lxml 等 21 个锁定包，langgraph / langchain-openai / typing-inspection 各低一个补丁版，cryptography 仍是 45.0.7。测试靠假实现兜底能通过，但会掩盖真实依赖问题。建议 `.venv/bin/pip install -r requirements.lock` 重新对齐。
5. **前端账户设置的报错文案。** 后端现在会返回具体原因（口令太弱、用户名已被占用、当前口令不对等）。前端创建用户失败时仍在后面拼「：用户名可能已被占用」，本地也只校验长度，应该改成直接展示接口返回的 `error`（`web-src/src/AccountSettings.jsx`）。
6. **`JARVIS_AGENT_WORKERS` 在 import 时读取**，早于 `run()` 里的 `load_env()`。本机直接跑 `jarvis-web` 时写在 `.env` 里不生效（生产经 systemd EnvironmentFile 注入，不受影响）。要修需要把线程池改成懒创建。
7. **Heartbeat 去重发生在模型生成之后**，每轮仍要调用一次模型。想进一步省钱，可以把最近 24 小时已推送的内容注入提示词，让模型直接回 PASS（要改 `server._heartbeat_compose`）。
8. **测试里约 20 条 sqlite 连接未关闭的 ResourceWarning**，来自测试创建、随后被回收的 Agent 检查点连接。不影响结果，生产单例 Agent 也不受影响。
