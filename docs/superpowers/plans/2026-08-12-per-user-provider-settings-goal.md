# 每用户 Provider / API Key 设置任务书（多用户验收后执行）

本书是唯一任务来源；疑点写 `BLOCKED.md` 后做别项，断线读 `PROGRESS.md` 续做。目标：每用户选择官方模型或兼容中转并填 Key，不影响他人/在途回答。冲突按“密钥/租户 > 回滚 > 兼容 > 体验”让步。

## 我替领导拍的板

- 用户继承系统或保存一份 LLM；Owner 管全局搜索（猜的）｜避免重复配置。
- 支持四个官方预设和自定义；不做 Anthropic、负载均衡、自定义 Header（猜的）。
- Key 用 `cryptography` 加密，只新增该依赖；不操作生产、不复用聊天中的 Key。

## 界限

前置：多用户任务已验收、工作树干净。只改 provider/runtime、四个入口、工具工厂、两端 UI、对应测试、依赖/lock、配置/文档/进度；其余只读。
`docs/superpowers/specs/2026-08-11-shared-api-provider-settings-design.md` 是判卷标准，禁止改；仅将全局 LLM 改为“系统+个人”。搜索顺序、fetcher、部署测试冻结。
禁止客户端存/回显 Key、相信请求 `user_id`、跨用户复用密文/runtime、真实外网、redirect、生产写入。

## 现状与任务 0

2026-08-12 原始 HEAD `fcfb22e` 的设置实现为 0。先核对前置：
`git status --short --branch && git log -1 --oneline`
`.venv/bin/python -m pytest tests/test_{accounts,auth,tenant_isolation,wechat,openai_api}.py -q`
`npm --prefix web-src test -- --run`
`node --test desktop/*.test.js`
缺文件、失败或 skip/todo 非 0 即停并写 `BLOCKED.md`；通过后写 ≤10 行测试数/目标/顺序/风险。

## 任务 1：密钥与 API

实现冻结规格的目录、SecretStore、TEST/PUT/DELETE、SecretStr、scope、generation CAS/回滚/审计。个人状态只能继承或保存 provider/base_url/model/密钥；AAD 绑定 user+provider+origin+generation，API 不读回。换 provider/origin 必须新 Key；Owner/Member 权限分开。有托管配置但缺主密钥则 fail closed。
新增 `tests/test_provider_settings_api.py`：两用户权限、409、坏密文、崩溃恢复、Key 不序列化；反向验证跨用户查询红→绿。

## 任务 2：安全传输与运行时

自定义仅公开 HTTPS，禁凭据/query/fragment/redirect；全部 DNS fail closed，固定批准 IP并保留 Host/SNI，禁环境代理。Probe 验证非流式、流式文本/工具。按 `{user,generation}` 缓存带 lease 的 bundle；二次 CAS 后切换，旧流结束再关；失败保留旧 runtime。搜索顺序不变。
新增 runtime/安全测试；全 stub，覆盖不同模型、失败不切换、SSRF/DNS rebinding/Key 跨 origin、断流、重启、脱敏。故意让 probe 失败，证明 generation 不变。

## 任务 3：UI 与交付

两端提供 Provider、URL、模型、Key、官方链接、测试/保存/恢复；Key 始终空，换 origin 禁保留。Owner 有系统/搜索页。桌面网络只走 main，renderer/IPC 不见凭据。补风险/回滚文档。
验收：
`.venv/bin/python -m pytest tests/test_{provider_settings_api,runtime_manager,auth,tenant_isolation,wechat,openai_api}.py -q`
`npm --prefix web-src test -- --run && npm --prefix web-src run build`
`node --test desktop/*.test.js`

## 规矩

TDD 先 RED 后 GREEN。禁止 skip/todo、删/松测试、mock 被测对象、改验收、`|| true`；只用假 Key，不打印环境/密文/头/原响应。测试只增不减；失败 3 次换项，变差回滚。每项独立提交，先 `git diff --check`。

## 完成条件

1. 两用户配置不同 Provider 后新请求各用自己的 generation，旧流不中断；互相读不到 Key/状态，泄漏 0，Owner 全局搜索可用。
2. 新旧后端、网页构建、桌面测试全绿；skip/todo=0、敏感扫描=0、冻结 diff=0、真实外网/生产写入=0。
每条在对话贴命令输出和红→绿；只说完成不算。提交 `BLOCKED.md`，空也写“无”。最多 4 轮，满轮即停并报剩余。
