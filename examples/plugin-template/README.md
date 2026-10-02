# 贾维斯插件模板 · 倒数日

这是一个能直接用的贾维斯插件，也是写新插件的起点：复制整个目录去 GitHub 建一个仓库，改几处名字，就能在贾维斯的「智能体市场 → 导入插件」里装上。

完整说明见贾维斯仓库的 [`docs/plugins.md`](https://github.com/123akw/jarvis/blob/main/docs/plugins.md)。

## 它能做什么

| 用户说 | 贾维斯调用 | 回答 |
| --- | --- | --- |
| 离 2027 年春节还有几天（春节是 2 月 6 日） | `my_plugin_countdown(target="2027-02-06", label="春节")` | 离 2027年2月6日（周六）「春节」还有 127 天，约 18 周零 1 天。 |
| 我生日 3 月 8 号，还有多久 | `my_plugin_countdown(target="3月8日", label="生日")` | 离 2027年3月8日（周一）「生日」还有 157 天，约 22 周零 3 天。 |

另外提供一个流程积木 `my_plugin_stamp`（加落款日期），在「流程工坊」里可以接在「AI 提炼」后面。

## 目录

```
plugin.json        # 清单：id、名字、图标、分类、工具名……
tools.py           # 工具实现：导出 TOOLS（可选 STEPS）
README.md          # 本文件
tests/test_tools.py
```

## 改成你自己的插件

1. `plugin.json`：改 `id`（小写字母开头，只含小写字母 / 数字 / 下划线）、`name`、`icon`、`summary`、`examples`、`tools`、`steps`、`author`、`homepage`。
2. `tools.py`：把 `my_plugin_` 前缀换成你的 id，写你自己的工具；docstring 用大白话写清「什么时候用」。
3. `tests/test_tools.py`：改成测你的工具。
4. 加一个 `LICENSE`，写清别人能不能用、怎么用（自己写的插件代码可选 MIT 或 Apache-2.0）；没有许可证的仓库，管理员不该导入。

## 本地测试

```bash
pip install pytest langchain-core pydantic   # 贾维斯的虚拟环境里已经都有
python -m pytest -q                           # 在本目录下运行
```

在贾维斯仓库里还可以跑一遍契约自检：

```bash
python examples/check_plugin.py /path/to/你的插件目录
```

## 规矩（必须遵守）

- 只用 Python 标准库与 `langchain_core` / `pydantic`；要用别的包，写进 `plugin.json` 的 `python_packages`，由管理员决定装不装。
- 文本进、文本出：参数是字符串 / 数字 / 布尔，返回给用户看的中文文本；可预见的错误自己说人话，不抛异常。
- 导入 `tools.py` 时不能联网、不能读写文件、不能读环境变量；第三方插件在独立子进程里运行，拿不到贾维斯的密钥。
- 每次调用要在几秒内返回。
