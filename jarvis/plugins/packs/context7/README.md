# Context7 编程文档 🧑‍💻

把 [Context7](https://context7.com) 的远程 MCP 服务接进贾维斯：写代码时问「这个库新版本怎么用」，贾维斯先查这个库**最新**的官方文档和示例代码再回答，少用过时的写法。

## 它是谁家的服务

- 服务方：Upstash 公司，开源仓库 <https://github.com/upstash/context7>（MIT 许可；文档抓取和解析的后端不开源）。
- 地址：`https://mcp.context7.com/mcp`（Streamable HTTP）。
- **不需要 Key**：官方说明不填 Key 也能用，只是调用频率有限制；用得多可以去 context7.com/dashboard 申请免费 Key 提高额度（请求头 `Authorization: Bearer <Key>`）。本插件第一版不带 Key。

## 能做什么（2026-10-02 本机实测 `initialize` + `tools/list`，服务端版本 Context7 4.1.1）

| MCP 工具名 | 在贾维斯里叫 | 做什么 |
| --- | --- | --- |
| `resolve-library-id` | `context7__resolve_library_id` | 把库名（如「某个前端框架」）解析成 Context7 的库 ID |
| `query-docs` | `context7__query_docs` | 按库 ID 和问题查最新文档与代码示例 |

一般先调第一个拿到库 ID，再调第二个查文档。

试试这样说：「查一下这个库最新版本的用法」「这个框架的路由在新版本里怎么写」。

## 数据会发给谁

你问的库名和问题会发到 Context7（Upstash）的服务器（境外）。别在问题里贴密钥、公司内部代码或个人信息。返回的文档贾维斯只当「外部资料」参考，不当指令执行。

## 许可证

本插件包（plugin.json、mcp.json、本说明）以 MIT-0 授权，见 [../LICENSE](../LICENSE)。Context7 服务本身归 Upstash 所有，使用时遵守其服务条款。
