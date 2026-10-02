"""从 GitHub / Gitee / zip 导入插件（仅 Owner）：下载 → 安全解包 → 找清单 → 校验 → 预览 → 确认安装。

- 地址：``https://github.com/<owner>/<repo>[/tree|blob|commit/<ref>[/<子目录>]]``，Gitee 同理；
  也认 ``owner/repo`` 简写（按 GitHub）。分支 / 标签一律先解析成 commit，**安装固定到这个 commit**；
- 服务器在大陆，访问 GitHub 常失败：失败时给出清楚的原因和「下载 zip 后上传」的退路；
- 解包：限下载大小、限条目数与解压总量、拒绝绝对路径 / ``..`` / 符号链接，只解出插件所在的子目录；
- 清单：自有 plugin.json、Agent Plugins 标准 plugin.json（Codex / ChatGPT 插件）、只有 SKILL.md 的社区技能都认；
- 预览给 Owner 做「信任确认」：作者、版本、来源 commit、权限、工具、缺失依赖、文件清单、主页与隐私政策；
- 确认（凭预览令牌，15 分钟有效、只认发起预览的人）后装进 ``$JARVIS_DATA_DIR/plugins/<id>/``。

另含「插件源」（marketplace）：一个仓库里的 ``.agents/plugins/marketplace.json`` 列出一组插件，
同步后在市场里成为一个分组，逐个预览安装（见 :func:`add_source` / :func:`source_preview`）。
"""
from __future__ import annotations

import base64
import binascii
import datetime as dt
import io
import json
import logging
import re
import secrets
import shutil
import stat
import threading
import time
import zipfile
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from urllib.parse import urlsplit

import httpx

from jarvis.plugins import loader, manifest as mf, sandbox

log = logging.getLogger(__name__)

MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024       # 仓库压缩包 / 上传的 zip
MAX_ARCHIVE_ENTRIES = 3000                  # 整个压缩包的条目数
MAX_ARCHIVE_BYTES = 60 * 1024 * 1024        # 整个压缩包解压后的总量（只做声明值检查）
MAX_PLUGIN_FILES = 200                      # 插件目录里的文件数
MAX_PLUGIN_BYTES = 10 * 1024 * 1024         # 插件目录解压后的总量
MAX_FILE_BYTES = 2 * 1024 * 1024            # 单个文件
PREVIEW_TTL = 15 * 60
HTTP_TIMEOUT = httpx.Timeout(20.0, connect=8.0)
MARKETPLACE_FILES = (".agents/plugins/marketplace.json", "marketplace.json", ".jarvis/marketplace.json")
_SKIP_PARTS = {"__MACOSX", ".git", "__pycache__", ".DS_Store"}
_ALLOWED_HOSTS = ("github.com", "api.github.com", "codeload.github.com", "objects.githubusercontent.com",
                  "raw.githubusercontent.com", "gitee.com", "foruda.gitee.com")
_SEGMENT = r"[A-Za-z0-9_.-]{1,100}"
_URL = re.compile(rf"^(?:https?://)?(?:www\.)?(?P<host>github\.com|gitee\.com)/(?P<owner>{_SEGMENT})/(?P<repo>{_SEGMENT}?)"
                  rf"(?:\.git)?(?:/(?:tree|blob|commit|src)/(?P<ref>[^/?#\s]{{1,100}})(?:/(?P<path>[^?#\s]*))?)?/?(?:[?#].*)?$")
_SHORT = re.compile(rf"^(?P<owner>{_SEGMENT})/(?P<repo>{_SEGMENT})(?:@(?P<ref>[^\s/]{{1,100}}))?$")
_SHA = re.compile(r"^[0-9a-f]{40}$")

GITHUB_HINT = ("服务器在国内，访问 GitHub 经常失败。可以在自己电脑上打开仓库页面 → Code → Download ZIP，"
               "再点「上传 zip」导入。")


class ImportFailure(Exception):
    """导入失败；message 给 Owner 看，code 给前端分支用，hint 是退路建议。"""

    def __init__(self, message: str, code: str = "INVALID", status: int = 422, hint: str = ""):
        super().__init__(message)
        self.message, self.code, self.status, self.hint = message, code, status, hint

    def body(self) -> dict:
        data = {"error": self.message, "code": self.code}
        if self.hint:
            data["hint"] = self.hint
        return data


# ---------- 地址解析 ----------

@dataclass
class RepoRef:
    host: str            # github / gitee
    owner: str
    repo: str
    ref: str = ""        # 用户给的分支 / 标签 / commit（空 = 默认分支）
    path: str = ""       # 仓库里的子目录

    @property
    def slug(self) -> str:
        return f"{self.owner}/{self.repo}"

    def web_url(self, ref: str = "") -> str:
        base = f"https://{self.host}.com/{self.slug}"
        ref = ref or self.ref
        if ref:
            return f"{base}/tree/{ref}" + (f"/{self.path}" if self.path else "")
        return base


def _clean_path(raw: str) -> str:
    parts = [p for p in str(raw or "").strip("/").split("/") if p and p != "."]
    if any(p == ".." or "\\" in p for p in parts):
        raise ImportFailure("子目录写法不对")
    return "/".join(parts)


def parse_repo_url(text: str) -> RepoRef:
    raw = str(text or "").strip()
    match = _URL.match(raw)
    if match:
        host = "github" if match.group("host").startswith("github") else "gitee"
        repo = match.group("repo")
        if not repo:
            raise ImportFailure("仓库地址不完整，要像 https://github.com/作者/仓库名")
        return RepoRef(host, match.group("owner"), repo, match.group("ref") or "", _clean_path(match.group("path") or ""))
    match = _SHORT.match(raw)
    if match:
        return RepoRef("github", match.group("owner"), match.group("repo"), match.group("ref") or "")
    raise ImportFailure("只支持 GitHub 或 Gitee 的仓库地址（例如 https://github.com/作者/仓库名），"
                        "其他来源请下载 zip 后上传", "BAD_URL")


# ---------- 下载 ----------

def _host_allowed(url: str) -> bool:
    parts = urlsplit(url)
    host = (parts.hostname or "").lower()
    return parts.scheme == "https" and any(host == h or host.endswith("." + h) for h in _ALLOWED_HOSTS)


def http_get(url: str, *, max_bytes: int = MAX_DOWNLOAD_BYTES, accept: str = "") -> bytes:
    """GET 一个白名单内的 https 地址；只跟随白名单内的跳转；超过 max_bytes 立即停止。测试里整体替换。"""
    headers = {"User-Agent": "JWS-Agent-plugin-importer"}
    if accept:
        headers["Accept"] = accept
    with httpx.Client(timeout=HTTP_TIMEOUT, follow_redirects=False, trust_env=False) as client:
        for _ in range(4):
            if not _host_allowed(url):
                raise ImportFailure("下载地址被重定向到了不认识的网站，已停止", "DOWNLOAD_FAILED", 502)
            with client.stream("GET", url, headers=headers) as response:
                if response.is_redirect:
                    url = str(response.url.join(response.headers.get("location", "")))
                    continue
                if response.status_code == 404:
                    raise ImportFailure("找不到这个仓库、分支或目录（私有仓库也会这样）", "NOT_FOUND", 404)
                if response.status_code in (401, 403, 429):
                    raise ImportFailure("仓库网站拒绝了下载（可能是访问次数超限或需要登录）", "DOWNLOAD_FAILED", 502,
                                        GITHUB_HINT)
                if response.status_code >= 400:
                    raise ImportFailure(f"仓库网站返回错误（{response.status_code}）", "DOWNLOAD_FAILED", 502, GITHUB_HINT)
                declared = response.headers.get("content-length")
                if declared and declared.isdigit() and int(declared) > max_bytes:
                    raise ImportFailure(f"仓库压缩包超过 {max_bytes // 1024 // 1024}MB，太大了", "TOO_LARGE", 413,
                                        "只把插件目录打成 zip 上传即可")
                chunks, size = [], 0
                for chunk in response.iter_bytes():
                    size += len(chunk)
                    if size > max_bytes:
                        raise ImportFailure(f"仓库压缩包超过 {max_bytes // 1024 // 1024}MB，太大了", "TOO_LARGE", 413,
                                            "只把插件目录打成 zip 上传即可")
                    chunks.append(chunk)
                return b"".join(chunks)
        raise ImportFailure("跳转次数太多，已停止", "DOWNLOAD_FAILED", 502)


def _fetch(url: str, **kwargs) -> bytes:
    try:
        return http_get(url, **kwargs)
    except ImportFailure:
        raise
    except httpx.TimeoutException:
        raise ImportFailure("连接仓库网站超时", "DOWNLOAD_FAILED", 502, GITHUB_HINT) from None
    except httpx.HTTPError:
        raise ImportFailure("连不上仓库网站", "DOWNLOAD_FAILED", 502, GITHUB_HINT) from None


def resolve_commit(ref: RepoRef) -> str:
    """分支 / 标签 / 默认分支 → 40 位 commit。"""
    if _SHA.match(ref.ref or ""):
        return ref.ref
    if ref.host == "github":
        target = ref.ref or "HEAD"
        body = _fetch(f"https://api.github.com/repos/{ref.slug}/commits/{target}", max_bytes=4096,
                      accept="application/vnd.github.sha").decode("utf-8", "replace").strip()
    else:
        target = ref.ref
        if not target:
            info = json.loads(_fetch(f"https://gitee.com/api/v5/repos/{ref.slug}", max_bytes=256 * 1024) or b"{}")
            target = info.get("default_branch") or "master"
        data = json.loads(_fetch(f"https://gitee.com/api/v5/repos/{ref.slug}/commits/{target}", max_bytes=512 * 1024) or b"{}")
        body = str(data.get("sha") or "")
    if not _SHA.match(body):
        raise ImportFailure("没能确定要安装的版本（commit）", "DOWNLOAD_FAILED", 502, GITHUB_HINT)
    return body


def download(ref: RepoRef) -> tuple[bytes, str]:
    """→ (zip 字节, commit)。"""
    sha = resolve_commit(ref)
    if ref.host == "github":
        url = f"https://codeload.github.com/{ref.slug}/zip/{sha}"
    else:
        url = f"https://gitee.com/{ref.slug}/repository/archive/{sha}.zip"
    return _fetch(url), sha


def decode_upload(data_base64: str) -> bytes:
    try:
        data = base64.b64decode(str(data_base64 or ""), validate=True)
    except (binascii.Error, ValueError):
        raise ImportFailure("上传的文件没读出来，请重新选择 zip", "BAD_ZIP") from None
    if len(data) > MAX_DOWNLOAD_BYTES:
        raise ImportFailure(f"zip 超过 {MAX_DOWNLOAD_BYTES // 1024 // 1024}MB，太大了", "TOO_LARGE", 413)
    if not data:
        raise ImportFailure("上传的文件是空的", "BAD_ZIP")
    return data


# ---------- 安全解包 ----------

class Archive:
    """校验过的 zip：条目名已规整（去掉公共顶层目录），拒绝穿越与符号链接。"""

    def __init__(self, data: bytes):
        try:
            self.zip = zipfile.ZipFile(io.BytesIO(data))
            infos = self.zip.infolist()
        except (zipfile.BadZipFile, OSError, ValueError):
            raise ImportFailure("这不是一个有效的 zip 文件", "BAD_ZIP") from None
        if len(infos) > MAX_ARCHIVE_ENTRIES:
            raise ImportFailure(f"压缩包里文件太多（超过 {MAX_ARCHIVE_ENTRIES} 个）", "TOO_LARGE", 413,
                                "只把插件目录打成 zip 上传即可")
        if sum(max(0, info.file_size) for info in infos) > MAX_ARCHIVE_BYTES:
            raise ImportFailure("压缩包解压后太大了", "TOO_LARGE", 413, "只把插件目录打成 zip 上传即可")
        files: dict[str, zipfile.ZipInfo] = {}
        for info in infos:
            name = info.filename.replace("\\", "/")
            if name.startswith("/") or re.match(r"^[A-Za-z]:", name):
                raise ImportFailure("压缩包里有绝对路径，已拒绝", "UNSAFE_ZIP")
            parts = [p for p in name.split("/") if p not in ("", ".")]
            if any(p == ".." for p in parts):
                raise ImportFailure("压缩包里有指向上级目录的路径，已拒绝", "UNSAFE_ZIP")
            mode = (info.external_attr >> 16) & 0o170000
            if mode == stat.S_IFLNK:
                raise ImportFailure("压缩包里有符号链接，已拒绝", "UNSAFE_ZIP")
            if info.is_dir() or not parts or any(p in _SKIP_PARTS for p in parts):
                continue
            files["/".join(parts)] = info
        tops = {name.split("/", 1)[0] for name in files}
        if len(tops) == 1 and all("/" in name for name in files):   # GitHub 压缩包的「仓库名-commit/」顶层目录
            top = next(iter(tops)) + "/"
            files = {name[len(top):]: info for name, info in files.items()}
        self.files = files

    def names(self) -> list[str]:
        return sorted(self.files)

    def read(self, name: str, limit: int = MAX_FILE_BYTES) -> bytes:
        info = self.files[name]
        if info.file_size > limit:
            raise ImportFailure(f"文件 {name} 太大了", "TOO_LARGE", 413)
        with self.zip.open(info) as handle:
            data = handle.read(limit + 1)
        if len(data) > limit:
            raise ImportFailure(f"文件 {name} 太大了", "TOO_LARGE", 413)
        return data

    def under(self, prefix: str) -> list[str]:
        prefix = prefix.strip("/")
        return [n for n in self.names() if not prefix or n.startswith(prefix + "/")]

    def extract(self, prefix: str, dest: Path) -> list[dict]:
        """把 prefix 子目录解到 dest（dest 必须不存在）；返回 [{path, size}]。"""
        names = self.under(prefix)
        if len(names) > MAX_PLUGIN_FILES:
            raise ImportFailure(f"插件目录里文件太多（超过 {MAX_PLUGIN_FILES} 个）", "TOO_LARGE", 413)
        cut = len(prefix.strip("/")) + 1 if prefix.strip("/") else 0
        dest.mkdir(parents=True)
        root = dest.resolve()
        listed, total = [], 0
        for name in names:
            rel = name[cut:]
            data = self.read(name)
            total += len(data)
            if total > MAX_PLUGIN_BYTES:
                raise ImportFailure(f"插件目录解压后超过 {MAX_PLUGIN_BYTES // 1024 // 1024}MB", "TOO_LARGE", 413)
            target = (dest / rel).resolve()
            if root not in target.parents:
                raise ImportFailure("压缩包里有越界路径，已拒绝", "UNSAFE_ZIP")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            listed.append({"path": rel, "size": len(data)})
        return listed


def _is_plugin_dir(names: set[str], prefix: str) -> bool:
    p = f"{prefix}/" if prefix else ""
    return any(f"{p}{m}" in names for m in (mf.MANIFEST_FILE, *mf.ALT_MANIFESTS, mf.SKILL_FILE))


def locate(archive: Archive, subpath: str = "") -> str:
    """在压缩包里找插件目录：指定了子目录就用它；否则根目录；再否则找唯一一个带清单的目录（≤3 层）。"""
    names = set(archive.names())
    subpath = _clean_path(subpath)
    if subpath:
        if not _is_plugin_dir(names, subpath):
            raise ImportFailure(f"子目录「{subpath}」里没有 plugin.json 或 SKILL.md", "NO_MANIFEST")
        return subpath
    if _is_plugin_dir(names, ""):
        return ""
    found = set()
    for name in names:
        path = PurePosixPath(name)
        if path.name in (mf.MANIFEST_FILE, mf.SKILL_FILE) and 1 <= len(path.parts) - 1 <= 3:
            folder = str(path.parent)
            if folder.endswith((".codex-plugin", ".claude-plugin")):
                folder = str(path.parent.parent)
            if not any(folder.startswith(f"{f}/") for f in found):
                found.add(folder)
    found = {f for f in found if not any(f.startswith(f"{g}/") for g in found if g != f)}
    if not found:
        raise ImportFailure("没在仓库里找到插件清单 plugin.json（或技能文件 SKILL.md）", "NO_MANIFEST",
                            hint="插件目录的根上要有 plugin.json；纯提示词技能放一个 SKILL.md 即可")
    if len(found) > 1:
        sample = "、".join(sorted(found)[:5])
        raise ImportFailure(f"仓库里有多个插件（{sample}），请在地址里指定子目录，"
                            "例如 …/tree/main/<子目录>", "MULTIPLE")
    return found.pop()


# ---------- 检查与预览 ----------

def _now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def _staging_root() -> Path:
    return loader.data_root() / ".staging"


def permissions(m: dict, tools: list[dict]) -> list[dict]:
    """给 Owner 看的权限清单：{key, label, level}（level: info / warn）。"""
    extras = m.get("extras") or {}
    caps = {str(c).lower() for c in extras.get("capabilities") or []}
    out = []
    if m["kind"] == "skill":
        out.append({"key": "prompt", "label": "往对话的系统提示词里加一段做事方法（按外部资料对待，不运行代码）",
                    "level": "info"})
    if m.get("entry"):
        out.append({"key": "subprocess", "label": "在独立子进程里运行插件自带的 Python 代码（不带任何密钥，每次限时）",
                    "level": "warn"})
        out.append({"key": "network", "label": "插件代码可以联网", "level": "warn"})
    if "read" in caps:
        out.append({"key": "read", "label": "读取：插件声明会读取你提供的内容", "level": "info"})
    if "write" in caps:
        out.append({"key": "write", "label": "写入：插件声明会生成或修改内容", "level": "warn"})
    if "files" in m.get("requires", []):
        out.append({"key": "files", "label": "使用你的文件空间", "level": "warn"})
    if m.get("mcp_servers"):
        from jarvis.plugins import mcp
        hosts = mcp.hosts(m)
        if hosts:
            out.append({"key": "mcp", "label": f"联网：{'、'.join(hosts)}（连接外部 MCP 服务，调用工具时会把参数发给它）",
                        "level": "warn"})
        config = m.get("config") or []
        if config:
            out.append({"key": "config", "label": "需要管理员配置：" + "、".join(item["label"] for item in config)
                        + ("（密钥加密保存，不会回显）" if any(item["secret"] for item in config) else ""), "level": "info"})
    elif extras.get("mcp"):
        out.append({"key": "mcp", "label": "包里带 MCP 服务配置，这次没有启用（只装提示词技能部分）", "level": "info"})
    if tools:
        out.append({"key": "tools", "label": f"给智能体增加 {len(tools)} 个工具", "level": "info"})
    return out


@dataclass
class Preview:
    token: str
    user_id: str
    staging: Path
    manifest: dict
    source: dict
    tools: list
    files: list
    created: float = field(default_factory=time.monotonic)
    upgrade_of: str = ""
    mcp_result: dict | None = None          # 第十五轮：预览时发现的 MCP 工具（确认安装 = 认可这份清单）
    mcp_error: str = ""
    config_values: dict = field(default_factory=dict, repr=False)   # 直接添加 MCP 服务时填的密钥（只在内存里）


_PREVIEWS: dict[str, Preview] = {}
_PREVIEW_LOCK = threading.Lock()


def _expire() -> None:
    now = time.monotonic()
    with _PREVIEW_LOCK:
        stale = [t for t, p in _PREVIEWS.items() if now - p.created > PREVIEW_TTL]
        for token in stale:
            shutil.rmtree(_PREVIEWS.pop(token).staging, ignore_errors=True)


def inspect_folder(folder: Path) -> tuple[dict, list[dict]]:
    """校验解出来的插件目录：→ (清单, 工具清单)。工具清单在子进程里读（主进程不导入第三方代码）。"""
    try:
        m = mf.read(folder, builtin=False)
    except mf.ManifestError as exc:
        raise ImportFailure(f"插件清单不合法：{exc}", "BAD_MANIFEST") from None
    tools: list[dict] = []
    if m["kind"] == "skill":
        try:
            mf.read_skill(folder)
        except mf.ManifestError as exc:
            raise ImportFailure(str(exc), "BAD_MANIFEST") from None
    elif m["entry"]:
        if not (folder / m["entry"]).is_file():
            raise ImportFailure(f"清单里的入口文件 {m['entry']} 不存在", "BAD_MANIFEST")
        if not loader.missing_packages(m["python_packages"]):
            try:
                described = sandbox.describe(folder, m["entry"])
            except sandbox.SandboxError as exc:
                raise ImportFailure(f"插件代码试运行失败：{exc}", "BAD_CODE") from None
            by_name = {item["name"]: item for item in described}
            missing = [t for t in m["tools"] if t not in by_name]
            if missing:
                raise ImportFailure(f"清单里的工具在代码里没找到：{'、'.join(missing)}", "BAD_MANIFEST")
            tools = [by_name[t] for t in m["tools"]]
    return m, tools


def _same_package(pack, upgrade_of: str) -> bool:
    return bool(upgrade_of) and not pack.builtin and pack.folder.name == upgrade_of


def _conflicts(m: dict, folder: Path | None = None, *, upgrade_of: str = "") -> None:
    current = loader.registry()
    ids = [item["id"] for item in (mf.expand(m, folder) if folder is not None else [m])]
    for plugin_id in dict.fromkeys([m["id"], *ids]):
        existing = next((p for p in current.packs if p.id == plugin_id or p.folder.name == plugin_id
                         and not p.builtin), None)
        if existing is not None and not _same_package(existing, upgrade_of):
            where = "内置插件" if existing.builtin else "已导入的插件"
            raise ImportFailure(f"已经有 id 为「{plugin_id}」的{where}「{existing.name}」，"
                                + ("内置插件不能被覆盖" if existing.builtin
                                   else "要换版本请在插件管理里「检查更新」，或先卸载旧的"), "DUPLICATE", 409)
    taken = {}
    for pack in current.packs:
        if pack.manifest and not _same_package(pack, upgrade_of):
            for name in pack.manifest["tools"]:
                taken[name] = pack.name
    from jarvis.plugins.loader import BASE_TOOLS, OWNER_TOOLS, _core_tool_names
    core = _core_tool_names() | set(BASE_TOOLS) | set(OWNER_TOOLS)
    for name in m["tools"]:
        if name in core:
            raise ImportFailure(f"工具名「{name}」和贾维斯的核心工具重名", "CONFLICT", 409)
        if name in taken:
            raise ImportFailure(f"工具名「{name}」已被「{taken[name]}」占用", "CONFLICT", 409)


def build_preview(data: bytes, source: dict, user_id: str, *, subpath: str = "", upgrade_of: str = "") -> dict:
    """zip 字节 → 预览（并把插件目录暂存起来等确认）。"""
    _expire()
    archive = Archive(data)
    prefix = locate(archive, subpath)
    token = secrets.token_urlsafe(18)
    staging = _staging_root() / token
    try:
        files = archive.extract(prefix, staging / "plugin")
        m, tools = inspect_folder(staging / "plugin")
        _conflicts(m, staging / "plugin", upgrade_of=upgrade_of)
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    source = dict(source)
    if prefix and not source.get("path"):
        source["path"] = prefix
    preview = Preview(token, user_id, staging, m, source, tools, files, upgrade_of=upgrade_of)
    if m.get("mcp_servers"):    # 包里有 mcp.json：不需要配置就先连一次，让管理员装之前看到工具清单
        from jarvis.plugins import mcp
        preview.mcp_result, preview.mcp_error = mcp.try_discover_for_preview(m)
    with _PREVIEW_LOCK:
        _PREVIEWS[token] = preview
    return preview_view(preview)


def _source_url(source: dict) -> str:
    if source.get("type") in ("github", "gitee") and source.get("repo"):
        host = "github.com" if source["type"] == "github" else "gitee.com"
        url = f"https://{host}/{source['repo']}"
        if source.get("ref"):
            url += f"/tree/{source['ref']}" + (f"/{source['path']}" if source.get("path") else "")
        return url
    return ""


def preview_view(preview: Preview) -> dict:
    m, extras = preview.manifest, preview.manifest.get("extras") or {}
    packages = [{"name": mf.package_name(spec), "spec": spec, "installed": loader.package_installed(spec)}
                for spec in m["python_packages"]]
    missing = [p["name"] for p in packages if not p["installed"]]
    warnings = []
    if m.get("entry"):
        warnings.append("第三方代码将在服务器上运行：只在独立子进程里执行、不带任何密钥、每次限时，"
                        "但它和贾维斯是同一个系统用户，请只安装你信任的来源")
    if not m.get("license") and preview.source.get("type") != "mcp":
        warnings.append("这个插件没有写许可证（license），使用前请确认作者允许")
    if missing:
        warnings.append(f"缺少 Python 包：{'、'.join(missing)}。可以先装上插件，管理员装好这些包并重启后才能用")
    tools = preview.tools or list((preview.mcp_result or {}).get("tools") or [])
    if m.get("mcp_servers"):
        warnings.extend(f"MCP 服务「{s['name']}」用不了：{s['problem']}" for s in m["mcp_servers"] if s.get("problem"))
        if preview.mcp_error:
            warnings.append(preview.mcp_error)
        if preview.mcp_result:
            warnings.append("MCP 服务返回的内容会当作外部资料交给智能体；以后服务方改动工具清单，插件会自动停用，等你确认")
    elif extras.get("mcp"):
        warnings.append("这个包还带了 MCP 服务配置；这次只按提示词技能安装，MCP 部分没有启用"
                        "（要用这个服务，可在插件管理里「直接添加 MCP 服务」）")
    skill = None
    if m["kind"] == "skill":
        parsed = mf.read_skill(preview.staging / "plugin")
        skill = {"title": parsed["title"], "chars": len(parsed["body"]), "truncated": parsed["truncated"],
                 "files": parsed.get("files", []), "excerpt": parsed["body"][:200]}
        if parsed["truncated"]:
            warnings.append("技能正文超过 2000 字，只会用前 2000 字")
    current_version = ""
    if preview.upgrade_of:
        pack = next((p for p in loader.registry().packs if not p.builtin and p.folder.name == preview.upgrade_of), None)
        current_version = (pack.manifest or {}).get("version", "") if pack else ""
    parts = mf.expand(m, preview.staging / "plugin")
    if len(parts) > 1:
        skill = dict(skill or {}, split=[{"id": p["id"], "name": p["name"], "summary": p["summary"]} for p in parts])
        warnings.append(f"这个包里有 {len(parts)} 个技能，会装成 {len(parts)} 个独立的技能插件")
    source = dict(preview.source)
    source.setdefault("url", _source_url(source))
    return {
        "token": preview.token, "expires_in": PREVIEW_TTL,
        "plugin": {key: m[key] for key in ("id", "name", "version", "icon", "category", "summary", "kind", "author",
                                           "homepage", "examples", "requires", "license")},
        "links": {"homepage": m["homepage"], "privacy": extras.get("privacy_url", ""),
                  "terms": extras.get("terms_url", ""), "repository": extras.get("repository", "")},
        "format": extras.get("format", "jarvis"),
        "tools": [{"name": t["name"], "description": t["description"][:200]} for t in tools],
        "permissions": permissions(m, tools),
        "python_packages": packages, "missing_packages": missing,
        "mcp": extras.get("mcp", []), "skill": skill,
        "config": [{k: item[k] for k in ("key", "label", "secret", "required", "help")} for item in m.get("config") or []],
        "mcp_error": preview.mcp_error, "mcp_connected": bool(preview.mcp_result),
        "files": preview.files[:MAX_PLUGIN_FILES], "file_count": len(preview.files),
        "total_size": sum(f["size"] for f in preview.files),
        "source": source, "warnings": warnings,
        "upgrade": {"from_version": current_version, "to_version": m["version"]} if preview.upgrade_of else None,
    }


def preview_from_url(url: str, user_id: str) -> dict:
    ref = parse_repo_url(url)
    data, sha = download(ref)
    source = {"type": ref.host, "repo": ref.slug, "ref": sha, "track": ref.ref, "path": ref.path}
    return build_preview(data, source, user_id, subpath=ref.path)


def preview_from_zip(data_base64: str, name: str, user_id: str, *, subpath: str = "") -> dict:
    data = decode_upload(data_base64)
    source = {"type": "zip", "name": str(name or "plugin.zip")[:100]}
    return build_preview(data, source, user_id, subpath=subpath)


def take_preview(token: str, user_id: str) -> Preview:
    _expire()
    with _PREVIEW_LOCK:
        preview = _PREVIEWS.get(str(token or ""))
        if preview is None or preview.user_id != user_id:
            raise ImportFailure("预览已过期，请重新预览一次", "EXPIRED", 404)
        _PREVIEWS.pop(preview.token, None)
    return preview


def confirm(token: str, user_id: str) -> dict:
    """确认安装：暂存目录 → plugins/<id>/，记录来源 commit 与工具清单，重建注册表。"""
    preview = take_preview(token, user_id)
    m = preview.manifest
    root = loader.data_root()
    target = root / m["id"]
    try:
        _conflicts(m, preview.staging / "plugin", upgrade_of=preview.upgrade_of)   # 预览之后可能又装了别的
        root.mkdir(parents=True, exist_ok=True)
        backup = None
        if preview.upgrade_of:
            if target.exists():
                backup = root / f".old-{m['id']}-{secrets.token_hex(4)}"
                target.rename(backup)
        elif target.exists():
            raise ImportFailure(f"插件目录 {m['id']} 已存在", "DUPLICATE", 409)
        try:
            shutil.move(str(preview.staging / "plugin"), str(target))
        except OSError:
            if backup is not None:   # 升级失败：旧版原样放回去
                shutil.rmtree(target, ignore_errors=True)
                backup.rename(target)
            raise ImportFailure("安装时写文件失败，没有改动现有插件", "INSTALL_FAILED", 500) from None
        if backup is not None:
            shutil.rmtree(backup, ignore_errors=True)
        source = {k: v for k, v in preview.source.items() if v}
        loader.record_install(m["id"], {
            "installed_at": _now(), "installed_by": user_id, "version": m["version"], "source": source,
            "tools": preview.tools if m["entry"] else None,
        })
        if m.get("mcp_servers"):
            from jarvis.plugins import mcp
            mcp.after_install(m["id"], preview, upgraded=bool(preview.upgrade_of))
    finally:
        shutil.rmtree(preview.staging, ignore_errors=True)
    current = loader.reload()
    packs = [p for p in current.packs if not p.builtin and p.folder.name == m["id"]]
    pack = packs[0] if packs else None
    return {"id": m["id"], "name": m["name"], "version": m["version"],
            "status": pack.status if pack else "unavailable", "reason": pack.reason if pack else "",
            "plugins": [{"id": p.id, "name": p.name, "status": p.status, "reason": p.reason} for p in packs],
            "upgraded": bool(preview.upgrade_of)}


def uninstall(plugin_id: str) -> dict:
    current = loader.registry()
    pack = current.by_id.get(plugin_id) or next((p for p in current.packs if p.id == plugin_id), None)
    if pack is None:
        raise ImportFailure("没有这个插件", "NOT_FOUND", 404)
    if pack.builtin:
        raise ImportFailure("内置插件不能卸载，只能停用", "BUILTIN", 400)
    folder = loader.data_root() / pack.folder.name
    if folder.is_symlink() or not folder.is_dir() or folder.resolve().parent != loader.data_root().resolve():
        raise ImportFailure("插件目录不对，没有卸载", "NOT_FOUND", 404)
    removed = [p.id for p in current.packs if not p.builtin and p.folder.name == folder.name]
    shutil.rmtree(folder)
    loader.forget_install(folder.name)
    from jarvis.plugins import mcp
    mcp.forget(dict.fromkeys([*removed, folder.name]))     # MCP 插件的配置（含密钥）、工具存档与会话一并清掉
    loader.reload()
    return {"id": pack.id, "name": pack.name, "removed": removed}


def check_update(plugin_id: str, user_id: str) -> dict:
    """重新解析来源分支的最新 commit；有新 commit 就生成一个「升级预览」（确认后替换）。"""
    current = loader.registry()
    pack = current.by_id.get(plugin_id) or next((p for p in current.packs if not p.builtin
                                                 and p.folder.name == plugin_id), None)
    if pack is None or pack.builtin:
        raise ImportFailure("只有从 GitHub / Gitee 导入的插件能检查更新", "NOT_FOUND", 404)
    source = pack.installed.get("source") or {}
    if source.get("type") not in ("github", "gitee") or not source.get("repo"):
        raise ImportFailure("这个插件是上传 zip 装的，没有可检查的来源；有新版就重新上传", "NO_SOURCE", 400)
    owner, repo = source["repo"].split("/", 1)
    ref = RepoRef(source["type"], owner, repo, source.get("track") or "", source.get("path") or "")
    sha = resolve_commit(ref)
    package = pack.folder.name
    current_version = (pack.manifest or {}).get("version", "")
    if sha == source.get("ref"):
        return {"id": plugin_id, "has_update": False, "current_version": current_version,
                "current_ref": source.get("ref", ""), "latest_ref": sha}
    pinned = RepoRef(ref.host, ref.owner, ref.repo, sha, ref.path)
    data, _ = download(pinned)
    new_source = {"type": ref.host, "repo": ref.slug, "ref": sha, "track": ref.ref, "path": ref.path}
    for key in ("marketplace",):
        if source.get(key):
            new_source[key] = source[key]
    preview = build_preview(data, new_source, user_id, subpath=ref.path, upgrade_of=package)
    if preview["plugin"]["id"] != package:
        take_preview(preview["token"], user_id)
        raise ImportFailure("新版本的插件 id 变了，不能直接升级；请卸载后重新导入", "ID_CHANGED", 409)
    return {"id": plugin_id, "has_update": True, "current_version": current_version,
            "latest_version": preview["plugin"]["version"], "current_ref": source.get("ref", ""), "latest_ref": sha,
            "preview": preview}


# ---------- 插件源（marketplace.json） ----------

SOURCES_DIR = "_sources"
_SOURCE_ID = re.compile(r"^[a-z][a-z0-9_]{1,30}$")
MAX_SOURCE_PLUGINS = 100


def _sources_dir() -> Path:
    return loader.data_root() / SOURCES_DIR


def _clean_policy(raw) -> dict:
    raw = raw if isinstance(raw, dict) else {}
    installation = str(raw.get("installation") or "AVAILABLE").upper()
    if installation not in ("AVAILABLE", "INSTALLED_BY_DEFAULT", "NOT_AVAILABLE"):
        installation = "AVAILABLE"
    authentication = str(raw.get("authentication") or "").upper()
    return {"installation": installation, "authentication": authentication if authentication in ("ON_INSTALL", "ON_USE") else ""}


def parse_marketplace(raw: dict) -> dict:
    """Codex 的 .agents/plugins/marketplace.json（也认我们自己的同结构文件）→ 规整后的插件源。"""
    if not isinstance(raw, dict) or not isinstance(raw.get("plugins"), list):
        raise ImportFailure("marketplace.json 里要有 plugins 列表", "BAD_MARKETPLACE")
    ui = raw.get("interface") if isinstance(raw.get("interface"), dict) else {}
    name = str(raw.get("name") or "plugins")
    plugins, skipped = [], []
    for item in raw["plugins"][:MAX_SOURCE_PLUGINS]:
        if not isinstance(item, dict) or not isinstance(item.get("name"), str):
            continue
        policy = _clean_policy(item.get("policy"))
        if policy["installation"] == "NOT_AVAILABLE":
            continue
        spec = item.get("source")
        if isinstance(spec, str):
            spec = {"source": "local", "path": spec}
        if not isinstance(spec, dict):
            continue
        kind = str(spec.get("source") or "local")
        if kind == "npm":
            skipped.append({"name": item["name"][:60], "reason": "npm 包需要 Node 环境，贾维斯的服务器上没有，不支持"})
            continue
        entry = {"name": item["name"][:60], "id": mf.slug_id(item["name"], "plugin"),
                 "display_name": str((item.get("interface") or {}).get("displayName") or item.get("displayName")
                                     or item["name"])[:30],
                 "description": str(item.get("description") or "")[:120],
                 "category": str(item.get("category") or "")[:30], "policy": policy}
        if kind == "local":
            try:
                entry["source"] = {"source": "local", "path": _clean_path(spec.get("path") or "")}
            except ImportFailure:
                continue
        elif kind in ("git-subdir", "github", "git", "url"):
            url = str(spec.get("url") or spec.get("repo") or "")
            try:
                repo = parse_repo_url(url)
                entry["source"] = {"source": "git-subdir", "url": url[:300],
                                   "path": _clean_path(spec.get("path") or repo.path), "ref": str(spec.get("ref") or repo.ref)[:100]}
            except ImportFailure:
                continue
        else:
            skipped.append({"name": item["name"][:60], "reason": f"不支持的来源类型「{kind[:20]}」"})
            continue
        if policy["installation"] == "INSTALLED_BY_DEFAULT":   # 不自动安装：一律由 Owner 逐个确认
            entry["note"] = "插件源建议默认安装；贾维斯不自动安装，需要你确认"
        plugins.append(entry)
    return {"name": name[:60], "display_name": str(ui.get("displayName") or raw.get("displayName") or name)[:30],
            "plugins": plugins, "skipped": skipped}


def _find_marketplace(archive: Archive, subpath: str = "") -> tuple[str, dict]:
    names = set(archive.names())
    prefix = f"{_clean_path(subpath)}/" if subpath else ""
    for rel in MARKETPLACE_FILES:
        if prefix + rel in names:
            try:
                raw = json.loads(archive.read(prefix + rel, 512 * 1024).decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                raise ImportFailure(f"{rel} 不是合法的 JSON", "BAD_MARKETPLACE") from None
            return prefix, parse_marketplace(raw)
    raise ImportFailure("仓库里没有找到插件源清单 .agents/plugins/marketplace.json", "NO_MARKETPLACE",
                        hint="单个插件请用「导入插件」，插件源要在仓库里放 .agents/plugins/marketplace.json")


def _source_id(name: str) -> str:
    base = mf.slug_id(name, "source")
    taken = set(list_sources_raw())
    candidate, n = base, 2
    while candidate in taken:
        candidate = f"{base[:27]}_{n}"
        n += 1
    return candidate


def list_sources_raw() -> dict:
    return dict(loader.read_state().get("sources") or {})


def _save_source(source_id: str, record: dict | None) -> None:
    with loader._LOCK:
        root = loader.data_root()
        state = loader.read_state(root)
        sources = dict(state.get("sources") or {})
        if record is None:
            sources.pop(source_id, None)
        else:
            sources[source_id] = record
        state["sources"] = sources
        loader.write_state(state, root)


def _sync_archive(data: bytes, origin: dict, source_id: str) -> dict:
    archive = Archive(data)
    base, market = _find_marketplace(archive, origin.get("path", ""))
    folder = _sources_dir()
    folder.mkdir(parents=True, exist_ok=True)
    (folder / f"{source_id}.zip").write_bytes(data)
    record = {"id": source_id, "name": market["name"], "display_name": market["display_name"],
              "origin": origin, "base": base, "synced_at": _now(), "plugins": market["plugins"],
              "skipped": market.get("skipped", [])}
    _save_source(source_id, record)
    return record


def add_source(user_id: str, *, url: str = "", zip_base64: str = "", zip_name: str = "") -> dict:
    if url:
        ref = parse_repo_url(url)
        data, sha = download(ref)
        origin = {"type": ref.host, "repo": ref.slug, "ref": sha, "track": ref.ref, "path": ref.path}
    elif zip_base64:
        data = decode_upload(zip_base64)
        origin = {"type": "zip", "name": str(zip_name or "marketplace.zip")[:100]}
    else:
        raise ImportFailure("填一个仓库地址，或上传含 marketplace.json 的 zip", "BAD_REQUEST")
    archive = Archive(data)
    _, market = _find_marketplace(archive, origin.get("path", ""))
    existing = next((sid for sid, rec in list_sources_raw().items()
                     if rec.get("origin", {}).get("repo") and rec["origin"].get("repo") == origin.get("repo")), None)
    source_id = existing or _source_id(market["name"])
    return source_view(_sync_archive(data, origin, source_id))


def sync_source(source_id: str) -> dict:
    record = list_sources_raw().get(source_id)
    if record is None:
        raise ImportFailure("没有这个插件源", "NOT_FOUND", 404)
    origin = dict(record.get("origin") or {})
    if origin.get("type") not in ("github", "gitee"):
        raise ImportFailure("这个插件源是上传 zip 加的，要更新请重新上传", "NO_SOURCE", 400)
    owner, repo = origin["repo"].split("/", 1)
    ref = RepoRef(origin["type"], owner, repo, origin.get("track") or "", origin.get("path") or "")
    data, sha = download(ref)
    origin["ref"] = sha
    return source_view(_sync_archive(data, origin, source_id))


def remove_source(source_id: str) -> dict:
    record = list_sources_raw().get(source_id)
    if record is None:
        raise ImportFailure("没有这个插件源", "NOT_FOUND", 404)
    _save_source(source_id, None)
    (_sources_dir() / f"{source_id}.zip").unlink(missing_ok=True)
    return {"id": source_id}


def source_view(record: dict) -> dict:
    current = loader.registry()
    installed = {pack.folder.name: pack for pack in current.packs if not pack.builtin}
    installed.update({pid: pack for pid, pack in current.by_id.items() if pack.builtin})
    plugins = []
    for item in record.get("plugins") or []:
        pack = installed.get(item["id"])
        mine = bool(pack and (pack.installed.get("source") or {}).get("marketplace") == record["id"])
        plugins.append({**item, "installed": mine, "id_taken": bool(pack) and not mine,
                        "installed_version": (pack.manifest or {}).get("version", "") if mine else ""})
    origin = record.get("origin") or {}
    return {"id": record["id"], "name": record.get("name", ""), "display_name": record.get("display_name", ""),
            "origin": {**origin, "url": _source_url({**origin, "type": origin.get("type")})},
            "synced_at": record.get("synced_at", ""), "plugins": plugins, "skipped": record.get("skipped", [])}


def list_sources() -> list[dict]:
    return [source_view(rec) for _, rec in sorted(list_sources_raw().items())]


def source_preview(source_id: str, plugin_name: str, user_id: str) -> dict:
    record = list_sources_raw().get(source_id)
    if record is None:
        raise ImportFailure("没有这个插件源", "NOT_FOUND", 404)
    item = next((p for p in record.get("plugins") or [] if p["name"] == plugin_name or p["id"] == plugin_name), None)
    if item is None:
        raise ImportFailure("插件源里没有这个插件", "NOT_FOUND", 404)
    spec = item["source"]
    origin = record.get("origin") or {}
    if spec["source"] == "local":
        data = (_sources_dir() / f"{source_id}.zip").read_bytes()
        path = "/".join(p for p in (record.get("base", "").strip("/"), spec["path"]) if p)
        source = {k: v for k, v in {"type": origin.get("type") or "zip", "repo": origin.get("repo"),
                                    "ref": origin.get("ref"), "track": origin.get("track"), "path": path,
                                    "name": origin.get("name"), "marketplace": source_id}.items() if v}
        return build_preview(data, source, user_id, subpath=path)
    ref = parse_repo_url(spec["url"])
    ref = RepoRef(ref.host, ref.owner, ref.repo, spec.get("ref") or ref.ref, spec.get("path") or ref.path)
    data, sha = download(ref)
    source = {"type": ref.host, "repo": ref.slug, "ref": sha, "track": ref.ref, "path": ref.path,
              "marketplace": source_id}
    return build_preview(data, source, user_id, subpath=ref.path)
