"""文档解析：把上传的 PDF / Word(docx) / TXT / Markdown 提取成纯文本。

上传走 JSON+base64（省掉 multipart 依赖）；docx 用标准库 zipfile 解析
word/document.xml（零依赖），PDF 用 pypdf（纯 Python、零传递依赖）。
解析结果只在内存里走一遭，注入对话消息，不落盘。
"""
from __future__ import annotations

import html
import io
import re
import zipfile

SUPPORTED_EXTENSIONS = (".pdf", ".docx", ".txt", ".md")
MAX_UPLOAD_BYTES = 10 * 1024 * 1024   # 10MB
MAX_DOC_CHARS = 8000                  # 超长截断，避免撑爆模型上下文


class DocumentError(Exception):
    """解析失败；消息可直接展示给用户，不含上游细节。"""


def _decode_text(data: bytes) -> str:
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return data.decode("gb18030", errors="ignore")


def _docx_text(data: bytes) -> str:
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as bundle:
            xml = bundle.read("word/document.xml").decode("utf-8", "ignore")
    except (zipfile.BadZipFile, KeyError, OSError) as exc:
        raise DocumentError("这个 Word 文档无法解析（只支持 .docx）") from exc
    xml = xml.replace("</w:p>", "\n").replace("<w:tab/>", "\t").replace("<w:br/>", "\n")
    return html.unescape(re.sub(r"<[^>]+>", "", xml))


def _pdf_text(data: bytes) -> str:
    try:
        from pypdf import PdfReader
        reader = PdfReader(io.BytesIO(data))
        return "\n".join((page.extract_text() or "") for page in reader.pages)
    except DocumentError:
        raise
    except Exception as exc:
        raise DocumentError("这个 PDF 无法解析（可能是扫描件或已加密）") from exc


def extract_text(filename: str, data: bytes) -> str:
    """按扩展名解析为纯文本；不支持或解析失败抛 DocumentError。"""
    name = str(filename).lower()
    if len(data) > MAX_UPLOAD_BYTES:
        raise DocumentError("文件超过 10MB 上限")
    if name.endswith(".pdf"):
        text = _pdf_text(data)
    elif name.endswith(".docx"):
        text = _docx_text(data)
    elif name.endswith((".txt", ".md")):
        text = _decode_text(data)
    else:
        raise DocumentError("只支持 PDF、Word（.docx）、TXT 和 Markdown 文件")
    text = re.sub(r"\n{3,}", "\n\n", text.replace("\r\n", "\n")).strip()
    if not text:
        raise DocumentError("没有从文档里读到文字（可能是纯图片扫描件）")
    return text
