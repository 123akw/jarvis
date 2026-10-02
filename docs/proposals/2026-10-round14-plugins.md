# 第十四轮方案：插件独立封装 · 开源导入 · 办公插件 · 体验修复

2026-10-02 · 依据用户在第十三轮上线后的反馈。

## 0 用户反馈

1. 智能体主页的快捷问题要**按这个智能体推荐**（「学习助手」不该出现「那家火锅叫啥」「奶茶店在搞什么活动」）。
2. 手机扫码进入新账号时看到了 admin 的历史对话。线上库核对：新账号名下 0 个会话、0 条索引，服务端没有串数据；原因是手机浏览器里还留着 admin 的登录，扫码带来的 `?u=新账号` 被忽略，直接进了 admin 的界面。另外「上次打开的会话」存在浏览器本地且不分账号。
3. 插件市场：**每个插件独立封装、互不影响**；可以**从 GitHub 和开源社区导入更多插件**；现在就加入 **PDF 处理、Excel 处理**等插件。

## 1 插件包格式（契约，B / C / D 共同遵守）

一个插件就是一个目录：

```
<插件目录>/
  plugin.json        # 清单（必需）
  tools.py           # 入口模块（可选）：导出 TOOLS: list[BaseTool]，可选 STEPS: dict[str, StepSpec]
  SKILL.md           # kind=skill 时的提示词技能正文（可选）
  README.md          # 给人看的说明（可选）
  tests/             # 插件自带测试（可选）
```

- **内置插件**：`jarvis/plugins/packs/<id>/`（随代码发布）。
- **导入的插件**：`$JARVIS_DATA_DIR/plugins/<id>/`（Owner 从 GitHub 导入，固定到某个 commit）。

`plugin.json`：

```json
{
  "id": "pdf",
  "name": "PDF 工具箱",
  "version": "1.0.0",
  "icon": "📄",
  "category": "documents",
  "summary": "合并、拆分、提取文字，PDF 的常用活一句话搞定",
  "kind": "tool",
  "tier": "free",
  "price": 0,
  "professions": ["office", "student", "teacher"],
  "examples": ["把这两个 PDF 合成一个", "把第 3 到 5 页单独拆出来"],
  "entry": "tools.py",
  "tools": ["pdf_info", "pdf_merge", "pdf_split", "pdf_extract_text"],
  "steps": [],
  "requires": ["files"],
  "python_packages": ["pypdf"],
  "author": "JWS-Agent",
  "homepage": "",
  "source": {"type": "builtin"}
}
```

- `id`：`^[a-z][a-z0-9_]{1,30}$`，全局唯一；与现有市场插件 id（schedule、todo、memo、memory、weather、search、recall、movies、esports、tickets、meeting、feishu、wechat 及九个积木）保持不变。
- `kind`：`tool`（对话技能）/ `channel`（需绑定的通道）/ `step`（流程积木）/ `skill`（纯提示词技能，正文在 SKILL.md，最多 2000 字）。
- `category`：沿用 `efficiency / communication / documents / info / life / ai / output`。
- `tools`：本插件提供的 Agent 工具名，**全局唯一**（建议以插件 id 为前缀）。内置的「已有能力」插件（日程、待办……）`entry` 为 `null`，`tools` 直接列核心工具名（schedule_add 等），表示把现有工具打包成插件。
- `steps`：本插件提供的流程积木 id（实现见 `STEPS`，签名沿用 `jarvis/flows/steps.py` 的 `StepSpec`）。
- `requires`：在原有 `feishu_bound / wechat_owner / desktop` 之外新增 `files`（需要文件空间）。
- `python_packages`：运行所需第三方包；加载时检查是否已安装，缺了就把插件标成「暂不可用」并写明原因，**不影响其他插件**。
- `source`：`{"type":"builtin"}` 或 `{"type":"github","repo":"owner/name","ref":"<commit sha>","path":"子目录"}`。

**隔离原则**（「每个插件互不影响」）：
1. 每个插件单独加载；清单不合法、导入报错、依赖缺失都只让这一个插件不可用（市场里灰显并写原因）。
2. 工具调用一律包一层：异常转成人话、单次调用有超时；一个插件的工具出错不会中断对话或影响别的插件。
3. 工具名、积木 id 冲突时，后加载的插件被拒绝并说明。
4. 插件自己的设置存在 tenant_prefs 的 `plugin:<id>:<key>` 命名空间下。
5. 导入的第三方插件（`source.type=github`）在**子进程**里执行工具（独立解释器、超时、最小环境变量，不继承密钥），崩溃只影响这次调用。

## 2 文件空间（契约，C 实现，B / D 可调用）

插件处理 PDF / Excel / Word 需要真正的文件，而不是解析后的文字。

```python
from jarvis import files
meta = files.save(owner_id, "合并后.pdf", data, mime=None, source="tool")   # -> {"id","name","size","mime","created_at","url"}
files.get(owner_id, file_id)    # -> meta；不存在或不属于该账号抛 KeyError
files.read(owner_id, file_id)   # -> bytes
files.path(owner_id, file_id)   # -> pathlib.Path（只读用）
files.list(owner_id, limit=50)  # -> [meta]，新的在前
files.delete(owner_id, file_id)
```

- 存放在 `data_dir()/files/<owner_id>/`，元数据 JSON 同目录；`id` 用 `secrets.token_urlsafe`；单个文件 ≤20MB，每个账号总量 ≤200MB，保留 30 天（惰性清理）。**不新增数据库表**。
- 接口：`POST /api/files`（JSON `{name, data_base64}`，CSRF）、`GET /api/files`、`GET /api/files/{id}`（下载，仅本人，`Content-Disposition` 带中文文件名）、`DELETE /api/files/{id}`。`url` 即 `/api/files/<id>`。
- 工具里取当前账号：`jarvis.tenancy` 的当前租户上下文（与现有工具一致）。
- **对话附件**：网页 📎 上传 PDF / Excel / CSV / Word 时，除了现有的「解析成文字注入对话」，还要存进文件空间，并在用户消息里带一行附件标记 `［附件：合同.pdf · file_id=XXXX］`；提示词里说明：用户提到附件时把 file_id 传给工具。工具生成的文件以 Markdown 链接返回：`[下载 合并后.pdf](/api/files/XXXX)`，对话里点开即下载。

## 3 分工（第十四轮）

| 代理 | 范围 |
| --- | --- |
| A 体验修复 | ① 扫码 `?u=` 与当前登录账号不一致时进入「切换账号」登录页（说明当前登录的是谁，可选择继续使用当前账号），新账号登录成功即替换会话；② 本地记住的「上次会话」等按账号区分；③ 智能体主页的问候与快捷问题按智能体生成（名称、介绍、职业、已装插件 → 模型生成 4 个、规则兜底），插件示例句改成中性通用的；已存在的智能体首次读取时补生成；前端优先用平台的 `home.chips` |
| B 插件框架与开源导入 | 第 1 节全部：插件包加载器 / 注册表、把现有 22 个插件迁成插件包（id 与 API 不变）、隔离原则、Owner 在市场里「从 GitHub 导入」（预览清单与权限 → 确认 → 固定 commit 安装）、启用 / 停用 / 卸载、`kind=skill` 的 SKILL.md 技能导入、第三方插件子进程执行 |
| C 文件空间与办公插件 | 第 2 节全部 + 内置插件包：PDF 工具箱（pypdf）、Excel 工具箱（openpyxl：读表、统计汇总、筛选、生成 Excel、CSV 互转）、Word 文档（python-docx：读取、按 Markdown 生成文档），以及对应的流程积木（生成 Excel 表格、生成 Word 文档）；新增依赖写进 pyproject 与 requirements.lock |
| D 生态与文档 | 插件开发指南 `docs/plugins.md`、可直接导入的示例插件仓库模板 `examples/plugin-template/` 与 2–3 个示例插件、调研可接入的开源插件 / 技能（GitHub 上的 Python 工具、Anthropic Skills 格式、MCP 生态的可行性与限制） |
