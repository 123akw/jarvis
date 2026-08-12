# 多用户账号与数据隔离任务书（先执行）

本书是唯一任务来源；疑点写 `BLOCKED.md` 后做别项，断线读 `PROGRESS.md` 续做。目标：多人可用且账号间不能读写数据。冲突按“隔离 > 不丢 Owner 数据/微信 > 功能 > 速度”让步。

## 我替领导拍的板

- Owner 管理 Member，不开放注册（猜的）｜减少公网入口。
- 旧数据、微信/CLI 归 Owner，不做多微信 Token（猜的）｜避免 iLink 冲突。
- 密码用 `pwdlib[argon2]`，只新增该依赖；不部署生产（猜的）｜上线另行验收。

## 界限

只改/建：`jarvis/{accounts,auth,tenancy,config,graph,server,wechat}.py`、四个个人工具、`web-src/**`、`desktop/**`、对应测试、依赖/lock、`.env.example`、README/deploy、进度文件；其余只读。搜索实现/测试、已确认规格冻结。
禁止明文/可逆密码、客户端持久化 Token、相信请求的 `user_id`、跨用户 fallback、删旧数据/微信凭据、真模型/搜索请求、生产写入。

## 现状与任务 0

2026-08-12 HEAD `fcfb22e` 实测：硬编码账号、共享 Token、client 自报 thread、个人数据/微信全局。基线：后端 36 passed/2 warnings、网页 5、桌面 5。
先跑：
`git status --short --branch && git rev-parse HEAD`
`.venv/bin/python -m pytest tests/test_{auth,threads,wechat,wechat_api,openai_api}.py -q`
`npm --prefix web-src test -- --run`
`node --test desktop/*.test.js`
数字不符则证据置顶写 `BLOCKED.md`，只做无关项；相符后写 ≤10 行开工回执：目标/顺序/最大风险。

## Task 1：账号与会话

建版本化 SQLite `users/sessions/audit`：UUID、唯一用户名、角色、Argon2id、随机 Token 只存摘要、吊销/过期/节流、安全 Cookie、CSRF。首次只从 `JARVIS_ADMIN_*` 建 Owner，缺值 fail closed。提供用户管理/改密并吊销会话。Web/Desktop/OpenAI 都映射服务端 `Principal`；错误登录响应等价，日志无凭据。
新增 `tests/test_accounts.py`；先贴预期 RED，再最小 GREEN。

## Task 2：迁移与隔离

建带 owner 约束的 thread/memo/todo/schedule/location 表。旧文件备份后幂等迁给 Owner；失败回滚，微信文件不动。所有入口从 Principal 得 owner；client thread 仅别名，checkpoint 加 owner 命名空间；越权 404。微信固定 Owner。
新增 `tests/test_tenant_isolation.py`：两用户同名 thread、历史/删除、四工具、bearer、并发、迁移中断/重跑。反向验证：临时去掉一处 owner 条件，测试红；恢复绿，贴红→绿输出。

## Task 3：UI 与交付

网页显示账号、本人改密；Owner 有用户管理页。桌面 Token 只在 Electron main+safeStorage，renderer/localStorage/DOM/IPC 不可见；重登后与网页同租户。补迁移、备份、回滚、角色文档。
验收：
`.venv/bin/python -m pytest tests/test_{accounts,auth,threads,tenant_isolation,wechat,wechat_api,openai_api}.py -q`
`npm --prefix web-src test -- --run && npm --prefix web-src run build`
`node --test desktop/*.test.js`

## 规矩

TDD 先 RED 后 GREEN。禁止 skip/todo、删/松测试、mock 被测对象、改验收、`|| true`；测试只增不减。不打印环境/数据库/凭据，只用假值。验收失败 3 次换项；变差回滚。每项独立提交，先 `git diff --check`。

## 完成条件

1. 两账号使用同名 thread/待办后，历史、工具、会话、checkpoint 全隔离；越权全 404、泄漏 0，旧 Owner 数据/微信凭据不丢。
2. 基线、新后端、网页构建、桌面测试全绿；skip/todo=0、敏感扫描=0、冻结 diff=0、生产写入=0。
每条在对话贴命令输出和红→绿；只说完成不算。提交 `BLOCKED.md`，空也写“无”。最多 4 轮，满轮即停并报剩余。
