"""PDF 工具箱：看信息、提取文字、合并、拆分、抽页、旋转（pypdf，纯 Python）。

输入一律是文件空间里的 file_id（对话里「［附件：xxx.pdf · file_id=…］」那一串，或上一个工具
返回的 file_id）；生成的新文件存回文件空间，返回 Markdown 下载链接。任何异常都转成人话返回，
不抛给对话；页数、文件数、字数都有上限。
"""
from __future__ import annotations

import functools
import io
import logging
import re

from langchain_core.tools import tool
from pydantic import BaseModel, Field

from jarvis import files
from jarvis.tenancy import TenantScopeError, current_owner_id

log = logging.getLogger("jarvis")

MAX_PAGES = 500           # 单个 PDF 页数上限
MAX_OUTPUT_PAGES = 1000   # 合并后的页数上限
MAX_MERGE_FILES = 20
MAX_SPLIT_PARTS = 20
MAX_TEXT_PAGES = 50       # 一次最多提取多少页文字
MAX_TEXT_CHARS = 8000     # 一次最多返回多少字

FILE_ID_HELP = "文件编号：对话里「［附件：文件名 · file_id=XXX］」中的 XXX，或之前工具返回的 file_id"
PAGES_HELP = "页码范围，从 1 开始，如「1-3,5,8-」（8- 表示第 8 页到最后）；留空表示全部页"


class Problem(Exception):
    """可以直接转告用户的问题。"""


def _friendly(fn):
    """工具体的统一兜底：人话问题原样返回，意外异常只给类名级说明，绝不抛给对话。"""
    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except Problem as exc:
            return str(exc)
        except Exception as exc:
            log.warning("pdf tool %s failed: %s", fn.__name__, type(exc).__name__)
            return ("PDF 处理没成功（内部错误）。不要用相同参数重试；请告诉领导这一步没成，"
                    "可以换个文件、少选几页或稍后再试。")
    return wrapper


def _owner() -> str:
    try:
        return current_owner_id()
    except TenantScopeError as exc:
        raise Problem("当前没有登录的账号，没法读写文件") from exc


def _load(ref: str) -> tuple[dict, bytes]:
    owner = _owner()
    try:
        meta = files.resolve(owner, ref)
        return meta, files.read(owner, meta["id"])
    except KeyError:
        raise Problem(f"没找到文件「{ref}」：可能已过期（文件保留 30 天）或编号不对。"
                      "请让领导重新上传，或使用对话里附件标记中的 file_id。") from None


def _save(name: str, data: bytes) -> dict:
    try:
        return files.save(_owner(), name, data, mime="application/pdf", source="tool")
    except files.FileSpaceError as exc:
        raise Problem(str(exc)) from exc


def _stem(meta: dict) -> str:
    name = meta["name"]
    return name[:-4] if name.lower().endswith(".pdf") else name


def _out_name(name: str, default: str) -> str:
    return files.with_extension(name or default, "pdf", default)


def _size(n: int) -> str:
    return f"{n / 1024 / 1024:.1f} MB" if n >= 1024 * 1024 else f"{max(1, round(n / 1024))} KB"


def _reader(meta: dict, data: bytes):
    """打开 PDF；加密、损坏、不是 PDF、页数超限都转成人话。"""
    from pypdf import PdfReader
    from pypdf.errors import FileNotDecryptedError

    name = meta["name"]
    if b"%PDF" not in data[:1024]:
        raise Problem(f"《{name}》不是 PDF 文件：PDF 工具只能处理 .pdf")
    try:
        reader = PdfReader(io.BytesIO(data))
    except Exception:
        raise Problem(f"《{name}》打不开，文件可能已损坏") from None
    locked = Problem(f"《{name}》设置了打开密码，没法处理。请先在 PDF 阅读器里输入密码、"
                     "另存一份不带密码的 PDF 再上传。")
    if reader.is_encrypted:
        try:
            if not reader.decrypt(""):
                raise locked
        except Problem:
            raise
        except Exception:
            raise locked from None
    try:
        total = len(reader.pages)
    except FileNotDecryptedError:
        raise locked from None
    except Exception:
        raise Problem(f"《{name}》打不开，文件可能已损坏") from None
    if total == 0:
        raise Problem(f"《{name}》里一页都没有")
    if total > MAX_PAGES:
        raise Problem(f"《{name}》有 {total} 页，超过一次处理 {MAX_PAGES} 页的上限，请先拆小一些")
    return reader


def _write(writer) -> bytes:
    buffer = io.BytesIO()
    writer.write(buffer)
    return buffer.getvalue()


_BLANKS = re.compile(r"\n{3,}")
_RANGE = re.compile(r"(\d*)\s*(?:-|~|～|—|–|到|至)\s*(\d*)")


def parse_pages(spec: str, total: int) -> list[int]:
    """「1-3,5,8-」→ 0 基页序（保持书写顺序、去重）；空 / 全部 → 全部页。"""
    text = str(spec or "").strip()
    if text.lower() in ("", "全部", "所有", "all", "*", "全部页"):
        return list(range(total))
    text = re.sub(r"(最后一|最末|末|最后|last|end)", str(total), text, flags=re.IGNORECASE)
    text = text.replace("第", "").replace("页", "")
    pages: list[int] = []
    for part in re.split(r"[,，、;；\s]+", text):
        if not part:
            continue
        match = _RANGE.fullmatch(part)
        if match:
            start = int(match.group(1)) if match.group(1) else 1
            end = int(match.group(2)) if match.group(2) else total
        elif part.isdigit():
            start = end = int(part)
        else:
            raise Problem(f"页码「{part}」看不懂：请写成「1-3,5,8-」这样的格式（页码从 1 开始）")
        if min(start, end) < 1:
            raise Problem("页码从 1 开始")
        if max(start, end) > total:
            raise Problem(f"第 {max(start, end)} 页超出范围：这个 PDF 只有 {total} 页")
        step = 1 if end >= start else -1
        for number in range(start, end + step, step):
            if number - 1 not in pages:
                pages.append(number - 1)
    if not pages:
        raise Problem("没有选中任何页")
    return pages


def _label(indices: list[int]) -> str:
    """给文件名用的页码说明：连续 → 第3-5页；单页 → 第3页；其他 → 选取4页。"""
    numbers = [i + 1 for i in indices]
    if len(numbers) == 1:
        return f"第{numbers[0]}页"
    if numbers == list(range(numbers[0], numbers[-1] + 1)):
        return f"第{numbers[0]}-{numbers[-1]}页"
    return f"选取{len(numbers)}页"


def _done(prefix: str, meta: dict) -> str:
    return f"{prefix}：{files.link(meta)}（file_id={meta['id']}，可继续交给其他工具处理）"


# ---------- 参数 ----------

class InfoArgs(BaseModel):
    file_id: str = Field(description=FILE_ID_HELP)


class TextArgs(BaseModel):
    file_id: str = Field(description=FILE_ID_HELP)
    pages: str = Field(default="", description=PAGES_HELP + f"；一次最多 {MAX_TEXT_PAGES} 页")


class MergeArgs(BaseModel):
    file_ids: list[str] = Field(min_length=2, max_length=MAX_MERGE_FILES,
                                description=f"按合并顺序排列的 file_id 列表，2–{MAX_MERGE_FILES} 个")
    name: str = Field(default="", max_length=80, description="新文件名，如「合并后.pdf」；留空自动命名")


class SplitArgs(BaseModel):
    file_id: str = Field(description=FILE_ID_HELP)
    ranges: list[str] = Field(default_factory=list, max_length=MAX_SPLIT_PARTS,
                              description="每一份的页码范围，如 [\"1-3\", \"4-6\", \"7-\"]，一项拆出一个文件")
    every: int = Field(default=0, ge=0, le=MAX_PAGES,
                       description="不写 ranges 时按每 N 页一份拆分；0 表示每页一份")


class PagesArgs(BaseModel):
    file_id: str = Field(description=FILE_ID_HELP)
    pages: str = Field(description="要抽出来的页码，如「3-5」「1,4,9」；按书写顺序组成新文件")
    name: str = Field(default="", max_length=80, description="新文件名；留空自动命名")


class RotateArgs(BaseModel):
    file_id: str = Field(description=FILE_ID_HELP)
    degrees: int = Field(default=90, description="旋转角度：90 / 180 / 270，正数顺时针，-90 表示逆时针")
    pages: str = Field(default="", description=PAGES_HELP)
    name: str = Field(default="", max_length=80, description="新文件名；留空自动命名")


# ---------- 工具 ----------

@tool("pdf_info", args_schema=InfoArgs)
@_friendly
def pdf_info(file_id: str) -> str:
    """查看 PDF 的基本信息：页数、标题、作者、大小、页面尺寸、有没有文字层（扫描件读不出字）。
    何时用：领导问「这个 PDF 多少页 / 是什么」，或拆分、抽页前先确认页数。
    示例：pdf_info(file_id="AbC123xyz")"""
    meta, data = _load(file_id)
    reader = _reader(meta, data)
    total = len(reader.pages)
    info = {}
    try:
        info = reader.metadata or {}
    except Exception:
        pass
    parts = [f"《{meta['name']}》：共 {total} 页，大小 {_size(meta['size'])}"]
    for key, label in (("/Title", "标题"), ("/Author", "作者"), ("/Subject", "主题")):
        value = str(info.get(key) or "").strip() if hasattr(info, "get") else ""
        if value:
            parts.append(f"{label}：{value[:80]}")
    try:
        box = reader.pages[0].mediabox
        width, height = float(box.width), float(box.height)
        size = "A4" if {round(width), round(height)} <= {595, 596, 841, 842} else f"{round(width)}×{round(height)} pt"
        parts.append(f"页面 {size}{'横向' if width > height else '纵向'}")
    except Exception:
        pass
    sample = ""
    for page in list(reader.pages)[:3]:
        try:
            sample += page.extract_text() or ""
        except Exception:
            pass
    parts.append("有文字层，可以提取文字" if sample.strip() else "前几页读不到文字，可能是扫描件或图片")
    if reader.is_encrypted:
        parts.append("文件带权限限制（无打开密码，已可处理）")
    return "；".join(parts) + f"。file_id={meta['id']}"


@tool("pdf_extract_text", args_schema=TextArgs)
@_friendly
def pdf_extract_text(file_id: str, pages: str = "") -> str:
    """按页提取 PDF 里的文字（逐页标注页码）。扫描件没有文字层时会说明。
    何时用：领导要看 / 总结 / 翻译 PDF 某几页的内容，而对话里没有这几页的全文时。
    示例：pdf_extract_text(file_id="AbC123xyz", pages="3-5")"""
    meta, data = _load(file_id)
    reader = _reader(meta, data)
    total = len(reader.pages)
    chosen = parse_pages(pages, total)
    note = ""
    if len(chosen) > MAX_TEXT_PAGES:
        chosen, note = chosen[:MAX_TEXT_PAGES], f"（一次最多提取 {MAX_TEXT_PAGES} 页，后面的页请再指定 pages）"
    blocks, used, empty = [], 0, 0
    for index in chosen:
        try:
            text = (reader.pages[index].extract_text() or "").strip()
        except Exception:
            text = ""
        if not text:
            empty += 1
            continue
        block = f"### 第 {index + 1} 页\n{_BLANKS.sub(chr(10) * 2, text)}"
        if used + len(block) > MAX_TEXT_CHARS:
            remain = MAX_TEXT_CHARS - used
            if remain > 200:
                blocks.append(block[:remain] + "…")
            note = f"（字数超过 {MAX_TEXT_CHARS} 字，只取到第 {index + 1} 页；后面的请再指定 pages）"
            break
        blocks.append(block)
        used += len(block)
    if not blocks:
        return f"《{meta['name']}》选中的 {len(chosen)} 页都读不到文字，可能是扫描件或图片，需要 OCR 才能识别。"
    head = f"《{meta['name']}》（共 {total} 页）的文字{note}："
    tail = f"\n\n（其中 {empty} 页没有文字，可能是图片页）" if empty else ""
    return head + "\n\n" + "\n\n".join(blocks) + tail


@tool("pdf_merge", args_schema=MergeArgs)
@_friendly
def pdf_merge(file_ids: list[str], name: str = "") -> str:
    """把多个 PDF 按给定顺序合并成一个新 PDF，返回下载链接。
    何时用：「把这两个 PDF 合成一个」「按 A、B、C 的顺序拼起来」。
    示例：pdf_merge(file_ids=["AbC123xyz", "DeF456uvw"], name="合并后.pdf")"""
    from pypdf import PdfWriter

    if len(file_ids) < 2:
        return "合并至少需要 2 个 PDF；只有一个文件时不用合并。"
    writer, count, names = PdfWriter(), 0, []
    for ref in file_ids[:MAX_MERGE_FILES]:
        meta, data = _load(ref)
        reader = _reader(meta, data)
        if count + len(reader.pages) > MAX_OUTPUT_PAGES:
            raise Problem(f"合并后会超过 {MAX_OUTPUT_PAGES} 页上限，请分批合并")
        for page in reader.pages:
            writer.add_page(page)
        count += len(reader.pages)
        names.append(meta["name"])
    out = _save(_out_name(name, "合并后.pdf"), _write(writer))
    order = " → ".join(f"《{n}》" for n in names)
    return _done(f"已按 {order} 的顺序合并成 1 个 PDF，共 {count} 页", out)


@tool("pdf_split", args_schema=SplitArgs)
@_friendly
def pdf_split(file_id: str, ranges: list[str] | None = None, every: int = 0) -> str:
    """把一个 PDF 拆成多个文件：按 ranges 指定的页码范围（一项一份），或每 N 页一份，返回每份的下载链接。
    何时用：「把第 1-3 页和第 4-6 页分别拆出来」「每 10 页拆一份」「拆成单页」。
    示例：pdf_split(file_id="AbC123xyz", ranges=["1-3", "4-"])；pdf_split(file_id="AbC123xyz", every=10)"""
    from pypdf import PdfWriter

    meta, data = _load(file_id)
    reader = _reader(meta, data)
    total = len(reader.pages)
    groups: list[list[int]] = []
    if ranges:
        groups = [parse_pages(spec, total) for spec in ranges if str(spec).strip()]
    if not groups:
        size = max(1, int(every or 1))
        groups = [list(range(start, min(start + size, total))) for start in range(0, total, size)]
    if len(groups) > MAX_SPLIT_PARTS:
        return (f"这样会拆出 {len(groups)} 个文件，超过一次 {MAX_SPLIT_PARTS} 个的上限；"
                f"请用 every 加大每份页数（这个 PDF 共 {total} 页），或用 ranges 指定要的几段。")
    if len(groups) == 1 and len(groups[0]) == total:
        return f"《{meta['name']}》只有 {total} 页，按这个方式拆出来和原文件一样；请指定要拆的页码范围。"
    stem, links = _stem(meta), []
    for group in groups:
        writer = PdfWriter()
        for index in group:
            writer.add_page(reader.pages[index])
        out = _save(_out_name(f"{stem}_{_label(group)}", "拆分.pdf"), _write(writer))
        links.append(f"- {_label(group)}（{len(group)} 页）：{files.link(out)}（file_id={out['id']}）")
    return f"已把《{meta['name']}》（共 {total} 页）拆成 {len(groups)} 个文件：\n" + "\n".join(links)


@tool("pdf_extract_pages", args_schema=PagesArgs)
@_friendly
def pdf_extract_pages(file_id: str, pages: str, name: str = "") -> str:
    """从 PDF 里抽出指定的页，按书写顺序组成一个新 PDF（也可用来调整页序、删掉某些页：只写要保留的页）。
    何时用：「把第 3 到 5 页单独拿出来」「只要第 1、4、9 页」「删掉第 2 页」（只写要保留的页：pages="1,3-"）。
    示例：pdf_extract_pages(file_id="AbC123xyz", pages="3-5")"""
    from pypdf import PdfWriter

    meta, data = _load(file_id)
    reader = _reader(meta, data)
    chosen = parse_pages(pages, len(reader.pages))
    writer = PdfWriter()
    for index in chosen:
        writer.add_page(reader.pages[index])
    out = _save(_out_name(name, f"{_stem(meta)}_{_label(chosen)}"), _write(writer))
    return _done(f"已从《{meta['name']}》抽出 {len(chosen)} 页", out)


@tool("pdf_rotate", args_schema=RotateArgs)
@_friendly
def pdf_rotate(file_id: str, degrees: int = 90, pages: str = "", name: str = "") -> str:
    """把 PDF 的页面旋转 90 / 180 / 270 度（正数顺时针），生成新文件。
    何时用：「扫描件是横着的，转正」「第 2 页倒了，转 180 度」。
    示例：pdf_rotate(file_id="AbC123xyz", degrees=90, pages="2")"""
    from pypdf import PdfWriter

    turn = int(degrees) % 360
    if turn not in (90, 180, 270):
        return "旋转角度只能是 90、180 或 270 度（-90 表示逆时针 90 度）。"
    meta, data = _load(file_id)
    reader = _reader(meta, data)
    total = len(reader.pages)
    chosen = set(parse_pages(pages, total))
    writer = PdfWriter()
    for index, page in enumerate(reader.pages):
        added = writer.add_page(page)
        if index in chosen:
            added.rotate(turn)
    scope = "全部页面" if len(chosen) == total else f"{len(chosen)} 页"
    out = _save(_out_name(name, f"{_stem(meta)}_旋转"), _write(writer))
    return _done(f"已把《{meta['name']}》的{scope}顺时针旋转 {turn} 度", out)


TOOLS = [pdf_info, pdf_extract_text, pdf_merge, pdf_split, pdf_extract_pages, pdf_rotate]
STEPS: dict = {}
