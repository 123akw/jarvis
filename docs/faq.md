# 常见问题

[← 返回 README](../README.md) · [功能](features.md) · [部署](deployment.md) · [配置](configuration.md) · [微信与飞书](channels.md) · [架构](architecture.md) · [开发与测试](development.md)

### 网站首页变成了智能体市场，怎么登录？

第十五轮起，根地址 `/` 是智能体市场（不登录也能逛），登录页在 `/login`，主应用（对话、今日板）在 `/app`。已登录时市场右上角有「进入我的智能体」；直接打开 `/app` 没登录会先去 `/login`，登录后自动回来。旧的 `/market` 和带 `?u=` 的旧二维码会自动跳到新地址。

### 点「桌面悬浮窗」后浏览器问我是否允许访问「此设备上的应用」？

这是 Chrome 的「本地网络访问」权限：网页要连本机 `127.0.0.1:17789` 唤起悬浮窗，第一次需要你点「允许」。拒绝过的话，点地址栏左侧的网站设置图标改回允许。没运行时网页会用 `jws://` 拉起 `贾维斯.app`，浏览器问「打开贾维斯？」时勾选「始终允许」。Safari 一律不让 https 页面访问 http 本机，只能走 `jws://`。桌面端的安装方法见 [部署指南 · 桌面悬浮窗](deployment.md#4-启动-macos-桌面悬浮窗)。

### 从 GitHub 导入插件失败怎么办？

服务器在国内时访问 GitHub 经常超时。可以换 Gitee 地址，或者在自己电脑上打开仓库页面点「Code → Download ZIP」，再在「导入插件」里上传 zip。导入只给管理员，安装前会显示作者、版本、许可证、来源和需要的权限；第三方代码会在服务器上运行，只装信任的来源。写插件见 [插件指南](plugins.md)。

### 高德地图、快递100 这类 MCP 插件显示「需要配置」？

它们要用你自己在服务商那里申请的 Key。管理员在市场「插件管理 → MCP 服务」里填写（加密保存、只显示末四位），保存时会自动测试连接并拉取工具清单，成功后插件就能加进工具箱。DeepWiki、Context7 免 Key，装好即可用。

### 为什么搜索没有使用本地 SearXNG？

先按 [`deploy/searxng/README.md`](../deploy/searxng/README.md) 静态检查并启动本地服务，再把 `SEARXNG_BASE_URL` 设为 `http://127.0.0.1:18888` 后重启 Python 服务。未配置或健康检查失败时，SearchService 会按顺序继续 DDGS，而不是把 SearXNG 声称为在线；需要时可另行配置可选 Tavily。天气使用 Open-Meteo，不依赖这些搜索 provider。

### npm install 后提示缺少 Electron 二进制怎么办？

某些 npm 配置会阻止 Electron 安装脚本。先在 `desktop/` 下执行：

```bash
npm rebuild electron
```

仍失败再执行：

```bash
node node_modules/electron/install.js
```

### 询问“这里的天气”却提示没有定位怎么办？

在网页端允许浏览器定位；服务端只在尚无定位时尝试公网 IP 城市级兜底，内网地址或外部定位服务失败时可能拿不到位置。也可以在问题中直接写城市名，例如“深圳未来三天天气”。

### 个人微信失效后怎样恢复？

打开网页头像菜单「接入个人微信」或桌面端“设置 → 个人微信”，重新生成二维码并扫码。若使用命令行备用桥，先确认它没有与内置桥同时连接同一账号，再按 [`wechat/README.md`](../wechat/README.md) 重新认证。更多见 [微信与飞书](channels.md#个人微信桥接)。

### 可以把默认 Web 服务直接暴露到公网吗？

不建议直接暴露。当前 `jarvis-web` 默认只监听 `127.0.0.1`，首次启动必须通过环境变量创建唯一 Owner，并使用 Argon2id、可撤销会话、CSRF 和登录限流；仓库不再提供固定账号或开发口令。公网部署仍应使用 HTTPS 反向代理、限制网络入口、配置强随机 `JARVIS_SESSION_SECRET` 与 Owner 口令、定期备份 `JARVIS_DATA_DIR`，并按组织要求补充日志审计、依赖更新和边界防护。
