# 第十七轮方案：智能体市场去冗余 + 拖拽加入

2026-10-02 · 用户原话：「插件市场太冗余了，界面布局都不行，参考苹果、华为、Anthropic 和 ChatGPT 的前端布局；插件要有拖动效果，可以拖动加入，参考好的用户体验。」

## 方向
- 首屏只留一个焦点：一句话主张 + 大搜索框（兼做「一句话帮我推荐」）+ 一排分类页签；光球插件环去掉或缩小。
- 帮我推荐改为按需展开；精选一行横滑；来源 / 类型筛选收进「筛选」弹层；卡片精简（图标、名称、一句话、最多一个关键徽标、轻量「+」）；管理员入口挪进头像菜单。
- 拖拽：卡片 / 套装拖进底部 Dock；手机长按拖动；点「+」同样飞入；Dock 内拖动排序、拖出移除；不可加入的拒绝并说明；键盘与读屏有替代；reduced-motion 降级。

## 拖拽接口（`web-src/src/market/dnd/index.jsx`）
| 导出 | 用法 |
| --- | --- |
| `DndRoot({ onAdd, canAdd, onReorder, onRemove, children })` | Market.jsx 包住整页 |
| `useDragSource({ id, ids, kind })` → `{ dragProps, isDragging }` | PluginCard / 套装卡根元素展开 `dragProps` |
| `flyToDock(fromEl, { icon })` | 点「+」加入时调用 |
| `useDockDrop()` → `{ dropProps, isOver, dragging, reason }` | Toolbox（Dock）放置区 |
| `DOCK_ID` | Dock 放置区元素 id |

## 分工
| 代理 | 文件 |
| --- | --- |
| 版面（去冗余） | `Market.jsx`、`Hero.jsx`、`Featured.jsx`、`Catalog.jsx`、`PluginCard.jsx`、`Recommend.jsx`、`TopBar.jsx`、`market.css`（按接口接线 `DndRoot` / `useDragSource` / `flyToDock`） |
| 拖拽 | `market/dnd/`（真实实现，样式放 `dnd/dnd.css`）、`Toolbox.jsx`（Dock 放置区、拖动排序、拖出移除、播报） |
| 详情与流程页 | `PluginDetail.jsx`、`Brand.jsx`、`Result.jsx`（新样式放各自的 css 文件，如 `detail.css`、`flow-pages.css`） |
| 调研 | `docs/design/2026-10-market-references.md` + 参考截图（不改代码） |
