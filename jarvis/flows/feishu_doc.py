"""「汇总到飞书文档」：Markdown 子集 → 飞书新版文档（docx）块，并把文档分享给本人。

调用链（open.feishu.cn 官方接口，tenant_access_token 复用 channels/feishu 的缓存）：
1. POST /open-apis/docx/v1/documents 建文档（应用身份建的文档归应用所有）；
2. POST /open-apis/docx/v1/documents/:id/blocks/:id/children 分批追加正文块（每批 ≤50）；
3. POST /open-apis/drive/v1/permissions/:id/members?type=docx 把本人（open_id）加为可管理协作者；
4. 取文档链接：POST /open-apis/drive/v1/metas/batch_query（with_url），取不到就拼通用链接。

应用需开通的权限：docx:document（创建及编辑新版文档）、docs:permission.member:create
（添加协作者）；drive 元数据读取（取链接）可选。缺权限 → :class:`DocPermissionError`，
由积木降级为发消息。真实调用本机无法验证，tests/test_flows.py 用 MockTransport 覆盖。
"""
from __future__ import annotations

import logging
import re

from jarvis.channels.feishu.api import FeishuAPIError

log = logging.getLogger("jarvis")

BATCH = 50
MAX_BLOCKS = 300
# 文档类接口的「无权限」：docx 1770032 forbidden、drive 1063002 permission denied
DOC_FORBIDDEN_CODES = frozenset({1770032, 1063002})

_HEADING = re.compile(r"^\s{0,3}(#{1,6})\s+(\S.*)$")
_BULLET = re.compile(r"^\s*[-*+•]\s+(.*)$")
_ORDERED = re.compile(r"^\s*\d{1,3}[.、)]\s*(.*)$")
_QUOTE = re.compile(r"^\s*>\s?(.*)$")
_BOLD = re.compile(r"\*\*(.+?)\*\*")


class DocError(RuntimeError):
    """建文档失败（网络 / 接口错误）。"""


class DocPermissionError(DocError):
    """应用没有文档或协作者权限：调用方应降级为发消息。"""


def _elements(text: str) -> list[dict]:
    runs, pos = [], 0
    for match in _BOLD.finditer(text):
        if match.start() > pos:
            runs.append({"text_run": {"content": text[pos:match.start()]}})
        runs.append({"text_run": {"content": match.group(1), "text_element_style": {"bold": True}}})
        pos = match.end()
    if pos < len(text):
        runs.append({"text_run": {"content": text[pos:]}})
    return [r for r in runs if r["text_run"]["content"]] or [{"text_run": {"content": " "}}]


def _block(block_type: int, key: str, text: str) -> dict:
    return {"block_type": block_type, key: {"elements": _elements(text.replace("`", ""))}}


def markdown_blocks(markdown: str) -> list[dict]:
    """## 标题 / - 列表 / 1. 列表 / > 引用 / 段落 → docx 块（block_type 3–5 / 12 / 13 / 15 / 2）。"""
    blocks = []
    for line in str(markdown or "").splitlines():
        if not line.strip():
            continue
        if heading := _HEADING.match(line):
            level = min(len(heading.group(1)), 3)
            blocks.append(_block(2 + level, f"heading{level}", heading.group(2).strip()))
        elif bullet := _BULLET.match(line):
            blocks.append(_block(12, "bullet", bullet.group(1).strip()))
        elif ordered := _ORDERED.match(line):
            blocks.append(_block(13, "ordered", ordered.group(1).strip()))
        elif quote := _QUOTE.match(line):
            blocks.append(_block(15, "quote", quote.group(1).strip()))
        else:
            blocks.append(_block(2, "text", line.strip()))
    return blocks[:MAX_BLOCKS]


def _permission(exc: FeishuAPIError) -> bool:
    return exc.permission_denied or exc.status == 403 or exc.code in DOC_FORBIDDEN_CODES


def publish(api, open_ids: list[str], *, title: str, markdown: str) -> str:
    """建文档、写正文、分享给本人，返回文档链接。"""
    try:
        document_id = api.create_document(title[:200] or "贾维斯整理")
        blocks = markdown_blocks(markdown)
        for start in range(0, len(blocks), BATCH):
            api.append_blocks(document_id, blocks[start:start + BATCH])
        for open_id in open_ids:
            api.add_doc_member(document_id, open_id)
    except FeishuAPIError as exc:
        log.warning("feishu doc failed: code=%s status=%s", exc.code, exc.status)
        if _permission(exc):
            raise DocPermissionError(str(exc.code)) from exc
        raise DocError(str(exc.code)) from exc
    return api.doc_url(document_id)
