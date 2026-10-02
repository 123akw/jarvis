# 第十三轮方案：智能平台工坊（插件拼接平台）

2026-10-02 · 依据当天 19:33 的会议纪要调整。第十二轮路线图（`2026-10-round12-roadmap.md`）里的「手机上的贾维斯」并入本轮（生成的平台就是一个能装到主屏的手机 App），「有人味的管家」顺延到下一轮。

## 1 会议结论（摘要）

- 方向：做**面向不懂技术的人的集成 / 插件拼接平台**（主打下沉市场）。把微信、飞书、文件处理这些能力封装成一个个插件，用户按场景拼起来，最后得到一个**链接或二维码**——就是他自己的平台。参考国外一款叫「神经」的节点式 App。
- 流程：**输入 → 工具 → 输出**。例：项目管理——输入项目资料，中间用「拆分文件」「微信技能包」「汇总到飞书文档」，最后输出二维码或网址。
- 第一版入口：先进**智能平台市场**选技能 → 填一份**职业表单** → 按职业推荐工具，一键添加（也可自己加）→ 生成**平台信息与账号密码** → 进入主页面。还可以加一段**自然语言描述自动推荐工具**。主页面要**偏定制化**。
- 卖点不是技术创新，而是「让人很快拿到自己的平台」。第一版做简单，比赛演示时可以适度拔高。商业模式：**卖插件**。

## 2 点子（本轮采纳的标 ✅）

1. ✅ **平台 = 能装到主屏的 App**：生成的平台有自己的名字、图标、主题色，扫码打开后「添加到主屏幕」，图标就在手机桌面上（PWA）。用户拿到的不是「一个网址」，而是「一个 App」——这是演示时最打动人的一刻。
2. ✅ **三种起步方式，一页搞定**：逛插件市场自己挑 / 选职业套餐 / 一句话描述「我是开奶茶店的，想管订单和员工排班」→ AI 推荐插件并说明理由，一键全加。
3. ✅ **插件 = 现有能力的重新包装**：27 个工具按用户能理解的「技能」重组（日程助手、待办、随手记、天气、联网搜索……），加上微信 / 飞书渠道和流程积木。每个插件写清「能干什么、需要什么、产出什么」，带免费 / 专业版标签，为卖插件铺路。
4. ✅ **积木式流程拼接**：输入 → 处理 → 输出 三段式，第一版是一条链（卡片可增删、排序），不用自由画布；但视觉上做成「节点 + 连线」，运行时信号沿连线流动、节点逐个亮起——呼应「神经」，也是比赛演示的高光。
5. ✅ **拼完立刻试运行**：用示例资料一键跑通，每一步给出可读的中间结果，最后生成结果网页 + 二维码。
6. ✅ **主页按插件自动定制**：项目经理看到「项目资料投递口 + 我的流程 + 飞书汇总」，店主看到「上新文案 + 待办 + 天气」；问候语、快捷问题、主题色都随平台变。对话里的贾维斯也换成平台自己的名字和人设，只用这个平台装了的插件。
7. ✅ **账号即平台**：市场里生成平台时自动开一个账号（用户名 + 随机强口令，只显示一次、可复制），登录后直接是自己的平台；已登录用户则把平台装到当前账号。
8. ✅ **分享卡**：随时在菜单里打开「分享我的平台」——链接、二维码、装到主屏的图文指引。
9. ✅ **比赛演示剧本**：一份现场 3 分钟的讲述脚本 + 预置演示数据（用今天这份会议纪要本身做输入：拆分 → 提炼待办 → 推飞书 → 生成纪要网页二维码），保证现场不翻车。
10. 插件计费：插件带价格字段和「专业版」徽标，本轮**只展示不收费**；支付、用量计费、插件上架审核放到后续。
11. 平台模板广场：用户拼好的平台可发布成模板给别人一键复制——社区玩法，后续。
12. 不做：自由画布节点编辑器（对非技术用户太难）、真实支付、第三方开发者上架、原生 App。

## 3 用户旅程（验收以此为准）

1. 扫市场二维码 / 打开 `/market` → 首屏一句话说清「几分钟拼出你自己的 AI 平台」。
2. **挑技能**：插件按分类展示，点「加入」进工具箱（底部工具箱条显示已选数量）。
3. **你是做什么的**：选职业卡片，或写一句话描述 → 推荐插件 + 推荐流程，「一键全部加入」或逐个加。
4. **给平台起名**：名字、图标（emoji）、主题色（6 选 1）、一句话介绍，右侧 / 下方实时预览手机里的样子。
5. **生成**：游客 → 开账号并登录，结果页显示账号与口令（只显示这一次）、平台链接、二维码、「进入我的平台」；已登录 → 直接装到当前账号。
6. **进入主页**：主页按平台定制；菜单里有「智能平台市场」「我的流程」「分享我的平台」「平台设置」。
7. **拼流程**：`/flows` 从职业模板新建或从空白开始，增删排序积木，配置每一步。
8. **试运行**：上传资料或贴一段文字 → 积木逐个亮起 → 输出结果网页链接 + 二维码，手机扫码可看。
9. 手机扫平台二维码 → `/p/<slug>` 品牌化入口（平台名、图标、主题色）→ 登录 →「添加到主屏幕」。

## 4 接口契约（各代理按此并行开发，改契约须在报告中写明）

### 4.1 插件与职业（后端 `jarvis/plugins/`）

插件对象 `Plugin`：

```json
{"id": "schedule", "name": "日程助手", "icon": "📅", "category": "efficiency",
 "summary": "说一句话就记下安排，到点提醒你", "kind": "tool",
 "tools": ["schedule_add", "schedule_list", "schedule_del"],
 "step": null, "requires": [], "tier": "free", "price": 0,
 "professions": ["freelancer", "project_manager"], "examples": ["明天下午3点和客户开会"],
 "available": true}
```

- `kind`：`tool`（对话里能用的技能）/ `channel`（微信、飞书等需绑定的通道）/ `step`（只在流程里用的积木）。
- `category`：`efficiency` 效率 · `communication` 沟通 · `documents` 资料 · `info` 资讯 · `life` 生活 · `ai` AI 处理 · `output` 输出。
- `requires`：`feishu_bound` / `wechat_owner`（微信桥只给 Owner）/ `desktop`（会议纪要要桌面端）。`available` 只在登录后按当前账号计算，游客恒为 `true`。
- `step`（`kind=step` 时必有；`tool/channel` 插件也可同时作为积木）：`{"role": "input|process|output", "accepts": ["text","file","parts","items"], "produces": [...], "options": [{"key","label","type":"select|text|number","choices":[...],"default"}]}`。

插件 id 清单（名称可微调，id 不改）：

| id | 名称 | kind | 说明 |
| --- | --- | --- | --- |
| `schedule` | 日程助手 | tool | schedule_add/list/del |
| `todo` | 待办清单 | tool | todo_add/list/done |
| `memo` | 随手记 | tool | memo_add/list/del |
| `memory` | 懂你的记忆 | tool | profile_remember/list/forget |
| `weather` | 天气 | tool | weather / weather_here / my_location |
| `search` | 联网搜索 | tool | web_search / web_extract |
| `recall` | 翻旧账 | tool | recall_history |
| `movies` | 影视评分 | tool | movie_ratings |
| `esports` | 电竞比分 | tool | esports_scores |
| `tickets` | 票务比价 | tool | ticket_search |
| `meeting` | 会议纪要 | tool | meeting_start/stop，requires `desktop` |
| `feishu` | 飞书 | channel | 绑定后对话 / 收提醒；同时可作积木 |
| `wechat` | 微信技能包 | channel | requires `wechat_owner` |
| `input_text` | 文字输入 | step·input | options: `label` |
| `input_file` | 资料上传 | step·input | PDF / Word / TXT / MD / 图片，复用 `jarvis/documents.py`、`vision.py` |
| `split_file` | 文件拆分 | step·process | options: `mode` chapter/paragraph/size，`max_parts` 2–20 默认 8 |
| `ai_extract` | AI 提炼 | step·process | options: `task` 要点/待办/摘要/周报/改写，`instruction`（≤200 字） |
| `to_todo` | 加到待办 | step·output | 上一步的条目逐条写入待办 |
| `feishu_send` | 发到飞书 | step·output | 发给本账号绑定的飞书；requires `feishu_bound` |
| `feishu_doc` | 汇总到飞书文档 | step·output | 需要飞书 docx 权限；没权限时降级为 `feishu_send` 并在结果里说明 |
| `wechat_send` | 发到微信 | step·output | requires `wechat_owner` |
| `web_page` | 生成网页与二维码 | step·output | 生成公开结果页 `/r/<token>`，options: `title` |

`now`、`calc` 是基础能力，任何平台都默认带上，不进市场。`coding_status`、`sys_query` 只给 Owner，不进市场。

职业 `Profession`：`{"id","name","icon","summary","plugins":[ids],"flows":[FlowTemplate],"persona":"一句话人设","home":{"greeting","chips":[...]}}`。

| id | 名称 | 推荐插件（示意） | 模板流程（示意） |
| --- | --- | --- | --- |
| `freelancer` | 自由职业者 | schedule todo memo search recall feishu | 客户需求整理：input_text → ai_extract(待办) → to_todo → web_page |
| `project_manager` | 项目经理 | schedule todo meeting feishu recall search | 项目资料归档：input_file → split_file → ai_extract(要点) → feishu_doc → web_page |
| `shop_owner` | 个体店主 / 微商 | memo todo schedule weather search wechat | 上新文案：input_text → ai_extract(改写) → web_page |
| `sales` | 销售 / 经纪人 | schedule todo memory recall feishu | 拜访纪要：input_text → ai_extract(待办) → to_todo → feishu_send |
| `teacher` | 老师 | schedule todo memo search | 课件提炼：input_file → split_file → ai_extract(要点) → web_page |
| `student` | 学生 | todo schedule search recall | 资料速读：input_file → ai_extract(摘要) → web_page |
| `creator` | 内容创作者 | search memo movies todo | 选题素材：input_text → ai_extract(要点) → web_page |
| `office` | 行政 / HR | schedule todo meeting feishu | 通知下发：input_text → ai_extract(改写) → feishu_send |

`FlowTemplate`：`{"id","name","summary","steps":[{"plugin":"input_file","options":{}}]}`。

### 4.2 市场与平台 API（后端·平台代理）

- `GET /api/market/catalog`（公开）→ `{"categories":[{"id","name"}], "plugins":[Plugin], "professions":[Profession], "signup":"off|invite|open"}`
- `POST /api/market/recommend`（公开，按 IP 限流）`{"profession"?: id, "description"?: str≤300}` → `{"plugins":[ids], "flows":[FlowTemplate], "reason": str, "source":"rules|model"}`。有描述且服务器默认模型可用时走模型（只允许从清单里选 id），否则关键词规则兜底。
- `POST /api/market/signup`（公开，按 IP 限流）`{"platform": PlatformIn, "invite_code"?: str}` → 201 `{"username","password","platform":Platform}`，同时像 `/api/login` 一样种会话 cookie。`JARVIS_MARKET_SIGNUP=off`（默认）/ `invite`（需 `JARVIS_MARKET_INVITE_CODE`）/ `open`。关闭时 403 `{"error":"…"}`。
- `GET /api/platform`（登录）→ `{"platform": Platform|null}`；`POST /api/platform`（登录 + CSRF，当前账号还没有平台时创建）；`PUT /api/platform`（部分更新）。
- `GET /api/p/{slug}`（公开）→ `{"slug","name","tagline","icon","accent"}`；不存在 404。
- `GET /p/{slug}/manifest.webmanifest`、`GET /p/{slug}/icon-{192|512}.png`（纯 Python 生成主题色光球图标，不引 Pillow）、`GET /sw.js`（最小 service worker，不缓存 `/api`）。

`PlatformIn`：`{"name"≤20, "tagline"?≤40, "icon": emoji, "accent": "#RRGGBB"（六个预设之一）, "profession"?: id, "plugins":[ids]}`。`Platform` = PlatformIn + `{"id","slug","url":"https://…/p/<slug>","home":{…},"created_at","updated_at"}`。一个账号一个平台；Owner 可以没有平台（保持完整的贾维斯）。

平台生效：账号有平台时，对话 Agent **只绑定平台插件对应的工具**（外加 now、calc），系统提示词加一段「你是『平台名』……由贾维斯驱动」+ 职业人设；没有平台的账号行为不变。

存储：`tenant_platforms`，租户 schema **v5**（`jarvis/tenancy.py`）。

### 4.3 流程 API（后端·流程代理）

- `GET /api/flows` → `{"flows":[Flow]}`；`POST /api/flows` `{"name","steps":[{"plugin","options"}]}` → `{"flow"}`；`PUT /api/flows/{id}`；`DELETE /api/flows/{id}`。
- `Flow`：`{"id","name","summary","steps":[{"id","plugin","options"}],"updated_at","last_run":{"id","status","finished_at","url"}|null}`。校验：第一步必须是 input 角色，至少一个 output，步数 ≤ 8，插件 id 必须存在且对当前账号可用。
- `POST /api/flows/{id}/run` `{"text"?: str, "file"?: {"name","data_base64"}}`（≤10MB，解析复用 `/api/upload` 的逻辑）→ `text/event-stream`，每行 `data: {json}`：
  - `{"type":"run_start","run_id"}`
  - `{"type":"step_start","step_id","plugin"}`
  - `{"type":"step_done","step_id","summary":"拆成 6 段","preview":"…"}`
  - `{"type":"step_error","step_id","message":"人话原因"}`（之后整条流程停止）
  - `{"type":"run_done","status":"ok|error","output":{"url":"/r/<token>","title"}|null}`
- `GET /api/flows/{id}/runs?limit=10`；`GET /api/r/{token}`（公开 JSON）；`GET /r/{token}`（公开、服务端渲染的移动优先结果页，带平台名与主题色，`noindex`，内容安全转义）。
- 步骤之间传一个上下文：`{"text","parts":[...],"items":[...],"title","links":[...]}`。
- 存储：`tenant_flows`、`tenant_flow_runs`，租户 schema **v6**。

### 4.4 前端（`web-src/src/`）

- 路由已在地基里：`routes.js`（`parseRoute` / `navigate` / `useRoute`），`App.jsx` 按路由懒加载 `market/Market.jsx`、`platform/PlatformEntry.jsx`、`flows/Flows.jsx`。页面组件 props：`Market({session,onAuthed})`、`PlatformEntry({slug,session,onAuthed})`、`Flows({session,onExpired})`，`session` 为 `null`（检查中）/ `false`（游客）/ 对象（已登录）。
- 二维码统一用 `qr.jsx` 的 `<QrCode value size label />`。
- 设计沿用 `--jv-*` token 与「安静未来感」；平台主题色通过覆盖 `--jv-accent` 生效；手机优先（390 宽）。

## 5 分工（第十三轮）

| 代理 | 范围 | 主要文件 |
| --- | --- | --- |
| P 后端·平台与市场 | 4.1 + 4.2 全部：插件 / 职业清单、推荐、注册开号、平台 CRUD、manifest / 图标 / sw.js、平台对 Agent 工具与人设生效 | `jarvis/plugins/`（新）、`jarvis/platforms.py`（新）、`tenancy.py` v5、`server.py` 一段、`graph.py` / `prompts.py` 最小接线 |
| F 后端·流程引擎 | 4.3 全部：流程存储、执行器、各积木实现、SSE、公开结果页 | `jarvis/flows/`（新）、`tenancy.py` v6、`server.py` 一段 |
| M 前端·智能平台市场 | `/market` 全旅程（第 1–5 步）+ 结果页 | `web-src/src/market/` |
| B 前端·流程拼接 | `/flows`：列表、模板新建、节点式编辑、试运行动画、结果卡 | `web-src/src/flows/` |
| H 前端·定制主页与分享 | 平台化主页（品牌、主题色、问候、快捷问题、工具箱、我的流程）、菜单入口、分享卡、平台设置、`/p/<slug>` 入口与 PWA | `Hud.jsx`、`Chat.jsx` 空态、`AccountMenu.jsx`、`CommandPalette.jsx`、`web-src/src/platform/`、`index.html` |
| R 调研与演示 | 「神经」类产品与国内竞品对标、职业 / 插件清单校准、插件定价、比赛 3 分钟演示剧本 + 演示数据 | `docs/` |
