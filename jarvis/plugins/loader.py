"""插件包加载器与注册表（第十四轮，契约见 docs/proposals/2026-10-round14-plugins.md 第 1 节）。

扫描两处：
- 内置：``jarvis/plugins/packs/<id>/plugin.json``（随代码发布）；
- 导入：``$JARVIS_DATA_DIR/plugins/<id>/plugin.json``（Owner 从 GitHub / Gitee / zip 导入）。

每个插件单独加载，**互不影响**（隔离原则）：
1. 清单不合法、依赖缺失、入口导入报错 → 只把这一个插件标成「暂不可用」并写明原因；
2. 插件提供的工具一律包一层：异常转人话、单次调用限时，出错不打断对话；
3. 工具名 / 积木 id / 插件 id 冲突 → 后加载的插件被拒绝（内置先于导入，同类按目录名 / 安装先后）；
4. 插件自己的设置走 tenant_prefs 的 ``plugin:<id>:<key>``（见 settings.py）；
5. 导入的第三方插件的工具在子进程里执行（见 sandbox.py），主进程从不导入它们的代码。

启用 / 停用状态与导入记录存在 ``$JARVIS_DATA_DIR/plugins/_state.json``（不加表）。
注册表按数据目录缓存，任何变化（导入 / 卸载 / 启停）都整体重建并让 ``generation()`` 加一，
AgentRuntimeManager 据此重建各账号的 Agent，工具集随之更新。
"""
from __future__ import annotations

import contextvars
import copy
import datetime as dt
import importlib
import importlib.metadata
import importlib.util
import json
import logging
import os
import sys
import threading
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeout
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from jarvis.plugins import manifest as mf
from jarvis.plugins import sandbox

log = logging.getLogger(__name__)

PACKAGE_DIR = Path(__file__).resolve().parent / "packs"
PACKS_DIR = PACKAGE_DIR          # 内置插件扫描目录（测试可替换）
STATE_FILE = "_state.json"
PRO_PRICE = 9.9
BASE_TOOLS = ("now", "calc")
OWNER_TOOLS = ("coding_status", "sys_query")
SANDBOX_TIMEOUT = 20.0

_TOOL_POOL = ThreadPoolExecutor(max_workers=16, thread_name_prefix="jarvis-plugin-tool")


def _option(key, label, type_, default, choices=None) -> dict:
    option = {"key": key, "label": label, "type": type_, "default": default}
    if choices is not None:
        option["choices"] = list(choices)
    return option


# 流程模块不在时（单独测试或拆分部署）九个核心积木的同形状兜底；平时以 jarvis.flows.step_catalog 为准
_FALLBACK_STEPS = {
    "input_text": {"role": "input", "accepts": [], "produces": ["text"],
                   "options": [_option("label", "输入框提示", "text", "贴一段文字")]},
    "input_file": {"role": "input", "accepts": [], "produces": ["text"], "options": []},
    "split_file": {"role": "process", "accepts": ["text"], "produces": ["parts", "text"],
                   "options": [_option("mode", "拆分方式", "select", "chapter", ("chapter", "paragraph", "size")),
                               _option("max_parts", "最多几段", "number", 8)]},
    "ai_extract": {"role": "process", "accepts": ["text", "parts"], "produces": ["text", "items"],
                   "options": [_option("task", "做什么", "select", "要点", ("要点", "待办", "摘要", "周报", "改写")),
                               _option("instruction", "补充要求", "text", "")]},
    "to_todo": {"role": "output", "accepts": ["items", "text"], "produces": [], "options": []},
    "feishu_send": {"role": "output", "accepts": ["text"], "produces": [], "options": []},
    "feishu_doc": {"role": "output", "accepts": ["text", "parts"], "produces": ["links"], "options": []},
    "wechat_send": {"role": "output", "accepts": ["text"], "produces": [], "options": []},
    "web_page": {"role": "output", "accepts": ["text", "parts", "links"], "produces": ["links"],
                 "options": [_option("title", "网页标题", "text", "")]},
}


def data_root() -> Path:
    """导入插件的根目录（不顺手建目录：只读路径上不该有副作用）。"""
    from jarvis.config import ROOT
    return Path(os.getenv("JARVIS_DATA_DIR", str(ROOT / "data"))) / "plugins"


def _now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


# ---------- 状态文件 ----------

def read_state(root: Path | None = None) -> dict:
    path = (root or data_root()) / STATE_FILE
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raw = {}
    disabled = raw.get("disabled") if isinstance(raw, dict) else None
    installed = raw.get("installed") if isinstance(raw, dict) else None
    sources = raw.get("sources") if isinstance(raw, dict) else None
    mcp = raw.get("mcp") if isinstance(raw, dict) else None     # 第十五轮：MCP 插件的工具清单存档（见 mcp.py）
    return {"disabled": sorted({x for x in disabled or [] if isinstance(x, str)}),
            "installed": {k: v for k, v in (installed or {}).items() if isinstance(k, str) and isinstance(v, dict)},
            "sources": {k: v for k, v in (sources or {}).items() if isinstance(k, str) and isinstance(v, dict)},
            "mcp": {k: v for k, v in (mcp or {}).items() if isinstance(k, str) and isinstance(v, dict)}}


def write_state(state: dict, root: Path | None = None) -> None:
    root = root or data_root()
    root.mkdir(parents=True, exist_ok=True)
    tmp = root / f".{STATE_FILE}.tmp"
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, root / STATE_FILE)


# ---------- 依赖检查 ----------

def package_installed(spec: str) -> bool:
    name = mf.package_name(spec)
    try:
        importlib.metadata.distribution(name)
        return True
    except importlib.metadata.PackageNotFoundError:
        pass
    module = name.replace("-", "_").lower()
    try:
        return importlib.util.find_spec(module) is not None
    except (ImportError, ValueError):
        return False


def missing_packages(specs) -> list[str]:
    return [mf.package_name(spec) for spec in specs or () if not package_installed(spec)]


# ---------- 工具包装（隔离第 2 条） ----------

def failure_text(plugin_name: str, reason: str) -> str:
    return (f"插件「{plugin_name}」这次没办成：{reason}。不要用相同参数重试；"
            "请用人话告诉用户这一步没成功，并给出替代办法（稍后再试、换个说法或手动处理）。")


def guard_tool(original, *, plugin_name: str, timeout: float):
    """内置插件包的工具：在线程池里跑（带上当前租户上下文），限时、异常转人话。"""
    from langchain_core.tools import StructuredTool

    def run(**kwargs):
        context = contextvars.copy_context()
        future = _TOOL_POOL.submit(context.run, original.invoke, kwargs)
        try:
            return future.result(timeout=timeout)
        except FutureTimeout:
            log.warning("plugin tool %s timed out", original.name)
            return failure_text(plugin_name, f"处理超时（超过 {int(timeout)} 秒）")
        except Exception as exc:
            log.warning("plugin tool %s failed: %s", original.name, type(exc).__name__)
            return failure_text(plugin_name, f"插件内部出错（{type(exc).__name__}）")

    wrapped = StructuredTool.from_function(func=run, name=original.name, description=original.description,
                                           args_schema=original.args_schema)
    object.__setattr__(wrapped, "plugin_guarded", True)
    return wrapped


def sandbox_tool(spec: dict, *, folder: Path, entry: str, plugin_name: str, timeout: float):
    """第三方插件的工具：主进程里只有一个代理，真正执行在子进程（隔离第 5 条）。"""
    from langchain_core.tools import StructuredTool

    def run(**kwargs):
        try:
            return sandbox.call(folder, entry, spec["name"], kwargs, timeout=timeout)
        except sandbox.SandboxError as exc:
            return failure_text(plugin_name, str(exc))
        except Exception as exc:
            log.warning("sandbox proxy %s failed: %s", spec["name"], type(exc).__name__)
            return failure_text(plugin_name, "插件进程出错")

    description = (spec.get("description") or plugin_name).strip()
    tool = StructuredTool.from_function(func=run, name=spec["name"], description=description[:1000],
                                        args_schema=copy.deepcopy(spec.get("parameters") or {"type": "object", "properties": {}}))
    object.__setattr__(tool, "plugin_guarded", True)
    object.__setattr__(tool, "plugin_sandboxed", True)
    return tool


def _mcp_hosts(m: dict) -> list[str]:
    from jarvis.plugins import mcp
    return mcp.hosts(m)


def _mcp_management(pack) -> dict | None:
    if not pack.manifest or not pack.manifest.get("mcp_servers"):
        return None
    try:
        from jarvis.plugins import mcp
        return mcp.management_info(pack)
    except Exception as exc:   # 管理清单不能因为一个插件的状态读不出来就整个失败
        log.warning("mcp management info for %s failed: %s", pack.id, type(exc).__name__)
        return None


# ---------- 插件与注册表 ----------

@dataclass
class Pack:
    id: str
    folder: Path
    builtin: bool
    manifest: dict | None = None
    status: str = "ok"            # ok / unavailable / disabled / needs_config / needs_review（后两种只有 MCP 插件）
    reason: str = ""
    detail: str = ""
    tools: list = field(default_factory=list)        # 包装后的工具（只有带入口的插件才有）
    steps: dict = field(default_factory=dict)        # {step_id: StepSpec}（带入口的内置插件）
    skill: dict | None = None
    installed: dict = field(default_factory=dict)    # 导入记录（来源、安装时间……）

    @property
    def name(self) -> str:
        return (self.manifest or {}).get("name") or self.id

    def fail(self, reason: str, detail: str = "") -> None:
        self.status, self.reason, self.detail = "unavailable", reason, detail or reason
        self.tools, self.steps = [], {}


def _builtin_order() -> dict[str, int]:
    """packs/order.json：内置插件在市场里的展示顺序（第十三轮的顺序）；读不到就按目录名。"""
    try:
        raw = json.loads((PACKAGE_DIR / "order.json").read_text(encoding="utf-8"))
        return {pid: index for index, pid in enumerate(raw.get("order") or []) if isinstance(pid, str)}
    except (OSError, ValueError, AttributeError):
        return {}


def _import_builtin(folder: Path, entry: str):
    """内置插件的入口模块：在 jarvis/plugins/packs 下就按包路径导入（插件自带测试可直接 import 同一个模块），
    别处（测试替换了 PACKS_DIR）按文件导入。"""
    stem = entry[:-3]
    if folder.parent.resolve() == PACKAGE_DIR:
        return importlib.import_module(f"jarvis.plugins.packs.{folder.name}.{stem}")
    name = f"jarvis_pack_{folder.name}_{stem}"
    spec = importlib.util.spec_from_file_location(name, folder / entry)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    try:
        spec.loader.exec_module(module)
    except BaseException:
        sys.modules.pop(name, None)
        raise
    return module


def _core_tool_names() -> set[str]:
    from jarvis.tools import TOOLS
    return {tool.name for tool in TOOLS}


def _core_steps() -> dict:
    try:
        from jarvis.flows import steps as flow_steps
    except ImportError:
        return {}
    return {key: spec for key, spec in flow_steps.STEPS.items() if key in flow_steps.CORE_STEP_IDS}


def _step_meta(spec) -> dict:
    return spec.meta() if hasattr(spec, "meta") else copy.deepcopy(spec)


class Registry:
    """一次完整加载的结果（不可变用法：变了就整体重建一个新的）。"""

    def __init__(self, root: Path, generation: int):
        self.root = root
        self.packs_dir = PACKS_DIR
        self.generation = generation
        self.state = read_state(root)
        self.packs: list[Pack] = []
        self.by_id: dict[str, Pack] = {}
        self.entries: list[dict] = []
        self.entry_by_id: dict[str, dict] = {}
        self.pack_tools: list = []
        self.pack_steps: dict = {}
        self._load()

    # ---- 扫描 ----

    def _candidates(self) -> list[tuple[Path, bool]]:
        found: list[tuple[Path, bool]] = []
        if self.packs_dir.is_dir():
            order = _builtin_order()
            builtin = [p for p in self.packs_dir.iterdir()
                       if p.is_dir() and not p.name.startswith(("_", ".")) and (p / mf.MANIFEST_FILE).exists()]
            builtin.sort(key=lambda p: (order.get(p.name, len(order)), p.name))
            found += [(p, True) for p in builtin]
        if self.root.is_dir():
            installed = self.state["installed"]
            imported = [p for p in self.root.iterdir()
                        if p.is_dir() and not p.is_symlink() and not p.name.startswith(("_", "."))]
            imported.sort(key=lambda p: (str(installed.get(p.name, {}).get("installed_at", "~")), p.name))
            found += [(p, False) for p in imported]
        return found

    def _load(self) -> None:
        core_tools = _core_tool_names()
        core_steps = _core_steps()
        claimed_tools: dict[str, str] = {name: "贾维斯基础能力" for name in (*BASE_TOOLS, *OWNER_TOOLS)}
        claimed_steps: dict[str, str] = {}
        claimed_ids: set[str] = set()
        disabled = set(self.state["disabled"])
        for folder, builtin in self._candidates():
            installed = dict(self.state["installed"].get(folder.name, {}))
            try:
                manifests = mf.expand(mf.read(folder, builtin=builtin), folder)
            except (mf.ManifestError, OSError) as exc:
                pack = Pack(id=folder.name, folder=folder, builtin=builtin, installed=installed)
                self.packs.append(pack)
                pack.fail(f"清单不合法：{exc}" if isinstance(exc, mf.ManifestError) else "清单读不出来")
                continue
            for m in manifests:   # 多技能包拆成多个插件，共用一个目录
                pack = Pack(id=m["id"], folder=folder, builtin=builtin, installed=installed, manifest=m)
                self.packs.append(pack)
                self._claim(pack, core_tools, core_steps, claimed_tools, claimed_steps, claimed_ids, disabled)
        self._finish(core_steps)

    def _claim(self, pack: Pack, core_tools, core_steps, claimed_tools, claimed_steps, claimed_ids, disabled) -> None:
        m, folder, builtin = pack.manifest, pack.folder, pack.builtin
        if not builtin:
            if (m["extras"].get("package") or m["id"]) != folder.name:
                pack.fail("插件目录名和清单 id 不一致")
                return
            if pack.installed.get("source"):
                m["source"] = mf.normalize_source(pack.installed["source"])
        if m["id"] in claimed_ids:
            pack.fail(f"插件 id「{m['id']}」和已有插件重复，后加载的这个没有启用")
            pack.manifest = None
            return
        claimed_ids.add(m["id"])
        self.by_id[m["id"]] = pack
        # 名字冲突：工具名、积木 id（停用的插件也占着自己声明的名字，免得启用时翻转）
        declared_steps = [s for s in m["steps"] if not (s == m["id"] and m["kind"] == "step" and m["entry"] is None)]
        conflict = next((f"工具名「{t}」已被「{claimed_tools[t]}」占用" for t in m["tools"]
                         if t in claimed_tools), None)
        if conflict is None and m["entry"] is not None:
            conflict = next((f"工具名「{t}」和贾维斯的核心工具重名" for t in m["tools"] if t in core_tools), None)
        if conflict is None:
            conflict = next((f"积木 id「{s}」已被占用" for s in declared_steps
                             if s in claimed_steps or s in core_steps or s in claimed_ids), None)
        if conflict:
            pack.fail(f"名称冲突：{conflict}，后加载的这个没有启用")
            return
        for name in m["tools"]:
            claimed_tools[name] = m["name"]
        for step in declared_steps:
            claimed_steps[step] = m["name"]
        if m["id"] in disabled:
            pack.status, pack.reason = "disabled", "已停用"
            return
        self._activate(pack, core_tools, core_steps)
        if pack.status == "ok" and m.get("mcp_servers"):   # MCP 工具名是发现来的，加载后再查一次冲突
            clash = next((t.name for t in pack.tools if t.name in claimed_tools or t.name in core_tools), None)
            if clash:
                pack.fail(f"名称冲突：MCP 工具名「{clash}」已被占用，后加载的这个没有启用")
                return
            for tool in pack.tools:
                claimed_tools[tool.name] = m["name"]

    def _finish(self, core_steps: dict) -> None:
        # 合成积木条目的 id 不能撞上后面才出现的插件 id
        for pack in self.packs:
            if pack.status == "ok" and pack.manifest:
                for step_id in list(pack.steps):
                    if step_id != pack.id and step_id in self.by_id:
                        pack.fail(f"名称冲突：积木 id「{step_id}」和插件 id 重名")
                        break
        for pack in self.packs:
            if pack.status == "ok":
                self.pack_tools.extend(pack.tools)
                self.pack_steps.update(pack.steps)
        self._build_entries(core_steps)

    def _activate(self, pack: Pack, core_tools: set[str], core_steps: dict) -> None:
        m = pack.manifest
        missing = missing_packages(m["python_packages"])
        if missing:
            pack.fail(f"缺少 Python 包：{'、'.join(missing)}（管理员安装后重启服务即可）")
            return
        if m["kind"] == "skill":
            try:
                pack.skill = mf.read_skill(pack.folder, m["extras"].get("skill_file", ""))
            except mf.ManifestError as exc:
                pack.fail(str(exc))
            return
        if m["entry"] is None and m.get("mcp_servers"):   # 第十五轮：远程 MCP 服务提供的工具
            from jarvis.plugins import mcp
            mcp.activate(pack, self.state)
            return
        if m["entry"] is None:
            unknown = [t for t in m["tools"] if t not in core_tools]
            if unknown:
                pack.fail(f"找不到核心工具：{'、'.join(unknown)}")
                return
            unknown_steps = [s for s in m["steps"] if s not in core_steps]
            if unknown_steps:
                pack.fail(f"找不到核心积木：{'、'.join(unknown_steps)}")
            return
        if not (pack.folder / m["entry"]).is_file():
            pack.fail(f"入口文件 {m['entry']} 不存在")
            return
        if pack.builtin:
            self._activate_builtin_entry(pack)
        else:
            self._activate_sandboxed(pack)

    def _activate_builtin_entry(self, pack: Pack) -> None:
        m = pack.manifest
        try:
            module = _import_builtin(pack.folder, m["entry"])
        except Exception as exc:   # 任何导入错误都只影响这一个插件
            log.warning("plugin %s import failed: %s", pack.id, type(exc).__name__)
            pack.fail("插件代码加载失败", f"插件代码加载失败（{type(exc).__name__}: {str(exc)[:160]}）")
            return
        exported = {getattr(tool, "name", None): tool for tool in (getattr(module, "TOOLS", None) or [])}
        missing = [t for t in m["tools"] if t not in exported or not hasattr(exported[t], "invoke")]
        if missing:
            pack.fail(f"清单里的工具在代码里没找到：{'、'.join(missing)}")
            return
        steps = getattr(module, "STEPS", None) or {}
        missing_steps = [s for s in m["steps"] if s not in steps]
        if missing_steps:
            pack.fail(f"清单里的积木在代码里没找到：{'、'.join(missing_steps)}")
            return
        pack.tools = [guard_tool(exported[t], plugin_name=m["name"], timeout=m["timeout"]) for t in m["tools"]]
        pack.steps = {s: steps[s] for s in m["steps"]}

    def _activate_sandboxed(self, pack: Pack) -> None:
        m = pack.manifest
        schemas = pack.installed.get("tools")
        if not isinstance(schemas, list):
            try:
                schemas = sandbox.describe(pack.folder, m["entry"])
            except sandbox.SandboxError as exc:
                pack.fail(str(exc))
                return
        exported = {s.get("name"): s for s in schemas if isinstance(s, dict)}
        missing = [t for t in m["tools"] if t not in exported]
        if missing:
            pack.fail(f"清单里的工具在代码里没找到：{'、'.join(missing)}")
            return
        timeout = min(m["timeout"], SANDBOX_TIMEOUT)
        pack.tools = [sandbox_tool(exported[t], folder=pack.folder, entry=m["entry"], plugin_name=m["name"],
                                   timeout=timeout) for t in m["tools"]]

    # ---- 目录条目 ----

    def _entry(self, pack: Pack, core_steps: dict) -> dict:
        m = pack.manifest
        step = None
        if m["kind"] == "step" and m["id"] in m["steps"]:
            spec = core_steps.get(m["id"]) or pack.steps.get(m["id"])
            step = _step_meta(spec) if spec is not None else copy.deepcopy(_FALLBACK_STEPS.get(m["id"]))
        price = PRO_PRICE if m["tier"] == "pro" else 0
        is_mcp = bool(m.get("mcp_servers"))
        hosts = _mcp_hosts(m) if is_mcp else []
        entry = {
            "id": m["id"], "name": m["name"], "icon": m["icon"], "category": m["category"], "summary": m["summary"],
            "kind": m["kind"], "tools": [t.name for t in pack.tools] if is_mcp else list(m["tools"]), "step": step,
            "requires": list(m["requires"]),
            "tier": m["tier"], "price": price, "professions": list(m["professions"]), "examples": list(m["examples"]),
            "available": True,
            "version": m["version"], "author": m["author"], "homepage": m["homepage"],
            "source": copy.deepcopy(m["source"]), "builtin": pack.builtin,
            "status": pack.status if pack.status in ("ok", "needs_config") else "unavailable", "reason": pack.reason,
            # 第十五轮：MCP 插件带「MCP」徽标（mcp: true），权限写「联网：<主机名>」；详情页用的说明、许可证、隐私政策
            "mcp": is_mcp, "hosts": hosts,
            "permissions": [{"key": "network", "label": f"联网：{host}", "level": "warn"} for host in hosts],
            "license": m.get("license") or "", "description": (m.get("extras") or {}).get("long_description", ""),
            "privacy_url": (m.get("extras") or {}).get("privacy_url", ""),
        }
        return entry

    def _step_entry(self, pack: Pack, step_id: str, spec) -> dict:
        """带入口的插件提供的积木：流程编辑器按 kind=step 认积木，所以给它一条独立条目。"""
        base = self._entry(pack, {})
        role = getattr(spec, "role", "output")
        base.update({
            "id": step_id, "name": getattr(spec, "name", step_id)[:20],
            "icon": getattr(spec, "icon", "") or pack.manifest["icon"],
            "category": {"input": "documents", "process": "ai"}.get(role, "output"),
            "summary": (getattr(spec, "summary", "") or f"「{pack.manifest['name']}」提供的流程积木")[:60],
            "kind": "step", "tools": [], "step": _step_meta(spec), "examples": [], "professions": [],
            "requires": list(dict.fromkeys([*pack.manifest["requires"], *getattr(spec, "requires", ())])),
            "pack": pack.id,
        })
        return base

    def _build_entries(self, core_steps: dict) -> None:
        for pack in self.packs:
            if pack.manifest is None or pack.status == "disabled":
                continue
            entry = self._entry(pack, core_steps)
            self.entries.append(entry)
            for step_id, spec in pack.steps.items():
                if step_id != pack.id:
                    self.entries.append(self._step_entry(pack, step_id, spec))
        self.entry_by_id = {item["id"]: item for item in self.entries}

    # ---- 查询 ----

    def ok(self, plugin_id: str) -> bool:
        entry = self.entry_by_id.get(plugin_id)
        return bool(entry and entry["status"] == "ok")

    def tool_names(self, plugin_id: str) -> list[str]:
        entry = self.entry_by_id.get(plugin_id)
        return list(entry["tools"]) if entry and entry["status"] == "ok" else []

    def skills(self) -> list[Pack]:
        return [p for p in self.packs if p.status == "ok" and p.skill]

    def management(self) -> list[dict]:
        """Owner 的插件管理清单：含停用的、清单坏掉的，带详细原因。"""
        rows = []
        for pack in self.packs:
            m = pack.manifest or {}
            rows.append({
                "id": m.get("id") or pack.id, "name": m.get("name") or pack.id, "icon": m.get("icon") or "🧩",
                "summary": m.get("summary") or "", "kind": m.get("kind") or "", "version": m.get("version") or "",
                "author": m.get("author") or "", "homepage": m.get("homepage") or "",
                "source": copy.deepcopy(m.get("source") or ({"type": "builtin"} if pack.builtin else {"type": "zip"})),
                "builtin": pack.builtin, "enabled": pack.status != "disabled", "status": pack.status,
                "reason": pack.reason, "detail": pack.detail, "tools": list(m.get("tools") or []),
                "steps": list(m.get("steps") or []), "installed_at": pack.installed.get("installed_at", ""),
                "sandboxed": not pack.builtin and m.get("entry") is not None,
                "mcp": _mcp_management(pack),
            })
            if rows[-1]["mcp"]:
                rows[-1]["tools"] = [t["name"] for t in rows[-1]["mcp"]["tools"]]
        return rows


# ---------- 全局缓存 ----------

_LOCK = threading.RLock()
_REGISTRY: Registry | None = None
_GENERATION = 0


def registry() -> Registry:
    """当前数据目录的注册表；数据目录变了（测试里每条用例一个）就重建。"""
    global _REGISTRY
    root = data_root()
    current = _REGISTRY
    if current is not None and current.root == root and current.packs_dir == PACKS_DIR:
        return current
    with _LOCK:
        if _REGISTRY is None or _REGISTRY.root != root or _REGISTRY.packs_dir != PACKS_DIR:
            _rebuild(root)
        return _REGISTRY


def _rebuild(root: Path) -> Registry:
    global _REGISTRY, _GENERATION
    _GENERATION += 1
    fresh = Registry(root, _GENERATION)
    _REGISTRY = fresh
    _sync_flow_steps(fresh.pack_steps)
    return fresh


def reload() -> Registry:
    """导入 / 卸载 / 启停之后调用：整体重建，generation 加一。"""
    with _LOCK:
        return _rebuild(data_root())


def generation() -> int:
    return registry().generation


def _sync_flow_steps(pack_steps: dict) -> None:
    try:
        from jarvis.flows import steps as flow_steps
    except ImportError:
        return
    flow_steps.sync_pack_steps(pack_steps)


def set_enabled(plugin_id: str, enabled: bool) -> None:
    with _LOCK:
        root = data_root()
        state = read_state(root)
        disabled = set(state["disabled"])
        if enabled:
            disabled.discard(plugin_id)
        else:
            disabled.add(plugin_id)
        state["disabled"] = sorted(disabled)
        write_state(state, root)
        _rebuild(root)


def record_install(plugin_id: str, record: dict) -> None:
    with _LOCK:
        root = data_root()
        state = read_state(root)
        state["installed"][plugin_id] = record
        state["disabled"] = [x for x in state["disabled"] if x != plugin_id]
        write_state(state, root)


def forget_install(plugin_id: str) -> None:
    with _LOCK:
        root = data_root()
        state = read_state(root)
        state["installed"].pop(plugin_id, None)
        state["disabled"] = [x for x in state["disabled"] if x != plugin_id]
        write_state(state, root)


__all__ = ["Pack", "Registry", "data_root", "failure_text", "forget_install", "generation", "guard_tool",
           "missing_packages", "package_installed", "read_state", "record_install", "registry", "reload",
           "sandbox_tool", "set_enabled", "write_state"]
