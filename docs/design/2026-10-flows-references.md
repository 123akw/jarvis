# 流程画布与新手引导设计参考（第十八轮调研）

2026-10-03 · 调研代理 · 配合 [第十八轮契约](../proposals/2026-10-round18-flows.md)

截图（如有）放在 `docs/design/refs-flows/`。

---

## TL;DR：最重要的 15 条结论

（撰写中）

---

## 一、各家值得抄的点与反例

> 来源说明：Dify 文档取自 docs.dify.ai 的 Markdown 版（2026-10-03），界面文案取自 GitHub `langgenius/dify` 的 `web/i18n/locales/zh-Hans/*.json`（官方中文），源码结构取自 `web/app/components/workflow/`。Langflow 同理（docs.langflow.org + `src/frontend/src/locales/zh-Hans.json`）。n8n 文案取自 `packages/frontend/@n8n/i18n/src/locales/en.json`。

### 1. Dify（工作流 / Chatflow）

值得抄：

1. **插入变量用 `/`（或 `{`）唤出下拉，选中后在文本里显示成「节点名 / 变量名」的小标签**，比如「User Input/draft」，用户看不到 `{{…}}` 原文；输入框里常驻一行灰字提示「按 '/' 键快速插入」。我们照搬：`/` 和 `{{` 都弹选择器，显示「AI 处理 · 文字」。【[Key Concepts](https://docs.dify.ai/en/learn/key-concepts.md)；[30 分钟上手](https://docs.dify.ai/en/quick-start.md)；中文文案 `common.insertVarTip`】
2. **「检查清单」（Checklist）**：顶栏一个带数字的按钮，列出「此节点尚未连接到其他节点」「{{field}} 不能为空」「必须添加{{node}}节点」，每条带「前往修复」，点了画布定位到该节点；全部解决时显示「所有问题均已解决」。这就是我们要的「就地提示 + 汇总」。【`panel.checklist*`、`common.needConnectTip`、`errorMsg.fieldRequired`、`panel.goToFix`】
3. **加节点三条路**：从块面板选、节点出口的「+」弹快捷面板（`nodes/_base/components/node-handle.tsx`、`next-step/`）、配置面板底部「下一步」区块列出下游并可「添加此工作流程中的下一个节点」。快捷面板打开即聚焦搜索框、Esc 关闭并把焦点还回、悬停 150ms 出预览卡。【`block-selector/README.md`；`panel.nextStep` / `panel.addNextStep`】
4. **运行追踪三栏：结果 / 详情 / 追踪**。追踪按执行顺序列出每个节点、耗时和数据流，失败节点直接给错误；每个节点的配置面板还有「上次运行」页签看该节点的输入 / 输出 / 用时。【[Run History](https://docs.dify.ai/en/cloud/use-dify/debug/history-and-logs.md)；[Single Node](https://docs.dify.ai/en/cloud/use-dify/debug/step-run.md)】
5. **一句话生成先出「计划」再出图**：生成弹窗下方给 4 个「试试这些」建议（模型生成、失败时退回固定列表、可「换一批」）；生成时先显示骨架 →「正在规划工作流……」→ 用真实节点图标列出计划 →「正在构建节点……」；改已有流程时先给「新增 2 · 删除 1 · 修改 1」的差异摘要再让用户「应用」。【`workflow-generator/example-prompts.tsx`、`generation-plan.tsx`、`graph-diff.ts`；`workflowGenerator.*` 中文】
6. **模板详情有「必须配置项」与「试用」**：探索页模板分类页签（推荐 / 写作 / 翻译 / 人力资源 …），点开有「试用」和「编排详情」两个页签，列出「必须配置项」，主按钮「从此模板创建应用」。对应我们的 `needs` 与预览弹层。【`explore.json`：`tryApp.requirements`、`tryApp.createFromSampleApp`】
7. **定时触发用可视化选择器，并显示「接下来 5 次运行时间」**，cron 只作为高级选项。【[Schedule Trigger](https://docs.dify.ai/en/cloud/use-dify/nodes/trigger/schedule-trigger.md)】

别学：

- **概念太多**：Workflow / Chatflow 两种应用、20 多种节点（参数提取器、变量聚合器、变量赋值、列表操作、文档提取器 …）、环境变量 / 会话变量 / 系统变量三套变量；块面板有「节点 / 工具 / 数据源 / 开始 / Snippets」五个页签。非技术用户看到就退。我们只留 7 种节点、一套「变量」。【[节点目录](https://docs.dify.ai/_llms/en/cloud.md)；`block-selector/README.md` 页签顺序】
- **出错默认直接停并给原始报错**，「默认值 / 失败分支」要用户自己去配。我们应当默认就把错误翻成人话并指出哪个节点、怎么改，不暴露 `error_type` 这类变量。【[Handle Errors](https://docs.dify.ai/en/cloud/use-dify/build/predefined-error-handling-logic.md)】

### 2. Langflow

值得抄：

1. **空画布欢迎页**：新建时先问「你想打造什么？」，下面是一个大输入框「请描述你的工作流程……」+「发送」，再下面「或者从模板开始：」两三个快捷模板 +「浏览更多…」+「空白流」。这就是「一句话生成 + 模板」合并成一个起步页。【`flowBuilderWelcome.*`（zh-Hans.json）；`components/core/flowBuilderWelcome/`】
2. **模板弹窗左侧分类**：「开始」（精选 3–4 个带大图的入门卡）/「所有模板」/ 按用例（助手、分类、编码、内容生成、问答 …），右侧网格 + 搜索；左上角固定「从头开始」。【`modals/templatesModal/index.tsx`；`templatesModal.*`】
3. **节点上直接「运行组件」和「检查输出」**：每个组件右上有 ▶ 按钮单独运行到它为止，输出口旁有眼睛图标看产出；不用跑整条。【[Components](https://docs.langflow.org/concepts-components)；`node.runComponent` / `node.inspectOutput`】
4. **端口按数据类型着色，悬停端口显示连接说明，点端口直接「搜索可接的组件」**（列表已按能不能接过滤）。我们不需要按类型着色（变量都是文字 / 列表），但「点出口 → 只列能接的节点」值得照做。【[Components](https://docs.langflow.org/concepts-components)】
5. **默认只显示必填和常用参数**，其余收进右侧「组件参数」面板（可调哪些参数露在卡片上）。我们的节点卡只露 1–2 行摘要，参数全在右侧面板。【同上；`inspectionPanel.*`】
6. **AI 助手改流程时逐条播报「正在添加 X…」「正在连接组件…」「正在配置 X…」，每次改动可「撤销此编辑」**。一句话生成的过程提示可以照这个写。【`assistant.buildTasks.*`、`assistant.revert.*`】

别学：

- **机翻中文**：「空白流」「特工」「成品检验」「您最喜爱的特工运输新方式」——术语直译、不通顺。我们所有文案要中文母语者口吻。【`page.welcomeDescription`、`shortcuts.name.outputInspection`（zh-Hans.json）】
- **以开发者为中心**：卡片上满是 Code / Freeze / Tool Mode / API 开关，Playground 只对含「Chat Input」的流程好用，非聊天流程要去调 API。我们的运行面板要对任何流程都能用：按开始字段自动生成表单。【[Playground](https://docs.langflow.org/concepts-playground)】

### 3. n8n / 扣子（Coze）/ ChatGPT Agent Builder

**n8n** 值得抄：

1. **加节点面板用问句当标题**：从出口点「+」→「What happens next?」（接下来做什么？）；新流程第一步→「What triggers this workflow? / When should this workflow run?」（什么时候运行？），选项写成「Trigger manually — 点按钮运行，适合刚上手」「On a schedule — 每天、每小时或自定义间隔运行」。【n8n `en.json`：`nodeCreator.triggerHelperPanel.*`】
2. **「过期」标记**：节点跑过之后又改了配置 / 连线，节点边框变黄、✓ 换成黄色三角，悬停说明「配置已改，再运行结果可能不同」。我们的运行态也该有「结果已过期」，避免用户对着旧结果困惑。【[Understand dirty nodes](https://docs.n8n.io/build/understand-workflows/understand-executions/understand-dirty-nodes.md)；`node.dirty`】
3. **上游没数据时给一个按钮**：「No input data — Execute previous nodes」。我们的变量选择器在上游还没跑过时也可以给「先运行一次看看会有什么」。【`ndv.input.noOutputData.*`】
4. **AI 建流程三步**：选示例或描述 → 实时阶段反馈 → 列出「还需要你配置的凭据 / 参数」再用对话继续改。【[AI Workflow Builder](https://docs.n8n.io/build/ways-of-building-workflows/ai-workflow-builder.md)】

n8n 别学：节点数据面板默认 JSON / 表格 / Schema 三视图、表达式模式 `{{ $json.x }}`，完全是给工程师的；模板库跳到外站浏览。

**扣子（Coze）** 值得抄（官方帮助中心为前端渲染页，以下据社区教程与产品界面整理，链接为二手来源）：

1. **参数「引用 / 输入」二选一**：每个参数左边一个小下拉，选「引用」就从上游节点的输出里点选，选「输入」就直接填文字。对不懂变量的人很直观。【[人人都是产品经理：扣子工作流教程](https://www.woshipm.com/ai/6258270.html)；[CSDN：扣子多节点流程](https://gitcode.csdn.net/6aa0e0d01a35784c84209897.html)】
2. **底部浮动工具条**放「添加节点」「试运行」、缩放与「优化布局」，画布上方不堆按钮。【同上】
3. **试运行时每个节点右上角出现「运行成功 · 耗时」徽标，可展开看本节点输入 / 输出**；失败节点标红并给原因。【同上】

扣子别学：变量名要用户自己起、区分大小写、没有自动补全，写错就「变量未定义」。我们的变量由系统按节点自动产生，用户只点选。【[CSDN](https://gitcode.csdn.net/6aa0e0d01a35784c84209897.html)】

**ChatGPT Agent Builder** 值得抄：模板起步或空白起步；**自动保存**；「预览」里可以带样例文件跑一遍并**看着每个节点依次执行**；发布 = 打一个版本快照。【[Agent Builder 文档](https://developers.openai.com/api/docs/guides/agent-builder)】

别学 / 注意：OpenAI 已宣布 Agent Builder 将于 **2026-11-30 停服**，节点间是「有类型的连线」、要求理解数据契约——对我们的用户太重；参考它的交互，不参考它的概念。【同上】

### 4. 新手引导：产品与库

**产品做法**

| 产品 | 值得抄 | 别学 / 注意 |
|---|---|---|
| Dify「认识 Dify」分步引导 | ① 状态存**服务端**（`completed_task_ids`、`skipped`），换设备不重复出现，前端先乐观更新再对账。② 用**具名锚点注册表**（`STEP_BY_STEP_TOUR_TARGETS`）而不是写死 CSS 选择器，和我们的 `data-tour` 同一思路。③ 每步分「看一眼」（walkthrough）和「要你动手」（action）两类，动手步只让目标可点（`interactionPolicy: 'target-only'`）。④ 跳过后给一条**恢复提示**：「引导已隐藏。可随时在 帮助 → 分步引导 中重新开启。」⑤ 标题旁写预期时长「快速浏览 — 大约 5 分钟」，步骤写「第 2 步 / 共 5 步」，按钮用「知道了」。【`web/app/components/step-by-step-tour/state.ts`、`target-registry.ts`；`onboarding.json`】 | 引导覆盖首页、Studio、知识库、集成四大块，近 50 个锚点，太长；我们每页 ≤7 步。 |
| Linear | **不做气泡导览**，给一份「熟悉 Linear」的任务清单（建一个事项、用 ⌘K、设优先级），任务本身就是真实数据，做完就会了；约 7 步、60 秒。【[Supademo：Linear 引导拆解](https://supademo.com/content/plg-onboarding-gallery/linear)；[Impeccable：onboard](https://www.impeccable.style/docs/onboard)】 | 只适合高意愿、懂行的用户；我们的用户需要被「指着看」，所以用导览 + 示例流程两手。 |
| Notion | 首次进入先问「你打算用来做什么」，据此给 5 个模板；「Getting Started」本身是一页带勾选框的文档（「输入 / 试试命令」），**边做边学**；悬停时才出高对比小提示。【[Appcues GoodUX：Notion 轻量引导](https://goodux.appcues.com/blog/notions-lightweight-onboarding)；[Supademo：Notion](https://supademo.com/user-flow-examples/notion)】 | — |
| Figma | 首次登录在工作区放好可动手的示例文件（Figma Basics），提示气泡就出现在要操作的位置，每条一句话 + 一段小动画。【[Appcues GoodUX：Figma 动画引导](https://goodux.appcues.com/blog/figmas-animated-onboarding-flow)；[Chameleon：Figma 导览](https://chameleon.io/inspiration/figmas-onboarding-tour)】 | 动画多、成本高，我们用静态气泡即可。 |
| 字节 Semi Design `UserGuide`（国内常见做法；飞书官方引导规范未公开，按同类做法参考） | 两种模式：**气泡**（围绕目标，12 个方位）与**弹窗**（居中，可带封面图，适合第一步「欢迎」）；可关遮罩做不打扰的提示；按钮「上一步 / 下一步 / 跳过 / 完成」。【[Semi UserGuide](https://semi.design/zh-CN/show/userGuide)；[人人都是产品经理：新手引导设计](https://www.woshipm.com/pd/3621684.html)】 | — |
| NN/g 研究 | 用户想马上动手（「主动用户悖论」），**脱离情境的引导记不住**；引导要易关、且关了以后能从菜单再找回；优先在用户真正用到时出现的情境提示。【[NN/g：Onboarding Tutorials vs. Contextual Help](https://www.nngroup.com/articles/onboarding-tutorials/)】 | 导览越长越被跳过：所以「只自动一次 + 可重看 + 每步一句话」。 |

**库的交互约定（我们自写 `tour/**`，不引库，但参数照抄这些默认值）**

| 约定 | Driver.js | Shepherd.js | Intro.js | 我们取 |
|---|---|---|---|---|
| 遮罩 | `overlayOpacity: 0.5` | `useModalOverlay` | 默认有 | 暗色 0.6 / 亮色 0.45 |
| 挖空内边距 / 圆角 | `stagePadding: 10` / `stageRadius: 5` | `modalOverlayOpeningPadding / Radius` | `helperElementPadding: 10` | 8 / 12（与令牌对齐） |
| 点遮罩 | `overlayClickBehavior: "close"` | — | `exitOnOverlayClick: true` | **不关闭**（误触太多），只有「跳过」与 Esc 退出 |
| 键盘 | `allowKeyboardControl`（← → Esc） | `keyboardNavigation`、`exitOnEsc` | `keyboardNavigation`、`exitOnEsc` | ← → 翻页、Esc = 跳过 |
| 目标不存在 | 默认居中显示；`skipMissingElement`；`waitForElement` 毫秒 | `waitForElement`（MutationObserver）、`showOn()` | — | 等 1.5 s（MutationObserver + 轮询兜底），仍无则跳过此步 |
| 滚动 | `smoothScroll: false` | `scrollTo`（scrollIntoView） | `scrollToElement: true` | 不在视口就 `scrollIntoView({block:'center'})`，减弱动效时用 `behavior:'auto'` |
| 进度 | `showProgress`、`"{{current}} of {{total}}"` | — | `showBullets: true` | 步骤点 +「2 / 5」 |
| 目标可否点 | `disableActiveInteraction: false` | `canClickTarget` | `disableInteraction: false` | 「看一眼」步禁点；「动手」步只放行目标 |
| 「不再显示」 | — | — | `dontShowAgain`（cookie 365 天） | 不放勾选框：**看完或跳过即记为看过**（服务端 + localStorage） |
| 读屏 | `closeBtnLabel` | 标题成 `h3` 并 `aria-labelledby` | — | `role="dialog"`、`aria-labelledby` 标题、`aria-describedby` 正文、焦点进卡片并在卡内循环、结束把焦点还给触发按钮【[WAI-ARIA APG 对话框](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/)】 |

【[Driver.js 配置](https://driverjs.com/docs/configuration)；[Shepherd 用法](https://docs.shepherdjs.dev/guides/usage/)；[Intro.js 选项](https://introjs.com/docs/tour/options)】

---

## 二、按区域的落地清单

### 1. 画布与节点卡
### 2. 节点面板与加节点方式
### 3. 配置面板与变量选择器
### 4. 条件分支
### 5. 运行与追踪
### 6. 模板库与起步页
### 7. 一句话生成
### 8. 定时 / 触发
### 9. 手机端
### 10. 新手引导（flows-home / flows-editor）

---

## 三、给非技术用户的文案与命名

（撰写中）
