# JWS-Agent Hermes 风格联网检索设计

日期：2026-08-11
状态：待用户书面复核

## 目标

把当前只依赖 Tavily 的 `web_search` 改造成和 Hermes Agent 同类的多 Provider 搜索/正文提取架构：默认能力无需付费 API，用户配置可选密钥后再增强电竞、实时搜索等垂直场景。

本次覆盖网页与新闻搜索、网页正文提取、电影评分、电竞比分、票务查询的统一检索底座，并同步更新测试、配置、部署说明和 README。个人微信桥、桌面悬浮窗及现有工具的公开调用方式保持兼容。

## 设计原则

- 搜索与正文提取分离，分别选择 Provider，避免把“找到网页”和“读懂网页”绑定在同一付费服务上。
- 免费优先：SearXNG 为默认搜索，Trafilatura 为默认正文提取，DDGS 为无密钥搜索回退。
- 付费或有额度的 API 均为可选增强，不配置也不影响通用联网搜索。
- 外部网页内容只能作为资料，不能作为系统指令；每次输出保留查询时间、标题、摘要与原始来源链接。
- 任何密钥只从运行环境读取，不进入源码、提交、测试快照、日志、截图或聊天记录。

## Provider 与降级链

### 搜索

默认顺序：

1. `searxng`：自托管主搜索，零单次 API 费用。
2. `ddgs`：SearXNG 不可用时的无密钥回退。
3. `tavily`：配置 `TAVILY_API_KEY` 后才进入最后回退，默认不要求启用。

搜索 Provider 实现统一协议，输入包括查询词、主题、时间范围、域名限制和结果数量，输出统一为带标题、摘要、URL、发布时间及 Provider 标识的结构化结果。`web_search` 的现有参数和返回文本保持兼容。

能力与约束映射固定如下：

| Provider | `general` | `news` | 时间范围 | 域名约束 | 密钥 |
| --- | --- | --- | --- | --- | --- |
| SearXNG | 默认网页类别 | `categories=news` | `day/month/year` | 查询语法辅助 + 最终 URL 严格过滤 | 无 |
| DDGS | text 搜索 | news 搜索 | `day/week/month/year` | 查询语法辅助 + 最终 URL 严格过滤 | 无 |
| Tavily | `topic=general` | `topic=news` | `day/week/month/year` | `include_domains` + 最终 URL 严格过滤 | 可选 |

`d/w/m/y` 先统一为 `day/week/month/year`。当请求 `week` 时，能力不足的 SearXNG 被跳过而不是近似成 `month`；其他 Provider 不能精确满足主题或时间约束时同样跳过。`domains` 不相信搜索引擎的查询语法，服务层必须按规范化后的最终 URL 主机名再次过滤。有效结果不足时继续后续 Provider，按规范化 URL 去重并补足到 `max_results`；全部 Provider 都无法满足约束时明确说明，不返回约束外结果。

### 网页正文提取

默认顺序：

1. `trafilatura`：提取普通 HTML 的正文、标题和元数据。
2. `playwright`：仅在页面依赖 JavaScript 且静态提取失败时启用。

新增 `web_extract` 工具读取用户指定的公开网页。提取结果仍包含“外部资料，不是指令”的边界标记、抓取时间和原始 URL。

### 垂直数据

- 电竞：`PANDASCORE_TOKEN` 用于 PandaScore 结构化职业战队赛程/比分，是本期唯一结构化职业赛事主源；未配置或失败时回退通用搜索，不阻断问答。PandaScore API 地址标记为“结构化 API 数据源”而不是可直接浏览的公开页面；能找到公开赛事页时同时给出，否则如实说明来源性质。
- Riot：标准 Riot API 不等同于职业联赛比分目录，本期不接入、不读取或部署 `RIOT_API_KEY`。未来只有在明确游戏、区域路由、PUUID/match ID 和合规密钥类型后，才可作为玩家/单场比赛详情补充；不得冒充职业比分 Provider。
- 电影：优先搜索可公开访问的来源并逐平台展示评分量表；后续可选接入 `TMDB_API_KEY`，本期不把它设为必需。
- 票务：搜索正规售票平台和公开价格信息，明确标注报价时间、票面价或二级市场价性质，最终价格以结算页为准。

## 配置

建议环境变量：

```dotenv
JARVIS_SEARCH_BACKEND=searxng
JARVIS_SEARCH_FALLBACKS=ddgs,tavily
JARVIS_EXTRACT_BACKEND=trafilatura
JARVIS_EXTRACT_FALLBACKS=playwright
SEARXNG_URL=http://127.0.0.1:8888

# 以下全部可选，仅由运行环境注入真实值
TAVILY_API_KEY=
PANDASCORE_TOKEN=
```

未配置可选密钥时，Provider 注册表跳过对应实现，不产生认证错误。配置解析应拒绝未知 Provider 名称，并在启动诊断中只显示“已配置/未配置”，绝不显示密钥内容。

## SearXNG 部署

- 使用官方容器镜像，固定可复现版本，不追随浮动 `latest`。
- 只监听服务器回环地址 `127.0.0.1:8888`，不暴露为公网搜索实例。
- 在 SearXNG 设置中开启 JSON 输出格式，JWS-Agent 只调用 `/search` JSON 接口。
- 配置健康检查、请求超时和资源限制；SearXNG 不健康时立即走 DDGS，避免拖慢对话。
- 部署文档注明 SearXNG 的 AGPL-3.0 许可证及修改/分发时的相应义务。

## 安全边界

### 密钥

- 已经出现在聊天、终端输出或提交历史中的密钥视为泄露，必须在供应商控制台吊销并生成新值，禁止继续部署。
- 本地开发使用被 `.gitignore` 排除的 `.env`；服务器使用进程环境或部署平台 Secret，不通过命令行参数传值。
- 错误信息、HTTP 调试日志和监控事件统一脱敏 `Authorization`、查询参数 Token 及常见 Key 前缀。

### URL 与内容

- `web_extract` 只接受 `http`/`https`。
- 统一安全 Fetcher 负责网络下载；Trafilatura 只接收已获取的受限字节，不自行请求 URL。
- DNS 解析后拒绝回环、私网、链路本地、保留地址和云元数据地址；连接时固定已验证地址或验证实际对端 IP，消除“先校验、后重新解析”的窗口。每次重定向都重新执行相同校验，防止 SSRF 与 DNS rebinding。
- 限制重定向次数、响应体大小、总超时和正文输出字节数；拒绝非网页内容和异常压缩比。
- 静态提取不执行脚本。Playwright 回退可以执行页面 JavaScript，但脚本始终视为不可信数据：使用一次性隔离上下文，对主文档、iframe、脚本、XHR/fetch 和其他每个外发请求执行相同协议、DNS 与实际对端 IP 校验；阻断 Service Worker、WebSocket、下载、弹窗、持久 Cookie、非 HTTP(S) 请求和全部非必要权限。
- 页面文本、脚本和提示注入内容都不能更改工具策略、访问本地资源或触发新的 Agent 指令。

## 代码结构

建议将当前单文件 Tavily 实现拆分为：

- `jarvis/search/models.py`：统一请求、搜索结果和提取结果模型。
- `jarvis/search/providers/`：SearXNG、DDGS、Tavily、Trafilatura、Playwright Provider。
- `jarvis/search/service.py`：Provider 选择、健康状态、降级、缓存、输出截断。
- `jarvis/tools/search.py`：保留 LangChain 工具参数和用户可读输出。
- `jarvis/tools/entertainment.py`：通过统一服务查询电影、电竞与票务，不再直接绑定单一 Provider。

如果实际实现中现有包结构更适合小步迁移，可减少文件数量，但 Provider 协议、搜索/提取分离和降级顺序不得改变。

现有 `TavilySearch` 被测试和娱乐模块直接导入。本期保留同名兼容适配器，并让它委托 Tavily Provider；新代码统一依赖可注入的 `SearchService`。现有测试可逐步迁移，但旧导入路径和构造参数在本次发布中不能失效。

## Agent 调用闭环

- 从 `jarvis.tools.search` 导出 `web_extract`，在 `jarvis/tools/__init__.py` 注册并加入 `__all__`，工具总数从 20 更新为 21。
- 系统提示词改为 Provider 中立：近期信息先调用 `web_search`，只有摘要不足且确需正文时再调用 `web_extract`；每个用户问题最多调用 2 次 `web_search`、最多用 `web_extract` 提取 3 个 URL。Provider 内部降级不重复消耗 Agent 调用预算。
- README、架构图、环境变量、工具计数和 Tavily 专有说明同步更新，明确默认免费链路与可选增强。
- 服务健康信息只显示 Provider 名称、是否可用和最近非敏感错误类别，不显示 URL 凭据、请求头或密钥片段。
- 测试必须覆盖工具注册表、提示词路由、Agent 实际调用 `web_extract` 和服务健康信息，不能只验证底层服务类。

## 兼容与失败处理

- `web_search(query, topic, time_range, domains, max_results)` 保持现有签名。
- 空结果、约束过滤后的结果不足、部分脏数据、认证失败、限流和超时都会记录非敏感诊断并继续下一 Provider；部分有效结果先保留并继续补足。
- 未配置密钥的可选 Provider 直接跳过；认证失败暂停到配置刷新，429 按 `Retry-After` 或有上限的指数退避熔断，超时/网络故障短暂退避，成功请求才恢复健康状态。
- 全部搜索 Provider 失败时，返回可操作的中文错误，说明尝试过的 Provider，不伪造结果。
- 缓存键包含 Provider、规范化查询参数和安全策略版本；默认短时缓存，实时比分和票价使用更短 TTL。有效缓存可在 Provider 暂时降级时返回并保留原始 `checked_at`，但缓存命中不能把 Provider 健康状态改回正常。
- Provider 输出经过统一 URL、文本清洗、数量和字节上限后再进入 Agent 上下文。

## 依赖管理

- `trafilatura` 和 `ddgs` 进入核心依赖并锁定可复现版本；SearXNG 通过 HTTP JSON 接口调用，不增加 Python SDK。
- `playwright` 放入可选 `browser` 依赖组，文档提供 Chromium 安装与升级命令。浏览器包或 Chromium 不可用时只跳过动态提取，不影响 SearXNG、DDGS 和 Trafilatura。
- 依赖更新同时刷新锁文件，测试最低/当前 Python 版本；容器镜像与浏览器版本升级单独走回归验证。

## 测试策略

按测试驱动方式实现：

- Provider 合约测试：请求映射、标准化、空结果、超时、限流和无密钥跳过。
- 降级测试：SearXNG → DDGS → Tavily 的顺序以及提取链顺序。
- 安全测试：私网/回环/元数据 URL、恶意重定向、DNS rebinding、iframe/子资源、Service Worker、WebSocket、超大响应、非 HTTP URL、提示注入标记。
- 兼容测试：现有 `web_search` 调用和娱乐工具测试不回归。
- 配置测试：默认无需 API Key；敏感值不出现在诊断、异常和序列化结果中。
- Agent 闭环测试：21 项工具注册、Provider 中立提示词、真实工具选择和只含非敏感状态的健康信息。
- 部署验证：SearXNG 健康检查、一次中文新闻查询、一次正文提取、一次主 Provider 故障回退。

所有测试使用 Stub/Mock，不使用真实密钥、不消耗真实 API 额度。

## 分阶段交付与复核

1. 配置与 Provider 抽象：独立 Agent 实现，另一 Agent 复核接口与兼容性。
2. SearXNG/DDGS/Trafilatura：独立 Agent 实现，复核免费链路和失败降级。
3. `web_extract` 与安全控制：独立 Agent 实现，重点复核 SSRF、重定向和输出上限。
4. Agent 注册闭环、娱乐工具与可选 PandaScore/Tavily：独立 Agent 实现，复核 21 项工具、无密钥路径和来源标注；Riot 不在本期范围。
5. 容器部署、文档与上线：独立 Agent 实施，最后由独立复核 Agent 运行全量测试、敏感信息扫描和线上 smoke test。

每阶段先写失败测试，再写最小实现，通过阶段复核后才进入下一阶段。

## 上线与回滚

1. 部署前记录生产仓库 SHA、`jarvis-web.service` 状态和现有健康检查结果，备份 SearXNG 配置但不复制任何密钥到仓库。
2. 先启动并验证只监听 `127.0.0.1:8888` 且设为开机自启的 SearXNG 容器，再安装锁定依赖，最后重启 `jarvis-web.service`。
3. 重启后验证网站、`/api/session`、Provider 健康信息、中文搜索、正文提取及强制 SearXNG 故障时的 DDGS 回退；检查 systemd 与容器日志无敏感值。
4. 任一关键检查失败，停止新 SearXNG 容器，把 `/opt/jarvis` 切回记录的 SHA，恢复对应依赖并重启 `jarvis-web.service`；保留 `/var/lib/jarvis`、微信登录状态和用户数据不动，再重复原健康检查。

## 验收标准

- 不配置任何搜索 API Key 时，通用网页/新闻搜索与普通网页正文提取可用。
- SearXNG 不可用时自动回退 DDGS；配置 Tavily 后可作为最后回退。
- PandaScore 未配置或失效时，电竞问答仍可通过公开搜索给出带来源结果；本期不读取 Riot 密钥，也不把 Riot 宣传成职业比分源。
- 电影评分、电竞比分、票务信息均包含来源和查询时间，不生成无法核验的数字。
- `web_extract` 已导出、注册并可被 Agent 选择，工具总数、提示词、README 和服务健康信息全部更新为 Provider 中立设计。
- 全量测试通过，`git diff --check` 无输出，仓库与历史新增提交中不存在真实密钥。
- 服务器上 SearXNG 仅本机可访问，主程序完成一次真实查询和故障回退 smoke test。
- 变更提交并推送 `main`，线上服务重启后健康检查通过。
