# JWS-Agent 共享 API Provider 设置设计

日期：2026-08-11
状态：安全修订版已由用户书面确认（v4）

## 目标与范围

为 JWS-Agent 增加一套服务器端统一管理的 API 设置中心。用户可以从网页端或 macOS 悬浮窗选择官方模型 Provider，或填写 OpenAI-compatible 第三方中转的 Base URL、模型名和 API Key；还可以管理 SearXNG、Tavily、PandaScore 等联网数据源。

服务器是唯一配置来源。网页端、悬浮窗、个人微信和服务器上的 CLI 不各自保存一份密钥：网页、桌面和微信立即共享服务器的活动模型，CLI 下一次启动时读取同一份持久配置。这个设计作为《JWS-Agent Hermes 风格联网检索设计》的独立配套子系统，不改变其中的免费优先降级链。

本期只支持 OpenAI Chat Completions 兼容协议及工具调用，不实现 Anthropic 原生协议、任意自定义请求头、多 Provider 负载均衡或按用户/入口选择不同模型。

## 方案选择

采用用户确认的“服务器全局共享配置”方案：

- 一处配置、所有入口同步生效，避免网页、桌面和微信使用不同模型。
- 密钥只传到受控后端并保存在服务器，客户端不持久化。
- 模型切换由服务器测试、原子应用和回滚，客户端不直接请求模型供应商。

不采用浏览器直连模型 API，因为浏览器代码和存储会暴露密钥；也不采用桌面独立配置，因为它无法同步到网页与微信，并会扩大密钥散落范围。

## Provider 目录

后端维护可升级的 Provider 目录，前端只消费目录，不在两套 UI 中重复硬编码。

| ID | 名称 | 默认 Base URL | API Key 入口 | 说明 |
| --- | --- | --- | --- | --- |
| `openai` | OpenAI 官方 | `https://api.openai.com/v1` | `https://platform.openai.com/api-keys` | 模型从 `/models` 获取或手动填写 |
| `deepseek` | DeepSeek 官方 | `https://api.deepseek.com` | `https://platform.deepseek.com/api_keys` | OpenAI-compatible；模型目录随官方更新 |
| `bailian` | 阿里云百炼 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `https://help.aliyun.com/zh/model-studio/get-api-key` | Base URL 随地域可能不同，允许修改 |
| `siliconflow` | SiliconFlow | `https://api.siliconflow.cn/v1` | `https://cloud.siliconflow.cn/account/ak` | 模型从平台目录选择或手动填写 |
| `custom` | 自定义中转 | 无 | 无 | 必须兼容 OpenAI Chat Completions 与工具调用 |

API Key 不是项目提供的公共值，而是用户在对应供应商账户中创建的个人凭据。界面提供“打开官方申请页”，不显示示例真 Key，不宣传或内置来源不明的共享中转密钥。

## 联网数据源目录

- `searxng`：默认搜索；配置 Base URL，不需要 API Key。
- `tavily`：可选最后搜索回退；配置 `TAVILY_API_KEY`。
- `pandascore`：可选职业赛事结构化数据；配置 `PANDASCORE_TOKEN`。
- `riot`：本期不展示、不保存。标准 Riot API 不作为职业俱乐部比分源。

联网数据源配置只改变《Hermes 风格联网检索设计》中相应 Provider 是否可用，不改变既定的 `SearXNG → DDGS → Tavily` 搜索顺序。

## 服务器组件

### ProviderCatalog

返回预设 ID、名称、默认 Base URL、官方申请链接、是否允许编辑 Base URL、是否需要 Key 和协议类型。目录内容不包含密钥或账户信息。

### SecretStore

- 每一代完整设置（非敏感字段、enabled 状态和 API Key）写入不可变的 `JARVIS_DATA_DIR/provider-generations/<generation>.enc`，使用 `JARVIS_SECRETS_KEY` 提供的 Fernet 主密钥进行认证加密；配置与密文不拆成两个无法共同提交的文件。
- `JARVIS_DATA_DIR/provider-active.json` 是不含秘密的活动清单，只记录 `active_generation`、`previous_generation` 和密文 SHA-256。它通过同目录临时文件、文件 `fsync`、原子 rename 和目录 `fsync` 提交。
- 所有配置修改的提交阶段取得进程内写锁和跨线程/进程文件锁，并校验客户端传入的 `expected_generation`。不匹配返回 `409 CONFIG_CONFLICT`，禁止陈旧页面覆盖新配置；锁外 Probe/构建仍按下一条两阶段流程执行。
- 提交使用两阶段事务，网络 I/O 永不持有阻塞聊天的写锁：先在短暂读锁下校验 `expected_generation` 并复制对应快照；释放锁后执行 Probe、构建候选 RuntimeBundle 和生成候选密文；随后取得写锁与文件锁并重新校验 generation。若活动代已变化，立即释放候选资源并返回 `409 CONFIG_CONFLICT`；未变化才快速写入 generation、CAS 更新 manifest 和交换运行时。
- manifest 切换后，内存 RuntimeBundle 指针交换设计为无异常赋值。若仍发生意外异常，必须在同一锁内立即把 manifest 回滚到旧 generation 并保留旧 runtime；回滚写入也失败时进入 fail-closed degraded 状态、拒绝新设置写入并触发受控进程重启，绝不返回成功。
- 只有磁盘活动 generation 与内存 RuntimeBundle 一致后才返回成功；设置网络测试可能耗时，但测试期间现有聊天和新 lease 不被阻塞。
- 进程崩溃或启动时验证 active manifest、密文摘要和解密结果；活动代损坏时使用清单中的上一代恢复并记录脱敏审计。已经成功提交后的用户主动回滚会创建新的递增 generation，不复写历史代；尚未成功的事务在异常中恢复旧 manifest 不算一次新回滚提交。
- generation 文件和 manifest 均为 `0600`；失败临时文件立即清理，并按保留策略只留下活动代、上一代和有限审计所需代。
- `JARVIS_SECRETS_KEY` 只由服务器环境或 systemd Secret 注入，不与加密文件存放在仓库，不通过网页设置，也不出现在命令输出和日志中。
- 缺少或无效主密钥时，若没有托管活动代则仍可读取环境变量配置并聊天，但设置接口进入只读状态；若已经存在托管活动代则 fail closed 并给出本机可操作错误，禁止静默回退到另一组环境 Key。

配置优先级固定为：已验证的托管配置优先于环境变量；不存在托管模型配置时读取 `JARVIS_PROVIDER`、`JARVIS_BASE_URL`、`JARVIS_MODEL` 和通用 `JARVIS_API_KEY`。`JARVIS_PROVIDER` 缺失时为兼容现有部署默认 `deepseek`。通用 Key 缺失时，只在 `provider=openai` 时读取标准 `OPENAI_API_KEY`，只在 `provider=deepseek` 时读取旧的 `DEEPSEEK_API_KEY`，绝不能把一个 Provider 的 Key 静默发送给另一个 Provider。联网数据源继续读取 `TAVILY_API_KEY` 和 `PANDASCORE_TOKEN`。用户选择“恢复服务器环境配置”时原子删除相应托管覆盖，不删除环境变量。

`.env.example` 和 README 将以 `JARVIS_PROVIDER` + `JARVIS_API_KEY` 作为新推荐写法，同时列出 `JARVIS_ADMIN_USERNAME`、`JARVIS_ADMIN_PASSWORD`、`JARVIS_SESSION_SECRET`、`JARVIS_SECRETS_KEY` 与写入 feature flag，并保留 `DEEPSEEK_API_KEY` 的兼容说明；迁移不能使现有 DeepSeek 部署在升级后失去模型凭据。

CLI 要读取托管配置时必须使用与 `jarvis-web.service` 相同的 `JARVIS_DATA_DIR` 和 `JARVIS_SECRETS_KEY`。拿不到主密钥时明确失败，不静默改用环境配置；没有托管活动代时才走上述环境兼容路径。

当 LLM 与全部联网数据源都删除托管覆盖时，事务写入不含密文引用的 `mode=environment` manifest，并把运行时切到环境快照；这种纯环境活动态不要求主密钥。只要仍存在托管 Key、托管禁用或自定义设置，active manifest 就必须引用可解密的 generation，主密钥丢失时继续 fail closed。上一代密文可以保留用于有主密钥时回滚，但不会阻止纯环境活动态启动。

### ProviderProbe

对候选配置执行以下测试：

1. 在不允许重定向的条件下请求模型目录；若 Provider 不支持 `/models`，允许用户手动输入模型名并继续。
2. 执行一次极小的非流式强制工具调用；使用无副作用函数和明确 `tool_choice`，只有返回可解析目标工具调用才判定兼容。
3. 执行一次极小的流式文本请求，确认网页 SSE 所需的文本 chunk 可以解析和结束。
4. 执行一次流式强制工具调用，确认工具名、ID 和参数增量 chunk 能按当前 ChatOpenAI/LangGraph 路径正确拼装。

第 2–4 步可能产生少量模型费用，界面必须在按钮旁明确提示。这样同时覆盖微信/普通 invoke 的非流式路径，以及网页和 OpenAI-compatible 接口的流式文本/工具路径。测试只返回 `ok`、总延迟、经过清洗的错误类别、可选模型 ID 和两种调用模式是否兼容；不把供应商原始响应、请求头或 Key 返回客户端。

### AgentRuntimeManager

- 每个 `RuntimeBundle` 同时包含固定 generation 的模型客户端、SearchService、由该 SearchService 绑定的搜索/娱乐工具实例、完整工具注册表和 Agent。现有模块级搜索单例改为 bundle 工厂，防止旧 Agent 在回答中途调用到新搜索配置。
- AgentRuntimeManager 以 generation 管理 RuntimeBundle，并提供同步/异步 `acquire()` lease；lease 返回固定代的 bundle，并在 `finally` 中 `release()` 计数。
- `acquire()` 在与配置提交相同的读写锁下短暂读取活动 generation；提交持有写锁期间新 lease 等待，因此请求只能看到完整的旧代或完整的新代，不能看到“manifest 已更新、运行时未切换”的中间态。
- 网页 SSE、非流式聊天、OpenAI-compatible 流式/非流式接口、历史状态读取和微信消息处理凡是访问 Agent，都必须通过相同 lease 契约；任何异常、断流或取消都在 `finally` 释放。
- SQLite CheckpointStore 是跨 generation 的服务器级稳定资源，只在服务退出时关闭；RuntimeBundle 不拥有也不关闭它。每代拥有自己的模型 HTTP 客户端、SearchService HTTP 资源、工具注册表和 Agent 封装。
- 保存时先测试候选配置，再构建候选 RuntimeBundle；构建成功后按 SecretStore 事务提交磁盘 generation，并在同一写锁内切换活动 bundle。
- 已经取得 lease 的流式回答继续使用旧运行时；切换后的新 lease 使用新 generation。
- 退休 bundle 在 lease 计数归零后整体关闭模型与搜索的同步/异步 HTTP 客户端；超时未归零只记录诊断，不强杀正在输出的回答。
- 配置写入、Agent 构建或切换任一步失败，都保留旧配置和旧运行时，不出现“设置显示已保存但聊天不可用”。
- 网页、桌面和微信通过服务器 Agent 获取器自然使用新版本；CLI 新进程从共享配置构建运行时。

## 后端 API

除网页登录、桌面登录和未认证 session 探测外，业务与设置接口都要求有效网页会话 Cookie 或桌面 `X-JWS-Token`；认证与设置响应均返回 `Cache-Control: no-store`。

### 读取

`GET /api/settings/providers`

返回 Provider 目录、当前非敏感模型配置、联网数据源状态和设置能力：

```json
{
  "writable": true,
  "llm": {
    "provider": "deepseek",
    "base_url": "https://api.deepseek.com",
    "model": "example-model",
    "key_configured": true,
    "source": "managed",
    "generation": 2
  },
  "integrations": {
    "searxng": {"enabled": true, "source": "managed", "key_configured": false, "healthy": true, "generation": 2},
    "tavily": {"enabled": false, "source": "managed", "key_configured": false, "healthy": null, "generation": 2},
    "pandascore": {"enabled": false, "source": "environment", "key_configured": false, "healthy": null, "generation": 2}
  },
  "catalog": []
}
```

响应不包含 `api_key`、Key 前后缀、加密文本、管理员口令或主密钥。

### 测试与保存模型配置

- `POST /api/settings/llm/test`：接收候选 Provider、Base URL、模型、可选新 Key、当前管理员口令和 `expected_generation`，执行 ProviderProbe，不持久化。
- `PUT /api/settings/llm`：接收同一候选配置，服务器再次测试后按 generation 事务保存并切换运行时。
- `DELETE /api/settings/llm`：接收当前管理员口令和 `expected_generation`，创建一个明确恢复环境来源的新 generation 并重建运行时。

Key 凭据范围定义为 `credential_scope = provider + 规范化 origin`。只有候选配置与当前配置的 `credential_scope` 完全相同且 body 明确传 `keep_existing_key=true` 时才允许复用旧 Key；Provider、scheme、host 或有效端口任一变化都必须提交新 Key，服务器不得把旧 Key 发送到新 origin。显式恢复环境配置必须使用 DELETE。PUT 成功响应只返回新的脱敏配置和 generation。

所有包含 `api_key` 或 `admin_password` 的 Pydantic 字段使用 `SecretStr`/专用秘密模型，禁止 repr 和序列化。FastAPI 422、全局异常处理和请求日志只能返回字段名与稳定错误码，不能回显无效原值。

### 测试与保存联网数据源

- `POST /api/settings/integrations/{provider}/test`
- `PUT /api/settings/integrations/{provider}`
- `DELETE /api/settings/integrations/{provider}`

`provider` 只允许 `searxng`、`tavily`、`pandascore`。精确请求体如下：

- SearXNG PUT/TEST：`enabled: bool`、`base_url: str`、`admin_password: SecretStr`、`expected_generation: int`。
- Tavily/PandaScore PUT/TEST：`enabled: bool`、`api_key?: SecretStr`、`keep_existing_key: bool = false`、`admin_password: SecretStr`、`expected_generation: int`。
- DELETE：`admin_password: SecretStr`、`expected_generation: int`，表示移除托管覆盖并恢复环境来源。

托管 `enabled=false` 必须覆盖环境中已有的 Key，使用户能从 UI 明确禁用 Provider；它不同于 DELETE。空 Key 仅在同一 Provider 凭据范围且 `keep_existing_key=true` 时保留。响应统一返回 `enabled/source/key_configured/healthy/generation`。

SearXNG 测试执行固定的无敏感查询，Tavily 和 PandaScore 使用最小只读请求，不改变业务数据。联网配置保存同样在锁外构建包含新 SearchService、全新熔断状态和空查询缓存的候选 RuntimeBundle，再通过相同 generation CAS 交换；旧 lease 继续使用旧 SearchService，归零后随旧 bundle 释放。降级顺序始终保持 `SearXNG → DDGS → Tavily`。

### 认证与节流

- 删除 `jarvis/server.py` 和桌面 renderer 中的硬编码 `admin/admin`。
- 网页服务从 `JARVIS_ADMIN_USERNAME` 与 `JARVIS_ADMIN_PASSWORD` 读取凭据；任一缺失时无条件 fail closed，`jarvis-web` 不启动，不存在“公网/本地”弱口令分支。
- 网页与桌面登录接口分离：`POST /api/login` 只设置网页 Cookie，响应绝不包含 bearer Token；`POST /api/desktop/login` 只供 Electron main-process 客户端使用，返回桌面会话 Token，renderer 永远看不到响应中的凭据。
- 登录成功生成 256-bit 随机、逐会话 Token；服务器只在 SQLite session 表保存 session ID、Token SHA-256 摘要、创建时间、绝对过期时间、最近活动时间和客户端类型。Token 默认 30 天绝对过期，可单独吊销；登出立即吊销当前会话，管理员凭据版本变化时吊销全部旧会话。最近活动时间每个 session 最多 5 分钟更新一次，避免流式请求产生持续 SQLite 写竞争。
- 网页 Cookie 使用 `HttpOnly`、`SameSite=Strict`，生产 HTTPS 下强制 `Secure`；只有显式开发模式且请求来自回环地址时允许非 Secure Cookie。
- CSRF Token 不保存也不从摘要反推，而是按固定 UTF-8/原始字节编码确定性计算：`HMAC(JARVIS_SESSION_SECRET, b"csrf-v1\0" + token_bytes + b"\0" + session_id_utf8)`。服务端从 HttpOnly Cookie 取得原始会话 Token、按其摘要找到 session ID，再计算当前 CSRF；`JARVIS_SESSION_SECRET` 是独立的服务器 Secret，不进入前端或仓库。
- `GET /api/session` 在已认证网页 Cookie 下返回 `authed`、计算出的 `csrf_token` 和 `expires_at`，不返回 bearer Token；登录/重新登录生成新 session Token，因此自然生成新 CSRF，登出或会话过期使其失效。所有网页状态变更请求必须发送 `X-JWS-CSRF`，服务器重新计算并常量时间比较；缺失或不匹配返回 `403 CSRF_FAILED`。桌面 bearer 请求不使用网页 CSRF。
- 桌面端 Token 仅由 Electron main process 持有，并用 `safeStorage`/系统钥匙串加密持久化；renderer、`localStorage`、DOM 和 preload 返回值都拿不到 Token。首次连接或 Token 失效时显示登录界面，不保存管理员口令。
- 桌面服务器地址只允许 `https://`；显式开发模式只允许 `http://127.0.0.1` 或 `http://[::1]`。恢复 `webSecurity: true`，由 main process 的受限网络层和窄 IPC 完成登录、聊天、设置与流式事件转发，renderer 不能任意 fetch 或附加认证头。
- 设置测试、保存和删除除现有登录态外，还必须重新验证当前管理员口令；口令只存在于当次请求内存，前端请求结束立即清空。
- 登录和设置写操作按来源地址与会话节流；失败响应不区分用户名、口令或 Key 哪一项错误。服务端通过 `JARVIS_SETTINGS_WRITE_ENABLED` 独立控制设置写入，关闭时即使主密钥存在也只读。
- `GET /api/session`、`POST /api/login` 和 `POST /api/desktop/login` 与全部设置接口都返回 `Cache-Control: no-store`。

生产服务固定单 Uvicorn worker；RuntimeBundle 和 generation 交换只在这个进程内维护。systemd/启动配置显式设置 `workers=1`，检测到多 worker 配置时启动失败；本期不实现跨进程 runtime 广播。

## URL 与中转安全

- 官方预设只允许目录中的官方主机；百炼允许用户选择文档列出的地域端点。
- 自定义模型中转只允许无用户名、无密码、无查询串、无 fragment 的公开 `https://` Base URL。
- `SafeProviderTransport` 是 Probe 和实际模型运行时唯一允许使用的同步/异步网络实现：检查域名返回的全部 DNS 地址，只要包含回环、私网、链路本地、保留地址或云元数据地址就拒绝。
- SafeProviderTransport 为每条连接固定一个已经批准的 IP，同时保留原始 Host Header 与 TLS SNI/证书校验；不得“预解析后再让普通客户端重新解析”。连接池新建连接或 DNS TTL 到期时重新完成全部校验，从而关闭 DNS rebinding 窗口。
- 同一 transport factory 创建 `httpx.Client` 与 `httpx.AsyncClient`，统一设置 `trust_env=false`、禁用环境代理、`follow_redirects=false` 和受限超时，再通过 `http_client`/`http_async_client` 注入 ChatOpenAI。ProviderProbe 与运行时不得另建绕过该实现的 HTTP 客户端。
- Key 只能发送给已经验证的精确 `credential_scope` origin；响应中的 redirect 一律作为错误，不跟随到新主机。
- 本期不允许自定义 Header、代理地址或 TLS 验证开关，避免把 Key 转发到不可审计目标。
- 自定义中转选择区持续显示风险提示：中转运营方可以读取问题、上下文、工具调用与模型输出；建议使用独立、低额度、可随时吊销的 Key。

SearXNG Base URL 只接受两类地址：通过安全传输校验的公开 `https://` URL，或精确的本机 `http://127.0.0.1:8888` / `http://[::1]:8888`（允许末尾 `/` 规范化）。其他 HTTP、其他回环端口和任何私网地址均拒绝；本机特例不能复用于自定义模型中转。

## 网页端体验

- 顶栏新增齿轮按钮，打开与微信弹窗同层级的“API 设置中心”。
- 设置中心包含“模型 API”和“联网数据源”两个页签。
- 模型页包含 Provider 下拉框、Base URL、模型选择/输入、密码型 API Key 输入、“测试连接”“保存并应用”“恢复服务器配置”和官方申请链接。
- Key 输入始终为空。同一凭据范围内显示“已配置；可勾选保留”，Provider 或 origin 改变后强制输入新 Key且禁用“保留”选项。保存或测试结束后立即清空 DOM 状态。
- 测试成功显示延迟与工具调用兼容性；测试失败只显示可操作的脱敏错误。
- 保存成功后顶栏模型名称和 Provider 状态立即刷新，无需刷新页面。
- 狭窄屏幕使用全屏设置抽屉，所有输入有可见 label、键盘焦点和错误关联。
- 官方申请链接使用新窗口并设置 `noopener,noreferrer`，链接目标只能来自 ProviderCatalog。

## macOS 悬浮窗体验

- 现有设置页改为“基础设置 / 模型 API / 联网数据源”三个页签，模型与联网表单字段、状态文案和行为与网页一致。
- Electron main process 通过受限 API 客户端调用相同设置接口，并把脱敏结果或流式事件经窄 IPC 传给 renderer；不沿用 renderer 任意 fetch 的 `api()` 包装器，不在 `settings.json`、`localStorage`、IPC 日志或 preload 暴露对象中持久化 Key。
- Token 失效时打开登录表单；不再使用 renderer 内置用户名和口令自动登录。
- main process 每次需要登录时先请求 `POST /api/desktop/login`；只有明确收到 `404` 或 `405` 才回退旧后端的 `POST /api/login`。`401`、`429`、超时、TLS 或网络错误不得触发旧端点回退。新后端上线或旧 Token 失效后的下一次登录仍从 `/api/desktop/login` 开始，不永久缓存旧能力。
- 旧后端 `/api/login` 返回的 Token 和新后端桌面 Token 都只在 main process/safeStorage 内处理。新版首次启动在加载可交互 renderer 前删除遗留的 `localStorage['jws_token']`，之后 renderer 代码不再读取或写入该键。
- 官方申请链接通过 preload 暴露的窄接口调用 Electron `shell.openExternal`，只允许 ProviderCatalog 中的 HTTPS 地址，不能由页面任意打开 URL。
- 保存成功后清空 Key 和管理员口令输入，并更新面板顶部在线/模型状态。

## 错误处理与审计

- 统一错误码：`AUTH_FAILED`、`CSRF_FAILED`、`READ_ONLY`、`CONFIG_CONFLICT`、`INVALID_URL`、`DNS_BLOCKED`、`TLS_FAILED`、`PROVIDER_AUTH`、`MODEL_NOT_FOUND`、`TOOL_CALL_UNSUPPORTED`、`RATE_LIMITED`、`TIMEOUT`、`APPLY_FAILED`。
- API 返回稳定中文提示和错误码，不返回异常堆栈、供应商完整响应或本地文件路径。
- 现有聊天 SSE、OpenAI-compatible 接口和微信错误同样经过 Provider 错误映射，只返回稳定错误码与脱敏提示，不再把 `type(e)` 或异常文本直接发给客户端。
- 日志仅记录 Provider ID、错误码、延迟、配置 generation 和请求 ID；统一脱敏 Authorization、API Key、管理员口令和疑似 Key 前缀。
- 设置变更写入不含秘密的审计记录：时间、来源入口、旧/新 Provider、旧/新模型、结果和 generation。
- Dashboard 只展示当前 Provider、模型和健康状态，不展示 Base URL 中可能存在的租户路径。

## 测试策略

按 TDD 实现，每项生产行为先观察失败测试：

- SecretStore：Fernet 加解密、错误主密钥、不可变 generation、manifest CAS、并发写锁、崩溃恢复、`fsync`/`0600`、上一代回滚、环境兼容和响应/日志无秘密。
- ProviderCatalog/URL：官方预设、自定义 HTTPS、禁止凭据/查询串/重定向、SafeProviderTransport、全部 DNS 地址、固定对端 IP、正确 Host/SNI、私网/元数据和 DNS rebinding。
- ProviderProbe：模型目录、手动模型、认证失败、限流、超时和清洗错误，并逐项覆盖非流式强制工具调用、流式文本 chunk、流式强制工具 chunk 三条路径。
- AgentRuntimeManager：锁外 Probe/构建、二次 generation 校验、lease acquire/release、网页/微信/OpenAI-compatible 全入口、模型与 SearchService 同 bundle、原子切换、在途工具调用、失败回滚、共享 CheckpointStore 和旧 HTTP 资源释放。
- API：未登录、逐会话过期/吊销、确定性 HMAC CSRF 与常量时间比较、网页登录不返回 bearer、桌面登录返回 main-process Token、重新验证失败、feature flag 只读、generation 冲突、凭据范围变化强制新 Key、同范围保留 Key、托管禁用覆盖环境、恢复环境、SecretStr 422、写操作节流、单 worker 和 `no-store`。
- 网页端 Vitest：Provider 切换、Key 永不回显、测试/保存状态、恢复配置、401 和窄屏可访问性。
- 桌面 Node 测试：main-process 会话、safeStorage、清除遗留 `jws_token`、新端点优先/仅 404 或 405 回退、Token 过期、HTTPS/回环地址、`webSecurity: true`、窄 IPC、三页签、Key/口令不进本地存储和外链 allowlist。
- Agent 闭环：网页、桌面、微信请求在切换后使用同一 generation；CLI 新进程读取共享配置。
- 敏感信息扫描：新增提交、构建产物、测试报告、日志和截图不得包含真实 Key、主密钥或管理员口令。

测试使用固定 Stub/Mock Provider，不调用真实模型、不消费用户额度。真实上线 smoke test 由用户在 UI 中安全填写新 Key 后触发，测试按钮会明确提示可能产生极少量费用。

## 分阶段交付与复核

1. 认证迁移、SecretStore 与 ProviderCatalog：独立 Agent TDD 实现，独立复核密钥边界和兼容迁移。
2. ProviderProbe 与 AgentRuntimeManager：独立 Agent TDD 实现，复核 URL 安全、工具调用测试、原子切换和回滚。
3. 后端设置 API 与联网数据源接线：独立 Agent TDD 实现，复核认证、脱敏和 Hermes 搜索配置联动。
4. 网页设置中心：独立 Agent TDD 实现并构建，使用真实浏览器复核宽屏、窄屏和键盘操作。
5. 悬浮窗设置页与登录迁移：独立 Agent TDD 实现，复核 Electron 存储、IPC 和外链边界。
6. 全量文档、部署和上线：独立 Agent 实施，最终 Agent 运行全量测试、构建、敏感信息扫描、生产 smoke test 与回滚演练。

每阶段由新的实现 Agent 完成，再由独立复核 Agent 检查规格符合性和代码质量；未通过复核不得进入下一阶段。

实现阶段可以先完成后端认证代码，但生产环境不得在第 5 阶段桌面兼容客户端准备完成前启用新认证。

## 上线与回滚

1. 部署前记录生产 SHA、网站/微信健康状态和现有环境配置；不读取或输出已有 Key。
2. 先安装兼容旧后端的新版桌面客户端：main-process 登录按“首选 `/api/desktop/login`，仅 404/405 回退旧 `/api/login`”协商，把旧 Token 放入 safeStorage、清除 renderer 遗留 Token，并在 `webSecurity: true` 下完成聊天 smoke test。确认后才能迁移服务器认证。
3. 在服务器安全环境中分别生成 `JARVIS_SECRETS_KEY` 与 `JARVIS_SESSION_SECRET`，配置新的管理员凭据并确保 Secret 文件仅服务用户可读；初始设置 `JARVIS_SETTINGS_WRITE_ENABLED=false`。
4. 在明确维护窗口内原子部署新后端认证、网页前端与设置只读接口。旧桌面会话失效时，新版桌面显示登录表单；网页 Cookie 重新登录。不得出现“新后端已上线但用户仍只有旧桌面客户端”的状态。
5. 确认网页、桌面、微信、旧环境模型、会话吊销和 SecretStore 后，把 feature flag 改为 `true`。用户通过网页或悬浮窗填写已经轮换的新 Key；聊天中出现过的 Key 禁止重新使用。
6. 验证网页、桌面、微信共享 generation，执行模型/搜索切换、在途调用、并发冲突、失败回滚和服务重启恢复。
7. 失败时切回记录 SHA、恢复原 systemd 环境并重启 `jarvis-web.service`；保留 `/var/lib/jarvis`、微信登录状态和用户数据。加密配置与新主密钥成对备份或成对移除，不能只恢复其中一个；若已迁移会话，回滚说明必须包含重新登录预期。

## 验收标准

- 网页和悬浮窗都能查看脱敏状态、测试、保存和恢复模型/联网 Provider。
- OpenAI、DeepSeek、百炼、SiliconFlow 预设和自定义 OpenAI-compatible HTTPS 中转可配置。
- API Key、管理员口令和主密钥不被 API 读回，不出现在浏览器/Electron 持久存储、日志、测试或 Git。
- 网页会话随机、可过期、可吊销；桌面 Token 只存在 main process 的 safeStorage，renderer 在 `webSecurity: true` 下无法读取认证值。
- 保存前验证工具调用；失败配置不影响当前对话服务。
- 成功保存后网页、桌面和微信的新请求使用同一 generation，正在输出的回答不中断。
- Probe 同时通过非流式工具、流式文本和流式工具 chunk 测试；联网配置切换时旧 lease 仍使用旧 SearchService。
- Provider/origin 改变时无法复用旧 Key；并发陈旧写入返回冲突，崩溃恢复后磁盘活动代与运行时一致。
- 默认联网搜索仍无需付费 Key；Tavily 与 PandaScore 未配置时不阻断主链路。
- 自定义 Base URL 通过重定向、SSRF、DNS rebinding 和 Key origin 约束测试。
- 全量 Python、Web、Desktop 测试与构建通过，敏感信息扫描及 `git diff --check` 通过。
- 生产重启后设置、模型、微信桥和联网搜索保持健康；回滚演练能恢复原版本且不丢用户数据。
