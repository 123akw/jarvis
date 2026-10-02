"""插件自检：按第十四轮插件包契约（docs/proposals/2026-10-round14-plugins.md 第 1 节）检查插件目录或插件源。

用法（在贾维斯仓库根目录，用贾维斯的虚拟环境）：
    python examples/check_plugin.py <插件目录或插件源目录> [...]

- 贾维斯原生插件（plugin.json 里有 id）：检查清单、tools.py 导出、SKILL.md；
- Agent Plugins 标准插件（Codex / ChatGPT 格式：plugin.json 里是 name + extensions，技能在 skills/）：
  先按 docs/plugins.md 的对照表近似转成贾维斯清单再检查；
- 插件源（目录下有 .agents/plugins/marketplace.json）：检查清单，并逐个检查本地插件。

只做开发期自查，不代替贾维斯导入器的校验；退出码 0 表示没有错误（可能有提醒）。
"""
from __future__ import annotations

import importlib.metadata
import importlib.util
import json
import re
import sys
from pathlib import Path

ID_RE = re.compile(r"^[a-z][a-z0-9_]{1,30}$")
TOOL_RE = re.compile(r"^[a-z][a-z0-9_]{1,63}$")
KEBAB_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
KINDS = ("tool", "channel", "step", "skill")
CATEGORIES = ("efficiency", "communication", "documents", "info", "life", "ai", "output")
PROFESSIONS = ("shop_owner", "freelancer", "project_manager", "sales", "teacher", "student", "creator", "office")
REQUIREMENTS = ("feishu_bound", "wechat_owner", "desktop", "files")
REQUIRED = ("id", "name", "version", "icon", "kind", "category", "summary", "tools", "steps", "requires")
MAX_SKILL_CHARS = 2000
MARKETPLACE_FILE = Path(".agents/plugins/marketplace.json")
# Codex / ChatGPT 目录分类 → 贾维斯分类（近似，没有的归「效率」）
OPENAI_CATEGORIES = {"productivity": "efficiency", "communication": "communication", "lifestyle": "life",
                     "education": "documents", "research": "info", "news": "info", "design": "output",
                     "coding": "ai", "developer tools": "ai", "finance": "life"}
# 第三方插件里出现这些写法时提醒管理员多看一眼（不是禁止：子进程里本来也拿不到密钥）
RISKY = {
    r"\bos\.environ\b|\bgetenv\(": "读取环境变量",
    r"\bsubprocess\b|\bos\.system\(|\bos\.popen\(": "启动外部程序",
    r"\beval\(|\bexec\(|\b__import__\(": "动态执行代码",
    r"\bsocket\b|\burllib\b|\bhttp\.client\b|\bhttpx\b|\brequests\b|\baiohttp\b": "联网",
    r"\bshutil\.rmtree\(|\bos\.remove\(|\bunlink\(": "删除文件",
    r"\bpickle\b|\bmarshal\b": "反序列化",
}


def _load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _read_json(path: Path) -> tuple[dict | None, str | None]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None, f"缺少 {path.name}"
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        return None, f"{path.name} 不是合法的 UTF-8 JSON：{exc}"
    if not isinstance(data, dict):
        return None, f"{path.name} 顶层必须是对象"
    return data, None


# ---------- 贾维斯原生插件 ----------

def check_plugin(plugin_dir: str | Path) -> tuple[list[str], list[str]]:
    """返回 (错误, 提醒)。错误意味着导入器大概率会拒绝这个插件。"""
    root = Path(plugin_dir)
    errors: list[str] = []
    warnings: list[str] = []
    manifest, problem = _read_json(root / "plugin.json")
    if problem:
        return [problem], warnings
    skill_text = None
    if "id" not in manifest and ("extensions" in manifest or (root / "skills").is_dir()):
        manifest, skill_text = from_agent_plugin(manifest, root, errors, warnings)
        if manifest is None:
            return errors, warnings
    _check_fields(manifest, errors, warnings)
    kind = manifest.get("kind")
    if kind == "skill":
        _check_skill(root, manifest, errors, skill_text)
    elif kind == "tool" or manifest.get("entry"):
        _check_entry(root, manifest, errors, warnings)
    return errors, warnings


def _check_fields(manifest: dict, errors: list[str], warnings: list[str]) -> None:
    missing = [key for key in REQUIRED if key not in manifest]
    if missing:
        errors.append(f"plugin.json 缺少字段：{', '.join(missing)}")
    pid = manifest.get("id", "")
    if not ID_RE.match(str(pid)):
        errors.append(f"id「{pid}」不合规：小写字母开头，只含小写字母、数字、下划线，2–31 位")
    if manifest.get("kind") not in KINDS:
        errors.append(f"kind 只能是 {' / '.join(KINDS)}")
    if manifest.get("category") not in CATEGORIES:
        errors.append(f"category 只能是 {' / '.join(CATEGORIES)}")
    if manifest.get("tier", "free") not in ("free", "pro"):
        errors.append("tier 只能是 free / pro")
    if not re.fullmatch(r"\d+\.\d+\.\d+", str(manifest.get("version", ""))):
        warnings.append("version 建议写成 1.0.0 这样的三段式")
    for key in ("tools", "steps", "requires", "professions", "examples", "python_packages"):
        if key in manifest and not (isinstance(manifest[key], list)
                                    and all(isinstance(x, str) for x in manifest[key])):
            errors.append(f"{key} 必须是字符串列表")
    if not 4 <= len(str(manifest.get("summary", ""))) <= 40:
        warnings.append("summary 建议 4–40 字，市场卡片上只显示一行")
    unknown = sorted(set(manifest.get("requires") or []) - set(REQUIREMENTS))
    if unknown:
        errors.append(f"requires 里有不认识的条件：{', '.join(unknown)}")
    unknown = sorted(set(manifest.get("professions") or []) - set(PROFESSIONS))
    if unknown:
        warnings.append(f"professions 里有不认识的职业（会被忽略）：{', '.join(unknown)}")
    if not manifest.get("examples"):
        warnings.append("examples 为空：市场里没有示例句，用户不知道怎么用")
    for package in manifest.get("python_packages") or []:
        try:
            importlib.metadata.distribution(package)
        except importlib.metadata.PackageNotFoundError:
            warnings.append(f"依赖 {package} 在当前环境未安装：贾维斯里会显示「暂不可用」")


def _check_skill(root: Path, manifest: dict, errors: list[str], text: str | None = None) -> None:
    if manifest.get("entry") or manifest.get("tools"):
        errors.append("kind=skill 的插件不能带 entry / tools（纯提示词）")
    if text is None:
        try:
            text = (root / "SKILL.md").read_text(encoding="utf-8")
        except OSError:
            errors.append("kind=skill 需要 SKILL.md")
            return
    first, _, body = text.strip().partition("\n")
    if not first.startswith("# "):
        errors.append("SKILL.md 第一行（YAML 头之后）要写「# 技能名称」")
    if not body.strip():
        errors.append("SKILL.md 正文为空")
    elif len(body.strip()) > MAX_SKILL_CHARS:
        errors.append(f"SKILL.md 正文 {len(body.strip())} 字，超过 {MAX_SKILL_CHARS} 字会被截断")


def _check_entry(root: Path, manifest: dict, errors: list[str], warnings: list[str]) -> None:
    entry = manifest.get("entry")
    if not entry:
        errors.append("kind=tool 需要 entry（通常是 tools.py）")
        return
    path = (root / entry).resolve()
    if root.resolve() not in path.parents or not path.is_file():
        errors.append(f"entry「{entry}」不存在或不在插件目录里")
        return
    source = path.read_text(encoding="utf-8")
    for pattern, label in RISKY.items():
        if re.search(pattern, source):
            warnings.append(f"代码里有「{label}」相关写法，导入前请人工看一眼")
    try:
        module = _load_module(f"_check_{manifest.get('id', 'plugin')}", path)
    except Exception as exc:   # noqa: BLE001 — 自检要把任何导入错误都报出来
        errors.append(f"导入 {entry} 失败：{type(exc).__name__}: {exc}")
        return
    exported = getattr(module, "TOOLS", None)
    if not isinstance(exported, list):
        errors.append(f"{entry} 必须导出 TOOLS 列表")
        return
    names = [getattr(t, "name", None) for t in exported]
    if names != list(manifest.get("tools") or []):
        errors.append(f"TOOLS 的工具名 {names} 与 plugin.json 的 tools 不一致")
    if len(set(names)) != len(names):
        errors.append("工具名重复")
    for item in exported:
        name = getattr(item, "name", "")
        if not TOOL_RE.match(str(name)):
            errors.append(f"工具名「{name}」不合规：小写字母、数字、下划线")
        elif not name.startswith(str(manifest.get("id"))):
            warnings.append(f"工具名「{name}」建议以插件 id 为前缀，避免和别的插件撞名")
        if not str(getattr(item, "description", "")).strip():
            errors.append(f"工具「{name}」没有 docstring（模型靠它决定什么时候用）")
        if not hasattr(item, "invoke"):
            errors.append(f"TOOLS 里的「{name}」不是 LangChain 工具，请用 @tool 装饰")
    steps = getattr(module, "STEPS", {}) or {}
    if steps and list(steps) != list(manifest.get("steps") or []):
        errors.append(f"STEPS {list(steps)} 与 plugin.json 的 steps 不一致")
    elif manifest.get("steps") and not steps:
        warnings.append("plugin.json 写了 steps，但当前环境没导出 STEPS（不在贾维斯里运行时属正常）")


# ---------- Agent Plugins 标准插件（Codex / ChatGPT 格式） ----------

def split_frontmatter(text: str) -> tuple[dict, str]:
    """拆 SKILL.md 的 YAML 头（只认简单的 key: value 行，够用于 name / description）。"""
    match = re.match(r"^---\s*\n(.*?)\n---\s*\n?", text, flags=re.S)
    if not match:
        return {}, text
    meta = {}
    for line in match.group(1).splitlines():
        key, sep, value = line.partition(":")
        if sep and key.strip() and not line.startswith((" ", "\t")):
            meta[key.strip()] = value.strip().strip("\"'")
    return meta, text[match.end():]


def from_agent_plugin(manifest: dict, root: Path, errors: list[str],
                      warnings: list[str]) -> tuple[dict | None, str | None]:
    """按 docs/plugins.md 第 9 节的对照表，把标准清单近似转成贾维斯清单；返回 (清单, 技能正文)。"""
    name = str(manifest.get("name", ""))
    if not KEBAB_RE.match(name) or len(name) > 64:
        errors.append(f"标准插件的 name「{name}」应为 kebab-case（小写字母、数字、连字符）")
        return None, None
    iface = ((manifest.get("extensions") or {}).get("com.openai") or {}).get("interface") or {}
    for extra, label in (("mcp.json", "MCP 服务器"), (".app.json", "应用（apps）"), ("hooks", "钩子（hooks）")):
        if (root / extra).exists():
            warnings.append(f"带有{label}：贾维斯 v1 不加载这部分，只导入技能")
    skills = sorted((root / "skills").glob("*/SKILL.md"))
    if not skills:
        errors.append("标准插件里没有 skills/<名>/SKILL.md，贾维斯 v1 没有可导入的内容")
        return None, None
    if len(skills) > 1:
        warnings.append(f"有 {len(skills)} 个技能：每个技能会成为一个技能插件（以导入器为准），这里只检查第一个")
    meta, body = split_frontmatter(skills[0].read_text(encoding="utf-8"))
    skill_dir = skills[0].parent.name
    if meta.get("name") != skill_dir:
        errors.append(f"SKILL.md 的 name「{meta.get('name')}」要和目录名「{skill_dir}」一致")
    if not 1 <= len(meta.get("description", "")) <= 1024:
        errors.append("SKILL.md 的 description 必填，1–1024 字")
    if not body.lstrip().startswith("# "):   # 没写标题时用 displayName 补一个，贾维斯技能要「# 名称」开头
        body = f"# {iface.get('displayName') or name}\n{body}"
    author = manifest.get("author")
    mapped = {
        "id": name.replace("-", "_"),
        "name": iface.get("displayName") or name,
        "version": manifest.get("version", ""),
        "icon": "🧩",
        "category": OPENAI_CATEGORIES.get(str(iface.get("category", "")).lower(), "efficiency"),
        "summary": iface.get("shortDescription") or manifest.get("description", ""),
        "kind": "skill", "tier": "free", "price": 0, "professions": [],
        "examples": list(iface.get("defaultPrompt") or [])[:3],
        "entry": None, "tools": [], "steps": [], "requires": [], "python_packages": [],
        "author": author.get("name", "") if isinstance(author, dict) else str(author or ""),
        "homepage": manifest.get("homepage", ""),
    }
    if iface.get("capabilities"):
        warnings.append(f"声明了权限 {iface['capabilities']}：导入预览时请管理员确认")
    return mapped, body


# ---------- 插件源（.agents/plugins/marketplace.json） ----------

def check_marketplace(source_root: str | Path, resolve_git=None) -> tuple[list[str], list[str]]:
    """检查插件源清单；本地插件逐个跑 check_plugin。resolve_git(url, path) 能返回本地目录时也一并检查。"""
    root = Path(source_root)
    errors: list[str] = []
    warnings: list[str] = []
    data, problem = _read_json(root / MARKETPLACE_FILE)
    if problem:
        return [problem], warnings
    if not KEBAB_RE.match(str(data.get("name", ""))):
        errors.append("插件源 name 必填，kebab-case")
    entries = data.get("plugins")
    if not isinstance(entries, list) or not entries:
        return errors + ["plugins 必须是非空列表"], warnings
    seen = set()
    for entry in entries:
        name = str(entry.get("name", ""))
        label = f"插件「{name}」"
        if name in seen:
            errors.append(f"{label}重复")
        seen.add(name)
        src = entry.get("source") or {}
        kind = src.get("source")
        target = None
        if kind == "local":
            rel = str(src.get("path", ""))
            target = (root / rel).resolve()
            if not rel.startswith("./") or root.resolve() not in target.parents:
                errors.append(f"{label}的 local path 要以 ./ 开头且在插件源目录内")
                continue
        elif kind == "git-subdir":
            url, rel = str(src.get("url", "")), str(src.get("path", ""))
            if not url.startswith("https://") or not rel or rel.startswith(("/", "..")) or "/../" in rel:
                errors.append(f"{label}的 git-subdir 要写 https 的 url 和仓库内相对 path")
                continue
            target = resolve_git(url, rel) if resolve_git else None
        elif kind == "url":
            if not str(src.get("url", "")).startswith("https://"):
                errors.append(f"{label}的 url 要用 https")
        elif kind == "npm":
            errors.append(f"{label}是 npm 来源：贾维斯服务器没有 node，不支持")
        else:
            errors.append(f"{label}的 source 只能是 local / git-subdir / url")
        installation = (entry.get("policy") or {}).get("installation", "AVAILABLE")
        if installation not in ("AVAILABLE", "INSTALLED_BY_DEFAULT", "NOT_AVAILABLE"):
            errors.append(f"{label}的 policy.installation 不认识")
        elif installation == "INSTALLED_BY_DEFAULT":
            warnings.append(f"{label}要求默认安装：贾维斯不自动安装，仍由管理员逐个启用")
        if target is not None:
            sub_errors, sub_warnings = check_plugin(target)
            errors += [f"{label}：{e}" for e in sub_errors]
            warnings += [f"{label}：{w}" for w in sub_warnings]
            if not sub_errors and name.replace("-", "_") != _plugin_id(target):
                errors.append(f"{label}与插件自己的 id「{_plugin_id(target)}」不一致")
    return errors, warnings


def _plugin_id(plugin_dir: Path) -> str:
    manifest, _ = _read_json(plugin_dir / "plugin.json")
    manifest = manifest or {}
    return str(manifest.get("id") or manifest.get("name", "")).replace("-", "_")


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__)
        return 2
    failed = False
    for target in argv:
        is_source = (Path(target) / MARKETPLACE_FILE).is_file()
        errors, warnings = check_marketplace(target) if is_source else check_plugin(target)
        print(f"{'❌' if errors else '✅'} {target}{'（插件源）' if is_source else ''}")
        for line in errors:
            print(f"   错误：{line}")
        for line in warnings:
            print(f"   提醒：{line}")
        failed = failed or bool(errors)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
