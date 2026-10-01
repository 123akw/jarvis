# 常见问题

[← 返回 README](../README.md) · [功能](features.md) · [部署](deployment.md) · [配置](configuration.md) · [微信与飞书](channels.md) · [架构](architecture.md) · [开发与测试](development.md)

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

打开网页顶栏“微信”或桌面端“设置 → 个人微信”，重新生成二维码并扫码。若使用命令行备用桥，先确认它没有与内置桥同时连接同一账号，再按 [`wechat/README.md`](../wechat/README.md) 重新认证。更多见 [微信与飞书](channels.md#个人微信桥接)。

### 可以把默认 Web 服务直接暴露到公网吗？

不建议直接暴露。当前 `jarvis-web` 默认只监听 `127.0.0.1`，首次启动必须通过环境变量创建唯一 Owner，并使用 Argon2id、可撤销会话、CSRF 和登录限流；仓库不再提供固定账号或开发口令。公网部署仍应使用 HTTPS 反向代理、限制网络入口、配置强随机 `JARVIS_SESSION_SECRET` 与 Owner 口令、定期备份 `JARVIS_DATA_DIR`，并按组织要求补充日志审计、依赖更新和边界防护。
