# 本地 SearXNG 部署

这个 Compose 单元为 JWS-Agent 的免费优先搜索链提供可选的本地第一跳。镜像固定为
`ghcr.io/searxng/searxng:2026.7.28-c01178d03@sha256:5d6d903ab82afa56ee32792d477f36bc63d3e5ca04fcb6947e28a5cfd987fad3`，
宿主机只发布 `127.0.0.1:18888`，不会监听公网地址。生产部署审计发现 BT-Panel
已占用 `127.0.0.1:8888`；确认候选端口 18888 没有 IPv4、IPv6、防火墙或 Docker 引用后，
本部署迁移到 18888。

## 启动与检查

从仓库根目录执行：

```bash
docker compose -f deploy/searxng/compose.yaml config --quiet
docker compose -f deploy/searxng/compose.yaml up -d
docker compose -f deploy/searxng/compose.yaml ps
```

然后在 `.env` 中设置：

```dotenv
SEARXNG_BASE_URL=http://127.0.0.1:18888
```

未启动或未配置本地 SearXNG 时，JWS-Agent 会继续尝试 DDGS；只有显式配置
`TAVILY_API_KEY` 时才会把 Tavily 作为可选的后续搜索供应商。此部署不需要付费搜索 key，
也不会改变 JWS-Agent 的 `SafeFetcher` 对 loopback URL 的拒绝策略。

升级镜像时必须同时更新 tag 与 digest，并重新检查 Compose 配置、JSON 搜索、健康检查、
资源限制、上游许可证和对应源码链接。仅通过 `docker compose config` 是静态校验，不能证明
镜像可拉取、容器内健康检查命令可执行或运行时限制已经生效。

## SearXNG 的 AGPL-3.0 义务

[SearXNG](https://github.com/searxng/searxng) 是独立的第三方组件，采用
[GNU Affero General Public License v3.0](https://github.com/searxng/searxng/blob/master/LICENSE)。
本仓库没有修改 SearXNG 程序，只把上面的 `settings.yml` 作为运行时配置只读挂载。
固定镜像对应的上游提交是
[`c01178d03`](https://github.com/searxng/searxng/commit/c01178d03)，可从该提交取得所固定版本的源码。

如果修改 SearXNG 并让用户通过网络与修改版交互，AGPL-3.0 要求向这些用户提供该版本的
完整 Corresponding Source。分发镜像或修改版时，还需保留适用的许可证与版权声明，并履行
相应的源码提供义务。升级固定版本时应再次核对这些要求；具体部署若有法律疑问，请咨询
专业法律意见。

JWS-Agent README 中的“禁止商用”是本项目维护者对 JWS-Agent 自身使用范围的声明。它不能
替代、削弱或重新许可 SearXNG 用户依据 AGPL-3.0 享有的权利；两者不是同一许可证。
