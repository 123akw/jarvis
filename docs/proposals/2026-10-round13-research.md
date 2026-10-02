# 第十三轮调研：「神经」、对标、清单校准、插件定价

2026-10-02 · 代理 R。配套：方案与契约 `2026-10-round13-platform.md`，演示剧本 `../demo/round13-pitch.md`，演示资料 `../demo/sample-project.md`（虚构）。只给建议，不改代码；带「未核实」的条目上台前别当事实讲。产品形态以用户修正为准：挑插件 → 专属账号口令 → 现有登录页登录 → 专属智能体（界面叫「智能体」），积木流程与结果页二维码保留。

## 0 结论速览

1. **「神经」最可能是苹果「捷径」**（Shortcuts，前身付费 App Workflow，谐音转写误差），置信度中；功能上最像「拼完给链接」的是 Google Opal，但它据报将于 2026-11 关停。
2. **交互方向对**：捷径证明「竖排卡片链 + 底部卡片网格选积木 + 推荐下一步」最好懂，自由画布劝退新手——契约第一版做一条链是正确的。
3. **对标共性**：一句话生成要「先出计划 → 用户确认」；新手入口是「模板 + 一键复制」；交付物是「一张表单 + 一个链接」，**访客免登录**和**微信里能打开**决定成败——我们的结果页二维码正好对上。
4. **清单校准**：8 个 id 不动，改显示名和排序（店主第一）；模板默认落到「生成分享页」，不带飞书积木（新账号没绑飞书）；「翻旧账」「票务比价」等改成人话。
5. **定价**：基础插件永久免费；4 个专业插件 9.9 元 / 月 / 个；全包 19.9 元 / 月（年付 168）；不做 1 元首月、不玩隐藏续费。
6. **演示**：按修正形态（挑插件 → 专属账号口令 → 登录即专属智能体 → 积木流程 → 结果二维码），虚构「邻里鲜」资料；主线不依赖飞书，最大现场风险是注册限流、模型慢、扫码。

## 1 「神经」是哪款产品

**最可能：苹果「捷径」（Shortcuts，前身付费 App Workflow），置信度中。** 「捷径 jié jìng」与「神经 shén jīng」韵母、声调相近，转写易错；iOS 12 时它的中文名就叫「捷径」（后改「快捷指令」）。前身 Workflow 只在苹果上有、卖 $2.99（国区 ¥18），2015 年获 Apple 设计奖、2017 年被苹果收购，玩法正是把一个个「动作」拼成流程并用链接分享。不吻合处：现在免费且系统自带；火在 2015–2019，不是「前两年」；分享出去的是一条捷径，不是网页小应用；原生二维码分享未核实。如果会上强调的是「拼完生成一个可分享的小应用链接」，功能最像的是 **Google Opal**（但它是免费网页，不谐音）。没找到叫 Nerve / Neuron / Synapse / 神经且符合描述的产品，中文社区也没有把某节点 App 叫「神经」的说法。

| 候选 | 平台 / 价格 | 火的时间 | 吻合 | 不吻合 |
| --- | --- | --- | --- | --- |
| 捷径 / Workflow [1][2][3] | iOS / macOS；Workflow $2.99，2017 起免费 | 2014 上线，2015 获奖，2018 改名 Shortcuts | 谐音最近、只在苹果、曾付费、动作拼接、iCloud 链接分享 | 现免费；输出不是网页 |
| Google Opal [4][5][6] | 网页，免费；2025-11 扩到 160+ 国家，2025-12 进 Gemini | 2025-07 发布 | 卡片节点拼 AI 小应用，一键发布得公开网址 | 非苹果 App、不付费、不谐音 |
| Weavy（现 Figma Weave）[7] | 网页 | 2024–2025，2025-10 被 Figma 收购 | 节点画布，流程可发布成表单式小应用 | 非苹果 App |
| Glif [8] / Wabi [9] | Glif 网页按积分；Wabi 仅 iPhone，2026-01 上线 | 2024 / 2026 | 可分享、可「复制改造」的小应用 | Glif 非苹果；Wabi 无节点、太新 |

**拼接交互（以捷径和 Opal 为主）**

- **捷径：竖排动作卡片**，不是自由画布；上一步输出自动流到下一步，也可点选引用前面任意一步（「魔法变量」）。**选择界面**是编辑器底部的搜索栏抽屉：空白时显示搜索框、推荐动作、置顶动作和分类（脚本 / 文本 / 设备 / 媒体 / 共享 / 网页……），另有按 App 筛选；每加一个动作就**推荐下一步**；iOS 18.1 起常用的「请求输入」「显示结果」排最上 [10][11]。点一下加到末尾、拖动重排，播放键运行，可「添加到主屏幕」，「拷贝 iCloud 链接」分享。
- **Opal：三色卡片**（输入黄 / 生成蓝 / 输出绿 + 资源卡）。**选择界面没有大菜单**，只有工具栏上几个固定按钮「输入 / 生成 / 输出 / 添加资源」，也能一句话生成整条流程；连线靠拖或在提示词里 @ 引用。「应用 / 编辑」两种视图切换，Console 按步显示过程、可单步重跑；结果是 AI 排版的网页，「Share app」得公开网址，作品库可复制改造，有版本回退 [4][5]。
- **Weavy / ComfyUI App 模式**：发布时把流程折叠成「一个表单 + 一个按钮」，只露出没接线的输入，其余隐藏；每次发布自动存版本 [7][12]。

**对我们的三条借鉴**：① 加积木的界面「少而准」——固定「放进来 / 帮你办 / 送出去」三个位置，点哪个就从底部弹出**卡片网格**（图标 + 一句白话），最上面是「推荐下一步」和「最常用」，搜索放次要位置；② 竖排卡片链，引用前一步的结果靠点卡片，不用 @ 语法、不拖线（契约第一版是一条链，正好）；③ 发布出来的结果页只露出「一个输入 + 一个按钮」，同时给链接和二维码，并预留「复制一份改一改」（模板广场）。

## 2 对标

只摘对「非技术用户 + 下沉市场 + 输出成链接 / 二维码 + 卖插件」有用的点；「反着做」是它们劝退新手的地方。

### 2.1 海外

| 产品 | 借鉴 | 反着做 |
| --- | --- | --- |
| Google Opal（一句话 + 可视化生成 AI 小应用） | 一句话生成步骤链，Gallery 模板一键 Remix [13]；进 Gemini 后从画布改成「步骤列表」，更好懂 [14]；2026-02 加 agent 步骤，信息不够时追问并给选项 [15] | 访客必须登录 Google 账号才能用分享的应用 [13]；Google 支持页称 Opal 将于 2026-11 停止运行、应用不自动迁移 [16]——实验品说关就关 |
| Apple 快捷指令 | 动作库按类别 / App 分组、可搜可收藏、按上一步推荐下一步 [10]；Gallery 按场景分组，点一下添加，需配置的先走问答 [17]；iOS 26「Use Model」让 AI 只是链上一块积木 [18] | 一打开是空白页，魔法变量难懂，新手引导被批不足 [19]；分享链接只能导入苹果设备 [3] |
| n8n | AI Workflow Builder 一句话自动选节点、连线、配参数，生成失败不扣额度 [20]；按整次运行计费、不按步骤数 [21] | 调试要读 JSON；套模板后还得自己填凭证、改配置 [22] |
| Zapier | Copilot 用「X 发生时做 Y」的白话生成流程，可选「一口气搭完」或「每步先问我」[23]；Forms / Chatbot 直接出公开链接，免费版就有 [24] | 每个动作算 1 个 task，免费版 100 次 / 月且只能两步 [24]；界面只有英文 |
| Make | 模板走引导式设置，逐模块打 ✓ / ! 标完成度 [25]；Maia 对话建场景，用户审阅后再连账号、跑测试 [26]；2025-08 计费改 credit，能看每个场景的消耗 [27] | 迭代器、聚合器难懂，第一个像样的场景要 3–5 小时 [28]；免费版只能开 2 个场景 |
| Gumloop | 助手 Gummie 先出计划、问澄清问题，再连节点、修错 [29]；Interfaces 在流程前套一张表单，拿链接填表点 Run 就出结果，看不到节点 [30] | 打开托管页的人必须登录、扣自己的额度，匿名不能运行 [31] |
| Dify | 一建应用就自动有 WebApp 链接，也能嵌入 [32]；访问权限可设「Anyone」免登录 [33]；市场近 1000 插件、300+ 模板，2026-09 加评分评论 [34] | 先装模型供应商插件、填 API Key；入门教程一上来讲 IF/ELSE、迭代、Jinja2 [35] |
| MindStudio（一键发布可收费 AI 小应用的典型） | 发布即独立 Web App 链接，可匿名访问；创作者可选「使用者付费」、可开 Remix [36] | 外部用户免账号付费在 2026-02 仍只是功能请求 [36] |

共性：一句话生成流程已是标配，而且都是「先出计划 / 问澄清问题 → 用户确认 → 再配置」，不是黑盒；新手主入口是「模板 + 一键复制 + 引导式设置」，从空白搭的都被批难上手；交付物是「前面一张表单、流程藏在后面」的链接，**访客要不要登录**决定成败；计费在往 credit 收拢，但按步骤扣让人算不清。

### 2.2 国内

| 产品 | 借鉴 | 反着做 |
| --- | --- | --- |
| 扣子 Coze（2026-01 升级 2.0） | 新开「技能商店」，一键安装，专家能把经验做成技能出售 [37]；第三方付费插件由开发者定单价和免费额度，**添加前就看到价格** [38]；一句话 / 语音「口喷式」创建技能 [39]；2025-07 开源 Coze Studio，节点设计可参考 [41] | 功能越强学习成本越高；套餐 10 档 + 积分 + 第三方插件扣现金余额，三套钱算不清 [40]；卖技能要先开商户身份，有作者为此去办个体户执照 [39] |
| 腾讯元器 | 发布渠道含「体验链接 / 二维码」（官方称上线最快）、公众号、微信客服、企业微信 [42]；授权一次拉公众号历史文章做知识库，有「一键同款」模板 [43]；腾讯生态内渠道不按 token 计费 [42] | 接公众号得先有号，发布要等审核 [42]；没有常态化开发者分成，激励靠比赛 [44] |
| 飞书多维表格 + aily | AI 字段捷径：像加一列一样批量总结、打标签，第三方可开发 [45]；2025-12 上线一句话生成表格 / 仪表盘初稿 + 分行业模板 [46]；表单一键出链接 / 二维码，外部人员直接填、自动汇总 [47] | aily 只能在飞书里用，额度用完另买 AI 包 [48]；下沉用户大多没有飞书 |
| 钉钉 AI 助理 | 2024-04 上线 AI 助理市场，首批 200+ 按场景分类 [49]；AI 表格「一句话生成」，主打「小白不用会做表」[50]；2025-12 Agent OS：拍照、手绘、传表格就生成 AI 应用 [51] | 上架要申请审核，三种创建方式选择太多 [49]；主打大企业组织 [51] |
| 文心智能体平台 | 一句话创建、免费，分发到百度搜索、文小言、网盘、贴吧 [52]；五个商业组件：挂链接、挂商品、收线索、联盟广告、胶囊位 [53] | 变现靠自己运营挂货接广告，没有订阅分成；2026 年现状未核实 [53] |
| 百度秒哒（补充） | 一句话生成应用、可发布成微信小程序并内置微信支付；81% 用户不是程序员；付费版 25 元 / 月起 [54] | — |

两条必须知道的国内背景：

- **政策**：2026-07《人工智能拟人化互动服务管理暂行办法》施行前后，豆包、千问、元宝下线了用户自建智能体广场（豆包约 800 万个）；新华网援引的专家意见称工作助手类任务型智能体不在新规范围 [55]。→ 我们定位**任务型工具**（拆文件、提待办、推送、出结果页），智能体人设写成「××的工作助手」，不做拟人陪伴；下一轮「有人味的管家」要先过合规。
- **人群**：下沉市场月活 6.53 亿、占全网 51.1%，46 岁以上占 46.3%，AIGC 活跃占比 47.3%（同比 +28.3pt）[56]；小镇中青年受亲友推荐影响大于 KOL [57]。→ 大字号、语音输入、「把二维码分享给亲友」做裂变入口；分发首选「链接 + 二维码 + 微信里直接打开」，不要求用户有公众号、小程序或企业资质。

## 3 校准清单（对照契约 4.1）

### 3.1 职业：id 不动，换「下沉市场看得懂」的名字与顺序

下沉市场的主力是**开店的、卖货的、跑客户的、教书的、读职校 / 考证的**；「项目经理」「自由职业者」偏城市白领。第一版 8 个 id 不改（契约与前端已按 id 并行开发），只建议改显示名、排序和模板。市场里的职业卡按下表顺序排，店主放第一。

| 顺序 | id | 建议显示名 | 理由 |
| --- | --- | --- | --- |
| 1 | `shop_owner` | 开店老板 / 微商 | 下沉市场人数最多、付费意愿最直接；奶茶店、小超市、美甲店、社区团长都归这里 |
| 2 | `sales` | 销售 / 中介 / 保险 | 县城房产中介、保险代理人、建材销售，天天跑客户、怕忘事 |
| 3 | `creator` | 短视频 / 直播带货 | 「内容创作者」太书面；快手抖音卖土特产是真实场景 |
| 4 | `teacher` | 老师 / 培训班 | 乡镇老师和培训班老板的最大痛点是**家长通知**，不是课件 |
| 5 | `student` | 学生 / 考证 | 职校、专升本、考证考公 |
| 6 | `office` | 行政 / 文员 | 镇上工厂、单位的文员，写通知、排会议 |
| 7 | `freelancer` | 接单师傅 / 自由职业 | 装修、摄影、家教、设计，客户需求全在微信语音里 |
| 8 | `project_manager` | 项目负责人 | 「项目经理」听着像大公司；比赛演示用它（见剧本），保留 |

下一轮可考虑加「宝妈 / 家长」（孩子作业、家庭日程、团购）和「农户 / 农产品电商」两个职业。

### 3.2 每个职业：1 个最打动人的流程模板 + 3 个快捷问题

原则：**结果默认落到「生成网页与二维码」**——下沉用户的协作发生在微信群里，一张能转发、能扫的结果页比「发到飞书」更通用；而且市场新开的账号都没绑飞书，**模板里带飞书积木会让新用户第一次套模板就校验失败**，飞书只给已绑定的账号做可选尾巴。所有模板只用契约里已有的积木和 `ai_extract.task` 枚举（要点 / 待办 / 摘要 / 周报 / 改写），差异写在 `instruction` 里，不新增枚举。

| id | 模板名（建议） | 积木链 | 快捷问题（home.chips） |
| --- | --- | --- | --- |
| `shop_owner` | 今日上新海报页 | input_text →  ai_extract(改写，instruction「写成朋友圈文案 + 群接龙格式，带价格」) → web_page | 帮我写一条今天的上新朋友圈 · 明天会下雨吗，要不要少进点货 · 提醒我周三给供货商打款 |
| `sales` | 拜访记录变跟进单 | input_text → ai_extract(待办，instruction「每条带客户称呼和回访日期」) → to_todo → web_page | 帮我记一下：客户下周二再看房 · 这个月答应客户的事还有哪些 · 写一段节日问候发给老客户 |
| `creator` | 卖点变口播稿 | input_text → ai_extract(改写，instruction「30 秒直播口播稿，口语化，开头抓人」) → web_page | 最近大家在聊什么，给我 5 个选题 · 把这段卖点改成 30 秒口播 · 提醒我晚上 8 点开播 |
| `teacher` | 家长通知一键成页 | input_text → ai_extract(改写，instruction「家长看得懂的通知 + 注意事项清单」) → web_page | 把这段话改成给家长的通知 · 帮我出 5 道三年级应用题 · 周五第三节调课提醒我 |
| `student` | 考前划重点 | input_file → split_file(chapter) → ai_extract(要点) → web_page | 帮我把这一章划个重点 · 离考试还有 30 天，排个复习计划 · 明早 8 点叫我背单词 |
| `office` | 领导的话变正式通知 | input_text → ai_extract(改写，instruction「正式通知格式：标题、时间、地点、要求」) → web_page（已绑飞书再接 feishu_send） | 把这段话改成正式通知 · 下周三全员开会，提前一天提醒我 · 帮我写本月考勤说明 |
| `freelancer` | 客户需求变清单 | input_text → ai_extract(待办) → to_todo → web_page | 把客户这段话整理成报价要点 · 明天上午 10 点量房提醒我 · 这周还有哪些活没交 |
| `project_manager` | 项目资料归档（演示用） | input_file → split_file → ai_extract(待办) → to_todo → web_page（已绑飞书再接 feishu_doc） | 这周哪些任务快到期了 · 把今天的会整理成待办 · 帮我写一份本周周报 |

与契约示意的差异：`shop_owner` / `teacher` / `office` / `creator` 的模板改了场景（契约是「上新文案 / 课件提炼 / 通知下发 / 选题素材」）；`sales` / `office` 的尾巴由 `feishu_send` 改为 `web_page`；`project_manager` 的 `ai_extract` 由「要点」改为「待办」、`feishu_doc` 换成 `to_todo`——演示时待办直接进了这个智能体，问一句就能答。课件提炼、选题素材可作为第二个模板保留。

### 3.3 插件命名：够不够「人话」

| id | 契约名 | 建议名 | 说明 |
| --- | --- | --- | --- |
| `schedule` | 日程助手 | 日程提醒 | 用户要的是「到点提醒我」 |
| `todo` | 待办清单 | 待办清单 | 保留 |
| `memo` | 随手记 | 随手记 | 保留 |
| `memory` | 懂你的记忆 | 记住我的习惯 | 「记忆」偏抽象 |
| `weather` | 天气 | 天气 | 保留；店主场景写清「下雨提醒进货」 |
| `search` | 联网搜索 | 上网查 | 更口语 |
| `recall` | 翻旧账 | 找回聊过的话 | 「翻旧账」中文是贬义（翻出过去的不是），下沉用户会误解 |
| `movies` | 影视评分 | 看片参考 | 低频，不进下沉职业推荐 |
| `esports` | 电竞比分 | 电竞比分 | 低频，不进任何职业推荐，只在市场里能搜到 |
| `tickets` | 票务比价 | 查票价与入口 | 现有能力只列公开展示价 + 购票深链接，不下单，「比价」过度承诺 |
| `meeting` | 会议纪要 | 开会记纪要（电脑） | 名字里带「电脑」，免得手机用户加了用不了 |
| `feishu` | 飞书 | 飞书 | 保留 |
| `wechat` | 微信技能包 | 微信助手 | 「技能包」是行话；且仅 Owner 可用，市场里要醒目标「需管理员开通」 |
| `input_text` | 文字输入 | 贴一段文字 | 动作化 |
| `input_file` | 资料上传 | 传文件 / 拍照 | 支持图片，写出来 |
| `split_file` | 文件拆分 | 长文件分段 | 说清用途 |
| `ai_extract` | AI 提炼 | AI 帮你整理 | 「提炼」偏书面；选项名用「划重点 / 列待办 / 写摘要 / 写周报 / 改写」 |
| `to_todo` | 加到待办 | 存进待办 | 保留亦可 |
| `feishu_send` | 发到飞书 | 发到飞书 | 保留 |
| `feishu_doc` | 汇总到飞书文档 | 汇总成飞书文档 | 保留亦可 |
| `wechat_send` | 发到微信 | 发到微信 | 保留；同 `wechat` 标注 |
| `web_page` | 生成网页与二维码 | 生成分享页（带二维码） | 强调「能转发到群里」 |

分类名同样建议人话化：积木三种角色显示为「**放进来 → 帮你办 → 送出去**」（input / process / output），市场分类「AI 处理」改「AI 帮手」、「输出」改「分享与发送」，「资讯」改「查信息」。只改显示文案，`category` / `role` 的 id 不变。

## 4 插件定价

### 4.1 参照：分成与价格带（截至 2026-10）

| 平台 | 分成 / 价格 | 出处 |
| --- | --- | --- |
| Apple 中国区 | 2026-03-15 起标准 30%→25%，小企业 / 满一年订阅 15%→12% | [58] |
| 微信小程序虚拟支付（工具类） | 安卓标准 10%、现行 1%；会员订阅首笔 1% 之后 10%；iOS 12%（归苹果） | [59] |
| Shopify App Store | 开发者终身前 100 万美元 0 抽成，超出 15%（2025-06 起） | [60] |
| Figma 社区 | 平台 15%，创作者 85% | [61] |
| Dify 插件市场 | 目前只允许免费插件，禁止插件内付费；模板作者走推广联盟 | [62] |
| 扣子 Coze | 免费档每天送积分（官方文档为 1500，二手资料有 500 的说法）；进阶 39.9 元 / 月起（≈1000 积分 = 1 元）；官方付费插件扣积分，第三方要自备 Key | [40] |
| 钉钉 | 2025-03 起对 AI 生态伙伴免佣金、免保证金、免算力费 | [63] |
| Zapier / Make / n8n / Gumloop | 都按「次数 / 点数」分档：Zapier 免费 100 任务、专业 $19.99 起；Make $9 起；n8n €20 起；Gumloop $37 起 | [24][64] |
| 国内工具会员 | 美图 VIP 连续包月 15 元、WPS AI 25 元、WPS 大会员 35 元、豆包专业 68 元（学生 38）、剪映 SVIP 79 元 / 月 | [65] |
| 按时长计费 | 讯飞听见：1 小时 18 元 vs 包月 18 元含 30 小时；阿里听悟接口成本 0.6 元 / 小时 | [66] |

另外两条要上台讲的事实：**下沉市场月活 6.53 亿，AIGC 活跃占比 47.3%，同比 +28.3 个百分点**（QuestMobile 2026 下沉市场报告）[56]——他们已经在用 AI；**2025 年黑猫自动续费投诉 6.9 万件**，七成多是诱导开通或扣费前没通知 [67]，工信部要求续费前 5 天显著提醒 [68]——下沉用户最怕「被偷偷扣钱」。

### 4.2 第一版方案（一句话能讲清）

> **基础插件永久免费；专业插件 9.9 元 / 月一个；全部专业插件 19.9 元 / 月（年付 168 元）。**

| 档位 | 内容 | 价格 |
| --- | --- | --- |
| 免费 | 18 个基础插件全部可用（日程、待办、随手记、天气、上网查、贴文字 / 传文件、长文件分段、AI 帮你整理、存进待办、发到飞书、生成分享页……）；每天 20 次「AI 动作」（推荐、AI 整理、流程试运行各算 1 次），当天清零；结果页带「由贾维斯生成」角标 | 0 |
| 单个专业插件 | 4 个：开会记纪要（转写有成本，需电脑端）、汇总成飞书文档、微信助手 + 发到微信（目前仅管理员可用，开放给普通账号前只展示不售卖） | 9.9 元 / 月 / 个 |
| 专业版全包 | 全部专业插件 + 每月 300 个 AI 点数 + 结果页去角标 | 19.9 元 / 月；年付 168 元 |
| 加油包（以后） | AI 点数用完按次买，不强制订阅；会议转写约 1 点 / 分钟 | 9.9 元 / 300 点 |

- **为什么订阅为主、按次为辅**：19.9 元落在国内工具会员 15–40 元区间的下沿；「订阅 + 点数」是扣子、即梦、Zapier、Make 的共同做法；妙鸭式 9.9 元单次拉新快但复购低 [69]，所以按次只做加油包。
- **不做 1 元首月、不做隐藏续费**：首月价和次月价同样醒目、续费前 5 天提醒、一键取消——合规红线，也是下沉用户的信任点。在微信里收款时，单次 / 买断的渠道费（1%）比连续包月续费（10%）低，加油包走单次正好。
- **以后开放第三方插件**：开发者 80% / 平台 20%，每个开发者累计前 10 万元流水 0 抽成（学 Shopify、微信小游戏的门槛）；苹果 / 微信渠道费先扣再分。本轮按契约**只展示价格与「专业版」徽标，不收费**。

## 5 对实现中契约的修改建议

都不改 id、不改接口形状，只涉及文案、默认值和少量逻辑；各代理可按需采纳。

1. **形态与用语（全体）**：按用户修正，主线是「挑插件 → 生成专属账号口令 → 现有登录页登录 → 按所选插件形成的专属智能体」，界面统一叫「智能体」；`/p/<slug>` 专属网址与装主屏降为可选，不进演示主线；积木流程与结果页二维码保留。
2. **演示数据**（契约 2-9）：不用会议纪要原文（含真实手机号与邮箱），改用 `docs/demo/sample-project.md`。
3. **模板不带飞书（P / B）**：市场新开的账号都没绑飞书，而流程校验要求插件对当前账号可用——职业模板默认不含 `feishu_*`（按 3.2），或从模板新建时自动跳过不可用积木并提示「绑定飞书后可加」；否则新用户第一次套模板就失败。`project_manager` 模板改为 input_file → split_file → ai_extract(待办) → to_todo → web_page。
4. **推荐（P）**：开号得到的都是普通账号，永远不满足 `wechat_owner`——推荐结果**不返回 `wechat` / `wechat_send`**，市场里醒目标「需管理员开通」；`esports`、`movies` 不进任何职业推荐。
5. **价格字段（P / M）**：`price` 单位定为「元 / 月」数字（可为 9.9）；`tier=pro` 只有 `meeting`、`feishu_doc`、`wechat`、`wechat_send`；前端显示「¥9.9 / 月 · 专业版 · 本期免费体验」。
6. **显示名（P / M / B）**：职业按 3.1 改名与排序、按 3.2 换模板与 `home.chips`；插件按 3.3 改名；积木三种角色显示为「放进来 / 帮你办 / 送出去」。
7. **开号结果页（M）**：口令只显示一次，下沉用户最容易丢——给「复制账号口令」「存成图片」两个按钮和「请截图保存」提示，未登录就离开时二次确认。
8. **结果页在微信里（F）**：`/r/<token>` 要在微信内置浏览器里免登录正常显示（不依赖 Service Worker）；如保留装主屏，检测 UA 含 `MicroMessenger` 时提示「点右上角 ··· 在浏览器打开」。
9. **人设（P）**：智能体人设写成「××的工作助手」，任务型、不拟人陪伴（见 2.2 政策）。

## 6 出处

资料由调研子代理于 2026-10-02 检索，「未核实」处见正文。同条补充来源：[16] 关停日期另见 mixed-news.com 报道；[24] Zapier Forms 另见其帮助中心；[64] 另含 n8n.io/pricing 与 Gumloop 定价博客；[65] 另含美图、豆包、剪映的定价报道。

**「神经」**

[1] https://sspai.com/post/55205 · [2] https://www.geekwire.com/2017/apple-acquires-workflow-popular-automation-app-can-connect-various-services/ · [3] https://support.apple.com/guide/shortcuts/apdf01f8c054/ios  
[4] https://developers.google.com/opal/overview · [5] https://www.kdnuggets.com/building-ai-automations-with-google-opal · [6] https://techcrunch.com/2025/12/17/googles-vibe-coding-tool-opal-comes-to-gemini  
[7] https://help.weavy.ai/en/articles/12267755-the-design-app · [8] https://aimaker.substack.com/p/glif-ai-creative-workflow-builder-guide-image-video-audio-generator · [9] https://techcrunch.com/2025/11/05/replika-founder-raises-20m-pre-seed-for-wabi-the-youtube-of-apps  
[10] https://support.apple.com/guide/shortcuts/navigate-the-action-list-apdc33e4f4da/ios · [11] https://matthewcassinelli.com/apple-has-finally-made-shortcuts-action-editor-easier-to-browse/ · [12] https://blog.comfy.org/p/from-workflow-to-app-introducing  

**海外对标**

[13] https://developers.googleblog.com/introducing-opal/ · [14] https://blog.google/innovation-and-ai/models-and-research/google-labs/mini-apps-opal-gemini-app-experiment/ · [15] https://blog.google/innovation-and-ai/models-and-research/google-labs/opal-agent/  
[16] https://support.google.com/gemini/answer/18560919?hl=en · [17] https://support.apple.com/guide/shortcuts/discover-shortcuts-in-the-gallery-apdd018638ca/ios · [18] https://matthewcassinelli.com/ios-26-public-beta-shortcuts-actions-apple-intelligence-messages-notes-checklists/  
[19] https://www.imore.com/apps/apple-isnt-doing-enough-for-new-shortcuts-users-heres-how-they-can-fix-it · [20] https://docs.n8n.io/build/ways-of-building-workflows/ai-workflow-builder · [21] https://blog.n8n.io/n8n-execution-advantage/  
[22] https://docs.n8n.io/build/ways-of-building-workflows/use-templates · [23] https://help.zapier.com/hc/en-us/articles/15703650952077-Use-the-power-of-AI-to-generate-Zap-workflows · [24] https://zapier.com/pricing  
[25] https://help.make.com/scenario-templates · [26] https://www.make.com/en/blog/natural-language-automation · [27] https://www.make.com/en/credits  
[28] https://saascrmreview.com/make-review/ · [29] https://www.gumloop.com/blog/gummie-agent · [30] https://docs.gumloop.com/learn/running-flows-automatically  
[31] https://forum.gumloop.com/t/enable-runs-to-anon-users-from-interfaces/3111 · [32] https://docs.dify.ai/en/use-dify/publish/README.md · [33] https://docs.dify.ai/en/use-dify/publish/webapp/web-app-access  
[34] https://dify.ai/blog/from-discovery-to-response-a-more-connected-dify-marketplace · [35] https://docs.dify.ai/en/use-dify/getting-started/quick-start · [36] https://university.mindstudio.ai/docs/deployment-of-ai-agents/sharing-agents-in-mindstudio  

**国内对标**

[37] https://www.digitaling.com/articles/1454732.html · [38] https://docs.coze.cn/coze_pro_plugin_fee · [39] https://www.woshipm.com/ai/6329776.html  
[40] https://docs.coze.cn/cozespace_coze_billing_overview · [41] https://adg.csdn.net/696f39c2437a6b403369b532.html · [42] https://aistacknav.com/tencent-yuanqi-intro/  
[43] https://www.woshipm.com/ai/6314177.html · [44] https://www.woshipm.com/it/6301615.html · [45] https://www.feishu.cn/content/AsLfwRvl2iUT8lkDYuZcNvQenae  
[46] https://www.feishu.cn/content/article/7588081416752106693 · [47] https://www.feishu.cn/content/article/7581406132237782223 · [48] https://feishu.cn/content/article/7631864469689240764  
[49] https://www.qbitai.com/2024/04/136081.html · [50] https://news.mydrivers.com/1/1076/1076328.htm · [51] https://news.qq.com/rain/a/20251223A06LU100  
[52] https://www.pingwest.com/a/298339 · [53] http://www.news.cn/tech/20241121/dbda2471b1374eb6b4d3757e7d5f539c/c.html · [54] https://www.qbitai.com/2025/11/353556.html  
[55] https://www.news.cn/tech/20260708/03036e8acdf34710a9d35e4cd52141d5/c.html · [56] https://www.donews.com/news/detail/1/6623252.html · [57] https://www.21jingji.com/article/20250120/herald/7417f7d69b0ae8a3006beb3c928967eb.html  

**定价**

[58] https://www.bjnews.com.cn/detail/1773378447129116.html · [59] https://developers.weixin.qq.com/miniprogram/dev/platform-capabilities/business-capabilities/virtual-payment/devplan.html · [60] https://shopify.dev/changelog/update-to-shopifys-app-developer-revenue-share  
[61] https://help.figma.com/hc/en-us/articles/12067637274519-About-selling-Community-resources · [62] https://dify.ai/legal/marketplace-agreement · [63] https://www.qbitai.com/2025/03/265896.html  
[64] https://www.make.com/en/pricing · [65] https://www.ithome.com/0/853/778.htm · [66] https://help.aliyun.com/zh/tingwu/pricing-and-billing-rules/  
[67] https://www.chinanews.com.cn/m/cj/2026/03-14/10586915.shtml · [68] https://www.thepaper.cn/newsDetail_forward_30405410 · [69] https://www.jiemian.com/article/9793963.html
