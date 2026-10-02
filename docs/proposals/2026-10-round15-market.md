# 第十五轮方案：市场做主页 · 参考 Codex 的插件市场 · MCP 接入 · 平台自己的开源插件

2026-10-02 · 依据用户要求：① 智能体市场前端参考 Codex 的插件目录重做，提升体验；② 用已有的导入能力，做一批平台自己的开源工具（技能 + MCP）；③ 登录页改为 `/login`，插件市场作为主域名首页，整体体验优化。

## 1 路径（契约，前端地基已提交在 `web-src/src/routes.js`）

| 路径 | 页面 | 说明 |
| --- | --- | --- |
| `/` | 智能体市场 | 主域名首页，未登录也能逛；已登录时顶栏有「进入我的智能体」 |
| `/login` | 登录页 | 现有登录页（视觉不变）；`?u=` 预填账号并处理换号确认；`?next=` 登录后去哪（只接受站内路径） |
| `/app` | 主应用 | 对话 / 今日板；未登录访问跳 `/login?next=/app` |
| `/flows` | 积木流程 | 不变 |
| `/p/<slug>` | 智能体品牌入口 | 不变；登录后进 `/app` |
| `/market` | 兼容旧链接 | 重定向到 `/` |
| `/?u=X` 等旧链接 | 兼容 | 重定向到 `/login?u=X` |

站内链接一律用 `MARKET_PATH` / `LOGIN_PATH` / `APP_PATH` / `loginHref(username, next)`，不再手写 `'/'`、`'/?u='`。登出、401、会话过期 → `/login`。服务端对 `/login`、`/app` 回 index.html。

## 2 MCP 插件（契约，C 实现、D 按此写官方 MCP 插件）

- 插件包里放 `mcp.json`（Agent Plugins 标准）：
  ```json
  {"mcpServers": {"amap": {"type": "streamable-http", "url": "https://mcp.amap.com/mcp?key=${AMAP_KEY}"}}}
  ```
  也可以带 `"headers": {"Authorization": "Bearer ${TOKEN}"}`。第一版只支持远程 `streamable-http`（以及老式 `sse`，能做就做）；本地 stdio 一律拒绝并说明（服务器没有 node / uvx）。
- `plugin.json` 新增可选 `config`：`[{"key": "AMAP_KEY", "label": "高德 Web 服务 Key", "secret": true, "required": true, "help": "在 lbs.amap.com 控制台申请"}]`。`${KEY}` 占位符只能出现在 url 和 headers 里，由管理员在插件管理里填写（密钥加密存储、永不回显）；缺必填项时插件显示「需要配置」，不可加入工具箱。
- 安装 / 保存配置时连一次服务器：`initialize` → `tools/list`，把工具清单（名称、说明、参数 schema）存档；工具在 Agent 里的名字是 `<插件id>__<工具名>`（清洗成 `[a-z0-9_]`）。以后重连时如果工具清单变了，插件自动停用，等管理员确认新清单再启用（防「装好后偷偷换工具」）。
- 调用：超时（默认 30 秒）、结果截断（约 8000 字）、异常转人话；MCP 返回的内容一律当「外部资料」，不当指令。
- 市场里 MCP 插件带「MCP」徽标，权限写「联网：<主机名>」。管理员也可以在插件管理里**直接添加一个 MCP 服务**（填名称、图标、地址、请求头 / Key），不必先建仓库。

### 2.1 实现补充（C，已落地；以下是对上面契约的细化与改动）

- **清单写法**：MCP 插件的 `plugin.json` 写 `kind: "tool"`（也接受 `"mcp"`，加载时规整成 `tool`）、`entry: null`、`tools: []`（写了也忽略，工具靠发现）。服务定义读插件根目录的 `mcp.json`，也认 `.mcp.json` 和 `plugin.json` 里的 `mcpServers`（对象或相对路径）。每个插件最多 3 个服务；`type` 认 `streamable-http`（`http` 是别名）和 `sse`；有 `command` 或 `type: "stdio"` 的服务拒绝，原因写明。
- **config**：每项 `{key, label, secret(默认 true), required(默认 true), help, placeholder}`，最多 10 项；url / headers 里用到但没声明的 `${KEY}` 自动补成「必填密钥」。替换时 url 里的值按查询参数编码；可选项没配时，含它的请求头整个去掉。
- **存放**：配置在 `$JARVIS_DATA_DIR/plugins/_config.json`（0600），密钥项 AES-GCM 加密，主密钥优先用 `JARVIS_SECRETS_KEY`，没配时退回同目录自动生成的 `_secret.key`（插件管理里会提示建议配主密钥）；接口只回「已配置」与（≥12 位时）末四位。工具清单存档在 `_state.json` 的 `mcp` 段（工具、指纹、待确认的变化）。
- **状态**：插件状态多了 `needs_config`（缺必填配置）与 `needs_review`（工具清单有变化，待确认，不绑定任何工具）。还没拿到过工具清单的 MCP 插件先是 `unavailable`（原因「正在连接 MCP 服务」），服务启动时后台自动连接（免 Key 的装好即可用）；`JARVIS_MCP_AUTOCONNECT=0` 可关，测试环境（`JARVIS_ENV=test`）默认关。
- **工具名**：`<插件id>__<工具名>`，驼峰拆开、清洗成 `[a-z0-9_]`、总长 ≤ 64、重名加 `_2`。工具说明末尾注明「来自 MCP 服务「名称」· 主机」。
- **市场目录字段**（`/api/market/catalog`）：`mcp: true`、`hosts: ["mcp.amap.com"]`、`permissions: [{key: "network", label: "联网：mcp.amap.com", level: "warn"}]`、`status: "needs_config"` + `reason`、`tools` 为发现到的工具名；另给所有条目加了 `license`、`description`、`privacy_url`。
- **接口**（仅 Owner，写操作要 CSRF）：`POST /api/plugins/{id}/config` `{values, clear}`（留空 = 不改，保存后自动测试连接）、`POST /api/plugins/{id}/test`、`POST /api/plugins/{id}/approve` `{fingerprint}`、`POST /api/plugins/mcp/preview` `{name, url, icon?, summary?, category?, transport?, headers?: [{name, value}], key?: {value, mode: bearer|header|query, name}}` → 预览后照旧走 `POST /api/plugins/import/confirm`。`GET /api/plugins` 每行多一个 `mcp` 字段（服务、配置项视图、工具、待确认的差异）。直接添加时查询参数里像密钥的值（key / token …）和所有请求头都转成 `${占位符}` 加密保存，`mcp.json` 里不落明文。
- **以后「每个账号自己的 Key」**：`mcp.resolve_values(plugin_id, items, user_id=…)` 是扩展点，现在只读全站配置。

## 3 平台自己的开源插件（D）

- 官方插件放在 `jarvis/plugins/packs/<id>/`（随平台发布，市场「官方」页签），每个插件 `plugin.json` 写 `"license": "MIT-0"`、`"author": "JWS-Agent"`，`jarvis/plugins/packs/LICENSE` 用 MIT-0（与插件模板一致）。
- 仓库根目录放 `.agents/plugins/marketplace.json`，把这些官方插件按 `local` 来源列出——别人把本仓库地址添加为「插件源」就能一键装我们的插件（兼容 Codex / ChatGPT 的插件源格式）。
- 第一批：技能插件 10–15 个（面向下沉市场、办公、学习、生活的中文写作 / 规划类技能）、纯 Python 工具插件 4–6 个（不新增依赖）、MCP 插件 3–4 个（DeepWiki、Context7 免 Key；高德地图等需 Key 的标「需要配置」）。线上服务器实测：mcp.deepwiki.com、mcp.context7.com、mcp.amap.com 都可达。

## 4 分工

| 代理 | 范围 | 主要文件 |
| --- | --- | --- |
| A 路由与登录 | 第 1 节全部；登出 / 401 / 换号 / `?next=`；全站链接改用常量；进场动画只在 `/` 首次播；服务端路由与测试；桌面端里打开网页的链接指向 `/app` | `routes.js`、`App.jsx`、`Login.jsx`、`loginParam.js`、`Hud.jsx`/`AccountMenu.jsx` 的登出、`platform/PlatformEntry.jsx`、`flows/Flows.jsx` 返回按钮、`intro/`、`jarvis/server.py` 静态页一段、`desktop/` |
| B 市场体验（参考 Codex） | 市场浏览与旅程的全部前端：顶栏（搜索、登录 / 进入我的智能体）、精选、分类、插件卡、插件详情、工具箱、起名、结果页；手机优先 | `web-src/src/market/` 下除 `PluginAdmin.jsx` 外的文件 |
| C MCP 接入 | 第 2 节全部：后端 MCP 客户端、配置与密钥、工具清单存档与变更保护、市场目录字段；插件管理里的 MCP 配置与「直接添加 MCP 服务」 | `jarvis/plugins/`（mcp 相关新文件 + loader / routes 接线）、`market/PluginAdmin.jsx`、依赖 |
| D 官方开源插件 | 第 3 节全部 | `jarvis/plugins/packs/<新插件>/`、`.agents/plugins/marketplace.json`、`jarvis/plugins/packs/LICENSE`、`docs/plugins.md` 补充 |
