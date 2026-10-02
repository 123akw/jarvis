# DeepWiki 问仓库 📖

把 [DeepWiki](https://deepwiki.com) 的远程 MCP 服务接进贾维斯：问一个 GitHub 公开仓库「是干嘛的、怎么上手、代码怎么分的」，贾维斯去 DeepWiki 查它整理好的项目文档再回答。

## 它是谁家的服务

- 服务方：Cognition（AI 编程助手 Devin 的开发公司）运营的 DeepWiki，官方说明见 <https://docs.devin.ai/work-with-devin/deepwiki-mcp>。
- 地址：`https://mcp.deepwiki.com/mcp`（Streamable HTTP）。官方文档写明：免费、不用登录、只能查**公开**仓库。文档没写调用频率上限和收费，以服务方为准。
- **不需要 Key**，装上就能用。

## 能做什么（2026-10-02 本机实测 `initialize` + `tools/list`，服务端版本 DeepWiki 2.14.3）

| MCP 工具名 | 在贾维斯里叫 | 做什么 |
| --- | --- | --- |
| `read_wiki_structure` | `deepwiki__read_wiki_structure` | 列出某个仓库的文档目录 |
| `read_wiki_contents` | `deepwiki__read_wiki_contents` | 读某个仓库的完整文档 |
| `ask_wiki_question` | `deepwiki__ask_wiki_question` | 就某个仓库提问，拿到基于文档的回答 |

参数都是 `repoName`（`owner/repo` 形式）加上问题。服务端的说明里还列了几个「仅私有模式」的工具，公开模式的 `tools/list` 不返回，贾维斯也不会用到。

试试这样说：「这个 GitHub 仓库是做什么的，怎么上手」「这个开源项目的代码目录是怎么分的」。

## 数据会发给谁

你问的问题和仓库名会发到 DeepWiki 的服务器（境外）。别在问题里贴密码、密钥、公司内部代码或个人信息。DeepWiki 返回的内容贾维斯只当「外部资料」参考，不当指令执行。

## 许可证

本插件包（plugin.json、mcp.json、本说明）以 MIT-0 授权，见 [../LICENSE](../LICENSE)。DeepWiki 服务本身归服务方所有，使用时遵守其服务条款。
