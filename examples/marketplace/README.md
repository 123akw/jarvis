# 插件源示例（marketplace）

一个「插件源」仓库就是一份插件清单：管理员在贾维斯「智能体市场 → 导入插件源」里填一次仓库地址，就能在市场里看到清单里的全部插件，再逐个安装。格式与 Codex / ChatGPT 的 Agent Plugins 插件源相同：

```
marketplace/                         ← 插件源仓库根（导入时填这个目录）
  .agents/plugins/marketplace.json   ← 插件源清单
  plugins/
    festival-greetings/              ← 本仓库自带的插件（Agent Plugins 标准格式）
      plugin.json
      skills/festival-greetings/SKILL.md
```

`marketplace.json` 里有两种来源：

- `"source": "local"`：插件就在本仓库里，`path` 以 `./` 开头、相对插件源根目录（如 `./plugins/festival-greetings`）。
- `"source": "git-subdir"`：插件在别的 Git 仓库的子目录里，写 `url`、`path`，可选 `ref`（分支 / tag）或 `sha`（commit）。本例引用贾维斯仓库里 `examples/plugins/` 下的四个示例插件。

`festival-greetings` 演示 Agent Plugins 标准的 `plugin.json` 与 `skills/<名>/SKILL.md`（YAML 头里写 `name`、`description`）；贾维斯导入时按 `docs/plugins.md` 第 9 节的对照表转成自己的插件（它会成为一个 `kind: skill` 技能插件，id 为 `festival_greetings`）。

许可证：随贾维斯仓库 README 的「声明」（学习、研究与个人非商业用途）。
