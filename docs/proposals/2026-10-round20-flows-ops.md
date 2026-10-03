# 第二十轮：流程接进对话与消息 · 让新手敢用 · 管理后台

> 契约文档：各代理按这里的接口与文件归属并行开发；要改契约先找主控，不要改别人的文件。

## 1. 用户诉求

用户选了三组：
1. **流程接进对话与消息**：对贾维斯说「跑一下我的早报流程」就能跑，飞书 / 微信里也行；流程能被**收到消息**或**一个链接**触发。
2. **让不懂技术的人敢用**：「发送前让我确认」节点；单独试跑一个节点；用某次的输入一键重跑。
3. **管理后台**：各账号用量与估算花费、流程运行与失败；每账号每日配额；失败与断线告警。

地基（主控已提交）：tenant schema **v8**（运行记录表重建：状态多 `waiting/rejected/expired`、加 `source`；新表 `tenant_flow_hooks`、`tenant_flow_approvals`、`usage_daily`、`tenant_quotas`、`admin_alerts`，见 `jarvis/tenancy.py` 的 `_schema_v8_statements`）；空实现 `jarvis/flows/approvals.py`、`jarvis/flows/hooks.py`、`jarvis/usage.py` 及接线（approvals / hooks 在 `flows.install` 里先于流程路由注册，usage 在 server.py 注册）；前端路由 `/approve/<id>`（`flows/Approve.jsx` 占位）、`/admin`（`admin/Admin.jsx` 占位，非 Owner 回 /app）及服务端 SPA 路径。

## 2. 运行来源与通用约定

- 运行记录 `source`：`manual`（流程页）/ `schedule` / `chat`（对话里叫跑）/ `message`（消息触发）/ `webhook`（链接触发）/ `rerun` / `test`（单节点试跑，不落运行记录也可）/ `resume`（确认后接着跑的那段，沿用原运行记录）。
- `FlowRuntime.run_headless(user_id, flow_id, inputs, *, source="schedule")` → `{status: ok|error|busy|waiting|quota, run_id, output: {text, links, page_url?}, error, approval?: {id, url, expires_at}}`。
- **文件输入**：开始节点的文件字段除 `{name, data_base64}` 外，还接受**文件空间里已有的文件**：`{file_id}`，或含「file_id=XXX」的附件标记文字（对话附件、重跑、链接触发都用它）；按当前账号 `files.resolve` 取，不重复存。
- 用量：流程入口先 `usage.check_flow_run(user_id)`（返回人话就拒跑：接口 429 / run_headless `status: "quota"`），跑完 `usage.record_flow_run(user_id, ok)`；AI 节点的模型调用包在 `usage.kind_scope("flow")` 里；一句话生成包在 `kind_scope("compose")`。
- 文案说人话，不出现 id、JSON、英文工具名；报错说清哪一步、怎么了、怎么改。

## 3. 发送前确认 / 单节点试跑 / 重跑（引擎代理）

### 3.1 确认节点 `approval`
- data：`title`、`message`（给确认人看的内容模板，可含变量，默认上游 text）、`editable: bool`（确认时能不能改内容，默认 true）、`timeout_hours`（1–72，默认 24）、`notify: {feishu, desktop}`（默认按账号送达设置）。
- 执行到它：渲染 `message` → 写 `tenant_flow_approvals`（pending，`state` 存恢复所需：已完成节点的产出、激活的边、输入、来源）→ 运行记录 `status=waiting` → 推通知「「流程名」有一步等你确认：…」附 `/approve/<id>`（绝对地址用 `JARVIS_PUBLIC_URL`）→ SSE 发 `{type: "node_wait", node_id, approval_id, url, expires_at}`，再 `run_done {status: "waiting", approval: {id, url, expires_at}}`。
- 同意：用（改过的）内容作为该节点产出 `text`/`items`，在后台从它的下游接着跑（`source` 记 `resume`，沿用同一运行记录），跑完推「流程已完成 / 没跑通」；拒绝：运行记录 `rejected`，下游不跑；超时：`expired`（后台定期清，或读取时惰性判定）。
- 同一账号一次只跑一条的闸（RunGuard）在等待期间**释放**；恢复时重新拿，忙就排队重试（最多等 5 分钟）。
- 接口：`GET /api/approvals?status=pending|all&limit=` → `{approvals: [{id, flow: {id, name}, run_id, node_id, title, preview, status, created_at, expires_at}], pending}`；`GET /api/approvals/{id}` → `{approval: {..., content, editable, next: [{title, node_type}], source}}`；`POST /api/approvals/{id}` `{decision: "approve"|"reject", content?, note?}`（CSRF）→ `{approval, run: {id, status}}`；只能处理自己的；已处理 / 过期回 409 人话。
- `GET /api/flows/{id}/runs/{run_id}` 单次运行详情（同列表项结构），确认页据此轮询「接着跑」的进度。

### 3.2 单节点试跑 `POST /api/flows/{id}/nodes/{node_id}/test`
- 请求 `{inputs?}`；上游产出取**最近一次运行**里各节点保存的产出（运行记录每个节点结果多存 `ctx`：text ≤ 20000 字、items、links、title），缺了就用 `inputs` 渲染开始字段，仍缺则报「先完整跑一次，或填上开始的输入」。
- 只跑这一个节点（不跑下游、不发飞书 / 微信这类有副作用的积木——这些积木试跑时只渲染要发的内容、不真的发，结果里注明「试跑不会真的发送」），返回 JSON `{status, ms, output: {text, items, links}, note, error}`；不占 RunGuard；记 `source=test` 的用量但不写运行记录列表。

### 3.3 重跑 `POST /api/flows/{id}/runs/{run_id}/rerun`
- 用那次运行保存的输入（文件字段存的是文件空间 id）再跑一遍，响应同 `/run` 的 SSE，`source=rerun`。运行记录的 `input` 里文件字段保存为 `{file_id, name}`（第十九轮已存原件）。

### 3.4 节点目录
- `GET /api/flows/nodes` 基础组加 `approval`（「发送前确认」）；`node_wait` 等新事件、`waiting` 状态写进运行记录与列表的 `last_run`。

## 4. 流程接进对话与消息（对话与触发代理）

### 4.1 对话里跑流程
- 新核心工具（`jarvis/tools/flows_tool.py`，加进 `TOOLS`，并加入 `BASE_TOOLS` 让智能体账号也有）：
  - `flow_list()`：列出我的流程（名字、一句话、要填什么、有没有定时），最多 20 条；
  - `flow_run(name, inputs)`：按名字（模糊匹配，多个相近先问清）跑，`inputs` 是 `{字段名或标签: 值}` 或一段文字（填第一个文字字段）；文件字段用对话里的附件标记；`source="chat"`；返回人话结果 + 结果网页 / 生成文件链接；`waiting` 时说「已经发给你确认了：链接」；`quota`/`busy`/`error` 都说人话。
- 提示词里加一句何时用它（`jarvis/prompts.py` 工具指引段）；工具芯片中文名「运行流程」「我的流程」（`tool_labels` 或现有的工具中文名映射）。飞书 / 微信 / 网页 / 语音入口都走同一个智能体，自然可用。

### 4.2 消息触发
- 设置：`GET /api/flows/{id}/hooks` → `{message: {enabled, channels: ["feishu","wechat"], match: "keywords"|"all", keywords: [...], input_field, last_hit_at} | null, webhook: {enabled, created_at, last_hit_at, url_hint} | null, channels: {feishu: {ready, reason}, wechat: {ready, reason}}}`；`PUT /api/flows/{id}/hooks/message` 同结构（关掉传 `enabled: false`）。关键词 ≤10 个、每个 ≤20 字；`all` 每个账号同一渠道只能有一条流程用。
- 执行：飞书 bridge 与微信回复路径在把消息交给对话前调 `hooks.handle_message(user_id, channel, text, attachments=...)`：命中就 `run_headless(..., source="message")`，把消息文字填进 `input_field`（附件标记填文件字段），返回要回复的文字（结果 + 链接；`waiting` 说等你确认）；没命中返回 None 照常对话。群聊只在被 @ 时生效（沿用现有规则）。

### 4.3 链接触发（webhook）
- `POST /api/flows/{id}/hooks/webhook`（CSRF）生成 / 重置令牌 → `{webhook, url}`（完整地址**只这一次**给，库里只存 sha256）；`DELETE` 关掉。
- 公开 `POST /api/hooks/{token}`：JSON `{inputs: {...}}`，或任意 JSON（顶层键能对上字段就按字段填，否则整段转文字填第一个文字字段）；≤256KB；每令牌每分钟 ≤30 次（429 人话）；最多等 30 秒：完成回 `{status, run_id, output}`，没完回 202 `{status: "running", run_id}`；令牌不对 404；流程被删 / 关掉 410。`source="webhook"`。

## 5. 用量、配额与告警（用量代理，`jarvis/usage.py`）

- **记账**：给模型调用挂回调（`jarvis/provider_runtime.py` 建模型处，按 bundle 的 user_id）读 `usage_metadata`（输入 / 输出 token）写 `usage_daily`（按本地日期，kind 取 `kind_scope` 当前值，默认 chat）；估算费用按环境变量 `JARVIS_PRICE_INPUT_PER_M` / `JARVIS_PRICE_OUTPUT_PER_M`（元 / 百万 token，默认按当前默认模型给个合理值并在后台注明「估算」）；流程运行与失败 kind=`flow_run`。写库批量 / 限频，不拖慢对话。
- **配额**：`tenant_quotas`（null = 用默认）；默认 `JARVIS_DEFAULT_DAILY_MODEL_CALLS`（默认 300）、`JARVIS_DEFAULT_DAILY_FLOW_RUNS`（默认 100）；Owner 不限。超了：对话入口（网页 / 桌面 / 飞书 / 微信 / 语音）回人话「今天的用量到上限了，明天再来，或请管理员调高」，流程入口见 §2。
- **告警**：定时流程被自动暂停（`jarvis/flows/schedule.py` 暂停处调 `usage.alert`）、飞书 / 微信长连接断开超过 5 分钟、某账号配额用尽、定时流程连续失败；写 `admin_alerts`，同类同账号 1 小时内合并，推给 Owner（Notifier 桌面通知 + 飞书若已绑定）。
- **接口**（仅 Owner，`/api/admin/*`；`/api/usage/me` 任意登录账号）：
  - `GET /api/admin/usage?days=7|30` → `{range, totals: {calls, input_tokens, output_tokens, cost_yuan, flow_runs, flow_failures, active_accounts}, daily: [{day, calls, tokens, cost_yuan, flow_runs, flow_failures}], by_kind: [{kind, label, calls, tokens, cost_yuan}], accounts: [{user_id, username, role, platform: {name, icon} | null, calls, tokens, cost_yuan, flow_runs, flow_failures, today: {calls, flow_runs}, quota: {daily_model_calls, daily_flow_runs, source: "custom"|"default"|"unlimited"}, last_active_at}], pricing: {input_per_m, output_per_m, note}}`
  - `PUT /api/admin/quotas/{user_id}` `{daily_model_calls: int|null, daily_flow_runs: int|null}` → `{quota}`
  - `GET /api/admin/alerts?limit=50` → `{alerts: [{id, kind, title, detail, owner: {id, username} | null, created_at, read}], unread}`；`POST /api/admin/alerts/read` `{ids?: [...], all?: true}`
  - `GET /api/usage/me` → `{today: {calls, flow_runs}, quota: {...}, remaining: {calls, flow_runs}}`

## 6. 前端

### 6.1 流程前端（`web-src/src/flows/**`）
- 画布：节点面板「基础」里的「发送前确认」节点；配置表单（显示的内容〔可插变量〕、允许修改、超时、通知方式）；节点卡等待态（「等你确认」+ 链接）；运行面板收到 `node_wait` 显示「已发给你确认」与「去确认」按钮。
- 配置面板「试跑这一步」按钮（§3.2），结果显示在「上次结果」页签旁，标「试跑」；有副作用的积木提示「试跑不会真的发送」。
- 运行记录抽屉每条「用这次的输入再跑」（§3.3）。
- 流程卡片菜单「触发方式」弹层：页签「定时」（现有 ScheduleSheet 内容）/「收到消息时」（渠道、全部或关键词、填进哪个输入、渠道没绑定灰显说明）/「通过链接」（生成 / 重置 / 关闭，地址只显示一次并可复制，附一段 curl 示例与说明）；卡片上显示已开的触发方式小标记。
- `/approve/<id>` 确认页（`flows/Approve.jsx`，手机优先）：流程名、哪一步、要发出去的内容（可改）、接下来会做什么、同意 / 拒绝（拒绝可填原因）、已处理 / 已过期的状态；同意后显示「接着在跑」并轮询运行详情直到完成，给结果链接。
- `/flows` 首页顶部「等你确认 · N」入口（有待确认时才出现），点开是列表。

### 6.2 管理后台前端（`web-src/src/admin/**`）
- `/admin`（仅 Owner）：顶部今日 / 近 7 天 / 近 30 天切换；概览卡（模型调用、token、估算花费、流程运行、失败率、活跃账号）；趋势图（自写 SVG，近 7 / 30 天每日调用与花费）；按类别分布（对话 / 流程 / 一句话生成 / 语音）；账号表（搜索、排序：用量、花费、失败；每行可改配额，弹层里「不限 / 用默认 / 自定义」）；告警列表（未读高亮、全部已读）；空状态与加载态；手机可用（账号表变卡片）。
- 入口：主应用头像菜单与 ⌘K「管理后台」（仅 Owner），市场头像菜单（Owner）「管理后台」。

## 7. 分工与文件归属

| 代理 | 拥有 | 不要碰 |
|---|---|---|
| 引擎（后端） | `jarvis/flows/{graph,executor,routes,store,nodes,steps,engine,page,approvals,__init__}.py`、相关测试 `tests/test_flow*.py`（新建 `tests/test_flow_approvals.py` 等） | hooks.py、usage.py、extras/compose/schedule/templates.py、前端 |
| 对话与触发（后端） | `jarvis/flows/hooks.py`、`jarvis/tools/flows_tool.py`、`jarvis/tools/__init__.py`（注册）、`jarvis/plugins/loader.py` 的 `BASE_TOOLS`、`jarvis/prompts.py`（工具指引）、飞书 bridge / 微信的消息分流处、server.py 里对应接线、`tests/test_flow_hooks*.py`、`tests/test_flows_tool*.py` | 引擎文件、usage.py |
| 流程前端 | `web-src/src/flows/**`（含 canvas 与 Approve.jsx） | 后端、admin/** |
| 用量（后端） | `jarvis/usage.py`、`jarvis/provider_runtime.py`（挂回调）、server.py 里对话入口的配额检查与 usage 接线、`jarvis/flows/schedule.py` 与 `compose.py` 各一两行（告警 / kind_scope）、渠道断线检测处一两行、`tests/test_usage*.py` | 引擎文件、hooks.py、前端 |
| 管理后台前端 | `web-src/src/admin/**`；为入口小改 `Hud.jsx`、`market/TopBar.jsx` / `Market.jsx`（只加菜单项） | flows/**、后端 |

## 8. 交付要求

- 只在自己的 worktree 分支提交（**每完成一块就 commit**），不 push，不提交 `jarvis/web/` 构建产物，不加新依赖（要加先问主控）。
- 全量 `pytest`（基线 1757）与 `npx vitest run`（基线 719）全绿；新逻辑有测试。
- 起本地服务联调用自己的端口（引擎 19001、对话与触发 19002、流程前端 19003、用量 19004、后台前端 19005），停服务用 `kill $(lsof -t -iTCP:<端口> -sTCP:LISTEN)`，不要 pkill。
- 截图放 `output/round20-<代理>/`；交付报告：做了什么、与契约的偏离、真联调结果、需要主控决定的事。
