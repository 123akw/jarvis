"""文件空间：每个账号一块私有存储，给办公插件（PDF / Excel / Word）读写真正的文件。

契约见 docs/proposals/2026-10-round14-plugins.md 第 2 节::

    meta = files.save(owner_id, "合并后.pdf", data, mime=None, source="tool")
    files.get(owner_id, file_id)    # 不存在 / 不属于该账号 / 已过期 → KeyError
    files.read(owner_id, file_id)   # bytes
    files.path(owner_id, file_id)   # pathlib.Path（只读用）
    files.list(owner_id, limit=50)  # 新的在前
    files.delete(owner_id, file_id)

存放在 ``data_dir()/files/<owner_id>/``：``<id>.bin`` 是内容，``<id>.json`` 是元数据（同目录），
不进数据库。账号目录由已登录的 owner_id 决定、file_id 只认 ``secrets.token_urlsafe`` 的字符集，
请求里的任何字符串都拼不出别人的目录（路径穿越无效）。单个文件 ≤20MB、每个账号 ≤200MB、
保留 30 天，过期文件在下次访问该账号的文件空间时顺手清掉（惰性清理）。

注意：本模块不用 ``from __future__ import annotations``——register() 里的 FastAPI 路由靠运行时注解
识别 Request / 请求体，字符串注解在闭包里解析不到。
"""
import datetime as dt
import json
import mimetypes
import os
import re
import secrets
import threading
import unicodedata
from pathlib import Path, PurePosixPath, PureWindowsPath
from urllib.parse import quote

from jarvis import config

MAX_FILE_BYTES = 20 * 1024 * 1024        # 单个文件上限
QUOTA_BYTES = 200 * 1024 * 1024          # 每个账号总量上限
RETENTION_DAYS = 30                      # 保留天数
MAX_NAME_CHARS = 80                      # 文件名（不含扩展名）最长字符数
URL_PREFIX = "/api/files/"
# 对话 📎 上传时另存进文件空间的类型（办公插件能直接处理的原文件）
ATTACHABLE_EXTENSIONS = (".pdf", ".docx", ".xlsx", ".xlsm", ".csv")

_FILE_ID = re.compile(r"^[A-Za-z0-9_-]{8,64}$")
_OWNER_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
_MARKER = re.compile(r"file_id\s*[=＝:：]\s*([A-Za-z0-9_-]{8,64})")
_STALE_TMP_SECONDS = 3600

_MIME = {
    ".pdf": "application/pdf",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xlsm": "application/vnd.ms-excel.sheet.macroEnabled.12",
    ".xls": "application/vnd.ms-excel",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".doc": "application/msword",
    ".csv": "text/csv",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".json": "application/json",
    ".zip": "application/zip",
}
# 下载时一律按附件给；这些类型即使被浏览器内联打开也可能执行脚本，强制成二进制流
_UNSAFE_INLINE = {"text/html", "application/xhtml+xml", "image/svg+xml", "text/xml", "application/xml",
                  "application/javascript", "text/javascript"}

_LOCKS: dict[str, threading.Lock] = {}
_LOCKS_GUARD = threading.Lock()


class FileSpaceError(ValueError):
    """存不进去（太大 / 空间满 / 内容不对）；消息可直接给用户看。"""


# ---------- 内部 ----------

def _lock(owner_id: str) -> threading.Lock:
    with _LOCKS_GUARD:
        return _LOCKS.setdefault(owner_id, threading.Lock())


def _root() -> Path:
    return config.data_dir() / "files"


def _owner_dir(owner_id: str, create: bool = False) -> Path:
    if not isinstance(owner_id, str) or not _OWNER_ID.match(owner_id):
        raise ValueError("invalid owner id")
    folder = _root() / owner_id
    if create:
        folder.mkdir(parents=True, exist_ok=True)
    return folder


def _valid_id(file_id) -> bool:
    return isinstance(file_id, str) and bool(_FILE_ID.match(file_id))


def _now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def _iso(moment: dt.datetime) -> str:
    return moment.isoformat(timespec="seconds")


def _expired(meta: dict, now: dt.datetime | None = None) -> bool:
    try:
        expires = dt.datetime.fromisoformat(meta["expires_at"])
    except (KeyError, TypeError, ValueError):
        return False
    return (now or _now()) >= expires


def _public(meta: dict) -> dict:
    keys = ("id", "name", "size", "mime", "created_at", "expires_at", "source", "url")
    return {key: meta.get(key) for key in keys}


def _write_atomic(target: Path, data: bytes) -> None:
    tmp = target.with_name(f"{target.name}.{secrets.token_hex(4)}.tmp")
    try:
        with open(tmp, "wb") as handle:
            handle.write(data)
        os.replace(tmp, target)
    finally:
        if tmp.exists():
            tmp.unlink(missing_ok=True)


def _remove(folder: Path, file_id: str) -> None:
    (folder / f"{file_id}.json").unlink(missing_ok=True)
    (folder / f"{file_id}.bin").unlink(missing_ok=True)


def _load_meta(folder: Path, file_id: str) -> dict | None:
    meta_path, blob = folder / f"{file_id}.json", folder / f"{file_id}.bin"
    try:
        meta = json.loads(meta_path.read_text("utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(meta, dict) or meta.get("id") != file_id or not blob.is_file():
        return None
    return meta


def _sweep(folder: Path) -> list[dict]:
    """读出该账号全部有效文件（顺手删过期文件、孤儿内容与残留临时文件），新的在前。"""
    if not folder.is_dir():
        return []
    now = _now()
    alive: list[dict] = []
    seen: set[str] = set()
    for entry in folder.iterdir():
        name = entry.name
        if name.endswith(".tmp"):
            try:
                if now.timestamp() - entry.stat().st_mtime > _STALE_TMP_SECONDS:
                    entry.unlink(missing_ok=True)
            except OSError:
                pass
            continue
        if not name.endswith(".json"):
            continue
        file_id = name[:-5]
        if not _valid_id(file_id):
            continue
        meta = _load_meta(folder, file_id)
        if meta is None or _expired(meta, now):
            _remove(folder, file_id)
            continue
        seen.add(file_id)
        alive.append(meta)
    for entry in folder.glob("*.bin"):   # 元数据丢了的内容：没人能再拿到，删掉腾空间
        if entry.stem not in seen:
            try:
                if now.timestamp() - entry.stat().st_mtime > _STALE_TMP_SECONDS:
                    entry.unlink(missing_ok=True)
            except OSError:
                pass
    alive.sort(key=lambda m: (m.get("created_at") or "", m.get("seq") or 0), reverse=True)
    return alive


# ---------- 文件名 / 类型 / 下载头 ----------

def clean_name(name: str, default: str = "文件") -> str:
    """去掉目录部分、控制字符与 Windows 不允许的字符；过长截断但保留扩展名。"""
    raw = unicodedata.normalize("NFC", str(name or ""))
    raw = PureWindowsPath(PurePosixPath(raw.replace("\\", "/")).name).name
    raw = "".join(ch for ch in raw if unicodedata.category(ch)[0] != "C")
    raw = re.sub(r'[<>:"/\\|?*]', "_", raw).strip().strip(".").strip()
    if not raw:
        return default
    stem, dot, ext = raw.rpartition(".")
    if not dot or not stem or len(ext) > 10:
        stem, ext = raw, ""
    stem = stem[:MAX_NAME_CHARS].strip() or default
    return f"{stem}.{ext}" if ext else stem


def with_extension(name: str, ext: str, default: str) -> str:
    """规范成 ``xxx.<ext>``：没写扩展名或扩展名不对就补上。"""
    name = clean_name(name or default, default)
    ext = ext.lower().lstrip(".")
    if not name.lower().endswith(f".{ext}"):
        name = f"{name}.{ext}"
    return name


def guess_mime(name: str) -> str:
    ext = os.path.splitext(str(name).lower())[1]
    return _MIME.get(ext) or mimetypes.guess_type(f"x{ext}")[0] or "application/octet-stream"


def content_disposition(name: str, disposition: str = "attachment") -> str:
    """RFC 6266 / 5987：ASCII 兜底名 + ``filename*=UTF-8''<百分号编码>`` 中文名。"""
    name = clean_name(name)
    ext = os.path.splitext(name)[1]
    ascii_name = "".join(ch for ch in name if 32 <= ord(ch) < 127 and ch not in '"\\;%')
    if not ascii_name.strip(" ._") or ascii_name.strip() == ext:
        ascii_name = f"download{ext if ext.isascii() else ''}"
    return f"{disposition}; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(name, safe='')}"


def download_media_type(meta: dict) -> str:
    mime = str(meta.get("mime") or "application/octet-stream").split(";")[0].strip().lower()
    return "application/octet-stream" if mime in _UNSAFE_INLINE else mime


def url_for(file_id: str) -> str:
    return f"{URL_PREFIX}{file_id}"


def link(meta: dict, label: str | None = None) -> str:
    """对话里用的 Markdown 下载链接：``[下载 合并后.pdf](/api/files/XXXX)``。"""
    text = (label or f"下载 {meta['name']}").replace("[", "【").replace("]", "】")
    return f"[{text}]({url_for(meta['id'])})"


def attachment_marker(meta: dict) -> str:
    """用户消息里的附件标记：``［附件：合同.pdf · file_id=XXXX］``。"""
    return f"［附件：{meta['name']} · file_id={meta['id']}］"


# ---------- 契约接口 ----------

def save(owner_id: str, name: str, data: bytes, mime: str | None = None, source: str = "tool") -> dict:
    """存一个文件，返回元数据 {id, name, size, mime, created_at, expires_at, source, url}。"""
    if not isinstance(data, (bytes, bytearray, memoryview)):
        raise FileSpaceError("文件内容不对")
    data = bytes(data)
    if len(data) > MAX_FILE_BYTES:
        raise FileSpaceError(f"文件超过 {MAX_FILE_BYTES // (1024 * 1024)}MB 上限")
    name = clean_name(name)
    folder = _owner_dir(owner_id, create=True)
    with _lock(owner_id):
        used = sum(int(m.get("size") or 0) for m in _sweep(folder))
        if used + len(data) > QUOTA_BYTES:
            raise FileSpaceError(
                f"文件空间已满（每个账号 {QUOTA_BYTES // (1024 * 1024)}MB），请先删掉一些不用的文件再试")
        file_id = secrets.token_urlsafe(12)
        while (folder / f"{file_id}.json").exists() or (folder / f"{file_id}.bin").exists():
            file_id = secrets.token_urlsafe(12)
        created = _now()
        meta = {
            "id": file_id, "name": name, "size": len(data),
            "mime": (mime or guess_mime(name))[:100],
            "created_at": _iso(created),
            "expires_at": _iso(created + dt.timedelta(days=RETENTION_DAYS)),
            "source": str(source or "tool")[:20],
            "seq": int(created.timestamp() * 1_000_000),
            "url": url_for(file_id),
        }
        _write_atomic(folder / f"{file_id}.bin", data)
        try:
            _write_atomic(folder / f"{file_id}.json", json.dumps(meta, ensure_ascii=False).encode("utf-8"))
        except BaseException:
            (folder / f"{file_id}.bin").unlink(missing_ok=True)
            raise
    return _public(meta)


def get(owner_id: str, file_id: str) -> dict:
    """元数据；不存在、不属于该账号或已过期都抛 KeyError。"""
    if not _valid_id(file_id):
        raise KeyError(file_id)
    folder = _owner_dir(owner_id)
    meta = _load_meta(folder, file_id)
    if meta is None:
        raise KeyError(file_id)
    if _expired(meta):
        with _lock(owner_id):
            _remove(folder, file_id)
        raise KeyError(file_id)
    return _public(meta)


def path(owner_id: str, file_id: str) -> Path:
    get(owner_id, file_id)
    return _owner_dir(owner_id) / f"{file_id}.bin"


def read(owner_id: str, file_id: str) -> bytes:
    target = path(owner_id, file_id)
    try:
        return target.read_bytes()
    except OSError as exc:   # 刚好被并发删除
        raise KeyError(file_id) from exc


def list(owner_id: str, limit: int = 50) -> "list[dict]":  # noqa: A001 — 契约规定的名字
    folder = _owner_dir(owner_id)
    with _lock(owner_id):
        metas = _sweep(folder)
    return [_public(m) for m in metas[: max(0, int(limit))]]


def usage(owner_id: str) -> int:
    folder = _owner_dir(owner_id)
    with _lock(owner_id):
        return sum(int(m.get("size") or 0) for m in _sweep(folder))


def delete(owner_id: str, file_id: str) -> None:
    """删除；不存在或不属于该账号抛 KeyError。"""
    get(owner_id, file_id)
    with _lock(owner_id):
        _remove(_owner_dir(owner_id), file_id)


def resolve(owner_id: str, ref: str) -> dict:
    """工具参数容错：接受 file_id、``file_id=XXX`` / 附件标记原文、下载链接，或文件名（取最新同名文件）。"""
    text = str(ref or "").strip()
    if not text:
        raise KeyError(ref)
    candidates = [text]
    marked = _MARKER.search(text)
    if marked:
        candidates.insert(0, marked.group(1))
    if URL_PREFIX in text:
        candidates.insert(0, text.split(URL_PREFIX, 1)[1].split(")")[0].split("?")[0].strip())
    for candidate in candidates:
        if _valid_id(candidate):
            try:
                return get(owner_id, candidate)
            except KeyError:
                pass
    wanted = clean_name(re.sub(r"^［?附件[：:]\s*", "", text).split(" · ")[0].strip("］ "))
    for meta in list(owner_id, limit=1000):
        if meta["name"] == wanted:
            return meta
    raise KeyError(ref)


# ---------- HTTP 接口（契约第 2 节）----------

def register(app, *, request_principal, write_authorized, deny, csrf_deny) -> None:
    """挂上 /api/files 的四个接口；鉴权依赖由 server.py 注入（与 platforms.register 同一模式）。"""
    import base64
    import binascii

    from fastapi import Request
    from fastapi.responses import FileResponse, JSONResponse
    from pydantic import BaseModel, Field

    class FileIn(BaseModel):
        name: str = Field(max_length=300)
        data_base64: str

    def _json(content: object, status: int = 200) -> JSONResponse:
        return JSONResponse(content, status_code=status, headers={"Cache-Control": "no-store"})

    def _missing() -> JSONResponse:
        return _json({"error": "文件不存在或已过期"}, 404)

    def _writer(request: Request):
        principal = write_authorized(request)
        if principal is None:
            principal_any, _token = request_principal(request)
            return None, (csrf_deny() if principal_any else deny())
        return principal, None

    @app.post("/api/files")
    def files_upload(request: Request, body: FileIn):
        principal, err = _writer(request)
        if err:
            return err
        if len(body.data_base64) > (MAX_FILE_BYTES + 2) // 3 * 4 + 4:
            return _json({"error": f"文件超过 {MAX_FILE_BYTES // (1024 * 1024)}MB 上限"}, 413)
        try:
            data = base64.b64decode(body.data_base64, validate=True)
        except (binascii.Error, ValueError):
            return _json({"error": "文件内容编码不合法"}, 422)
        try:
            meta = save(principal.user_id, body.name, data, source="upload")
        except FileSpaceError as exc:
            return _json({"error": str(exc)}, 413 if "上限" in str(exc) or "已满" in str(exc) else 422)
        return _json(meta)

    @app.get("/api/files")
    def files_list(request: Request):
        principal, _token = request_principal(request)
        if not principal:
            return deny()
        owner = principal.user_id
        items = list(owner, limit=200)
        return _json({"files": items, "used": usage(owner), "quota": QUOTA_BYTES,
                      "max_file": MAX_FILE_BYTES, "retention_days": RETENTION_DAYS})

    @app.get("/api/files/{file_id}")
    def files_download(file_id: str, request: Request):
        principal, _token = request_principal(request)
        if not principal:
            return deny()
        try:
            meta = get(principal.user_id, file_id)
            target = path(principal.user_id, file_id)
        except KeyError:
            return _missing()
        return FileResponse(target, media_type=download_media_type(meta), headers={
            "Content-Disposition": content_disposition(meta["name"]),
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; sandbox",
        })

    @app.delete("/api/files/{file_id}")
    def files_delete(file_id: str, request: Request):
        principal, err = _writer(request)
        if err:
            return err
        try:
            delete(principal.user_id, file_id)
        except KeyError:
            return _missing()
        return _json({"ok": True})
