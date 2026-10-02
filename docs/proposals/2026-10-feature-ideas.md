# 贾维斯新功能提案：加得上，又不累赘（2026-10）

> 状态：提案，只给方案，不含产品代码 · 基线：`main @ 166d342`（ui-round9 之后） · 日期：2026-10-02
> 读者：产品决策人和开发代理。第 5 节可以直接作为开发任务书派发。

**结论**：首批做三项，**一句话速记**、**记忆回执**和**今日简报卡**。三项都落在已有的「今日」板和对话流里，不新增任何顶栏按钮，工作量合计约 S + S + M。业内最热门的「例行任务」排到第二批之后（它依赖先把送达和免打扰规则做好）；「全自主虚拟电脑 Agent」明确不做。

**目录**：[0 现状盘点](#0-现状盘点) · [1 克制原则](#1-克制原则) · [2 对标速览](#2-对标速览它们怎么把功能塞进来) · [3 候选清单](#3-候选清单12-项) · [4 评分表](#4-评分表) · [5 首批推荐](#5-首批推荐-3-项可直接派发) · [6 不建议做](#6-明确不建议做) · [7 参考来源](#7-参考来源)

---

## 0 现状盘点

所有提案都只往下表的「空位」里放东西。下表来自代码实读，不是推测。

| 容器 | 现在有什么（文件） | 可承载的空位 |
| --- | --- | --- |
| 顶栏 | 会话栏开关、标题、⌘K 搜索钮、今日钮、账户菜单（`Hud.jsx`） | **已满，不再加** |
| ⌘K 命令面板 | 新对话、会话栏、今日、设置类命令和最近对话（`CommandPalette.jsx`），**只匹配会话标题** | placeholder 写着「搜索对话，或输入要做的事…」，但没有匹配时只显示「没有匹配的命令或对话」，**这个承诺还没兑现** |
| 「今日」板 | 日程（只读、可删）、待办（增、删、勾）、备忘（增、删）、会议纪要卡（`Panels.jsx`），每 30 秒轮询 `/api/dashboard` | 日程**没有新增入口**（`addSchedule` 已经 import，但没有用上）；顶部没有「今天概览」 |
| 对话 | 流式 Markdown、工具 chip（中文名、耗时、结果摘要）、空态 4 条建议（`Chat.jsx`） | chip 只告诉用户「做了什么」，没有可撤销的回执 |
| 主动通道 | 日程提醒（微信、桌面、网页）、Heartbeat（微信加领取箱，读全局 `data/HEARTBEAT.md`）、晨报电台（只走微信、只服务唯一 Owner）、夜间蒸馏（静默写画像） | 飞书还没接主动推送（见 PROGRESS 待办）；提醒不能操作；没有免打扰；蒸馏写了什么，用户看不到 |
| 桌面端 | 悬浮球、⌥Space、⌥Q 划词条（翻译、解释、改写）、唤醒词、会议双路采集（`main.js`、`quick-ask.js`） | 按 ⌥Q 时如果没选中文字，`triggerQuickAsk` 直接 return，这是一个**空位** |
| 渠道 | 微信（发链接即总结、群里 @ 才应答、语音）、飞书（流式卡片、绑定码） | 飞书 `parse_content` 只解析 text、post、image，合并转发的聊天记录拿到的是空文本 |

> **先做一项减法**：`/api/threads` 没有过滤服务线程。`_service_invoke` 每次都会 `upsert_thread`，所以 Owner 的侧栏会出现「主动唤醒」「记忆蒸馏」「晨报电台」「会议纪要」这几条点开为空的会话。建议在加任何新功能之前，先把 `server.py` 里的 `_DISTILL_SERVICE_ALIASES` 提升为公共常量，并在 `/api/threads` 里过滤掉。工作量约半天。在「不累赘」这件事上，这是最便宜的一步，F4 也依赖它。

---

## 1 克制原则

贾维斯加任何功能，都必须**同时**满足下面 5 条。

| # | 原则 | 在贾维斯里的硬规则 | 依据 |
| --- | --- | --- | --- |
| 1 | **不开新门** | 不新增顶栏按钮、侧栏页签、常驻浮层或独立页面。新能力只能放进 5 个已有容器：**⌘K、「今日」板、对话消息、输入框、已有渠道**（微信、飞书、桌面通知、邮件） | Apple HIG：只在有明确价值的地方提供生成式功能，并保证不用 AI 时体验同样完整 [S30]；HAX G7 Support efficient invocation [S33] |
| 2 | **按需出现，一键收起** | 默认折叠成一行，或者干脆不出现。只有上下文命中时才出现：有时间词、有选中内容、有工具回执、到点了。每处都有 ×，另有**一个**全局开关 | HAX G3、G4、G8、G17 [S33]；PAIR《Feedback + Control》[S36] |
| 3 | **做了就留回执，回执可撤销** | AI 替用户写入的东西（记忆、日程、推送）必须留下可见回执，并能撤销；发送、删除、对外这类不可逆动作，执行前先确认 | HIG：Keep people in control，要能 revert 或 retry，并在更正生效时给出回应 [S30]；HAX G9、G11、G16 [S33] |
| 4 | **打扰有预算** | 每个主动通道每天有次数上限；能合并的合并进简报；夜间静默；沿用 Heartbeat 的 `PASS` 机制，该开口才开口 | Apple「减少干扰」专注模式 [S20]；HAX G3 Time services based on context、G5 Match relevant social norms [S33] |
| 5 | **成本和隐私有护栏** | 不做常驻采集，屏幕和麦克风只在用户触发时使用；每个功能写明「每用户每天最多调用几次模型」；失败时静默降级，当日不重试（沿用 radio、distill 现有口径）；能用确定性代码解决的不用模型 | HIG Privacy：尽量在本地处理，减少外发数据 [S30]；Raycast：后台不采集、不存储 [S23] |

**视觉约定**：只用现有的 `--jv-*` token 和 `Icon.jsx` 线性图标，不新增 emoji 作为 UI 图标。AI 生成的内容在左侧加 1px `--jv-ai-gradient` 细边，标明「这是 AI 写的」（HIG：Clearly identify when and where you use AI [S30]）。

---

## 2 对标速览：它们怎么把功能「塞」进来

| 产品 | 功能（2025–2026） | 克制手法 | 贾维斯对应 |
| --- | --- | --- | --- |
| ChatGPT Memory | 回答下方出现「Memory updated」，悬停即可管理；可以关闭「参考聊天记录」[S2][S3] | **回执加就地管理** | F3 |
| ChatGPT Tasks | 在对话里说「每天…」就建好任务，统一放在 Scheduled 区，可暂停 [S1] | **对话即入口** | F11 |
| ChatGPT Pulse | 每晚研究，次日出一组卡片，用 👍👎 和 curate 调教 [S4] | **每天一次，可调教** | F4（只取一张卡） |
| ChatGPT Projects | 项目级「仅本项目记忆」[S5] | 作用域隔离 | 不做（贾维斯按线程隔离已够用） |
| Claude Memory 与 Chat search | 记忆可查可改，支持无痕对话；可以搜索过往对话 [S6][S7] | **显式检索** | F10 |
| Claude Artifacts | 产出物在对话旁边单独开面板 [S8] | 自动出现 | 反例，见 N2 |
| Gemini Scheduled actions | 对话里建定时提示词，**最多 10 个**，可暂停 [S9] | **数量上限** | F11 |
| Gemini Daily Brief 与 Spark | 早间摘要配 👍👎；Spark 遇到高风险动作先请示 [S10][S11] | 每天一次，先请示 | F4 |
| Gemini Live | 通话里直接读写 Calendar、Tasks、Keep [S12] | 复用通话 | 已有（通话能调日程工具） |
| Gemini Gems → skills | 2026-11 起 Gems 迁移成 skills [S13] | 能力收敛 | F12 |
| Google CC | 早报用邮件送达，直接回复邮件就能调教或加待办 [S14] | **复用已有渠道** | F4、F8 |
| Apple Siri AI（WWDC26） | 屏幕感知、个人上下文，从 Spotlight、灵动岛唤起 [S15][S31] | 复用系统入口 | F9、F10 |
| Apple Writing Tools | 选中文字后，工具出现在系统菜单里 [S16] | **上下文触发** | 已有 ⌥Q |
| Apple 减少干扰 | 只放行需要立即处理的通知 [S20] | **打扰预算** | F6 |
| Raycast Quick AI | 在根搜索里按 Tab 直接问 AI [S21] | 复用启动器 | F1 |
| Raycast AI Commands | 把常用提示词做成一键命令 [S22] | 隐形入口 | F12 |
| Raycast Screen Awareness | 按热键才截取当前窗口，后台不采集、不存储 [S23] | **按需采集** | F9 |
| Dia Skills | 用斜杠调用自己写的技能 [S24][S25] | 隐形入口 | F12 |
| Notion AI Meeting Notes | 检测到会议开始时弹通知「开始转写」[S26] | **零入口** | F7 |
| Manus Mail | 把邮件转发到专属地址就算派活 [S27] | 复用已有渠道 | F8 |
| 腾讯元宝 | 在微信里加好友；2026-05 起支持转发聊天记录，一键总结并提炼待办 [S28][S29] | 复用 IM | F8 |
| 豆包 | 电脑版划词、截屏提问；2026-06 起任务模式支持定时任务 [S17][S18] | 上下文触发 | F9、F11 |
| Kimi OK Computer | 在虚拟电脑里全自主执行的 Agent [S19] | 重模式 | 反例，见 N1 |
| 飞书智能伙伴、aily | 预设「每日工作总结」场景；定时任务的结果由机器人推送 [S37][S38] | 复用 IM 推送 | F4、F6 |
| Todoist Quick Add | 在输入框里识别「明天下午 4 点」并高亮 [S39] | **就地解析** | F2 |

**共性**：做得好的产品几乎不为 AI 单独开新入口。它们把 AI 放进**已有的输入框、通知、启动器和 IM 会话**里，并配上**回执、上限和请示**。

---

## 3 候选清单（12 项）

**工作量口径**：S 不超过 1 人日；M 为 2 到 4 人日；L 至少 5 人日。均按一个熟悉本仓库的开发代理估算，含测试，不含真机验收。

| 编号 | 名称 | 一句话价值 | 落点 | 工作量 |
| --- | --- | --- | --- | --- |
| F1 | ⌘K 直接吩咐 | 在 ⌘K 里打一句话就能办事或提问，兑现 placeholder 的承诺 | ⌘K | S |
| F2 | 一句话速记 | 在待办框里写上时间，就成了日程 | 「今日」板 · 待办输入框 | S |
| F3 | 记忆回执 | 记住了什么当场可见、可撤销；夜间蒸馏不再「暗箱操作」 | 对话消息 + 「今日」板一行 | S |
| F4 | 今日简报卡 | 每个账号每天都有一张折叠成一行的早间简报 | 「今日」板顶部 | M |
| F5 | 可操作的提醒 | 提醒可以「稍后 10 分钟」，不用切回对话 | 网页弹条 / 桌面通知 / 微信回复 | S–M |
| F6 | 送达与免打扰 | 统一决定主动消息走哪个渠道、什么时候闭嘴；补上飞书 | 设置中心已有页签 | M |
| F7 | 会前一页纸 | 会前 5 分钟的提醒附上上次纪要里的待办，一键开始记纪要 | 已有提醒通道 | M |
| F8 | 转发即办 | 往微信或飞书转发一段话，贾维斯提议加日程或待办，确认后才写入 | 微信 / 飞书会话 | S–M |
| F9 | 问屏幕 | 没选中文字时按 ⌥Q，可以就当前窗口提问 | 桌面 ⌥Q 划词条 | M |
| F10 | 翻旧账 | 问「上次你推荐的那家店叫什么」能答出来并标明出处；⌘K 能搜到正文 | 对话 + ⌘K | M |
| F11 | 例行任务 | 「每周五 5 点帮我回顾本周」这类话说一次就会反复执行 | 对话回执 + 「今日」板一行 | M–L |
| F12 | 「/」快捷指令 | 输入「/」调出技能和常用指令 | 输入框 | S–M |

### F1 ⌘K 直接吩咐

| 项 | 内容 |
| --- | --- |
| 价值 | 用户按 ⌘K 输入一句话，能直接落地成待办、备忘、日程；不属于这三类时，回车就把这句话发给贾维斯 |
| 对标 | [Raycast Quick AI](https://manual.raycast.com/ai/quick-ai)（在根搜索里按 Tab 问 AI）；[Siri AI 从 Spotlight 唤起](https://www.apple.com/newsroom/2026/06/apple-introduces-siri-ai-a-profoundly-more-capable-and-personal-assistant/) |
| 放在哪 | `CommandPalette.jsx` 的 `items`：在现有分组前插入动态的「吩咐」组，列表末尾固定一条「问贾维斯」 |
| 复用 | `addTodo`、`addMemo`、`addSchedule`（`api.js`）；F2 的解析器；Hud 已有的 `setInjected` 注入链路（「会议追问」就是用它把文本发进 Chat） |
| 还缺 | 动态项构造（以「待办 / 备忘 / 提醒」开头时直接写入）；写入成功后的 toast 带「撤销」（调用对应 DELETE） |
| 工作量 | S |
| 风险 | 误写入：回车前预览标签已经写明动作，写入后 toast 可撤销。零模型调用 |
| 为什么不累赘 | 没有新入口。只是把 placeholder 已经承诺的行为做出来 |

```
┌ ⌘K ───────────────────────────────────────────┐
│ 🔍 提醒 下周一10点半 面试                      │
├───────────────────────────────────────────────┤
│ 吩咐                                          │
│ ▸ 加日程 · 10/05(一) 10:30 · 面试          ↵  │
│   问贾维斯「提醒 下周一10点半 面试」           │
│ 对话                                          │
│   （标题匹配的会话…）                          │
└───────────────────────────────────────────────┘
回车后 → 底部 toast「已加日程 10/05 10:30 面试 · 撤销」
```

### F2 一句话速记（自然语言快速添加）

| 项 | 内容 |
| --- | --- |
| 价值 | 现在想加日程只能去对话里说一句，耗时 1 到 3 秒，还要烧一次模型。改成在待办框里写「明天下午3点 复盘」直接成为日程，零延迟、零成本 |
| 对标 | [Todoist Quick Add](https://www.todoist.com/help/articles/use-task-quick-add-in-todoist-va4Lhpzz)：在输入里识别日期、高亮，保存时写入 |
| 放在哪 | 「今日」板待办区现有的 `jv-add-row` 输入框，**不新增输入框** |
| 复用 | `addSchedule` 和 `addTodo`（前者在 `Panels.jsx` 里已 import 但未用）；`POST /api/schedule` 已有格式校验；写入后日程提醒的三条通道自动生效 |
| 还缺 | 纯前端解析器 `quickAdd.js`；输入框下方的预览 chip |
| 工作量 | S |
| 风险 | 解析错误：chip 先用 24 小时制展示解析结果，可一键「改成待办」。不调用模型，没有隐私问题 |
| 为什么不累赘 | 输入框还是那一个，chip 只在识别出时间时出现 |

```
今日 · 待办
┌─────────────────────────────────────────────┐
│ ＋ 明天下午3点 项目复盘▌                      │
└─────────────────────────────────────────────┘
   ⓘ 将加为日程 · 10月3日(六) 15:00 · 项目复盘   [改成待办]
（没有时间词时 chip 不出现，回车照旧加待办）
```

### F3 记忆回执

| 项 | 内容 |
| --- | --- |
| 价值 | 「记得住」是贾维斯的卖点，但现在记住什么是隐形的：工具 chip 只显示「◉ 记住画像 ✓」，夜间蒸馏则完全静默。回执让用户看见、能撤回，信任才建立得起来 |
| 对标 | [ChatGPT「Memory updated」加悬停管理](https://help.openai.com/en/articles/8590148-memory-faq)；[Claude 记忆可查可改](https://claude.com/blog/memory)；HAX G11「Make clear why the system did what it did」、G18「Notify users about changes」 |
| 放在哪 | ① 对话：回答下方一行回执（一种新的消息附属类型）；② 「今日」板顶部一行「昨晚整理出 N 条新记忆」，N 为 0 时不渲染 |
| 复用 | `profile_remember` 的回执文本里本来就带编号（「记住了（编号 N）：…」），可以从 SSE `tool_result.detail` 直接解析；撤销调用现有 `DELETE /api/profile/{id}`；「管理」打开现有 `MemoryPanel` |
| 还缺 | 蒸馏批次记账（存 `tenant_prefs`，**不加表**）；`GET /api/profile` 返回 `fresh`；`MemoryPanel` 里的「夜间自动整理」开关 |
| 工作量 | S |
| 风险 | 几乎为零，反而降低隐私焦虑。回执要克制：同一条重复记忆不出回执 |
| 为什么不累赘 | 回执只在真的写入时出现；夜间那一行看过就消失 |

```
J.A.R.V.I.S.
  好的，以后订咖啡默认美式。
  ◉ 已记住：领导喝咖啡只喝美式 · 撤销 · 管理
                       ↓ 点「撤销」
  ◉ 已撤销（不会再记着这条）

今日
  ◉ 昨晚整理出 2 条新记忆 · 看看                 ×
```

### F4 今日简报卡

| 项 | 内容 |
| --- | --- |
| 价值 | 晨报电台现在只走微信、只服务唯一 Owner，Member 和不用微信的人什么都收不到。改成在「今日」板顶部放一张**默认折叠成一行**的简报，**每个账号都有** |
| 对标 | [ChatGPT Pulse](https://openai.com/index/introducing-chatgpt-pulse/)（卡片、👍👎）；[Gemini Daily Brief](https://blog.google/innovation-and-ai/products/gemini-app/next-evolution-gemini-app/)；[飞书每日工作总结](https://www.feishu.cn/hc/zh-CN/articles/777115286675-%E4%BD%BF%E7%94%A8%E6%99%BA%E8%83%BD%E4%BC%99%E4%BC%B4%E7%9A%84-%E6%AF%8F%E6%97%A5%E5%B7%A5%E4%BD%9C%E6%80%BB%E7%BB%93-%E5%9C%BA%E6%99%AF) |
| 放在哪 | 「今日」板顶部，放在「日程」区块之上 |
| 复用 | `RADIO_PROMPT` 的思路，以及 `weather_here`、`schedule_list`、`todo_list` 工具；`_service_invoke`（一次性 checkpoint，用完即删）；`tenant_prefs` 存当日缓存；`/api/dashboard` 数据用于确定性兜底 |
| 还缺 | `jarvis/brief.py`（提示词、解析、兜底）；`/api/brief` 的 GET、POST 和 feedback 接口；前端 `BriefCard` |
| 工作量 | M |
| 风险 | 费用：每用户每天最多 1 次 Agent 调用，而且只在当天第一次打开「今日」时生成，没打开就是零成本。可能幻觉：只允许引用工具结果，失败时退回到确定性的一行 |
| 为什么不累赘 | 只有一张卡，默认一行；可以「今天不再显示」，也可以在设置里关掉 |

```
今日                                           ×
┌▍☀ 22° 晴 · 2 项日程，下一项 15:00 复盘     ⌄ ┐   ← 默认一行，左侧 1px AI 渐变细边
└──────────────────────────────────────────────┘
展开：
│ 上海 18–24°，晴，不用带伞                      │
│ 10:00 周会 · 15:00 项目复盘                    │
│ 3 项待办，最久的是「整理会议材料」(5 天)        │
│ 两场会之间有 2 小时空档，适合清待办             │
│                       👍  👎  · 今天不再显示  │
```

### F5 可操作的提醒

| 项 | 内容 |
| --- | --- |
| 价值 | 提醒响了但现在不方便，目前只能点「知道了」，然后去对话里改期。改成就地「稍后 10 分钟」 |
| 对标 | HAX G8「Support efficient dismissal」、G9「Support efficient correction」；[Electron NotificationAction](https://www.electronjs.org/docs/latest/api/structures/notification-action) |
| 放在哪 | 网页 `Reminders.jsx` 弹条加一个按钮；桌面 `startReminderPolling` 的通知加点击动作；微信提醒文案末尾加「回『稍后』推迟 10 分钟」 |
| 复用 | `tenant_reminders_sent` 按 `(日程, when, 通道)` 去重，**改期后会按新时间自动再次提醒**，所以稍后等于把 `when` 加 10 分钟；微信的命令式解析可以照抄 `PUSH_BIND_COMMANDS` |
| 还缺 | `POST /api/schedule/{id}/snooze`；网页按钮；桌面通知的 click 处理（展开悬浮窗）；微信「稍后」短指令，只在最近一条提醒的 10 分钟内有效 |
| 工作量 | S（网页 + 微信）到 M（桌面原生按钮） |
| 风险 | macOS 原生通知按钮**要求应用签名**，并在 Info.plist 里设置 alert 样式 [S40]，开发版不会显示，所以先只做 click。微信「稍后」可能误触：限定在提醒后 10 分钟内，而且只认这一个词 |
| 为什么不累赘 | 不新增通知，只让已有通知更好处理 |

```
网页弹条： ⏰ 15:00 项目复盘            [稍后 10 分]  [知道了]
微信：     ⏰ 日程提醒：15:00 项目复盘（回「稍后」推迟 10 分钟）
           你：稍后
           贾维斯：好的，15:10 再叫你。
```

### F6 送达与免打扰

| 项 | 内容 |
| --- | --- |
| 价值 | 主动来源越来越多（提醒、Heartbeat、晨报、纪要邮件，以后还有 F4、F7、F11），需要一个地方统一决定「走哪条渠道、几点闭嘴」，并补上飞书推送 |
| 对标 | [Apple 减少干扰与通知摘要](https://support.apple.com/guide/iphone/summarize-notifications-reduce-interruptions-iph1fbe7d2b9/ios)；[飞书 aily 定时任务由机器人推送结果](https://aily.feishu.cn/hc/1u7kleqg/2sav1okv)；HAX G17「Provide global controls」 |
| 放在哪 | 设置中心现有的「语音」页签（晨报时间就在这里），新增一个「主动找你」小节，**不新增页签** |
| 复用 | `reminders.py`、`heartbeat.py`、`PendingOutbox`；`wechat.push_text`；飞书 `api.send(receive_id_type, …)` 加上 `bindings` 里的 open_id；`tenant_prefs` |
| 还缺 | 飞书 push 函数；免打扰队列（夜间只攒 Heartbeat 和例行结果，早上合并成一条或并入 F4，**日程提醒照常发**）；Heartbeat 改成按用户读关注清单（现在是全局文件） |
| 工作量 | M |
| 风险 | 漏发：免打扰不拦用户亲手设的日程，设置页明确写出这一点 |
| 为什么不累赘 | 它是减少打扰的功能，只占设置里的一小节 |

```
设置中心 › 语音
  晨报电台   07:30
  ── 主动找你 ──────────────────────────────
  送达到     [✓] 微信  [✓] 飞书  [✓] 桌面  [✓] 网页
  免打扰     22:30 – 08:00
             日程提醒照常；巡检和例行结果攒到早上合并成一条
  巡检频率   ○ 关   ● 每 30 分钟   ○ 每 2 小时
```

### F7 会前一页纸

| 项 | 内容 |
| --- | --- |
| 价值 | 会前 5 分钟的提醒顺带告诉你上次同名会议留下了哪些属于你的待办，并给一个「开始记纪要」按钮，免得忘开录音 |
| 对标 | [Notion 检测到会议开始时弹通知提示转写](https://www.notion.com/help/ai-meeting-notes)；Pulse 的「会前简报」[S4]；HAX G4「Show contextually relevant information」 |
| 放在哪 | 已有的日程提醒通道（网页弹条、桌面通知、微信） |
| 复用 | `ReminderScanner`；`tenant_meetings`（含纪要正文）；`extract_todos`（「导入待办」已经在用）；`meeting.desktop_commands.put` 下发开始指令 |
| 还缺 | 给像会议的日程（标题含会、评审、面试、约、拜访）加 T-5 分钟提前窗口；同名或高重合标题的匹配（确定性规则，不用模型）；`POST /api/meetings/start` |
| 工作量 | M |
| 风险 | 匹配错了很尴尬：只在标题严格匹配时才附上下文，否则退回普通提醒。打扰：每场会只多 1 条，而且受 F6 控制 |
| 为什么不累赘 | 不新增提醒类型，只给已有提醒加一行上下文和一个按钮 |

```
⏰ 14:55 · 15:00 产品评审（5 分钟后）
   上次「产品评审」(9/26) 你的待办：补齐竞品截图、确认排期
   [开始记纪要]  [知道了]
```

### F8 转发即办

| 项 | 内容 |
| --- | --- |
| 价值 | 微信或飞书里别人发来「周四下午两点 3 楼开预算会，带上 Q3 数据」，转发给贾维斯，它**提议**加成日程和待办，回个数字就写入 |
| 对标 | [元宝：转发聊天记录一键总结并提炼待办](https://www.chinaz.com/ainews/27939.shtml)；[Mail Manus：转发即派活](https://manus.im/docs/features/mail-manus)；[Google CC：回复邮件即调教](https://9to5google.com/2025/12/16/google-labs-cc/) |
| 放在哪 | 微信和飞书的现有会话。飞书用卡片按钮（`card.action.trigger` 支持长连接模式 [S41]） |
| 复用 | `wechat.link_summary_prompt` 的包装模式；F2 解析器（确定性判断里有没有时间）；`schedule_add`、`todo_add`；飞书 `parse_content` |
| 还缺 | 每个联系人一个「待确认」短状态（TTL 10 分钟）；飞书 `merge_forward` 解析；卡片回调处理；提示词规则「检测到事项只提议，不直接写」 |
| 工作量 | S（微信文本）到 M（飞书卡片和合并转发） |
| 风险 | 误写入：**永远先确认**。打扰：只在内容带时间或截止词时提议，普通闲聊不提议 |
| 为什么不累赘 | 不新增入口，用户本来就在 IM 里 |

```
你（转发）：周四下午两点 3 楼开预算会，请带上 Q3 数据
贾维斯：要点：10/08(四) 14:00 预算会 @3 楼；需准备 Q3 数据。
        要记下来吗？ 1 = 日程  2 = 日程+待办「带上 Q3 数据」  0 = 不用
你：2
贾维斯：已加日程 10/08 14:00 预算会，并加待办「带上 Q3 数据」。
```

### F9 问屏幕

| 项 | 内容 |
| --- | --- |
| 价值 | 按 ⌥Q 时如果没选中文字，现在什么都不发生。改成弹出「问问当前窗口」：截取当前窗口，**先给缩略图确认**，再发去识别和提问 |
| 对标 | [Raycast Screen Awareness](https://manual.raycast.com/ai/screen-awareness)（按热键才截取，后台不采集、不存储）；[Siri AI 屏幕感知](https://www.apple.com/newsroom/2026/06/apple-introduces-siri-ai-a-profoundly-more-capable-and-personal-assistant/)；[豆包截屏提问](https://zhuanlan.zhihu.com/p/1951638145033561848) |
| 放在哪 | 桌面端现有的 ⌥Q 划词条（`renderer.js` 的 `#quickbar`），**不新增热键** |
| 复用 | `triggerQuickAsk`；`desktopCapturer`（会议功能已在用）；会议功能已经申请过的「屏幕录制」权限；`/api/upload` 的图片分支走 `vision.describe_image`（qwen3-vl） |
| 还缺 | 当前窗口截图（`getSources({types:['window']})` 的缩略图）；划词条缩略图和「发送」确认；IPC |
| 工作量 | M |
| 风险 | **隐私**：截图会发到云端视觉模型。对策是只在按键后截取、先预览再发、只保存识别文本不保存图片。费用：每次一次视觉调用 |
| 为什么不累赘 | 复用 ⌥Q 的空分支，选中了文字时行为完全不变 |

```
（未选中文字时按 ⌥Q）
┌──────────────────────────────┐
│ [当前窗口缩略图]  Safari · 报销单 │
│ 问点什么…▌                      │
│ [解释] [总结] [翻译]   发送 ↵   │
│ ⓘ 截图仅用于本次识别，不保存      │
└──────────────────────────────┘
```

### F10 翻旧账（对话全文回忆）

| 项 | 内容 |
| --- | --- |
| 价值 | 「上次你推荐的那家日料叫什么？」现在答不出来：画像只存稳定事实，⌘K 也只搜标题。改成能答，并给出「出自 9/21《周末去哪吃》」，点击即可跳转 |
| 对标 | [Claude 搜索过往对话](https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context)；[ChatGPT 参考聊天记录](https://help.openai.com/en/articles/8590148-memory-faq)；Siri AI 个人上下文 [S15] |
| 放在哪 | 对话（新工具 `recall_chats` 的 chip）和 ⌘K 的「对话」组（正文命中） |
| 复用 | `_distill_collect` 已经示范了怎么从 checkpoint 读出各线程消息；`tenant_threads`；`CommandPalette` 的对话分组 |
| 还缺 | SQLite FTS5 索引表 `tenant_message_index`（**需要新 schema 版本**，见 PROGRESS「加表必须开新版本」教训），每轮结束写入并回填历史；`recall_chats` 工具；`GET /api/search?q=`；删线程时同步删索引 |
| 工作量 | M |
| 风险 | 隐私：只在本地，排除服务线程，删除可传导。工具数从 26 变成 27，需要同步更新文档和计数测试 |
| 为什么不累赘 | 没有新界面，用户照常提问，⌘K 搜得更全 |

```
你：上次你推荐的那家日料叫什么？
  [🔎 翻旧账 ✓ 38ms]
J.A.R.V.I.S.：是「鮨 心」，在静安寺附近，人均 400 左右。
  出自 9/21《周末去哪吃》 →
```

### F11 例行任务

| 项 | 内容 |
| --- | --- |
| 价值 | 「每周五下午 5 点帮我回顾这周完成的待办」「每天 8 点看一下某关注话题有没有新消息」，说一次就会反复执行 |
| 对标 | [ChatGPT Tasks](https://help.openai.com/en/articles/10291617-scheduled-tasks-in-chatgpt)；[Gemini Scheduled actions，最多 10 个](https://support.google.com/gemini/answer/16316416)；[豆包任务模式定时任务](https://www.ithome.com/0/963/725.htm)；[飞书 aily 定时任务](https://aily.feishu.cn/hc/1u7kleqg/2sav1okv) |
| 放在哪 | 只能在对话里创建，回答下方出回执「⟳ 例行 · 每周五 17:00 · 暂停 · 删除」；「今日」板日程区下方加一行「例行 2」（可展开），**不做管理页** |
| 复用 | `MorningRadio` 的调度循环和成本护栏（窗口、当日记账、失败不重烧）；`_service_invoke`；`PendingOutbox`；F6 送达规则；Heartbeat 的 `PASS`（没新内容就不发） |
| 还缺 | `tenant_routines` 表（新 schema 版本）；`routine_add`、`routine_list`、`routine_del` 工具；通用调度器；顺带把 `HEARTBEAT.md` 关注清单迁移成「盯着」类例行，改成对话维护、按用户隔离 |
| 工作量 | M–L |
| 风险 | **费用和打扰都最高**：每次运行都是一次 Agent 调用，可能还要联网搜索。护栏：每用户最多 3 个，粒度至少每天一次，连续 3 次 `PASS` 自动暂停并告知，免打扰时段内的结果并入早间简报 |
| 为什么不累赘 | 没有管理页，生命周期都在对话和一行列表里。但它**必须排在 F6 之后**，否则会变成打扰源 |

```
你：每周五下午5点帮我回顾这周完成了哪些待办
J.A.R.V.I.S.：好的，每周五 17:00 发你一份本周回顾。
  ⟳ 例行 · 每周五 17:00 · 送达：微信、网页 · 暂停 · 删除

今日 › 日程
  …
  ⟳ 例行 2 项 ⌄
```

### F12 「/」快捷指令

| 项 | 内容 |
| --- | --- |
| 价值 | `skills/` 里的技能目前只能隐式生效，用户不知道有哪些。输入框里打「/」就列出技能和内置指令（/晨报、/总结链接、/翻译） |
| 对标 | [Dia Skills 斜杠调用](https://browsercompany.substack.com/p/the-strategy-behind-dias-design)；[Raycast AI Commands](https://manual.raycast.com/ai/ai-commands)；[Gems 迁移为 skills](https://support.google.com/gemini/answer/18560919)；[Notion /meet](https://www.notion.com/help/ai-meeting-notes) |
| 放在哪 | `Chat.jsx` 输入框（行首输入「/」时才弹出）；⌘K 增加「技能」组 |
| 复用 | `prompts.load_skills()`（名称与正文）；空态 `SUGGESTIONS` |
| 还缺 | `GET /api/skills`（只返回名称和一句说明）；弹层组件；每用户自定义常用指令（`tenant_prefs` JSON，第二步） |
| 工作量 | S–M |
| 风险 | 低。但价值有限：技能是 Owner 级文件，多数用户没有自定义技能 |
| 为什么不累赘 | 不打「/」就看不见 |

```
┌──────────────────────────────┐
│ /晨报      天气、日程、待办一次说清 │
│ /总结链接  读网页并列 5 条要点     │
│ /龙虾      （skills/lobster）      │
└──────────────────────────────┘
│ /▌                                   │
```

---

## 4 评分表

各维度 1 到 5 分。**实现成本**和**打扰度**都是分数越高越好（越省、越安静）。
**权重**：用户价值 35%，实现成本 20%，打扰度 25%，与现有能力契合度 20%。

| 排名 | 编号 | 名称 | 用户价值 | 实现成本 | 打扰度 | 契合度 | **加权分** |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | F2 | 一句话速记 | 4 | 4 | 5 | 5 | **4.45** |
| 2 | F3 | 记忆回执 | 4 | 5 | 4 | 5 | **4.40** |
| 3 | F4 | 今日简报卡 | 5 | 3 | 4 | 5 | **4.35** |
| 4 | F1 | ⌘K 直接吩咐 | 3 | 5 | 5 | 5 | **4.30** |
| 5 | F5 | 可操作的提醒 | 4 | 3 | 5 | 5 | **4.25** |
| 5 | F10 | 翻旧账 | 4 | 3 | 5 | 5 | **4.25** |
| 7 | F6 | 送达与免打扰 | 4 | 3 | 5 | 4 | **4.05** |
| 7 | F9 | 问屏幕 | 4 | 3 | 5 | 4 | **4.05** |
| 9 | F8 | 转发即办 | 3 | 4 | 4 | 4 | **3.65** |
| 10 | F7 | 会前一页纸 | 4 | 3 | 3 | 4 | **3.55** |
| 11 | F12 | 「/」快捷指令 | 2 | 4 | 5 | 3 | **3.35** |
| 12 | F11 | 例行任务 | 4 | 2 | 2 | 4 | **3.10** |

**读法**：

- 排在前面的都是「把已有能力用得更顺」的功能，排在后面的都是「新开一条主动通道」的功能。这符合克制原则：先把通道用好，再开新通道。
- F11 分低不是因为价值低，而是它的打扰和成本风险最高。建议顺序是 **F6 → F11**，并把 Heartbeat 关注清单一起迁进去。
- F1 和 F2 共用同一个解析器。F2 交付后，F1 只剩不到半天的工作量，可以作为第一批的加分项。

**建议路线**：
- 第一批：F2、F3、F4，外加 §0 的减法。
- 第二批：F1、F5、F6、F10。
- 第三批：F9、F8、F7。
- 视反馈再定：F11、F12。

---

## 5 首批推荐 3 项（可直接派发）

**三项共同约束**：
- 不新增顶栏按钮，也不新增页签。
- 不新增数据库表，只用 `tenant_prefs`。
- 前端改动后执行 `cd web-src && npm run build`，并把 `jarvis/web` 产物一起提交。
- 全量 `pytest -q`、`npx vitest run`、`node --test` 都要 0 失败。
- 三项都改 `Panels.jsx`。建议**同一代理按 F2 → F3 → F4 串行做**；如果要并行，F4 的卡片放进新文件 `Brief.jsx`，`Panels.jsx` 只插入一行挂载，以减少冲突。

### ① F2 一句话速记

**目标**：在「今日」板的待办输入框里，写上时间就成为日程，没写时间就照旧是待办。整个过程零模型调用、零新输入框。

**最小可行范围**

| 做 | 不做（以后再说） |
| --- | --- |
| 纯前端解析器 `web-src/src/quickAdd.js`：`parseQuickAdd(text, now) → {kind:'schedule', title, when:'YYYY-MM-DD HH:MM', matched} \| {kind:'todo', title}` | 重复规则（每周三）、时区、英文日期 |
| `Panels.jsx` 待办输入框下方的预览 chip，带「改成待办」 | 桌面端任务台（第二步复用同一模块） |
| placeholder 改为「＋ 待办或日程，写上时间就是日程」 | 后端解析接口 |

**解析规则 v1**

| 类别 | 支持的写法 | 规则 |
| --- | --- | --- |
| 相对日期 | 今天、今晚、明天、明早、明晚、后天、大后天 | 今晚、明晚的默认时段是「晚上」 |
| 星期 | 周一到周日、星期X、礼拜X、下周X | 本周还没过的那天；已经过了就取下周 |
| 绝对日期 | X月X日、X月X号、X号、M/D | 当年；已经过了就取次年 |
| 时段 | 凌晨、早上、上午、中午、下午、傍晚、晚上 | 下午、傍晚、晚上的 1 到 11 点加 12 小时 |
| 时刻 | X点、X点半、X点一刻、X点三刻、X点Y分、HH:MM；中文数字一到十二、「两点」 | 没有时段时：1 到 6 点按下午，7 到 11 点按上午，12 点按中午 |
| 只有时刻 | 例如「3点开会」 | 取今天；已经过了就取明天，chip 里写明「明天」 |
| 只有日期 | 例如「周三交电费」 | 默认 09:00；如果是今天且 09:00 已过，就按待办处理 |
| 标题 | 剩余文本 | 去掉命中的时间片段，以及「提醒我、记得、要」等引导词；标题为空则不提交 |

**验收标准**（固定 `now = 2026-10-02 周五 10:00`）

1. 解析器的 vitest 至少 24 条，必须包含下表全部用例：

| 输入 | 期望 |
| --- | --- |
| 明天下午3点 项目复盘 | 日程 2026-10-03 15:00「项目复盘」 |
| 3点开会 | 日程 2026-10-02 15:00「开会」 |
| 9点 晨跑 | 日程 2026-10-03 09:00「晨跑」（今天已过） |
| 下周一 10:30 面试 | 日程 2026-10-05 10:30「面试」 |
| 周三交电费 | 日程 2026-10-07 09:00「交电费」 |
| 周五 6点 聚餐 | 日程 2026-10-02 18:00「聚餐」 |
| 10月8号 交周报 | 日程 2026-10-08 09:00「交周报」 |
| 提醒我晚上8点半给妈妈打电话 | 日程 2026-10-02 20:30「给妈妈打电话」 |
| 明早7点一刻 出发 | 日程 2026-10-03 07:15「出发」 |
| 后天 14:00 牙医 | 日程 2026-10-04 14:00「牙医」 |
| 凌晨2点 看比赛 | 日程 2026-10-03 02:00「看比赛」 |
| 两点 打电话 | 日程 2026-10-02 14:00「打电话」 |
| 今天 交电费 | 待办「今天 交电费」（09:00 已过） |
| 整理会议材料 | 待办 |
| 买 3 本书 | 待办（数字后面不是「点」，不算时间） |

2. 输入时实时出现预览 chip，不发任何网络请求；点「改成待办」或按 Esc 后，本次输入按待办处理。
3. 回车后：日程调用 `addSchedule(title, when)`，待办调用 `addTodo(text)`；成功后清空输入框并刷新列表。服务端返回 422 时，chip 显示错误原文，输入框不清空。
4. 日程区块**不新增**任何输入框；`Panels.test.jsx` 补 2 个用例：时间文本走 `addSchedule`，普通文本走 `addTodo`。
5. 改动白名单：`web-src/src/quickAdd.js`（新）、`quickAdd.test.js`（新）、`Panels.jsx`、`Panels.test.jsx`、`styles.css`，以及 `jarvis/web/` 产物。**后端零改动。**

### ② F3 记忆回执

**目标**：每一次「记住」和「忘记」当场可见、一键可撤；夜间蒸馏写了什么，第二天有一行提示；用户可以一键关掉夜间蒸馏。

**最小可行范围**

| 做 | 不做 |
| --- | --- |
| `Chat.jsx`：收到 `tool_result` 且 `name === 'profile_remember'`、`ok`，并且 detail 匹配 `^记住了（编号 (\d+)）：(.+)$` 时，在该条回答下渲染回执行；`profile_forget` 成功时渲染「◉ 已忘记编号 N」 | 历史回放里的回执（`getHistory` 不含工具事件） |
| 「撤销」调用现有 `deleteProfile(id)`，成功后回执变成「已撤销」并置灰；「管理」通过 Hud 新 prop `onOpenMemory` 打开 `MemoryPanel` | 桌面端回执、记忆分类、来源列 |
| `server.py` 的 `_distill_remember` 每写入一条新条目，就把 id 记进 `tenant_prefs` 的 `distill_fresh`（JSON：`{date, ids}`，新批次覆盖旧批次） | 新增表或 schema 版本 |
| `GET /api/profile` 增加 `fresh: [ids]`；新增 `POST /api/profile/fresh/ack`（鉴权、CSRF、租户隔离沿用 `_panel_write`） | |
| 「今日」板顶部一行「◉ 昨晚整理出 N 条新记忆 · 看看」：点击后打开 `MemoryPanel` 并高亮这些条目，同时调用 ack | |
| `MemoryPanel` 加开关「夜间自动整理记忆」（pref `distill_enabled`，默认开）；`NightlyDistiller.scan_once` 关闭时不 collect、不 compose | |

**验收标准**

1. vitest：模拟 SSE 事件 `tool_result{name:'profile_remember', ok:true, detail:'记住了（编号 7）：领导喝咖啡只喝美式'}`，回答下出现回执；点撤销后 `deleteProfile(7)` 被调用，文案变成「已撤销」。
2. vitest：detail 为「这条我已经记着了（编号 7）…」时，**不**渲染回执。
3. pytest：蒸馏写入 2 条新事实，`/api/profile` 返回的 `fresh` 长度为 2；ack 后为 0；次日新批次覆盖旧批次；内容重复（`existed`）的条目不计入 `fresh`。
4. pytest：`distill_enabled=0` 时 `scan_once` 返回 0，注入的 collect 和 compose 调用次数都是 0。
5. pytest：A 账号的 `fresh` 对 B 账号不可见（租户隔离）。
6. 「今日」板在 N 为 0 时不渲染这一行（DOM 中不存在）；回执用 `Icon` 的 `sparkles` 和 `--jv-*` token，亮、暗主题都清晰可读。
7. 改动白名单：`web-src/src/{Chat,Hud,MemoryPanel,Panels}.jsx`、`api.js`、`styles.css` 及对应测试；`jarvis/server.py`（profile 路由和 `_distill_remember`）、`jarvis/distill.py`；`tests/` 新增用例。

### ③ F4 今日简报卡

**目标**：每个账号每天在「今日」板顶部看到一张默认一行、可展开到 4 行的 AI 简报。每用户每天最多 1 次模型调用；失败时退回确定性的一行，不报错。

**最小可行范围**

| 做 | 不做（第二步） |
| --- | --- |
| 新模块 `jarvis/brief.py`：`BRIEF_PROMPT` 要求固定 4 行（天气、日程、待办、一句建议），每行不超过 28 字，不用 Markdown 和 URL，只引用工具结果；`parse_brief()`；`fallback_brief(dashboard)` 用日程数、下一项和待办数拼一行，零模型 | 朗读（TTS）、推送到微信或飞书（并入 F6） |
| 路由：`GET /api/brief` 返回 `{date, status: 'ready'\|'none'\|'off', lines, source: 'model'\|'fallback'}`；`POST /api/brief` 当日没生成时生成一次，已生成就返回缓存；`POST /api/brief/feedback {vote}`；`PUT /api/brief/settings {enabled}` | 与晨报电台共用同一次生成 |
| 生成走 `_service_invoke(user, "brief", "今日简报", BRIEF_PROMPT)`；`brief` 加入服务线程常量，并随 §0 的减法不出现在侧栏 | 多张卡片、联网新闻、按兴趣研究 |
| 每用户一把 `threading.Lock`，加上 `tenant_prefs` 记账 `brief:{date}`，保证同一天只生成一次 | |
| 前端新文件 `Brief.jsx`：本地时间不早于 05:00 才挂载；状态为 none 时自动 POST 一次；折叠态一行加 ⌄，展开后 4 行加 👍、👎、「今天不再显示」；左侧 1px `--jv-ai-gradient`；加载时显示一行骨架，不转圈 | |
| 「今天不再显示」写入 `localStorage` 的 `jws_brief_hide=<date>`，读写都要 try/catch | |
| 最近 5 次 👎 记进 pref；下次生成时在提示词末尾加一句「主人最近嫌简报啰嗦，只说要紧的」 | |
| 设置中心「语音」页签里、晨报电台下方，加「今日简报卡」开关，默认开 | |

**验收标准**

1. pytest（注入假 compose 计数）：
   - 同一天连续 POST 3 次，compose 只调用 1 次；
   - 5 个线程并发 POST，compose 仍然只调用 1 次；
   - 跨日后重新生成；
   - `enabled=false` 时 GET 返回 `off`，POST 不调用 compose；
   - compose 抛异常时返回 `source:'fallback'`，当天再次 POST 也不重试；
   - `/api/threads` 里没有 `brief`（也没有 radio、heartbeat、distill、meeting）。
2. pytest：模型输出带 Markdown 或超过 4 行时，`parse_brief` 截成 4 行并去掉符号；输出为空时走 fallback。
3. vitest：
   - none 状态自动 POST 后渲染出一行；
   - 展开和收起正常；
   - 👍 调用 feedback；
   - 点「今天不再显示」后，同日重新挂载不再渲染；
   - `off` 和 05:00 之前都不渲染；
   - `localStorage` 抛异常时卡片仍能正常显示。
4. 视觉：折叠态高度不超过 44px；不改变「今日」板其他区块的顺序；亮、暗主题各截一张图放进 `output/`（不提交）。
5. 可选：用真实模型手测一次，确认输出 4 行、不含 URL 或 Markdown、数字与 `/api/dashboard` 一致。
6. 改动白名单：`jarvis/brief.py`（新）、`jarvis/server.py`（路由和服务线程常量）、`tests/test_brief.py`（新）；`web-src/src/Brief.jsx`（新）、`Brief.test.jsx`（新）、`Panels.jsx`（只插一行挂载）、`ProviderSettings.jsx`（开关）、`api.js`、`styles.css`；`jarvis/web/` 产物。

---

## 6 明确不建议做

| # | 看起来很酷的功能 | 不建议的理由 | 替代 |
| --- | --- | --- | --- |
| N1 | **全自主「虚拟电脑」Agent 模式**（Kimi OK Computer [S19]、Manus、豆包任务模式「操作本地电脑」[S18]） | 私有部署要自建沙箱，安全面陡增；一次任务就要几十次模型调用，成本不可控；长任务还需要进度页，和「不开新门」直接冲突；贾维斯定位是管家，不是工作站 | 用 26 个工具组合；以后需要再加单个工具 |
| N2 | **Canvas 或 Artifacts 式侧边编辑区** [S8] | 宽屏布局已经是三栏（会话栏、对话、「今日」），第四块面板会和「今日」抢位置；管家场景很少需要长文协作 | 已有「导出为 Markdown」，长文交给专业编辑器 |
| N3 | **Pulse 式多卡信息流**，每天 5 到 10 张主题研究卡 [S4] | 信息流就是注意力黑洞；成本约为单卡的 10 倍；免费搜索链（SearXNG、DDGS）会被频繁调用 | F4 只做一张卡 |
| N4 | **全天屏幕或麦克风常驻记录**（类 Recall） | 隐私代价太大。Microsoft Recall 因此被迫改成可选启用并多次延期 [S42]；贾维斯的唤醒词刚做到「本地 VAD、静音零上传」，不能倒退 | F9 只在用户按键时截一次 |
| N5 | **再加人格、场景，或者生图生视频** | 已有 9 个通话场景和 2 个人格，再加就是内容膨胀；生图依赖 Provider，而且贵（PROGRESS 记载「生图：等 Provider 侧配置」） | 用 `skills/` 让用户自己长技能，需要时配合 F12 暴露出来 |

---

## 7 参考来源

产品

- [S1] ChatGPT · Scheduled tasks：https://help.openai.com/en/articles/10291617-scheduled-tasks-in-chatgpt
- [S2] ChatGPT · Memory FAQ：https://help.openai.com/en/articles/8590148-memory-faq
- [S3] OpenAI · Memory and new controls：https://openai.com/index/memory-and-new-controls-for-chatgpt/
- [S4] OpenAI · Introducing ChatGPT Pulse：https://openai.com/index/introducing-chatgpt-pulse/
- [S5] ChatGPT · Projects：https://help.openai.com/en/articles/10169521-projects-in-chatgpt
- [S6] Anthropic · Bringing memory to Claude：https://claude.com/blog/memory
- [S7] Claude · Chat search and memory：https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context
- [S8] Claude · What are artifacts：https://support.claude.com/en/articles/17153992-what-are-artifacts-and-how-do-i-use-them
- [S9] Gemini · Schedule actions：https://support.google.com/gemini/answer/16316416
- [S10] Google · Gemini app 更主动（Daily Brief / Spark，2026-05-19）：https://blog.google/innovation-and-ai/products/gemini-app/next-evolution-gemini-app/
- [S11] Gemini · Daily brief 帮助：https://support.google.com/gemini/answer/17077455
- [S12] Google · Gemini Live 接入 Calendar、Tasks、Keep：https://blog.google/products-and-platforms/products/gemini/gemini-live-updates-august-2025/
- [S13] Gemini · Gems 迁移为 skills：https://support.google.com/gemini/answer/18560919
- [S14] 9to5Google · Google Labs CC：https://9to5google.com/2025/12/16/google-labs-cc/
- [S15] Apple Newsroom · Siri AI（2026-06-08）：https://www.apple.com/newsroom/2026/06/apple-introduces-siri-ai-a-profoundly-more-capable-and-personal-assistant/
- [S16] Apple · Writing Tools（Mac）：https://support.apple.com/guide/mac-help/writing-tools-write-improve-summarize-mchldcd6c260/mac
- [S17] 知乎 · 豆包电脑版提效玩法（划词、截屏提问）：https://zhuanlan.zhihu.com/p/1951638145033561848
- [S18] IT之家 · 豆包上线「任务模式」（含定时任务）：https://www.ithome.com/0/963/725.htm
- [S19] IT之家 · Kimi Agent 模式 OK Computer：https://www.ithome.com/0/885/750.htm
- [S20] Apple · 通知摘要与减少干扰：https://support.apple.com/guide/iphone/summarize-notifications-reduce-interruptions-iph1fbe7d2b9/ios
- [S21] Raycast · Quick AI：https://manual.raycast.com/ai/quick-ai
- [S22] Raycast · AI Commands：https://manual.raycast.com/ai/ai-commands
- [S23] Raycast · Screen Awareness：https://manual.raycast.com/ai/screen-awareness
- [S24] The Browser Company · The strategy behind Dia's design：https://browsercompany.substack.com/p/the-strategy-behind-dias-design
- [S25] Dia · Changelog（Skills）：https://www.diabrowser.com/changelog
- [S26] Notion · AI Meeting Notes：https://www.notion.com/help/ai-meeting-notes
- [S27] Manus · Mail Manus：https://manus.im/docs/features/mail-manus
- [S28] 经济参考报 · 元宝入驻微信（2025-04）：http://jjckb.xinhuanet.com/20250417/0381b367dbfd497fae62e4507a59a379/c.html
- [S29] 站长之家 · 元宝支持微信聊天记录一键总结与待办提炼（2026-05）：https://www.chinaz.com/ainews/27939.shtml
- [S37] 飞书 · 智能伙伴「每日工作总结」：https://www.feishu.cn/hc/zh-CN/articles/777115286675-%E4%BD%BF%E7%94%A8%E6%99%BA%E8%83%BD%E4%BC%99%E4%BC%B4%E7%9A%84-%E6%AF%8F%E6%97%A5%E5%B7%A5%E4%BD%9C%E6%80%BB%E7%BB%93-%E5%9C%BA%E6%99%AF
- [S38] 飞书 aily · 定时任务：https://aily.feishu.cn/hc/1u7kleqg/2sav1okv
- [S39] Todoist · Task Quick Add：https://www.todoist.com/help/articles/use-task-quick-add-in-todoist-va4Lhpzz

设计指南

- [S30] Apple HIG · Generative AI（2026-06-08 更新）：https://developer.apple.com/design/human-interface-guidelines/generative-ai
- [S31] Apple HIG · Siri：https://developer.apple.com/design/human-interface-guidelines/siri
- [S32] Apple HIG · Machine learning：https://developer.apple.com/design/human-interface-guidelines/machine-learning
- [S33] Microsoft · HAX 18 条人机交互指南：https://www.microsoft.com/en-us/haxtoolkit/ai-guidelines/
- [S34] Microsoft Research · Guidelines for Human-AI Interaction（CHI 2019）：https://www.microsoft.com/en-us/research/publication/guidelines-for-human-ai-interaction/
- [S35] Google PAIR · People + AI Guidebook：https://pair.withgoogle.com/guidebook/
- [S36] PAIR · Feedback + Control：https://pair.withgoogle.com/chapter/feedback-controls/；Mental Models：https://pair.withgoogle.com/chapter/mental-models/；Errors + Graceful Failure：https://pair.withgoogle.com/chapter/errors-failing/；Explainability + Trust：https://pair.withgoogle.com/chapter/explainability-trust/

技术与反例

- [S40] Electron · NotificationAction（macOS 按钮需签名）：https://www.electronjs.org/docs/latest/api/structures/notification-action
- [S41] 飞书开放平台 · 卡片回传交互回调：https://open.feishu.cn/document/feishu-cards/card-callback-communication
- [S42] Computerworld · Recall 因隐私争议改为可选启用：https://www.computerworld.com/article/2140187/microsoft-makes-windows-recall-opt-in-after-privacy-security-backlash.html

> 引用说明：HAX 的编号沿用 CHI 2019 论文原序。G3 Time services based on context，G4 Show contextually relevant information，G5 Match relevant social norms，G7 Support efficient invocation，G8 Support efficient dismissal，G9 Support efficient correction，G11 Make clear why the system did what it did，G16 Convey the consequences of user actions，G17 Provide global controls，G18 Notify users about changes。
