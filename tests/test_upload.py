"""文档上传解析：txt/docx/pdf 提取、限制与鉴权。"""
import base64
import io
import zipfile

import jarvis.server as server_mod
import pytest
from fastapi.testclient import TestClient
from jarvis.accounts import AccountStore
from jarvis.documents import DocumentError, extract_text
from jarvis.tenancy import tenant_scope


@pytest.fixture(autouse=True)
def tenant():
    accounts = AccountStore(); accounts._ensure_bootstrap()
    with tenant_scope(accounts.list_users()[0]["id"]):
        yield


def _authed_client():
    c = TestClient(server_mod.app)
    c.post("/api/login", json={"username": "admin", "password": "admin"})
    c.headers["X-JWS-CSRF"] = c.get("/api/session").json()["csrf_token"]
    return c


def _docx_bytes(paragraphs):
    xml = ('<?xml version="1.0"?><w:document xmlns:w="ns"><w:body>'
           + "".join(f"<w:p><w:r><w:t>{p}</w:t></w:r></w:p>" for p in paragraphs)
           + "</w:body></w:document>")
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as bundle:
        bundle.writestr("word/document.xml", xml)
    return buf.getvalue()


def _pdf_bytes(text="Hello Jarvis"):
    from pypdf import PdfWriter
    writer = PdfWriter()
    page = writer.add_blank_page(width=200, height=200)
    try:
        from pypdf.annotations import FreeText  # noqa: F401  # 仅探测可用性
    except Exception:
        pass
    buf = io.BytesIO()
    # 手工塞一段未压缩文本内容流，pypdf 可提取
    from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject
    stream = DecodedStreamObject()
    stream.set_data(f"BT /F1 12 Tf 10 100 Td ({text}) Tj ET".encode())
    ref = writer._add_object(stream)
    page[NameObject("/Contents")] = ref
    page[NameObject("/Resources")] = DictionaryObject({
        NameObject("/Font"): DictionaryObject({
            NameObject("/F1"): DictionaryObject({
                NameObject("/Type"): NameObject("/Font"),
                NameObject("/Subtype"): NameObject("/Type1"),
                NameObject("/BaseFont"): NameObject("/Helvetica"),
            })
        })
    })
    writer.write(buf)
    return buf.getvalue()


def test_extract_txt_docx_pdf():
    assert extract_text("a.txt", "第一行\r\n\r\n\r\n\r\n第二行".encode()) == "第一行\n\n第二行"
    assert extract_text("b.md", "# 标题".encode("gb18030")) == "# 标题"
    docx = extract_text("c.docx", _docx_bytes(["段落一", "段落二 &lt;&amp;&gt; 符号"]))
    assert "段落一" in docx and "段落二 <&> 符号" in docx  # 实体反转义还原
    assert "Hello Jarvis" in extract_text("d.pdf", _pdf_bytes())


def test_extract_rejects_unsupported_and_empty():
    with pytest.raises(DocumentError):
        extract_text("evil.exe", b"MZ")
    with pytest.raises(DocumentError):
        extract_text("blank.txt", b"   \n  ")
    with pytest.raises(DocumentError):
        extract_text("broken.docx", b"not a zip")
    with pytest.raises(DocumentError):
        extract_text("big.txt", b"x" * (10 * 1024 * 1024 + 1))


def test_upload_endpoint_roundtrip_and_auth():
    anon = TestClient(server_mod.app)
    assert anon.post("/api/upload", json={"name": "a.txt", "content_b64": ""}).status_code == 401

    c = _authed_client()
    payload = {"name": "会议纪要.txt",
               "content_b64": base64.b64encode("决议：周五上线".encode()).decode()}
    r = c.post("/api/upload", json=payload).json()
    assert r["ok"] is True and r["name"] == "会议纪要.txt"
    assert r["text"] == "决议：周五上线" and r["truncated"] is False

    assert c.post("/api/upload", json={"name": "x.txt", "content_b64": "!!!"}).status_code == 422
    assert c.post("/api/upload", json={"name": "x.exe", "content_b64": base64.b64encode(b"MZ").decode()}).status_code == 422


def test_upload_truncates_long_documents():
    from jarvis.documents import MAX_DOC_CHARS
    c = _authed_client()
    long_text = "很长的内容。" * 3000
    payload = {"name": "long.txt", "content_b64": base64.b64encode(long_text.encode()).decode()}
    r = c.post("/api/upload", json=payload).json()
    assert r["truncated"] is True and r["chars"] == MAX_DOC_CHARS
