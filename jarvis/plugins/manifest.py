"""插件清单 plugin.json 的校验与规整（契约见 docs/proposals/2026-10-round14-plugins.md 第 1 节）。

只做「纯数据」检查：字段类型、取值范围、id / 工具名格式、第三方插件的额外限制。
入口模块能不能导入、依赖装没装、名字和别人冲不冲突，由加载器（loader.py）负责。
所有错误都抛 :class:`ManifestError`，message 是给 Owner 看的人话。
"""
from __future__ import annotations

import json
import re
from pathlib import Path

MANIFEST_FILE = "plugin.json"
SKILL_FILE = "SKILL.md"
MAX_MANIFEST_BYTES = 64 * 1024
MAX_SKILL_CHARS = 2000

ID_RE = re.compile(r"^[a-z][a-z0-9_]{1,30}$")
TOOL_RE = re.compile(r"^[a-z][a-z0-9_]{1,63}$")
VERSION_RE = re.compile(r"^[0-9A-Za-z][0-9A-Za-z.+_-]{0,31}$")
PACKAGE_RE = re.compile(r"^([A-Za-z0-9][A-Za-z0-9._-]{0,99})\s*(\[[A-Za-z0-9_,.\s-]*\])?\s*([<>=!~][^;]{0,60})?$")

KINDS = ("tool", "channel", "step", "skill")
CATEGORY_IDS = ("efficiency", "communication", "documents", "info", "life", "ai", "output")
REQUIREMENT_IDS = ("feishu_bound", "wechat_owner", "desktop", "files")
TIERS = ("free", "pro")
SOURCE_TYPES = ("builtin", "github", "gitee", "zip")
DEFAULT_TIMEOUT = 30.0
MAX_TIMEOUT = 120.0

_TEXT_LIMITS = {"name": 20, "summary": 60, "author": 40, "icon": 16, "license": 40}
_MAX_EXAMPLES = 6
_MAX_EXAMPLE_CHARS = 40
_MAX_TOOLS = 20
_MAX_PACKAGES = 20


class ManifestError(ValueError):
    """清单不合法；message 直接给 Owner 看。"""


def _text(raw: dict, key: str, *, required: bool, default: str = "") -> str:
    value = raw.get(key, default)
    if value is None:
        value = default
    if not isinstance(value, str):
        raise ManifestError(f"清单里的 {key} 要是文字")
    value = " ".join(value.split())
    if required and not value:
        raise ManifestError(f"清单缺少 {key}")
    limit = _TEXT_LIMITS.get(key)
    if limit and len(value) > limit:
        raise ManifestError(f"清单里的 {key} 最多 {limit} 个字")
    return value


def _str_list(raw: dict, key: str, *, limit: int, item_limit: int = 64) -> list[str]:
    value = raw.get(key) or []
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise ManifestError(f"清单里的 {key} 要是文字列表")
    if len(value) > limit:
        raise ManifestError(f"清单里的 {key} 最多 {limit} 项")
    cleaned = [" ".join(item.split()) for item in value]
    if any(not item or len(item) > item_limit for item in cleaned):
        raise ManifestError(f"清单里的 {key} 有空项或过长的项")
    return list(dict.fromkeys(cleaned))


def package_name(spec: str) -> str:
    """「pypdf>=6」「python-docx」→ 包名部分。"""
    match = PACKAGE_RE.match(spec.strip())
    if not match:
        raise ManifestError(f"python_packages 里的「{spec[:40]}」写法不对")
    return match.group(1)


def normalize_source(raw) -> dict:
    if raw in (None, {}):
        return {"type": "builtin"}
    if not isinstance(raw, dict) or raw.get("type") not in SOURCE_TYPES:
        raise ManifestError("清单里的 source 写法不对")
    source = {"type": raw["type"]}
    for key in ("repo", "ref", "path", "url", "name"):
        value = raw.get(key)
        if isinstance(value, str) and value.strip():
            source[key] = value.strip()[:200]
    return source


def validate(raw, *, builtin: bool, folder: str | None = None) -> dict:
    """校验并规整一个清单；返回只含契约字段（外加 timeout）的新 dict。

    ``builtin``：随代码发布的内置插件；False 表示导入的第三方插件，额外限制：
    不能是 channel、不能提供流程积木、不能要求文件空间（v1 第三方插件只做文本进文本出）。"""
    if not isinstance(raw, dict):
        raise ManifestError("plugin.json 的最外层要是一个对象")
    plugin_id = raw.get("id")
    if not isinstance(plugin_id, str) or not ID_RE.match(plugin_id):
        raise ManifestError("插件 id 要以小写字母开头，只含小写字母、数字和下划线，2–31 位")
    if builtin and folder is not None and folder != plugin_id:
        raise ManifestError(f"内置插件目录名「{folder}」要和 id「{plugin_id}」一致")
    kind = raw.get("kind", "tool")
    if kind not in KINDS:
        raise ManifestError(f"插件类型 kind 只能是 {' / '.join(KINDS)}")
    category = raw.get("category", "efficiency")
    if category not in CATEGORY_IDS:
        raise ManifestError(f"分类 category 只能是 {' / '.join(CATEGORY_IDS)}")
    tier = raw.get("tier", "free")
    if tier not in TIERS:
        raise ManifestError("tier 只能是 free 或 pro")
    price = raw.get("price", 0)
    if isinstance(price, bool) or not isinstance(price, (int, float)) or price < 0 or price > 9999:
        raise ManifestError("price 要是 0–9999 的数字")
    version = raw.get("version", "0.0.0")
    if not isinstance(version, str) or not VERSION_RE.match(version):
        raise ManifestError("版本号 version 写法不对（例如 1.0.0）")

    entry = raw.get("entry")
    if entry is not None:
        if (not isinstance(entry, str) or not re.match(r"^[A-Za-z_][A-Za-z0-9_]{0,40}\.py$", entry)):
            raise ManifestError("入口 entry 要是插件目录里的一个 .py 文件名（例如 tools.py），或者 null")
    tools = _str_list(raw, "tools", limit=_MAX_TOOLS)
    bad_tool = next((name for name in tools if not TOOL_RE.match(name)), None)
    if bad_tool:
        raise ManifestError(f"工具名「{bad_tool[:40]}」只能用小写字母、数字和下划线")
    steps = _str_list(raw, "steps", limit=10)
    bad_step = next((name for name in steps if not ID_RE.match(name)), None)
    if bad_step:
        raise ManifestError(f"积木 id「{bad_step[:40]}」只能用小写字母、数字和下划线")
    requires = _str_list(raw, "requires", limit=4)
    unknown = [need for need in requires if need not in REQUIREMENT_IDS]
    if unknown:
        raise ManifestError(f"requires 里有不认识的条件：{'、'.join(unknown)}")
    packages = _str_list(raw, "python_packages", limit=_MAX_PACKAGES, item_limit=100)
    for spec in packages:
        package_name(spec)
    examples = _str_list(raw, "examples", limit=_MAX_EXAMPLES, item_limit=_MAX_EXAMPLE_CHARS)
    professions = _str_list(raw, "professions", limit=12, item_limit=32)
    timeout = raw.get("timeout", DEFAULT_TIMEOUT)
    if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not 1 <= timeout <= MAX_TIMEOUT:
        raise ManifestError(f"timeout 要是 1–{int(MAX_TIMEOUT)} 秒")

    extras = _extras(raw.get("extras"))
    if kind == "skill":
        if entry is not None or tools or steps:
            raise ManifestError("提示词技能（kind=skill）只有 SKILL.md，不能带入口模块、工具或积木")
    elif entry is not None and not tools and not steps:
        raise ManifestError("有入口模块的插件要在 tools 或 steps 里列出它提供的东西")
    if kind == "tool" and not tools and entry is None and not extras.get("mcp"):
        raise ManifestError("对话技能（kind=tool）至少要列一个工具")
    if kind == "step" and not steps:
        raise ManifestError("流程积木（kind=step）要在 steps 里列出积木 id")
    if not builtin:
        if kind == "channel":
            raise ManifestError("第三方插件暂不支持通道（channel）类型")
        if steps:
            raise ManifestError("第三方插件暂不支持流程积木，只能提供对话工具或提示词技能")
        if "files" in requires:
            raise ManifestError("第三方插件暂不能使用文件空间（只做文本进、文本出）")
        if kind == "tool" and entry is None and not extras.get("mcp"):
            raise ManifestError("第三方插件要有入口模块 entry（例如 tools.py）")
        if entry is None and tools:
            raise ManifestError("第三方插件的工具要由自己的入口模块提供")

    source = normalize_source(raw.get("source"))
    if builtin:
        source = {"type": "builtin"}
    elif source["type"] == "builtin":
        source = {"type": "zip"}
    homepage = raw.get("homepage") or ""
    if not isinstance(homepage, str) or (homepage and not re.match(r"^https?://[^\s<>\"']{1,300}$", homepage)):
        raise ManifestError("homepage 要是 http(s) 开头的网址")

    return {
        "id": plugin_id,
        "name": _text(raw, "name", required=True),
        "version": version,
        "icon": _text(raw, "icon", required=False, default="🧩") or "🧩",
        "category": category,
        "summary": _text(raw, "summary", required=True),
        "kind": kind,
        "tier": tier,
        "price": price,
        "professions": professions,
        "examples": examples,
        "entry": entry,
        "tools": tools,
        "steps": steps,
        "requires": requires,
        "python_packages": packages,
        "author": _text(raw, "author", required=False),
        "license": _text(raw, "license", required=False) or str((raw.get("extras") or {}).get("license") or "")[:40],
        "homepage": homepage,
        "source": source,
        "timeout": float(timeout),
        "extras": extras,
    }


_URL_RE = re.compile(r"^https?://[^\s<>\"']{1,300}$")
_EXTRA_TEXT = {"format": 20, "license": 40, "logo": 120, "brand_color": 16, "long_description": 400}


def _extras(raw) -> dict:
    """插件的附加信息（主要来自 Agent Plugins 格式）：权限声明、隐私政策、MCP 服务……只做规整，不报错。"""
    if not isinstance(raw, dict):
        return {}
    out: dict = {}
    for key, limit in _EXTRA_TEXT.items():
        value = raw.get(key)
        if isinstance(value, str) and value.strip():
            out[key] = " ".join(value.split())[:limit]
    skill_file = raw.get("skill_file")
    if isinstance(skill_file, str) and re.match(r"^skills/[^/]{1,100}/SKILL\.md$", skill_file):
        out["skill_file"] = skill_file
    for key in ("privacy_url", "terms_url", "repository"):
        value = raw.get(key)
        if isinstance(value, str) and _URL_RE.match(value.strip()):
            out[key] = value.strip()
    caps = raw.get("capabilities")
    if isinstance(caps, list):
        out["capabilities"] = [str(c)[:20] for c in caps if isinstance(c, str) and c.strip()][:8]
    mcp = raw.get("mcp")
    if isinstance(mcp, list):
        out["mcp"] = [{"name": str(m.get("name", ""))[:40], "type": str(m.get("type", ""))[:30],
                       "url": str(m.get("url", ""))[:300]} for m in mcp if isinstance(m, dict)][:10]
    return out


ALT_MANIFESTS = (".codex-plugin/plugin.json", ".claude-plugin/plugin.json")


def manifest_path(folder: Path) -> Path | None:
    for rel in (MANIFEST_FILE, *ALT_MANIFESTS):
        path = folder / rel
        if path.is_file() and not path.is_symlink():
            return path
    return None


def load_json(path: Path) -> dict:
    if path.stat().st_size > MAX_MANIFEST_BYTES:
        raise ManifestError(f"{path.name} 太大了")
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except UnicodeDecodeError:
        raise ManifestError(f"{path.name} 要用 UTF-8 编码") from None
    except json.JSONDecodeError as exc:
        raise ManifestError(f"{path.name} 不是合法的 JSON（第 {exc.lineno} 行）") from None
    if not isinstance(raw, dict):
        raise ManifestError(f"{path.name} 的最外层要是一个对象")
    return raw


def raw_manifest(folder: Path, *, builtin: bool) -> dict:
    """读出「我们格式」的原始清单：plugin.json（自有格式或 Agent Plugins 格式自动映射），
    第三方的纯技能目录（只有 SKILL.md）按技能内容补一份。"""
    path = manifest_path(folder)
    if path is None:
        if builtin or not (folder / SKILL_FILE).is_file():
            raise ManifestError("没有找到 plugin.json")
        return manifest_from_skill(folder.name, read_skill(folder))
    raw = load_json(path)
    if is_agent_plugin(raw):
        raw = from_agent_plugin(raw, folder)
    return raw


def read(folder: Path, *, builtin: bool) -> dict:
    """读并校验 <folder> 的插件清单。"""
    return validate(raw_manifest(folder, builtin=builtin), builtin=builtin, folder=folder.name)


# ---------- Agent Plugins 格式（Codex / ChatGPT 插件）映射 ----------

AGENT_SCHEMA_HINT = "agent-plugins"
_CATEGORY_MAP = {
    "productivity": "efficiency", "efficiency": "efficiency", "project management": "efficiency",
    "communication": "communication", "social": "communication", "collaboration": "communication",
    "documents": "documents", "writing": "documents", "files": "documents", "education": "documents",
    "research": "info", "news": "info", "search": "info", "finance": "info", "data": "info", "analytics": "info",
    "lifestyle": "life", "travel": "life", "shopping": "life", "entertainment": "life", "food": "life",
    "ai": "ai", "developer tools": "ai", "coding": "ai", "design": "ai", "engineering": "ai",
}


def agent_interface(raw: dict) -> dict:
    """extensions["com.openai.interface"] 或 extensions["com.openai"]["interface"]（两种写法都见过）。"""
    ext = raw.get("extensions") if isinstance(raw.get("extensions"), dict) else {}
    ui = ext.get("com.openai.interface")
    if not isinstance(ui, dict):
        nested = ext.get("com.openai")
        ui = nested.get("interface") if isinstance(nested, dict) else None
    return ui if isinstance(ui, dict) else {}


def is_agent_plugin(raw: dict) -> bool:
    """带 $schema（agent-plugins.org）或 OpenAI interface 扩展，或只有 name/description 没有 id。"""
    schema = str(raw.get("$schema") or "")
    return (AGENT_SCHEMA_HINT in schema or bool(agent_interface(raw))
            or ("id" not in raw and isinstance(raw.get("name"), str) and "description" in raw))


def _clip(value, limit: int) -> str:
    text = " ".join(str(value or "").split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _skill_files(folder: Path) -> list[str]:
    files = []
    if (folder / SKILL_FILE).is_file():
        files.append(SKILL_FILE)
    skills_dir = folder / "skills"
    if skills_dir.is_dir() and not skills_dir.is_symlink():
        for sub in sorted(skills_dir.iterdir()):
            if sub.is_dir() and not sub.is_symlink() and (sub / SKILL_FILE).is_file():
                files.append(f"skills/{sub.name}/{SKILL_FILE}")
    return files[:MAX_SKILL_FILES]


def mcp_servers(folder: Path) -> list[dict]:
    path = folder / "mcp.json"
    if not path.is_file() or path.is_symlink():
        return []
    try:
        raw = load_json(path)
    except ManifestError:
        return []
    servers = raw.get("mcpServers") or raw.get("servers") or {}
    out = []
    if isinstance(servers, dict):
        for name, conf in servers.items():
            if isinstance(conf, dict):
                out.append({"name": str(name), "type": str(conf.get("type") or ("stdio" if conf.get("command") else "")),
                            "url": str(conf.get("url") or "")})
    return out


def from_agent_plugin(raw: dict, folder: Path) -> dict:
    """Agent Plugins 标准清单 → 我们的清单。技能（skills/*/SKILL.md）变成 kind=skill；
    只有 MCP 服务的插件先装上、标「需要 MCP 支持」。"""
    ui = agent_interface(raw)
    author = raw.get("author")
    author_name = author.get("name") if isinstance(author, dict) else author
    prompts = ui.get("defaultPrompt") or []
    prompts = [prompts] if isinstance(prompts, str) else [p for p in prompts if isinstance(p, str)]
    category = _CATEGORY_MAP.get(str(ui.get("category") or "").strip().lower(), "efficiency")
    skills = _skill_files(folder)
    mcp = mcp_servers(folder)
    homepage = raw.get("homepage") or ui.get("websiteURL") or ""
    repository = raw.get("repository")
    if isinstance(repository, dict):
        repository = repository.get("url")
    return {
        "id": slug_id(raw.get("name") or folder.name, "plugin"),
        "name": _clip(ui.get("displayName") or raw.get("name") or folder.name, 20),
        "version": str(raw.get("version") or "0.0.0")[:32],
        "icon": "🧩",
        "category": category,
        "summary": _clip(ui.get("shortDescription") or raw.get("description") or ui.get("displayName") or "社区插件", 60),
        "kind": "skill" if skills else "tool",
        "examples": [_clip(p, 40) for p in prompts if p.strip()][:6],
        "entry": None, "tools": [], "steps": [], "requires": [], "python_packages": [],
        "author": _clip(ui.get("developerName") or author_name or "", 40),
        "homepage": homepage if isinstance(homepage, str) and _URL_RE.match(homepage) else "",
        "extras": {
            "format": "agent-plugin", "capabilities": ui.get("capabilities") or [],
            "privacy_url": ui.get("privacyPolicyURL") or "", "terms_url": ui.get("termsOfServiceURL") or "",
            "logo": ui.get("logo") or ui.get("composerIcon") or "", "brand_color": ui.get("brandColor") or "",
            "long_description": ui.get("longDescription") or "", "license": raw.get("license") or "",
            "repository": repository or "", "mcp": mcp,
        },
    }


# ---------- SKILL.md（兼容社区常见写法：YAML front matter 可有可无，首行「# 标题」） ----------

_FRONT = re.compile(r"\A---[ \t]*\r?\n(.*?)\r?\n---[ \t]*(?:\r?\n|\Z)", re.S)


def _front_matter(text: str) -> dict:
    """极简 YAML：只认顶层「key: value」与「key: >/|」后的缩进续行；够读 name / description。"""
    data: dict[str, str] = {}
    key = None
    for line in text.splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if line[:1] in (" ", "\t") and key:
            data[key] = (data[key] + " " + line.strip()).strip()
            continue
        match = re.match(r"^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$", line)
        if not match:
            key = None
            continue
        key, value = match.group(1).lower(), match.group(2).strip()
        if value in (">", "|", ">-", "|-"):
            value = ""
        data[key] = value.strip().strip("'\"")
    return data


def parse_skill(text: str) -> dict:
    """SKILL.md → {title, description, body, truncated, meta}。body 最多 2000 字。"""
    text = str(text or "").replace("\r\n", "\n").lstrip("﻿")
    meta: dict[str, str] = {}
    match = _FRONT.match(text)
    if match:
        meta = _front_matter(match.group(1))
        text = text[match.end():]
    text = text.strip()
    title = ""
    first, _, rest = text.partition("\n")
    if first.lstrip().startswith("#"):
        title = first.lstrip("#").strip()
        text = rest.strip()
    title = title or meta.get("name", "")
    body = text
    truncated = len(body) > MAX_SKILL_CHARS
    return {"title": " ".join(title.split())[:40], "description": " ".join(meta.get("description", "").split())[:200],
            "body": body[:MAX_SKILL_CHARS], "truncated": truncated, "meta": meta}


MAX_SKILL_FILES = 5


def _read_skill_file(path: Path) -> dict:
    if path.is_symlink() or not path.is_file():
        raise ManifestError("提示词技能缺少 SKILL.md")
    try:
        return parse_skill(path.read_text(encoding="utf-8"))
    except UnicodeDecodeError:
        raise ManifestError("SKILL.md 要用 UTF-8 编码") from None


def read_skill(folder: Path, skill_file: str = "") -> dict:
    """根目录的 SKILL.md；没有就读 skills/*/SKILL.md（Agent Plugins 写法）。正文 ≤ 2000 字。

    ``skill_file``：多技能包拆开后，每个技能插件只读自己那一份。"""
    if skill_file:
        parsed = _read_skill_file(folder / skill_file)
        if not parsed["body"]:
            raise ManifestError("SKILL.md 没有正文")
        parsed["files"] = [skill_file]
        return parsed
    files = _skill_files(folder)
    if not files:
        raise ManifestError("提示词技能缺少 SKILL.md")
    if files[0] == SKILL_FILE:
        parsed = _read_skill_file(folder / SKILL_FILE)
    else:
        parts = [_read_skill_file(folder / rel) for rel in files]
        body = "\n\n".join(f"### {p['title'] or rel.split('/')[1]}\n{p['body']}"
                            for p, rel in zip(parts, files) if p["body"])
        parsed = {"title": parts[0]["title"], "description": parts[0]["description"], "meta": parts[0]["meta"],
                  "body": body[:MAX_SKILL_CHARS],
                  "truncated": len(body) > MAX_SKILL_CHARS or any(p["truncated"] for p in parts)}
    if not parsed["body"]:
        raise ManifestError("SKILL.md 没有正文")
    parsed["files"] = files
    return parsed


def slug_id(raw: str, fallback: str = "skill") -> str:
    """把 SKILL.md 里的 name / 目录名变成合法 id（社区技能常用短横线）。"""
    text = re.sub(r"[^a-z0-9_]+", "_", str(raw or "").strip().lower()).strip("_")
    if not text or not text[0].isalpha():
        text = f"{fallback}_{text}".strip("_")
    text = text[:31].rstrip("_")
    return text if ID_RE.match(text) else fallback


def expand(m: dict, folder: Path) -> list[dict]:
    """一个 Agent Plugins 包里有多个技能时，拆成多个技能插件（id = <插件>_<技能>）；其余原样返回。"""
    if m["kind"] != "skill" or (m.get("extras") or {}).get("format") != "agent-plugin":
        return [m]
    files = [f for f in _skill_files(folder) if f != SKILL_FILE]
    if len(files) <= 1:
        return [m]
    out = []
    for rel in files:
        skill_dir = rel.split("/")[1]
        try:
            parsed = _read_skill_file(folder / rel)
        except ManifestError:
            continue
        sub_id = slug_id(f"{m['id']}_{skill_dir}", m["id"])[:31].rstrip("_")
        item = dict(m, id=sub_id, extras=dict(m["extras"], skill_file=rel, package=m["id"]))
        item["name"] = _clip(parsed["title"] or skill_dir, 20)
        item["summary"] = _clip(parsed["description"] or m["summary"], 60)
        out.append(item)
    return out or [m]


def manifest_from_skill(folder_name: str, parsed: dict) -> dict:
    """只有 SKILL.md、没有 plugin.json 时，按技能内容补一份清单。"""
    meta = parsed.get("meta") or {}
    plugin_id = slug_id(meta.get("name") or folder_name)
    name = (parsed.get("title") or meta.get("name") or folder_name or "社区技能")[:20]
    summary = (parsed.get("description") or f"提示词技能：{name}")[:60]
    return {"id": plugin_id, "name": name, "version": "0.0.0", "icon": "📘", "category": "ai",
            "summary": summary, "kind": "skill", "tier": "free", "price": 0, "entry": None,
            "tools": [], "steps": [], "requires": [], "python_packages": [], "examples": [],
            "author": (meta.get("author") or "")[:40]}
