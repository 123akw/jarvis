# 第十四轮调研：插件生态——开源工具、Agent Skills、Codex / ChatGPT 插件体系、MCP

2026-10-02 · 代理 D · 版本与许可证核实自 PyPI 元数据 / 仓库 README / 官方文档（出处见各节链接）。

## 0 结论

1. **能直接包装的开源库很多，且都不需要系统二进制**：pypdf、pdfplumber、markitdown、openpyxl、XlsxWriter、python-docx、docxtpl、mammoth、Pillow、RapidOCR、segno、zxing-cpp、pypinyin、cn2an、OpenCC、lunar_python、chinesecalendar。许可证都是 MIT / BSD / Apache，只有 docxtpl 是 LGPL（作为库 import 使用可以接受）。
2. **要避开的**：AGPL 链（PyMuPDF、pdf2docx、easyofd 依赖 PyMuPDF）、需要系统二进制（OCRmyPDF、tesseract、pyzbar）、依赖太重（PaddleOCR、argos-translate、rembg）、GPL 的 zhdate。
3. **Agent Skills（SKILL.md）可以直接导入**：Anthropic、Codex、Cursor 等用的是同一套开放标准，贾维斯只需把 YAML 头转成 `# 名称` 加正文，再截到 2000 字。Anthropic 官方仓库里 docx / pdf / pptx / xlsx 四个技能是专有许可，**不能搬**。
4. **Codex / ChatGPT 的插件 = 技能 + MCP + 应用 + 钩子，用插件源 `marketplace.json` 分发**。第一版跟进三样：标准 plugin.json、技能、插件源。MCP、应用（OAuth）、钩子先不跟。
5. **MCP 分两步接**：第一步只接远程 Streamable HTTP 服务器，比如高德、百度地图，服务器上不需要 node。第二步接 pip 安装的 Python stdio 服务器，放在子进程里跑。npx / uvx 一律不支持。

## 1 可包装成贾维斯插件的开源项目（偏下沉市场实用）

| 场景 | 项目 | 许可证 | 依赖 / 体积 | 包装建议 |
| --- | --- | --- | --- | --- |
| PDF 合并拆分 | [pypdf](https://github.com/py-pdf/pypdf) | BSD-3 | 纯 Python，**已是依赖** | C 的「PDF 工具箱」 |
| PDF 文字 / 表格 | [pdfplumber](https://github.com/jsvine/pdfplumber) | MIT | pdfminer.six + pypdfium2（wheel） | 「PDF 表格提取」、全电发票字段 |
| 万能转文字 | [markitdown](https://github.com/microsoft/markitdown) | MIT | 按格式装 extras，magika 会带上 onnxruntime；0.x 版本 | 「任意文件转 Markdown」，文本进、文本出 |
| Excel 读写 | [openpyxl](https://foss.heptapod.net/openpyxl/openpyxl) | MIT | 纯 Python，建议配 defusedxml | C 的「Excel 工具箱」 |
| 生成 Excel | [XlsxWriter](https://github.com/jmcnamara/XlsxWriter) | BSD-2 | 零依赖，只写不读 | 带图表的报表 |
| Word 读写 | [python-docx](https://github.com/python-openxml/python-docx) | MIT | lxml | C 的「Word 文档」 |
| Word 模板 | [docxtpl](https://github.com/elapouya/python-docx-template) | **LGPL-2.1** | python-docx + jinja2 | 「合同 / 通知 / 成绩单模板批量生成」 |
| Word 转 HTML | [mammoth](https://github.com/mwilliamson/python-mammoth) | BSD-2 | 纯 Python（不清洗不可信文档） | 预览 Word |
| 图片处理 | [Pillow](https://github.com/python-pillow/Pillow) | MIT-CMU | wheel | 压缩、改尺寸、证件照底色、加水印 |
| 中文 OCR | [RapidOCR](https://github.com/RapidAI/RapidOCR) | Apache-2.0 | onnxruntime，wheel 约 26MB 含中英模型，纯 CPU | 「拍照识字」、名片 / 小票识别（**首选**） |
| 二维码生成 | [segno](https://github.com/heuer/segno) | BSD | 零依赖，**已是依赖** | 「生成收款 / Wi-Fi / 名片二维码」 |
| 二维码识别 | [zxing-cpp](https://github.com/zxing-cpp/zxing-cpp) | Apache-2.0 | manylinux wheel，不需要系统库 | 「识别图里的二维码 / 条码」 |
| 拼音 | [pypinyin](https://github.com/mozillazg/python-pinyin) | MIT | 纯 Python | 生字注音、姓名拼音 |
| 大写金额 | [cn2an](https://github.com/Ailln/cn2an) | MIT | 纯 Python | 「123 → 壹佰贰拾叁元整」，开票、收据 |
| 简繁转换 | [OpenCC](https://github.com/BYVoid/OpenCC) | Apache-2.0 | wheel | 简繁互转，含港台用词 |
| 农历 / 节气 | [lunar_python](https://github.com/6tail/lunar-python) | MIT | 纯 Python | 农历生日、节气、黄历（宜忌只作民俗参考） |
| 节假日调休 | [chinesecalendar](https://github.com/LKI/chinese-calendar) | MIT | 纯 Python，**目前只覆盖到 2026 年，每年要升级** | 「这天上不上班」 |
| 发票字段 | [invoice2data](https://github.com/invoice-x/invoice2data) | MIT | 核心纯 Python，后端可以选 pdfplumber | 中国发票要自己写 YAML 模板 |

发票补充：OFD 格式没有成熟的宽松许可 Python 库（[easyofd](https://github.com/renoyuan/easyofd) 依赖 PyMuPDF，有 AGPL 风险；汇总见 [awesome-ofd](https://github.com/wukonggo/awesome-ofd)）。OFD 本质是 ZIP 包加 XML，可以只用标准库 `zipfile` 和 `xml.etree` 自己解析。开源的 pdfplumber 发票解析项目大多没有许可证（如 [InvoiceRecognition](https://github.com/f-super/InvoiceRecognition)），只能参考思路。

**慎用**：[PyMuPDF](https://github.com/pymupdf/PyMuPDF) 是 AGPL-3.0（线上服务有公开源码的义务），[pdf2docx](https://github.com/ArtifexSoftware/pdf2docx) 依赖它且官方说不再积极维护。[OCRmyPDF](https://github.com/ocrmypdf/OCRmyPDF) 和 [pytesseract](https://github.com/madmaze/pytesseract) 需要系统装 tesseract，[pyzbar](https://github.com/NaturalHistoryMuseum/pyzbar) 需要 libzbar。[PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR)、[argos-translate](https://github.com/argosopentech/argos-translate)、[rembg](https://github.com/danielgatis/rembg) 太重，rembg 还要求 Python ≥ 3.11。[deep-translator](https://github.com/nidhaloff/deep-translator) 基本停更，而且要联网调用第三方翻译接口，翻译直接交给模型更好。[jieba](https://github.com/fxsjy/jieba) 自 2020 年起没有发过新版。

**落地方式**：这些包大多带 C 扩展或模型文件，不适合让第三方插件在 `python_packages` 里随便声明、再由管理员 pip 安装。建议**挑 5–6 个做成内置插件**（随依赖锁文件发布）。优先做 RapidOCR 拍照识字、segno + zxing-cpp 二维码、cn2an 大写金额、lunar_python + chinesecalendar 日历、markitdown 文件转文字。

## 2 Agent Skills（SKILL.md）能否直接导入

- 格式（[规范](https://agentskills.io/specification)）：YAML 头 `name` 必填，1–64 字符，小写字母、数字、连字符，须与目录同名。`description` 必填，1–1024 字符，写清「做什么、何时用」。可选字段有 `license`、`compatibility`、`metadata`、`allowed-tools`。正文建议少于 5000 token。可选目录 `scripts/`、`references/`、`assets/` 按需加载（渐进加载）。
- 采用方：这是 Anthropic 发起的开放标准，Codex、Cursor、Gemini CLI、GitHub Copilot 等都已采用（[agentskills.io](https://agentskills.io)，规范仓库 Apache-2.0）。
- 许可：[anthropics/skills](https://github.com/anthropics/skills) 大部分是 Apache-2.0。**`docx`、`pdf`、`pptx`、`xlsx` 四个是 source-available 专有许可**：禁止再分发、禁止做衍生作品，不能导入或改写。
- 适配工作（B 的导入器）：
  1. 拆掉 YAML 头，用 `description` 做市场简介；
  2. 正文前补 `# 名称`；
  3. 正文超过 2000 字时截断，并在预览里提示；
  4. `scripts/` 不执行，`references/` 不读取，在预览里列出「这些文件不会被使用」；
  5. 依赖脚本才能工作的技能（如表格计算、文件转换）应标成「不适合导入」。
- 结论：**纯指令型技能**可以直接导入，比如写作风格、流程规范、话术模板、审稿清单。**依赖脚本的技能**只能借鉴思路，改写成 `tools.py`。

## 3 Codex / ChatGPT 插件体系对照

出处：[Build plugins](https://developers.openai.com/plugins/build/plugins)、[Skills](https://developers.openai.com/plugins/build/skills)、[Plugin guidelines](https://developers.openai.com/plugins/plugin-guidelines)、[ChatGPT Plugins](https://learn.chatgpt.com/docs/plugins)、[Plugin management](https://learn.chatgpt.com/docs/enterprise/plugin-management)、[Agent Plugins 规范](https://github.com/agentplugins/agent-plugins-spec)。

| 方面 | Codex / ChatGPT 的做法 | 贾维斯第一版 |
| --- | --- | --- |
| 封装 | 插件根目录 `plugin.json`（可移植核心：name 用 kebab-case、version、description、author、license 等）。OpenAI 专属展示信息放在 `extensions.com.openai.interface`：displayName、shortDescription、longDescription、category、capabilities、defaultPrompt、brandColor、logo、screenshots、隐私和条款链接。内容由四部分组成：`skills/`、`mcp.json`、`.app.json`（应用 / 连接器）、`hooks/hooks.json` | **跟进**：读标准 plugin.json 并映射成贾维斯清单，`skills/` 转成技能插件（B 做映射，D 写了对照表和示例）。**暂不跟进**：`mcp.json`、应用、钩子 |
| 分发 | 插件源 `.agents/plugins/marketplace.json`：`plugins[]` 每条有 `name`、`source`、`policy`、`category`。`source` 可以是 local、git-subdir、url、npm。`policy` 里 `installation` 取 AVAILABLE / INSTALLED_BY_DEFAULT / NOT_AVAILABLE，`authentication` 取 ON_INSTALL 或首次使用时 | **跟进**：local、git-subdir、url 三种来源，示例见 `examples/marketplace/`。**不跟进**：npm（服务器没有 node）。INSTALLED_BY_DEFAULT 不照做，一律由管理员启用 |
| 同步 | 管理员填仓库 URL，可选子目录和 branch / tag / commit。默认每天自动同步，也有「Sync now」。更新失败时保留上一个可用版本，源里删掉的条目标「No longer in source」 | **跟进**：固定 commit、更新失败保留旧版、标「源里已没有」。**不跟进**：自动同步。第三方代码不自动换版本，由管理员手动「检查更新」后逐个确认 |
| 安装与授权 | 装到缓存 `~/.codex/plugins/cache/<源>/<插件>/<版本>/`。启停写在 `config.toml` 的 `plugins."name@源".enabled`。MCP 可以按插件设置 `enabled_tools` 和 `default_tools_approval_mode`。连外部账号时分个人连接和共享连接 | **跟进**：装到 `$JARVIS_DATA_DIR/plugins/<id>/`，在市场里启用、停用、卸载。**暂不跟进**：OAuth 连接，v1 插件不连外部账号 |
| 目录 UI | 分 OpenAI 官方、工作区、个人（我创建的 / 共享给我的）、已安装四个区，可以搜索，有详情页和「+」安装按钮。工作区强制安装的插件，成员不能卸载 | **跟进**：分内置、已导入、已安装三个区，详情页展示 displayName、简介、示例、权限、作者、许可证、来源 commit。**暂不跟进**：按角色设置安装策略、个人之间共享插件 |
| 质量规范 | 工具名用动词短语。描述写清用途、何时用、限制。标注 readOnlyHint、destructiveHint、openWorldHint。只要最少的输入，不要对话历史 | **跟进**：写进 `docs/plugins.md` 第 5 节。建议下一轮给工具加只读 / 有破坏性的标注，供确认弹窗使用 |

## 4 MCP（Model Context Protocol）的可行性与限制

- **SDK 现状**：官方 [python-sdk](https://github.com/modelcontextprotocol/python-sdk)（包名 `mcp`，MIT）。v2 于 2026-07 发布，FastMCP 改名 MCPServer，有破坏性改动。v1.x 进入维护期，最新 1.30。[langchain-mcp-adapters](https://github.com/langchain-ai/langchain-mcp-adapters)（MIT）能把 MCP 工具直接转成 LangChain 工具，支持 stdio、sse、streamable http，但**只有异步接口**，而且依赖 `mcp>=1.24,<2`。接入时要把 `mcp` 固定在 1.x。
- **线上限制**：服务器只有 Python，没有 node / npx / uvx。多数社区 MCP 服务器是 TypeScript 写的，用不了。[官方参考服务器](https://github.com/modelcontextprotocol/servers)里 fetch、git、time 是 Python 写的，`pip install mcp-server-xxx` 后可以用 `python -m` 启动。其中 fetch 能访问内网 IP，有 SSRF 风险，不要接。
- **远程服务器不需要本地运行环境**：[高德](https://lbs.amap.com/api/mcp-server/gettingstarted) `https://mcp.amap.com/mcp?key=…`，[百度地图](https://lbsyun.baidu.com/faq/api?title=mcpserver/quickstart) `https://mcp.map.baidu.com/mcp?ak=…`，[魔搭 MCP 广场](https://modelscope.cn/mcp)的托管服务（请求头带 token，未完全核实）。这些都走 Streamable HTTP，贾维斯这边只是一个 HTTP 客户端。
- **安全**：
  - 工具描述本身就能藏指令（[Tool Poisoning](https://invariantlabs.ai/blog/mcp-security-notification)），上线后还可能悄悄改描述（rug pull）。
  - 本地 stdio 服务器以服务账号身份运行，能读 `.env` 和数据库。
  - 远程服务器会看到用户发过去的内容，涉及隐私。
  - 官方的 [安全最佳实践](https://modelcontextprotocol.io/specification/draft/basic/security_best_practices) 覆盖 token 透传、SSRF、confused deputy、scope 最小化。
- **资源**：stdio 服务器一般是常驻进程，每个占几十 MB 内存。小服务器上要设并发上限和空闲回收。

**建议方案（下一轮）**

1. **MCP 也作为插件**：plugin.json 增加 `"kind": "tool"` 加 `"mcp": {"type": "streamable-http", "url": "https://…", "auth": "header|query"}`，兼容 Agent Plugins 的 `mcp.json`（只认 `streamable-http` 类型）。工具名统一加 `<插件id>_` 前缀。密钥由 Owner 在插件设置里填，加密后存到 `plugin:<id>:key`（已有 cryptography 依赖），不写进仓库。
2. **只接白名单远程服务器**：第一批接高德、百度地图（查路线、周边、天气）。
   - 安装时把工具清单和描述拍成快照；
   - 每次连接对比快照，描述变了就停用，等管理员重新确认；
   - 仿 Codex 的 `enabled_tools`，按工具勾选启用；
   - 工具结果一律当不可信数据，截断到 4000 字；
   - 单次调用设超时；
   - 写操作类工具默认关闭。
3. **第二步接 Python stdio 服务器**：只允许 pip 安装、已固定版本的包，复用第三方插件的子进程隔离。具体做法：
   - 最小环境变量，工作目录放在临时目录；
   - 用 `resource.setrlimit` 限制 CPU、内存、文件大小；
   - 空闲 5 分钟回收，全局最多 3 个常驻；
   - 条件允许时用单独的低权限系统用户运行。
4. **不做**：npx / uvx / docker 启动的服务器、对外提供 MCP 服务、OAuth 动态注册。
