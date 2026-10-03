# 第二十一轮：下线「我的流程」，专注个人助理（参考 Meta Muse / Manus Cue）

> 契约文档：各代理按这里的接口与文件归属并行开发；要改契约先找主控，不要改别人的文件。

## 1. 用户诉求

用户调研后判断：**手搭工作流（Dify / Langflow 式）已经过时**，删除「我的流程」，专注做**个人助理**，参考 2026-09 发布的 Meta Muse 与 Manus Cue 的设计理念优化。

## 2. 调研结论（设计原则）

| 来源 | 要点 | 我们怎么用 |
|---|---|---|
| Muse：长时任务 | 不是一问一答，而是替你**持续办事**；关掉 App 照跑，「做完回来告诉你」（[TechCrunch 9/8](https://techcrunch.com/2026/09/08/meta-debuts-its-muse-ai-agent-will-consumers-trust-it/)、[MarkTechPost](https://www.marktechpost.com/2026/09/08/meta-introduces-muse-a-personal-ai-agent-that-runs-on-its-own-dedicated-secure-cloud-computer/)） | **后台任务**：对话里一句话交代，服务器上跑完推通知 |
| Muse：同意分级 | **能撤回的直接做；难撤回的（发消息、下单）必须同意**；同意卡在**模型回复之外**由界面原生呈现，模型伪造不了（[ALM 指南](https://almcorp.com/meta-muse-complete-guide-personal-ai-agent/)） | **关键动作同意**：send / delete / spend 三类走 LangGraph interrupt + 原生同意卡 |
| Muse：活动记录 | 记录「正在做什么」与「你批准过的所有权限」，知道它动了什么、为什么 | **活动记录**页 |
| Muse：Goals / Ideas | Goals 页签记长期目标、策略、到哪一步；Ideas 页签放它主动想到的建议；**只在值得打扰时才推**，频率可调 | **目标**与**想法**两个页签 |
| Muse：用量表 | 免费额度用多少一目了然 | 复用第二十轮的 `/api/usage/me` 显示「今日剩余」 |
| Cue：数字员工 | 每个 Agent 有自己的邮箱、手机号、钱包、电脑，预算内付款，接电话留摘要，多个 Agent 群聊分工（[Implicator](https://www.implicator.ai/manus-cue-agents-phone-numbers-wallets/)、[Manus 2.0](https://manus.im/blog/introducing-manus-2-0)） | 本轮：助理在飞书 / 微信里的身份已有；**自动化**由事件触发。下一阶段：助理邮箱、云端浏览器、多助理协作 |
| Cue：Automations | 定时任务 + 由邮件、日历、消息等事件触发 | **自动化**：一句话建「每天 8 点…」「收到某人消息就…」「日程开始前…」 |
| Cue 的安全教训 | 邮件里的提示词注入曾能拿到连接应用的凭据 | 外部内容一律当数据；由外部事件触发的后台任务，任何 send / delete 动作都必须同意 |

**本轮不做（下一阶段）**：助理自己的邮箱（IMAP 收信转任务）、服务器端浏览器（Muse Secure VM 式：开网页、填表）、多助理群聊分工、预算内付款。

## 3. 下线「我的流程」（清理代理）

- 前端：删 `web-src/src/flows/**`（Flows、canvas、模板、一句话生成、触发方式、运行记录、旧 Approve 页等）、`/flows` 路由与入口（App、Hud 菜单与 ⌘K、市场头像菜单、智能体主页 PlatformHome / usePlatform 里的「我的流程」、toolInfo 的 flow 两项、tours 里 flows-home / flows-editor 两套）、`@xyflow/react` 依赖；管理后台里「流程运行」改叫「后台任务」（数据仍读 `flow_runs` 字段，契约 §9 的接口名不变）。
- 后端：删 `jarvis/flows/**`、`jarvis/tools/flows_tool.py`（并从 `TOOLS`、`BASE_TOOLS` 去掉 flow_list / flow_run）、kind=step 的积木插件包（ai_extract、feishu_doc、feishu_send、input_file、input_text、split_file、to_todo、web_page、wechat_send）及职业里的流程模板、飞书 / 微信里的流程消息触发接线、server.py 的 flows.install / 定时调度 / 公开结果页 `/r/<token>`（结果页同时下线）、提示词里关于流程的话；`usage` 的流程计数改名为「后台任务」口径（函数保留别名，见 §5.5）。
- 数据：**不删表**（`tenant_flow*` 原样留在库里，可随时找回）；不写破坏性迁移。
- 测试：删 `tests/test_flow*.py`、`tests/test_flows*.py`，改相关断言（插件数、工具数、市场目录等）。

## 4. 数据（tenant schema v9，主控已建，见 `jarvis/tenancy.py` `_schema_v9_statements`）

- `tenant_tasks`：后台任务（status：queued / running / waiting / done / failed / cancelled；source：chat / automation / goal / ui；`thread_id` 为任务专属对话线程；`plan` 为步骤 JSON；`result`、`links`、`error`；`automation_id`、`goal_id`）。
- `tenant_activity`：活动记录（kind：tool / consent / task / automation / message；risk：read / write / send / delete / spend；status；task_id；thread_id；tool；title；summary；detail JSON）。
- `tenant_consents`：待同意的动作（thread_id、task_id、channel、tool、risk、title、preview、args、editable、status、note、created / expires / decided）。
- `tenant_automations`：自动化（title、instruction、trigger JSON、enabled、next_run_at、last_run_at、last_status、last_task_id）。
- `tenant_goals`：目标（title、why、strategy、stage、progress 0–100、status、deadline、check_in JSON、notes JSON）。
- `tenant_ideas`：想法（title、body、reason、source、action、score、pushed、dismissed_at、acted_at）。

## 5. 后台任务与自动化（任务代理，`jarvis/tasks/**`、`jarvis/tools/task_tools.py`）

### 5.1 执行
- `start_task(user_id, goal, title, source, origin_thread)` 入队；执行池（每账号同时 1 个、全局 ≤4）用该账号的运行时（`with bundle_for(uid) as bundle`）跑**任务模式**：专属线程 `task-<id>`、递归上限放宽到 60、整条 ≤15 分钟；任务模式提示词要求先用内部工具 `task_plan(steps)` 写 3–7 步计划，每完成一步 `task_step(index, status, note)`；最后给结果（Markdown + 链接）。
- 过程写活动记录（`activity.callbacks(...)` 挂在 invoke 的 config 上）；`plan` / 状态实时写表；`GET /api/tasks/{id}/stream` SSE 推 `{type: "plan"|"step"|"activity"|"status"|"result", …}`。
- **停在同意**：任务里调到需要同意的工具时图会 interrupt（§6），任务记 `waiting`、发同意通知；同意代理在用户决定后调 `tasks.on_consent_decided(consent)`，任务代理用 `Command(resume=…)` 接着跑（重新进执行池）。
- 中途：`POST /api/tasks/{id}/cancel`；`POST /api/tasks/{id}/message {text}`（补一句话改方向：追加到任务线程，下一步生效）。
- 跑完：`done` / `failed`，按账号送达设置推「交代的事办好了：…」（Notifier；飞书 / 微信渠道发起的任务回到原渠道），链接回任务详情 `/app?task=<id>`。
- 用量：入口 `usage.check_flow_run`（超了不开跑，说人话），结束 `usage.record_flow_run(ok)`；模型调用包 `usage.kind_scope("task")`（线程池里在任务函数内部包）。

### 5.2 接口
- `GET /api/tasks?status=&limit=` → `{tasks: [{id, title, goal, status, source, progress: {done, total}, created_at, finished_at, automation: {id, title}|null}], running}`
- `POST /api/tasks {goal}`（CSRF）→ `{task}`；`GET /api/tasks/{id}` → `{task: {..., plan: [{index, text, status: todo|doing|done|skipped, note}], result, links, error, consents: [pending…]}, activity: [...]}`；`/stream`、`/cancel`、`/message` 见上。
- 自动化：`GET /api/automations`、`POST /api/automations {title?, instruction, trigger}`、`PUT /api/automations/{id}`（含 enabled）、`DELETE /api/automations/{id}`、`POST /api/automations/{id}/run`（立刻跑一次）。`trigger`：`{kind: "schedule", repeat: "daily"|"weekdays"|"weekly", time: "HH:MM", weekday?}`（工作日跳法定节假日——从 git 历史里 `jarvis/flows/schedule.py` 的算法搬到 `jarvis/tasks/`）｜`{kind: "message", channel: "feishu"|"wechat", from?: "联系人", keywords?: [...]}`（收到匹配的消息时把消息当输入开后台任务；由外部消息触发的任务里 send / delete 一律要同意）｜`{kind: "calendar", minutes_before: 30}`（日程开始前 N 分钟，用日程内容开任务，如「会前把相关资料整理给我」）。视图带 `label`（「每个工作日 08:00」「收到张三的飞书消息」「日程开始前 30 分钟」）。
- 渠道：飞书 bridge / 微信回复路径里，消息自动化在进入对话前判断（只做「是否命中 → 开后台任务并回一句『收到，在办了』」），接线要小。

### 5.3 对话里的工具（加进 `jarvis/tools/task_tools.py` 的 `TOOLS`，并把名字加进 `jarvis/plugins/loader.py` 的 `BASE_TOOLS`）
- `task_start(goal, title?)`：要好几步、要等的事交给后台（「我在后台办，好了告诉你」）；`task_status(query?)`：进行中 / 最近的任务；`automation_add(instruction, when)`：一句话建自动化（when 是人话，工具里解析成 trigger；解析不了就问）；`automation_list()`；`automation_remove(name)`。提示词里写清什么时候该转后台（多步、要查很多、要等外部结果），简单的事当场做。

## 6. 关键动作同意与活动记录（同意代理，`jarvis/consent.py`、`jarvis/activity.py`）

### 6.1 风险分级
- `read`：查询类（时间、天气、搜索、读网页、列表、读文件、翻旧账…）；`write`：能撤回的写（记备忘、加待办 / 日程、记住偏好、生成文件、开始会议纪要…）——**都不用同意**；
- `send`：替你把内容发给别人（飞书 / 微信发给他人或群、发邮件、对外发布）；`delete`：删数据（删备忘 / 日程 / 记忆、删文件、清空…）；`spend`：花钱（本轮没有，预留）——**都要同意**。
- 盘点全部核心工具与插件工具（含 MCP：没声明的按工具名 / 描述推断，拿不准按 write；插件 plugin.json 可声明 `risk`），给出表；`risk_of(name)`、`needs_consent(name)`。

### 6.2 机制
- `guard_tools(tools, user_id)` 给需要同意的工具包一层：执行前生成 / 复用一条 `tenant_consents`（id 由 thread_id + tool_call_id 确定，恢复执行时不重复建），`decision = interrupt({"type": "consent", "consent_id": …})`；同意 → 用（可能改过的）参数执行；不同意 → 返回「用户没同意，这一步没做」让模型如实告知；超时（默认 24 小时）→ expired。在 `jarvis/graph.py` 的 `build_agent` 里接上（所有入口自然生效）。
- **`heal_dangling_tool_calls` 必须跳过「停在同意」的线程**（它们恰好处于「AI 已声明 tool_calls、工具结果未写回」状态），否则会把待同意的调用当坏数据清掉。
- 前台对话（网页 / 桌面 SSE）：本轮回复结束时若停在同意，SSE 推 `{type: "consent", consent: {id, tool, risk, title, preview, fields: [{key, label, value, multiline}], expires_at}}` 后结束；用户在**原生同意卡**里决定 → `POST /api/consents/{id} {decision: "approve"|"reject", edits?: {key: value}, note?}`：对话线程的返回 `text/event-stream` 接着输出这轮回复（与 `/api/chat` 同格式），后台任务的返回 JSON 并调 `tasks.on_consent_decided`。
- 渠道（飞书 / 微信 / 语音）：停在同意时回复「这一步要你确认：<链接 /approve/<id>>」，网页上决定后把接着跑的结果推回原渠道。
- 同意通知：后台任务 / 渠道触发的同意按账号送达设置推（绝对链接用 `JARVIS_PUBLIC_URL`）；`GET /api/consents?status=pending`、`GET /api/consents/{id}`。
- 提示词：说明「发消息 / 删除这类动作系统会弹确认卡，你照常调用工具，不要自己在文字里要求用户回复『确认』」。

### 6.3 活动记录
- `activity.callbacks(owner_id, thread_id, task_id)`：LangChain 回调记录每次工具开始 / 结束（工具中文名、参数摘要、结果摘要、用时、成败、risk）；同意的创建 / 决定、任务开始 / 结束也记。前台对话、渠道、后台任务、自动化都要挂上（在 server.py / 渠道 / provider 里找统一入口，接线最小）。
- `GET /api/activity?kind=&task_id=&days=&limit=&cursor=` → `{items: [{id, at, kind, risk, status, title, summary, tool, task: {id, title}|null, where: "对话"|"后台任务"|"自动化"|"飞书"|"微信"}], next}`；只看自己的；保留 90 天（惰性清理）。摘要里不放密钥、长文截断。

## 7. 目标与想法（目标代理，`jarvis/goals.py`、`jarvis/tools/goal_tools.py`、`web-src/src/goals/**`）
- 目标：`GET/POST/PUT/DELETE /api/goals`；字段见 §4；对话工具 `goal_add(title, why?, deadline?)`、`goal_update(title, stage?, progress?, note?, status?)`、`goal_list()`；新建时由模型起草「策略」（3–5 条），用户可改；回访：按 `check_in`（如每周日晚）开一个 `source="goal"` 的后台任务（调 `tasks.start_task`）或推一条提醒问进度；目标进展写 `notes`。
- 想法：后台每天 1–2 次（不在免打扰时段）用模型根据记忆、目标、近期日程 / 待办 / 对话主题生成 0–3 条建议（`title`、`body`、`reason`「为什么想到这个」、`action`「可以直接交给我办的一句话」、`score` 0–100）；`score` 达到阈值且没超频率才推送（`tenant_prefs` 键 `ideas_level`：少 / 适中 / 多，默认少）；`GET /api/ideas`、`POST /api/ideas/{id}/dismiss`、`POST /api/ideas/{id}/act`（=`tasks.start_task(action)`）、`GET/PUT /api/ideas/prefs`。与现有心跳（`jarvis/heartbeat.py`）不重复推送：想法上线后心跳只保留 HEARTBEAT.md 清单功能。
- 前端：`GoalsTab`（目标卡：标题、为什么、策略、阶段、进度条、最近进展、下次回访；新建 / 编辑 / 完成 / 放弃）与 `IdeasTab`（建议卡：为什么想到、「交给贾维斯」「不感兴趣」；打扰频率设置），由任务中心渲染。

## 8. 前端：任务中心、同意卡、活动记录（前端代理）
- 入口：主应用顶栏一个「任务」按钮（有进行中 / 待同意时带数字）、头像菜单与 ⌘K「任务中心」「活动记录」；今日板加「进行中的任务」小卡。
- `TaskCenter`（`web-src/src/tasks/**`）：页签「任务 / 自动化 / 目标 / 想法 / 活动记录」（目标、想法由 `../goals/` 提供）。
  - 任务：列表（进行中、等你确认、已完成、失败），详情：交代的话、计划清单逐步打勾（实时 SSE）、过程（活动时间线，可展开）、结果（Markdown 安全渲染 + 链接）、停止、「补一句」；新建任务输入框（「交给贾维斯：……」）。
  - 自动化：卡片（人话触发条件、上次结果、下次时间、开关、立刻跑一次、删除）；新建用一句话（走 `automation_add` 的同款解析接口或直接表单）。
  - 活动记录：按天分组的时间线（图标按 kind / risk，同意记录高亮），筛选（全部 / 需要同意的 / 后台任务 / 对话）。
- **同意卡**（`web-src/src/consent/ConsentCard.jsx`）：对话流里收到 `consent` 事件时由界面渲染（不是模型文字）：动作图标与风险标签（发消息 / 删除）、给谁、内容（可改的字段）、「同意」「不同意」；同意后接着流式显示回复；在任务详情里同样出现。`/approve/<id>`（`consent/ConsentPage.jsx`）手机优先。
- 用量表：任务中心底部或头像菜单显示「今日还能用 N 次」（`/api/usage/me`，管理员不显示）。
- 新手引导：`web-src/src/tour/tours.js` 的 `app` 引导加一步介绍「任务」按钮（清理代理负责删掉流程那两套）。

## 9. 分工与文件归属

| 代理 | 拥有 | 不要碰 |
|---|---|---|
| 清理 | 删除 §3 列的所有文件与接线；改 `jarvis/server.py` 里流程相关段、`jarvis/tools/__init__.py` 的 flows 部分、`jarvis/plugins/loader.py` BASE_TOOLS 里 flow 两项、`jarvis/plugins/__init__.py`（职业流程模板）、`jarvis/prompts.py` 流程段、飞书 bridge / 微信里流程钩子、`jarvis/usage.py` 的标签、`web-src/src/flows/**`、App / routes 的 /flows、Market / TopBar / PlatformHome / usePlatform / toolInfo / tours 的流程部分、`web-src/src/admin/**` 文案、`web-src/package.json`、相关测试、README 以外的 docs 由主控改 | 新模块（tasks / consent / activity / goals / tasks 前端） |
| 任务 | `jarvis/tasks/**`、`jarvis/tools/task_tools.py`、`jarvis/prompts.py` 任务段、渠道里消息自动化的最小接线、`tests/test_tasks*.py` | consent.py / activity.py / goals.py、前端 |
| 同意与活动记录 | `jarvis/consent.py`、`jarvis/activity.py`、`jarvis/graph.py`（guard_tools、heal 跳过）、server.py 对话 SSE 的 consent 事件与恢复、渠道里同意链接与结果回推、`jarvis/prompts.py` 同意段、`tests/test_consent*.py`、`tests/test_activity*.py` | tasks / goals、前端 |
| 前端 | `web-src/src/tasks/**`、`web-src/src/consent/**`、`Hud.jsx` / `Chat.jsx` / 今日板 / `api.js` 的接入、`tour/tours.js` 加一步 | `web-src/src/goals/**`、后端 |
| 目标与想法 | `jarvis/goals.py`、`jarvis/tools/goal_tools.py`、`jarvis/heartbeat.py`（去重）、`web-src/src/goals/**`、`tests/test_goals*.py` | 其他 |

## 10. 交付要求
- 只在自己的 worktree 分支提交（**每完成一块就 commit**），不 push，不提交 `jarvis/web/`，不加新依赖（清理代理删依赖除外）。
- 全量 `pytest` 与 `npx vitest run` 全绿（清理代理删测试后基线会下降，以各自交付时的数为准，报告里写明）。
- 本地联调端口：清理 19031、任务 19032、同意 19033、前端 19034、目标 19035（本机 19001–19005 被 easytier 占用）；停服务用 `kill $(lsof -t -iTCP:<端口> -sTCP:LISTEN)`；scratchpad 里用自己的子目录（`scratchpad/r21-<代理>/`），不要动别人的文件。
- 截图放 `output/round21-<代理>/`；交付报告：做了什么、与契约的偏离、真联调结果、需要主控决定的事。
