# README 线上截图更新设计

日期：2026-08-13

## 目标

用当前生产版本的真实页面更新项目 README，清楚展示已上线的多用户账户、每用户 Provider/API 设置和 Owner 管理能力，同时保留现有桌面悬浮球、聊天窗与设置页素材。

## 图片范围

1. 更新 `docs/assets/readme/web-dashboard.png`：1600×1000，展示登录后的主界面、Owner 身份和顶部 API 设置入口。
2. 新增 `docs/assets/readme/web-provider-settings.png`：1600×1000，展示模型 Provider、Base URL、模型名、空白 API Key、当前口令与测试/保存/恢复入口。
3. 新增 `docs/assets/readme/web-account-settings.png`：1600×1000，展示当前 Owner 和用户管理入口；不创建宣传用虚构账号，不显示任何口令。
4. 保留 `desktop-orb.png`、`desktop-chat.png`、`desktop-settings.png`，本轮不重拍桌面端。

## README 更新

- 顶部部署状态日期更新为 2026-08-13，并说明多用户与 Provider 设置已上线。
- 主图后增加“多用户与 API 设置”双图表格。
- 补充首次登录、立即修改默认迁移口令、创建 Member/Owner、每用户模型隔离、Owner 全局联网源和密钥不回显说明。
- 保留非商用声明、两位共同开发者署名、免费搜索边界与第三方 Provider 费用/隐私提示。

## 隐私与真实性

- 只截取 `https://jws.gkgeek-set.cn` 当前生产页面。
- API Key、账号口令、Cookie、CSRF、二维码、微信联系人、真实对话和其他用户数据不得出现在图片或提交中。
- Provider 表单中的 API Key 与口令必须为空；不执行真实模型测试、不保存配置、不调用付费 API。
- 截图前后不创建、停用或修改用户，不改变服务器配置。

## 验收

- 三张网页图片均为可读 PNG，尺寸 1600×1000。
- README 中所有本地图片链接存在，GitHub 可直接渲染。
- README 描述与生产能力一致，不宣称未执行的实时模型/娱乐搜索验证。
- `git diff --check`、敏感信息扫描和最小 Markdown 图片链接检查通过。
