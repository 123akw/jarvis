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
