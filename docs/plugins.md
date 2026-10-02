# 插件开发与导入指南

> 适用于第十四轮起的插件包格式（契约见 [`proposals/2026-10-round14-plugins.md`](proposals/2026-10-round14-plugins.md) 第 1、2 节）。
> 写给两类人：**想给贾维斯写插件的开发者**，和**想从 GitHub 导入插件的管理员（Owner）**。

## 1 插件是什么

贾维斯的每项本事都是一个插件：「日程提醒」「待办清单」「PDF 工具箱」……用户在「智能体市场」里挑插件，组成自己的智能体。一个插件就是**一个目录**，里面一份清单 `plugin.json`，加上代码或提示词。

| kind | 是什么 | 谁能写 | 例子 |
| --- | --- | --- | --- |
| `tool` | 对话技能：给模型几个可调用的工具函数 | 任何人 | 单位换算、抽签分组、PDF 工具箱 |
| `skill` | 纯提示词技能：一段 `SKILL.md`，改变贾维斯的做事方式，不新增工具 | 任何人 | 朋友圈文案教练 |
| `step` | 流程积木：流程工坊里的一块（输入 / 处理 / 输出） | 内置为主 | 文件拆分、发到飞书 |
| `channel` | 需要绑定的通道（微信、飞书） | 仅内置 | 飞书 |

插件分两种来源：

- **内置插件**：随代码发布，在 `jarvis/plugins/packs/<id>/`。
- **导入的插件**：Owner 从 GitHub（或上传 zip）导入，装在 `$JARVIS_DATA_DIR/plugins/<id>/`，**固定到某个 commit**，不会自己更新。

现成的例子都在仓库的 `examples/` 下：

| 目录 | 说明 |
| --- | --- |
| `examples/plugin-template/` | 插件模板（倒数日），复制去 GitHub 建仓库的起点，含工具、积木、测试 |
| `examples/plugins/unit_convert/` | 单位换算：斤两、亩、尺寸、英制、温度 |
| `examples/plugins/lottery/` | 抽签分组：随机分组、抽签、排值日表，附可复核的抽签码 |
| `examples/plugins/text_check/` | 文字体检：字数、阅读时长、重复词、广告极限词 |
| `examples/plugins/moments_coach/` | `kind: skill` 示例：朋友圈文案教练 |
| `examples/marketplace/` | 插件源示例（Codex 同款 `.agents/plugins/marketplace.json`），含一个 Agent Plugins 标准格式的技能插件 |
| `examples/check_plugin.py` | 契约自检脚本：检查插件目录或插件源 |

## 2 五分钟上手

```bash
cp -r examples/plugin-template ~/my-plugin && cd ~/my-plugin
# 1. 改 plugin.json 的 id / name / summary / examples / tools
# 2. 改 tools.py：工具名以 id 为前缀，docstring 写清什么时候用
python -m pytest -q                                          # 3. 跑插件自带测试
python /path/to/jarvis/examples/check_plugin.py ~/my-plugin   # 4. 契约自检
git init && git add . && git commit -m "first plugin"         # 5. 推到 GitHub
```

然后请 Owner 在「智能体市场 → 导入插件」里填你的仓库地址（第 11 节）。

## 3 目录结构

```
<插件目录>/
  plugin.json        # 清单（必需）
  tools.py           # 入口模块（kind=tool 必需）：导出 TOOLS，可选 STEPS
  SKILL.md           # kind=skill 的提示词正文
  README.md          # 给人看的说明（建议写；导入预览时展示）
  tests/             # 插件自带测试（建议写）
  LICENSE            # 许可证（发布到 GitHub 时必须有；本仓库的 examples/plugin-template 以 MIT-0 授权，可放心复制）
```

测试文件名建议带上插件 id（如 `tests/test_lottery.py`），几个插件放一起测试时不会撞名。

## 4 plugin.json 字段

以「抽签分组」为例：

```json
{
  "id": "lottery",
  "name": "抽签分组",
  "version": "1.0.0",
  "icon": "🎲",
  "category": "efficiency",
  "summary": "随机分组、抽签、排值日表，结果附抽签码，公平可复核",
  "kind": "tool",
  "tier": "free",
  "price": 0,
  "professions": ["teacher", "student", "shop_owner", "project_manager", "office"],
  "examples": ["把这 12 个同学随机分成 3 组", "从这几个人里抽 2 个中奖"],
  "entry": "tools.py",
  "tools": ["lottery_groups", "lottery_draw", "lottery_rota"],
  "steps": [],
  "requires": [],
  "python_packages": [],
  "author": "JWS-Agent",
  "homepage": "https://github.com/123akw/jarvis/tree/main/examples/plugins/lottery"
}
```

| 字段 | 必需 | 说明 |
| --- | --- | --- |
| `id` | 是 | 全局唯一，`^[a-z][a-z0-9_]{1,30}$`。导入时与已装插件重名会被拒绝。内置 id（schedule、todo、memo、memory、weather、search、recall、movies、esports、tickets、meeting、feishu、wechat 及九个积木、pdf、excel、word 等）不能用。 |
| `name` | 是 | 市场里显示的名字，2–10 个字，说用户听得懂的话。 |
| `version` | 是 | 三段式 `1.0.0`。改了行为就升版本号。 |
| `icon` | 是 | 一个 emoji。 |
| `category` | 是 | `efficiency` 效率 / `communication` 沟通 / `documents` 资料 / `info` 资讯 / `life` 生活 / `ai` AI 处理 / `output` 输出。 |
| `summary` | 是 | 一句话卖点，市场卡片只显示一行，建议 ≤ 30 字。 |
| `kind` | 是 | `tool` / `skill` / `step` / `channel`，见第 1 节。 |
| `tier` / `price` | 否 | `free` 或 `pro`；第三方插件写 `free`、`0`。 |
| `professions` | 否 | 推荐给哪些职业：`shop_owner` 店主、`freelancer` 自由职业、`project_manager` 项目经理、`sales` 销售、`teacher` 老师、`student` 学生、`creator` 创作者、`office` 办公室。 |
| `examples` | 建议 | 2–3 句用户会怎么说，**写中性通用的句子**（智能体主页的快捷问题可能取自这里）。 |
| `entry` | kind=tool 必需 | 入口文件，通常 `tools.py`；`kind=skill` 写 `null`。 |
| `tools` | 是 | 本插件提供的工具名，**全局唯一**，以插件 id 为前缀；必须与 `TOOLS` 导出的一致（顺序也一致）。 |
| `steps` | 是 | 本插件提供的积木 id，与 `STEPS` 的键一致；没有写 `[]`。 |
| `requires` | 是 | 运行条件：`feishu_bound` 已绑飞书 / `wechat_owner` 仅 Owner 微信 / `desktop` 需桌面端 / `files` 需要文件空间；没有写 `[]`。 |
| `python_packages` | 否 | 需要的第三方包（pip 名）。**导入时不会自动安装**：缺了插件就显示「暂不可用」并写明缺什么，由管理员决定装不装。 |
| `author` / `homepage` | 否 | 作者与主页，导入预览时展示。 |
| `source` | 否 | 来源，由贾维斯在安装时写入（`{"type":"github","repo":"owner/name","ref":"<commit>","path":"子目录"}`）；仓库里不用写，写了也会被覆盖。 |

## 5 tools.py 怎么写

### 5.1 最小例子

```python
from langchain_core.tools import tool
from pydantic import BaseModel, Field


class ConvertArgs(BaseModel):
    value: float = Field(description="要换算的数值，如 3.5")
    from_unit: str = Field(description="原单位，如「斤」「亩」「英尺」")
    to_unit: str = Field(description="目标单位，如「千克」「平方米」")


def convert(value: float, from_unit: str, to_unit: str) -> str:
    ...   # 纯函数：业务逻辑写这里，测试直接测它


@tool(args_schema=ConvertArgs)
def unit_convert(value: float, from_unit: str, to_unit: str) -> str:
    """单位换算：长度、重量、面积、体积、温度，含斤、两、亩等市制单位。
    用户问「3 斤是几公斤」「一亩地多少平方米」时使用，不要心算。"""
    return convert(value, from_unit, to_unit)


TOOLS = [unit_convert]
```

### 5.2 规矩

- **用 LangChain 的 `@tool`**，和贾维斯自带工具（`jarvis/tools/`）同一写法；`TOOLS` 是一个列表，顺序与 `plugin.json` 的 `tools` 一致。
- **命名**：`<插件id>_<动作>`，小写加下划线，如 `lottery_draw`。工具名全局唯一，撞名的插件会被拒绝加载。
- **docstring 就是给模型的说明书**：第一句说它做什么，第二句说「用户说什么时用」；有容易混淆的工具就写「……用 xxx，不要用这个」。两三行足够，别写成文档。
- **参数**用 pydantic `Field(description=...)` 写清格式和例子；只用 `str` / `int` / `float` / `bool` 和它们的列表。日期让模型先换算成 `YYYY-MM-DD` 再传。
- **返回值**：给用户看的中文文本（可以用简单 Markdown：列表、粗体），控制在 2000 字以内；有生成文件时返回下载链接（5.4）。
- **异常**：参数不对、找不到、超上限……这些可预见的情况**自己接住、说人话**（「名单只有 3 人，抽不出 5 个」），不要抛异常。漏掉的异常贾维斯会兜底转成「插件出错了」，不会中断对话，但用户体验差。
- **超时**：每次调用都有时限（由贾维斯设定），请让工具在几秒内返回；不要 `sleep`、不要死循环、大输入先截断（示例插件统一 2 万字上限）。
- **导入无副作用**：`import tools` 时不联网、不读写文件、不读环境变量、不起线程——加载器可能只是为了读工具清单而导入它。
- **依赖**：只用标准库与贾维斯已有的 `langchain_core`、`pydantic`；要用别的包写进 `python_packages`。
- **确定性**：涉及随机的功能允许传种子，结果可复现（见「抽签分组」的抽签码）。

### 5.3 当前账号与插件设置（内置插件）

- 当前账号：`jarvis.tenancy.current_owner_id()`（贾维斯在调用工具前已绑定租户上下文，和自带工具一样）。
- 插件自己的设置存在 tenant_prefs 的 `plugin:<id>:<key>` 命名空间下，由插件框架统一读写。
- 第三方插件 v1 在独立子进程里运行，**拿不到账号上下文和数据库**，只做文本进文本出。

### 5.4 文件空间 `jarvis.files`（内置插件）

处理 PDF / Excel / Word 需要真实文件。用户在网页 📎 上传附件后，消息里会带一行 `［附件：合同.pdf · file_id=XXXX］`，模型会把 `file_id` 传给你的工具。

```python
from jarvis import files
from jarvis.tenancy import current_owner_id

owner = current_owner_id()
data = files.read(owner, file_id)                       # bytes；不存在或不属于本人抛 KeyError
meta = files.save(owner, "合并后.pdf", out_bytes, source="tool")
return f"合并好了，共 12 页：[下载 {meta['name']}]({meta['url']})"
```

- 其他接口：`files.get(owner, id)` 取元数据、`files.path(owner, id)` 取只读路径、`files.list(owner)`、`files.delete(owner, id)`。
- 限制：单个文件 ≤ 20MB，每个账号 ≤ 200MB，保留 30 天。`KeyError` 要接住，回一句「没找到这个文件，请重新上传」。
- 声明 `"requires": ["files"]`。第三方插件 v1 不开放文件空间（子进程里没有账号上下文）。

## 6 流程积木 STEPS 怎么写

积木是流程工坊里的一块，签名沿用 `jarvis/flows/steps.py` 的 `StepSpec`：

```python
from jarvis.flows.steps import ROLE_PROCESS, Outcome, StepFailure, StepSpec, preview

def _run_stamp(job, ctx, options):
    text = (ctx.get("text") or "").strip()
    if not text:
        raise StepFailure("前面没有可以加落款的内容")      # 人话错误，流程会停在这一步
    ctx["text"] = text + "\n\n（整理于 2026年10月2日）"
    return Outcome("加好了落款日期", preview(ctx["text"]))  # 摘要 + 一行预览

STEPS = {"my_plugin_stamp": StepSpec("my_plugin_stamp", "加落款日期", ROLE_PROCESS,
                                     accepts=("text",), produces=("text",), run=_run_stamp)}
```

- `role`：`input` / `process` / `output`；`accepts` / `produces` 用上下文键：`text` 正文、`parts` 拆分段落、`items` 条目、`title` 标题、`links` 链接。
- `options`：给流程主人填的选项，`{"key","label","type":"select|text|number","default",...}`。
- `timeout`：默认 30 秒；要调模型的设 60 秒。模型、飞书、微信等外部能力从 `job.deps` 取，**只对内置插件开放**。
- 在独立仓库里没有贾维斯，`from jarvis...` 要用 `try/except ImportError` 包住（见模板 `tools.py`）。
- 第三方插件建议 v1 只提供工具；积木先在内置插件里做。

## 7 kind: skill 纯提示词技能

不写代码，只写一份 `SKILL.md`：

```markdown
# 朋友圈文案教练
当用户要发朋友圈、写上新 / 促销文案时，按下面的规矩做。
……
```

- 第一行 `# 名称`，后面是正文，用大白话写清「什么时候用、按什么规矩做、输出什么格式」；正文 ≤ 2000 字（超出截断）。
- `plugin.json` 里 `kind` 写 `skill`、`entry` 写 `null`、`tools` 写 `[]`。
- 技能只改变说话和做事方式，**不能新增工具**；需要真正计算或处理文件的，写 `kind: tool`。
- 已有 Agent Skills 格式（Anthropic / Codex 通用，YAML 头里有 `name`、`description`）的技能，可以直接按第 9 节的标准插件结构导入；正文要删到 2000 字以内。`scripts/`、`references/`、`assets/` 里的东西贾维斯不会执行或读取，要用就把要点写进正文。

## 8 隔离原则：为什么这样设计

「每个插件互不影响」靠下面几条保证：

1. **单独加载**：清单写错、导入报错、依赖缺失，都只让这一个插件不可用（市场里灰显并写原因），其他插件照常。
2. **调用包一层**：异常转成人话、单次调用有超时；一个插件出错不会中断对话。
3. **冲突拒绝**：工具名、积木 id 与已装插件冲突时，后来的插件被拒绝并说明。
4. **设置分区**：插件设置在 `plugin:<id>:<key>` 下，插件之间看不到彼此的设置。
5. **第三方插件跑在子进程**：导入的插件（`source.type=github`）每次调用在独立的 Python 子进程里执行——独立解释器、超时强制结束、最小环境变量、**不继承任何密钥**（模型 API Key、飞书 / 微信凭据、邮箱密码……）。插件崩溃、内存泄漏、死循环，只影响这一次调用。

所以第三方插件 v1 **只做文本进文本出**：参数是文字和数字，返回是文字；拿不到账号、数据库、文件空间、模型。需要这些能力的，先做成内置插件，或等后续版本开放受控接口。

> 子进程隔离防的是「互相影响」和「拿到密钥」，**不是沙箱**：子进程仍以服务账号身份运行，能联网、能读写该账号能访问的文件。所以导入前的人工审查（第 12 节）不能省。

## 9 兼容 Codex / ChatGPT 的插件格式与插件源

OpenAI 的 Codex 和 ChatGPT 用的是开放的 **Agent Plugins** 标准（[agent-plugins.org](https://agent-plugins.org/)）：插件根目录一份 `plugin.json`，技能放 `skills/<名>/SKILL.md`，MCP 服务器写在 `mcp.json`，OpenAI 专属的展示信息放在 `extensions.com.openai.interface` 里。贾维斯导入时**两种 plugin.json 都认**：有 `id` 的按贾维斯格式读；没有 `id`、有 `name` + `extensions` 或 `skills/` 目录的按标准格式读，再按下表转成贾维斯插件。

### 9.1 字段对照

| Agent Plugins 标准 | 贾维斯 | 说明 |
| --- | --- | --- |
| `name`（kebab-case） | `id` | 连字符换成下划线：`festival-greetings` → `festival_greetings` |
| `interface.displayName` | `name` | 没有就用 `name` |
| `interface.shortDescription` | `summary` | 没有就用顶层 `description` |
| `interface.defaultPrompt` | `examples` | 取前 3 句 |
| `interface.category` | `category` | Productivity→efficiency、Communication→communication、Lifestyle→life、Education→documents、Research→info，其余归 efficiency |
| `interface.capabilities` | 权限说明 | 导入预览时列给管理员确认 |
| `version`、`author.name`、`homepage` | 同名字段 | |
| `skills/<名>/SKILL.md` | `kind: skill` 技能插件 | YAML 头的 `description` 进技能说明，正文 ≤ 2000 字；正文没有 `# 标题` 时用 `displayName` 补上 |
| `mcp.json`、`hooks/`、`.app.json` | 暂不支持 | 导入时提示「这部分不加载」，只导入技能 |
| `interface.logo` 等图片 | `icon` | 贾维斯用 emoji，统一给默认图标 🧩 |

例子见 `examples/marketplace/plugins/festival-greetings/`：

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  "name": "festival-greetings",
  "version": "1.0.0",
  "description": "按对象和场合写节日祝福语，一次给三条不同风格的",
  "extensions": {
    "com.openai": {
      "interface": {
        "displayName": "节日祝福语",
        "shortDescription": "中秋国庆春节，给长辈、客户、同事的祝福一次写好三条",
        "category": "Lifestyle",
        "defaultPrompt": ["帮我写条中秋祝福发给客户"]
      }
    }
  }
}
```

技能文件 `skills/festival-greetings/SKILL.md` 用标准的 YAML 头（`name` 必须与目录同名，`description` 1–1024 字，写清「做什么、什么时候用」），YAML 头之后写 `# 名称` 和正文，这样同一份文件在 Codex 和贾维斯里都能用：

```markdown
---
name: festival-greetings
description: 写节日祝福语与群发问候。用户说「帮我写条中秋祝福」时使用……
---
# 节日祝福语
用户要写节日祝福、拜年话、群发问候时，按下面的规矩做。……
```

贾维斯原生的工具插件（`tools.py`）是贾维斯专有的，Codex 里用不了；要两边都能用，只能做成技能。

### 9.2 插件源（一个仓库挂一串插件）

**插件源**就是一份插件清单，格式与 Codex 的 `marketplace.json` 相同，放在仓库的 `.agents/plugins/marketplace.json`。管理员导入一次插件源，市场里就能看到清单上的全部插件，再逐个安装。示例见 `examples/marketplace/`：

```
marketplace/
  .agents/plugins/marketplace.json
  plugins/festival-greetings/        ← 插件源自带的插件
```

```json
{
  "name": "jarvis-examples",
  "interface": {"displayName": "贾维斯示例插件源"},
  "plugins": [
    {"name": "festival-greetings",
     "source": {"source": "local", "path": "./plugins/festival-greetings"},
     "policy": {"installation": "AVAILABLE", "authentication": "ON_INSTALL"},
     "category": "Lifestyle"},
    {"name": "unit_convert",
     "source": {"source": "git-subdir", "url": "https://github.com/123akw/jarvis.git",
                "path": "examples/plugins/unit_convert", "ref": "main"},
     "policy": {"installation": "AVAILABLE", "authentication": "ON_INSTALL"},
     "category": "Lifestyle"}
  ]
}
```

- `name`：插件源的名字，kebab-case；插件条目的 `name` 要与插件自己的 id / name 一致（`-` 与 `_` 视为相同）。
- `source.source`：`local`（本仓库内，`path` 以 `./` 开头）、`git-subdir`（别的 Git 仓库的子目录，写 `url` + `path`，可选 `ref` 分支 / tag 或 `sha` commit）、`url`（别的仓库根目录）。**`npm` 来源不支持**（服务器没有 node）。
- `policy.installation`：`AVAILABLE` 可安装 / `NOT_AVAILABLE` 不显示；`INSTALLED_BY_DEFAULT` 贾维斯不照做，仍由管理员逐个启用。`authentication` 目前没有用到（贾维斯插件 v1 不连外部账号）。
- 本地自检：`python examples/check_plugin.py <插件源目录>` 会检查清单并逐个检查本地插件。

## 10 发布到 GitHub

**一个仓库一个插件**（推荐）：

```
my-plugin/              ← 仓库根就是插件目录
  plugin.json
  tools.py
  README.md
  LICENSE
  tests/test_my_plugin.py
```

**一个仓库多个插件**：每个插件一个子目录，导入时指定子目录路径（如本仓库的 `examples/plugins/lottery`）。

发布清单：

- [ ] `python -m pytest -q` 全绿，`check_plugin.py` 没有错误；
- [ ] 有 `LICENSE`（MIT / Apache-2.0 等），有 `README.md`（能做什么、示例、限制）；
- [ ] 不提交 `__pycache__`、虚拟环境、测试数据、任何密钥；
- [ ] 改了功能就升 `version`，打一个 tag（如 `v1.0.0`），方便管理员按版本导入。

## 11 管理员：在市场里导入插件

**从 GitHub 导入**

1. 打开「智能体市场」→「导入插件」。
2. 填仓库地址：`https://github.com/<owner>/<repo>`；插件在子目录或要指定版本时，直接贴浏览器地址 `https://github.com/<owner>/<repo>/tree/<tag 或分支>/<子目录>`。
3. 看预览：名字、简介、作者、许可证、要注册的工具名、`requires`、`python_packages`、代码自检提醒（联网、读环境变量、启动外部程序等）。
4. 确认安装：贾维斯把当时的分支 / tag 解析成**具体 commit** 并固定下来，以后作者改仓库也不会影响你装的版本。
5. 安装后默认停用，到插件卡片上「启用」；之后可「停用」「卸载」。要升级就重新导入新版本。

**导入插件源**：仓库里有 `.agents/plugins/marketplace.json` 时（第 9.2 节），填仓库地址后贾维斯会列出清单上的全部插件，逐个预览、确认、安装，每个插件同样固定到 commit。插件源更新后，新插件和新版本不会自动装上，需要管理员再看一遍、确认。

**服务器访问不了 GitHub 时：下载 zip 上传**

国内服务器访问 GitHub 常常超时。退路：

1. 在自己能上 GitHub 的电脑上打开仓库页面 →「Code」→「Download ZIP」（或进 Releases 下载某个版本的源码 zip）。
2. 回到「导入插件」，选「上传 zip」，选中刚下载的文件。
3. 预览、确认、启用，同上。上传的 zip 里可以是插件目录本身，也可以是整个仓库（再填子目录路径）。

**依赖缺失时**：插件显示「暂不可用：缺少 xxx」。确认这个包可信后，在服务器上用贾维斯的虚拟环境 `pip install xxx`，重启服务即可；不确定就别装。

## 12 安全须知

给管理员：

- **只导入你信任的仓库**：看作者、看 star 和 issue、看最近提交；没有 `LICENSE` 的不导入。
- **导入前读一遍代码**，尤其是自检提醒里列出的联网、读环境变量、启动外部程序、删除文件、`eval` / `exec`、`pickle`。文本工具没有理由联网。
- **固定 commit，不自动更新**；升级前看一眼两个版本的差异。
- **`python_packages` 谨慎安装**：第三方包装进的是贾维斯自己的虚拟环境，它不在子进程隔离之内。优先选知名、维护活跃、许可证清楚的包。
- **工具返回的文字也是不可信输入**：插件可能在结果里夹带「忽略之前的指令」之类的话，贾维斯会把工具结果当数据而不是指令，但请别给来路不明的插件开放更多权限。
- 发现插件异常，先「停用」再排查；卸载会删除 `$JARVIS_DATA_DIR/plugins/<id>/`。

给开发者：

- 不要在代码、测试、README 里写任何密钥或个人信息。
- 不要在导入时做任何事；不要读环境变量、不要偷偷联网上报。
- 用户输入一律当数据处理：不 `eval`、不拼进命令行、不当文件路径用。
- 给所有输入设上限（长度、个数、数值范围），防止一次调用卡死。

## 13 常见问题

- **装上了但市场里灰显**：卡片上会写原因——清单不合法、导入报错、缺依赖、工具名冲突。先在本地跑 `check_plugin.py`。
- **模型不调用我的工具**：多半是 docstring 没写清「用户说什么时用」；把示例句写进 docstring，并检查有没有和自带工具抢活。
- **想让插件调模型**：v1 第三方插件不行；把需要模型的部分交给对话本身（工具返回素材，让贾维斯组织语言），或写成 `kind: skill`。
- **想读写用户的文件**：v1 只开放给内置插件（第 5.4 节）。
