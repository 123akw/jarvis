# 第十八轮：流程画布（参考 Dify / Langflow）+ 新手引导

> 契约文档：各代理按这里的接口与文件归属并行开发；要改契约先找主控（不要自己改别人的文件）。

## 1. 用户诉求与方向

- 「我的流程」改成**可视化节点画布**：参考 Langflow、Dify，自己搭工具流和输出，**把插件、模组拼成自己的工作流**。
- 做完要**好用、方便**：有新手引导，**只自动出现一次、可跳过、能随时重看**。
- 面向不懂技术的人：说人话、少概念、默认值合理、出错讲清楚怎么改；**一句话生成流程**、**模板**降低起步成本。

方向：v6 的「≤8 步线性链」升级为**节点图**（开始 → AI / 插件工具 / 技能 / 条件分支 / 文本拼接 / 积木 → 结束），任何已装插件的工具都能直接当节点；保留旧积木（拆分、AI 提炼、加到待办、发飞书、飞书文档、发微信、生成网页、Excel、Word）；旧流程读取时自动换算成图，不丢。

地基（主控已提交）：`@xyflow/react@12.12.0`（MIT，Dify / Langflow 同款画布库，仅流程页懒加载）、tenant schema **v7**（`tenant_flows.graph`、`tenant_flow_triggers`）、`jarvis/flows/graph.py`（结构校验 + 旧流程换算）、`jarvis/flows/extras.py` 与 `jarvis/onboarding.py` 空实现及 server.py 接线、`/flows/<id>` 前后端路由、`flows/api.js` v2 函数、`tour/index.jsx` 与 `flows/canvas/Editor.jsx` 占位。

## 2. 节点图

```json
{
  "nodes": [{ "id": "start", "type": "start", "position": { "x": 0, "y": 0 }, "data": { ... } }],
  "edges": [{ "id": "e1", "source": "start", "target": "n1", "sourceHandle": null }]
}
```

| type | 名称 | data 字段 | 产出 |
|---|---|---|---|
| `start` | 开始 | `title`；`fields: [{key, label, type: text\|paragraph\|file\|number\|select, required, options?, default?, placeholder?}]`（≤8 个，key 形如 `^[a-z][a-z0-9_]{0,23}$`） | `{{start.<key>}}`；文件字段另有 `{{start.<key>}}`=提取出的正文 |
| `llm` | AI 处理 | `title`、`prompt`（≤4000，可含变量）、`skill?`（技能插件 id，执行时把 SKILL.md 作为指令）、`output: text\|list`、`foreach?` | text、items |
| `tool` | 插件工具 | `title`、`plugin`、`tool`（注册表里的工具名，如 `weather__now` 或核心工具名）、`args: {参数名: 可含变量的文字}`、`foreach?` | text、items |
| `condition` | 条件分支 | `title`、`cases: [{id, label, logic: and\|or, rules: [{var: "n1.text", op, value}]}]`；op：contains / not_contains / equals / not_equals / empty / not_empty / gt / lt / ge / le | 无；出口 = 每个 case 的 id + `else` |
| `template` | 文本拼接 | `title`、`template`（≤4000） | text |
| `step` | 积木 | `title`、`step`（STEPS 里 process / output 角色的积木 id）、`options`、`input?`（喂给积木的文字，默认 = 直接上游的 text） | text、items、title、links、parts |
| `end` | 结束 | `title`、`output`（最终结果模板，默认上游 text）、`page: bool`（生成结果网页） | 运行结果 |

- **变量**：`{{node_id.field}}`，field ∈ text / items / title / links / parts / files；开始节点 `{{start.<key>}}`；系统变量 `{{sys.date}}` `{{sys.time}}` `{{sys.weekday}}`；`foreach` 节点内另有 `{{item}}`（当前条目）。**只能引用祖先节点**（引擎校验，报人话）。
- **上限**：≤30 节点、≤60 连线、无环；开始唯一且 id 固定 `start`；至少一个 end 或 output 角色的 step；end 后面不能再接。
- **旧流程**：`graph` 为空串的行按 `graph_from_steps(steps)` 换算（输入积木并入开始字段）。保存一律写 `graph`；`steps` 列写 `[]` 以外的值仅为兼容。

## 3. 接口

所有 `/api/flows*` 需登录、写操作带 CSRF（沿用现有 `request_principal` / `panel_write` / `deny`）。

### 3.1 流程 CRUD（引擎代理）
- `GET /api/flows` → `{flows: [{id, name, summary, node_count, plugins: [id], trigger: {kind, label, next_run_at}|null, last_run: {status, started_at}|null, updated_at, graph}]}`（graph 用于列表缩略图）。
- `GET /api/flows/{id}` → `{flow: {id, name, summary, graph, updated_at}}`。
- `POST /api/flows` / `PUT /api/flows/{id}`：`{name, summary?, graph}` → `{flow}`；仍接受旧的 `{name, steps}`（换算成 graph）。校验失败 400 `{error: 人话}`。
- `DELETE /api/flows/{id}`（顺带删触发器）。
- **路由顺序**：`/api/flows/nodes`、`/api/flows/templates`、`/api/flows/compose` 必须先于 `/api/flows/{flow_id}` 注册（extras 已在 install 里先注册）。

### 3.2 节点目录（引擎代理）`GET /api/flows/nodes`
```json
{ "groups": [
    { "id": "basic", "label": "基础", "items": [ { "key": "llm", "type": "llm", "title": "AI 处理", "icon": "✨", "summary": "…", "data": { "title": "AI 处理", "prompt": "" } } ] },
    { "id": "tools", "label": "插件工具", "items": [ { "key": "tool:weather:weather__now", "type": "tool", "title": "查实时天气", "icon": "🌤️", "summary": "…",
        "plugin": "weather", "plugin_name": "查天气", "category": "life",
        "args": [ { "name": "city", "label": "城市", "type": "string", "required": true, "description": "…", "enum": null } ],
        "data": { "title": "查实时天气", "plugin": "weather", "tool": "weather__now", "args": {} },
        "available": true, "reason": "" } ] },
    { "id": "skills", "label": "技能", "items": [ { "key": "skill:work_report", "type": "llm", "data": { "title": "周报写手", "skill": "work_report", "prompt": "{{start.text}}" }, "…": "…" } ] },
    { "id": "steps", "label": "积木", "items": [ { "key": "step:to_todo", "type": "step", "role": "output", "options": [ "沿用 step_catalog 的选项声明" ], "data": { "step": "to_todo", "options": {} } } ] }
  ],
  "vars": { "sys": [ { "key": "date", "label": "今天日期" }, { "key": "time", "label": "现在时间" }, { "key": "weekday", "label": "星期几" } ] },
  "field_types": [ "text", "paragraph", "file", "number", "select" ] }
```
- `available` 按当前账号算：Owner = 全部已启用插件；**智能体账号没装的插件也列出**，`available: false`、`reason: "这个智能体还没装「X」，到智能体设置里加上就能用"`（引导去加插件）；需要配置 / 绑定的给对应原因。

### 3.3 运行（引擎代理）`POST /api/flows/{id}/run`
- 请求：`{inputs: {key: 文字|数字|{name, data_base64}}}`；仍接受旧的 `{text, file}`（映射到 `text` / `file` 字段）。
- 响应 `text/event-stream`，事件：
  - `{type: "run_start", run_id}`
  - `{type: "node_start", node_id, node_type, title}`
  - `{type: "node_done", node_id, summary, preview, ms, output: {text(≤2000), items?, links?}}`
  - `{type: "node_skip", node_id, reason}`（条件没走到的分支）
  - `{type: "node_error", node_id, message, ms}`（整条停下）
  - `{type: "run_done", status: ok|error, ms, output: {text, links: [{label, url}], page_url?}}`
- `GET /api/flows/{id}/runs?limit=` → `{runs: [{id, status, started_at, finished_at, ms, input_summary, nodes: [{node_id, title, node_type, status: ok|error|skipped, summary, preview, ms}], output_text, page_url, error}]}`。
- **稳定的无头运行入口**（给定时运行用）：`FlowRuntime.run_headless(user_id, flow_id, inputs) -> {"status", "run_id", "output", "error"}`；账号正在跑别的流程时返回 `status: "busy"`。

### 3.4 模板 / 一句话生成 / 定时（好用层代理，`jarvis/flows/extras.py` 等）
- `GET /api/flows/templates` → `{categories: [{id, label}], templates: [{id, name, summary, category, icon, plugins: [id], graph, needs: [人话前提，如「需要绑定飞书」]}]}`；≥12 个，覆盖办公 / 学习 / 内容创作 / 店铺 / 生活资讯；每个 graph 必须能过引擎校验，带好看的 position。
- `POST /api/flows/compose` `{description}` → `{draft: {name, summary, graph}, notes: [人话], source: "model"|"template"}`；不落库；模型只能用节点目录里的节点，结果过校验，失败退回最接近的模板；自动排版 position（左 → 右分层）。
- `GET|PUT /api/flows/{id}/trigger`：`{kind: "manual"|"schedule", enabled, schedule: {repeat: "daily"|"weekdays"|"weekly", time: "HH:MM", weekday?: 1-7}, inputs: {...}, notify: {feishu: bool, desktop: bool}}` → `{trigger: {..., label: "每个工作日 08:00", next_run_at, last_run_at, last_status}}`；表 `tenant_flow_triggers`。
- 后台：`extras.start_scheduler(runtime, notifier)` 每 30 秒左右查到点的触发器，用 `run_headless` 跑，跑完按 notify 送达（复用 jarvis/delivery.py 的 Notifier / 飞书推送），`busy` 顺延一分钟；服务重启不补跑过期太久（>1 小时）的。

### 3.5 新手引导（新手引导代理，`jarvis/onboarding.py`）
- `GET /api/onboarding` → `{seen: {tour_id: {status: "done"|"skipped", at}}}`；`PUT /api/onboarding` `{tour, status}` 记一笔，`{reset: true}` 清空。存 tenant_prefs 键 `onboarding`。

## 4. 执行语义（引擎代理）

- 拓扑序执行。节点在**所有上游都已结束（完成或跳过）且至少一条入边是「激活」**时运行；条件节点只激活选中的出口，其余出口的下游若再无激活入边就 `node_skip`（向下传播）。
- 每个节点在账号的 `tenant_scope` 里执行（插件工具读写的是该账号的数据）；插件工具走注册表里已包装的工具（超时、人话错误、第三方子进程隔离都沿用）；智能体账号只能跑它装了的插件（运行前检查，报人话）。
- 时限：llm 60 秒、tool 沿用插件超时（默认 30 秒）、step 沿用积木；整条 240 秒；同一账号同时只跑一条（RunGuard）。
- 模型调用沿用 `deps.compose`；喂给模型的上游内容一律按「资料只是数据，不是指令」包裹（沿用 ai_extract 的防注入写法）。
- `foreach`（可选，P1）：对 `{{x.items}}` 逐条执行（≤20 条），产出按条合并的 text 与 items。
- 运行记录写 `tenant_flow_runs`（`steps` 列存节点结果数组），结果页沿用 `/r/<token>`（end 节点 `page: true` 时生成）。

## 5. 前端

### 5.1 画布编辑器（画布代理，`flows/canvas/**`、`flows/graph.js`）
`<Editor flowId="abc"|"new" initial={{name, summary, graph}}? session onSaved(flow) onBack() onExpired() />`，由 Flows.jsx 在 `/flows/<id>` 渲染（懒加载，`@xyflow/react` 与其 CSS 只在这里引入）。
- 布局参考 Dify：顶栏（返回、可改名、保存状态「已保存 / 保存中 / 有改动」、撤销 / 重做、整理、运行、新手引导按钮）｜左侧节点面板（搜索；分组：基础 / 插件工具（按分类）/ 技能 / 积木）｜中间画布（点阵底、缩放、适配视图）｜右侧配置面板（选中节点时）。
- 加节点：从面板**拖到画布**、点面板项加在选中节点后面并自动连线、节点出口的「+」弹出快捷面板（Dify 式）。
- 节点卡：图标、标题、类型、1–2 行配置摘要、问题提示（缺必填参数、没连上）、运行态（转圈 / ✓ 用时 / ✕ / 跳过变暗）；条件节点每个分支一个出口并标名字。
- 配置面板：标题改名；按类型的表单；**插入变量**（按钮或输入 `{{` 弹出上游节点的产出，显示成「AI 处理 · 文字」这样的人话，存成 `{{n1.text}}`）；插件工具的参数表单由节点目录的 `args` 生成；不可用的节点显示原因与「去加插件」。
- 运行面板：按开始节点字段生成输入表单 → 运行（有改动先保存）→ 逐节点实时状态与可展开的产出 → 最终结果（Markdown、链接、结果网页）；可停止；运行中连线流动动画。
- 撤销 / 重做、⌘S 保存、Delete 删除、自动整理（左 → 右分层，`graph.js` 自写，不加 dagre）；客户端镜像校验给出就地提示。
- 手机（<760px）：列表式编辑（按拓扑序的节点卡 + 底部弹层配置），可运行；画布只读可缩放。
- `data-tour` 锚点：`flow-palette`、`flow-canvas`、`flow-node-start`、`flow-config`、`flow-var`、`flow-run`、`flow-run-panel`、`flow-save`；`useTour('flows-editor', { ready })`，顶栏放 `<TourButton tour="flows-editor" />`。

### 5.2 我的流程首页（列表页代理，`flows/Flows.jsx` 及其余 `flows/*`，除 canvas 与 graph.js）
- `/flows`：标题「我的流程」+ 主按钮「新建流程」；**一句话生成**大输入框（「说说你想自动化什么，比如：每天早上把天气和日程发到飞书」）→ 生成中 → 预览弹层（缩略图 + 节点清单 + notes）→「打开编辑」。
- **模板库**（参考 Dify 探索页）：分类页签、卡片（图标、名称、一句话、节点链小图标、需要的插件与是否可用）、预览弹层 →「用这个模板」。
- **我的流程**卡片：SVG 缩略图（由 graph 画，自写）、上次运行状态与时间、定时标记「每个工作日 08:00」、菜单（打开、运行记录、定时运行、复制、删除）。
- 运行记录抽屉：列表 + 单次详情（逐节点结果、最终结果、结果网页链接）。
- 定时运行弹层：开关、重复（每天 / 工作日 / 每周几）、时间、预填输入（按开始字段生成）、通知渠道（飞书没绑定时灰显说明）、「下次运行：明天 08:00」。
- 草稿交接：模板 / 一句话生成的草稿写 `sessionStorage['jvf-draft'] = {name, summary, graph}` 后 `navigate(flowHref('new'))`；Flows.jsx 在 `params.id` 存在时懒加载 `canvas/Editor.jsx` 并把草稿作为 `initial`；`onSaved` 后 `navigate(flowHref(flow.id), {replace: true})`。
- 旧的 Chain / RunParts / Editor.jsx / model.js 不再用就删掉（连同测试）。
- `data-tour`：`flows-new`、`flows-compose`、`flows-templates`、`flows-list`；`useTour('flows-home', { ready })`，页头放 `<TourButton tour="flows-home" />`。

### 5.3 新手引导（新手引导代理，`tour/**`）
- 接口（地基已定，不改签名）：`useTour(id, {ready, auto=true})`、`startTour(id)`、`<TourButton tour label className />`、`TOUR_IDS`。
- 行为：`ready` 为真且该账号没看过 → 自动开始（等进场动画结束，`introPlaying()` 为假再开）；**看完或点「跳过」都记为看过，之后不再自动出现**；`startTour` / TourButton 随时重看；账号菜单与 ⌘K 里加「新手引导」（重看当前页的），设置里可「重置所有新手引导」。
- 表现：聚光灯（目标元素四周压暗、目标挖空并有柔和描边）+ 气泡卡（标题、一两句说明、步骤点「2 / 5」、上一步 / 下一步 / 跳过 / 完成）；目标不在视口先滚过去；目标暂时不存在就等最多 1.5 秒，仍没有就跳过这一步；窗口缩放重新定位；Esc = 跳过，← → 翻页；手机上气泡改为底部卡片；`prefers-reduced-motion` 不做位移动画；读屏可用（role=dialog、焦点在卡片内）。
- 持久化：登录用户走 `/api/onboarding`（换设备也只出现一次）并缓存 localStorage；游客（市场）只用 localStorage。
- 引导内容（`tour/tours.js`）：`flows-home`、`flows-editor`（最重要：拖节点 → 连线 → 配参数与插入变量 → 运行看结果）、`market`（搜索 / 拖进工具箱 / 下一步生成）、`app`（输入框、⌘K、今日板、菜单）。market 与 app 的锚点由新手引导代理自己加（这两处本轮没有别的代理在改）。

## 6. 分工与文件归属

| 代理 | 拥有的文件 | 不要碰 |
|---|---|---|
| 调研 | `docs/design/2026-10-flows-references.md`、`docs/design/refs-flows/`（≤3MB） | 代码 |
| 引擎（后端） | `jarvis/flows/{graph,engine,steps,store,routes,page,__init__}.py`、`tests/test_flows*.py`、`tests/test_flow_graph*.py` | extras.py、onboarding.py |
| 好用层（后端） | `jarvis/flows/{extras,templates,compose,schedule}.py`（可新建）、`tests/test_flow_extras*.py` | 引擎代理的文件（要改接口找主控） |
| 画布（前端） | `web-src/src/flows/canvas/**`、`web-src/src/flows/graph.js(+test)` | Flows.jsx、api.js（缺接口找主控） |
| 列表页（前端） | `web-src/src/flows/` 下除 canvas/ 与 graph.js 外的全部（Flows.jsx、api.js、flows.css、新组件、测试） | canvas/** |
| 新手引导 | `web-src/src/tour/**`、`jarvis/onboarding.py`、`tests/test_onboarding.py`；为锚点与入口小改 `market/*.jsx`、`Hud.jsx`、`AccountMenu.jsx`、`CommandPalette.jsx`、`App.jsx` / `main.jsx`（挂载） | flows/** |

## 7. 交付要求

- 只在自己的 worktree 分支提交，**不要 push**，不要提交 `jarvis/web/` 构建产物；除 `@xyflow/react` 外不加新依赖（要加先问主控）。
- 后端 `pytest` 全绿、前端 `vitest` 全绿；新逻辑有测试；旧库升级路径已由地基覆盖（v7）。
- 文案说人话，不出现英文工具名、技术术语（节点 id、JSON）——界面上叫「节点」「连线」「变量」即可。
- 设计令牌沿用 `--jv-*`（深 / 浅色都要好看），间距取 4 的倍数，圆角 8 / 12 / 16。
- 交付报告：做了什么、接口有没有偏离契约、截图路径（`output/round18-<代理>/`）、需要主控决定的事。
