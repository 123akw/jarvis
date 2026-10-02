"""文件空间（契约第 2 节）：保存 / 读取 / 列表 / 删除、账号隔离、路径穿越、配额、过期、下载头、对话附件。"""
import base64
import datetime as dt
import io
import json
from urllib.parse import quote

import pytest
from fastapi.testclient import TestClient

import jarvis.server as server_mod
from jarvis import files
from jarvis.accounts import AccountStore

OWNER, OTHER = "owner-aaaa", "member-bbbb"


def _b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


# ---------- 库接口 ----------

def test_save_get_read_list_delete_roundtrip(isolated_data_dir):
    first = files.save(OWNER, "合同.pdf", b"%PDF-1.4 one", source="upload")
    second = files.save(OWNER, "报表.xlsx", b"PK second")
    assert set(first) >= {"id", "name", "size", "mime", "created_at", "url"}
    assert first["url"] == f"/api/files/{first['id']}" and first["size"] == len(b"%PDF-1.4 one")
    assert first["mime"] == "application/pdf" and first["source"] == "upload"
    assert second["mime"].endswith("spreadsheetml.sheet")
    assert files.get(OWNER, first["id"]) == first
    assert files.read(OWNER, first["id"]) == b"%PDF-1.4 one"
    assert files.path(OWNER, first["id"]).read_bytes() == b"%PDF-1.4 one"
    assert [m["id"] for m in files.list(OWNER)] == [second["id"], first["id"]]   # 新的在前
    assert [m["id"] for m in files.list(OWNER, limit=1)] == [second["id"]]
    # 存放位置：data_dir()/files/<owner_id>/，元数据 JSON 同目录
    folder = isolated_data_dir / "files" / OWNER
    assert (folder / f"{first['id']}.bin").is_file()
    assert json.loads((folder / f"{first['id']}.json").read_text("utf-8"))["name"] == "合同.pdf"
    files.delete(OWNER, first["id"])
    with pytest.raises(KeyError):
        files.get(OWNER, first["id"])
    with pytest.raises(KeyError):
        files.delete(OWNER, first["id"])
    assert [m["id"] for m in files.list(OWNER)] == [second["id"]]
    assert files.usage(OWNER) == len(b"PK second")


def test_accounts_are_isolated_and_path_traversal_is_inert(isolated_data_dir):
    mine = files.save(OWNER, "a.txt", b"secret of owner")
    with pytest.raises(KeyError):
        files.get(OTHER, mine["id"])
    with pytest.raises(KeyError):
        files.read(OTHER, mine["id"])
    with pytest.raises(KeyError):
        files.delete(OTHER, mine["id"])
    with pytest.raises(KeyError):
        files.resolve(OTHER, "a.txt")           # 按名字找也只在自己的空间里找
    assert files.list(OTHER) == []
    (isolated_data_dir / "accounts.sqlite3").write_bytes(b"db")
    for evil in ("../accounts", "../../accounts.sqlite3", f"../{OWNER}/{mine['id']}", "..", ".", "",
                 f"{mine['id']}/..", "a" * 65, "abc", None):
        with pytest.raises(KeyError):
            files.get(OWNER, evil)
        with pytest.raises(KeyError):
            files.read(OTHER, evil)
    for evil_owner in ("../" + OWNER, "..", "", "a/b", OWNER + "/..", None):
        with pytest.raises(ValueError):
            files.save(evil_owner, "x.txt", b"x")
        with pytest.raises(ValueError):
            files.list(evil_owner)
    assert files.read(OWNER, mine["id"]) == b"secret of owner"


def test_names_are_sanitized():
    assert files.clean_name("../../etc/passwd") == "passwd"
    assert files.clean_name("C:\\Users\\me\\报表.xlsx") == "报表.xlsx"
    assert files.clean_name("a\x00b\nc.pdf") == "abc.pdf"
    assert files.clean_name('合<同>:"?.pdf') == "合_同____.pdf"
    assert files.clean_name("   ") == "文件"
    long = files.clean_name("长" * 300 + ".docx")
    assert long.endswith(".docx") and len(long) == files.MAX_NAME_CHARS + 5
    assert files.with_extension("部门汇总", "xlsx", "表格") == "部门汇总.xlsx"
    assert files.with_extension("部门汇总.XLSX", "xlsx", "表格") == "部门汇总.XLSX"
    assert files.with_extension("", "pdf", "合并后") == "合并后.pdf"


def test_size_limit_and_quota(monkeypatch):
    monkeypatch.setattr(files, "MAX_FILE_BYTES", 10)
    with pytest.raises(files.FileSpaceError, match="上限"):
        files.save(OWNER, "big.bin", b"x" * 11)
    monkeypatch.setattr(files, "QUOTA_BYTES", 25)
    files.save(OWNER, "a.bin", b"x" * 10)
    files.save(OWNER, "b.bin", b"x" * 10)
    with pytest.raises(files.FileSpaceError, match="已满"):
        files.save(OWNER, "c.bin", b"x" * 10)
    files.save(OTHER, "c.bin", b"x" * 10)              # 配额按账号算
    assert len(files.list(OWNER)) == 2


def test_expired_files_are_cleaned_lazily(isolated_data_dir, monkeypatch):
    old = files.save(OWNER, "old.txt", b"old")
    fresh = files.save(OWNER, "fresh.txt", b"fresh")
    later = dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=files.RETENTION_DAYS, minutes=1)
    meta_path = isolated_data_dir / "files" / OWNER / f"{old['id']}.json"
    meta = json.loads(meta_path.read_text("utf-8"))
    meta["expires_at"] = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(seconds=1)).isoformat()
    meta_path.write_text(json.dumps(meta), "utf-8")
    with pytest.raises(KeyError):
        files.get(OWNER, old["id"])
    assert not (isolated_data_dir / "files" / OWNER / f"{old['id']}.bin").exists()
    assert [m["id"] for m in files.list(OWNER)] == [fresh["id"]]
    monkeypatch.setattr(files, "_now", lambda: later)     # 30 天后：全部过期，列表时顺手清掉
    assert files.list(OWNER) == []
    assert not any((isolated_data_dir / "files" / OWNER).iterdir())


def test_resolve_accepts_id_marker_link_and_name():
    meta = files.save(OWNER, "销售.xlsx", b"PK data")
    assert files.resolve(OWNER, meta["id"])["id"] == meta["id"]
    assert files.resolve(OWNER, files.attachment_marker(meta))["id"] == meta["id"]
    assert files.resolve(OWNER, f"file_id={meta['id']}")["id"] == meta["id"]
    assert files.resolve(OWNER, files.link(meta))["id"] == meta["id"]
    assert files.resolve(OWNER, "销售.xlsx")["id"] == meta["id"]
    with pytest.raises(KeyError):
        files.resolve(OWNER, "不存在.xlsx")
    assert files.attachment_marker(meta) == f"［附件：销售.xlsx · file_id={meta['id']}］"
    assert files.link(meta) == f"[下载 销售.xlsx](/api/files/{meta['id']})"


def test_content_disposition_rfc5987():
    header = files.content_disposition("合并后.pdf")
    assert header.startswith("attachment; ")
    assert 'filename="download.pdf"' in header
    assert f"filename*=UTF-8''{quote('合并后.pdf', safe='')}" in header
    plain = files.content_disposition('Q3 "report".pdf')
    assert 'filename="Q3 report.pdf"' in plain or 'filename="Q3 _report_.pdf"' in plain
    assert "\n" not in files.content_disposition("a\r\nSet-Cookie: x=1.pdf")


# ---------- HTTP 接口 ----------

def _client(username="admin", password="admin"):
    client = TestClient(server_mod.app)
    assert client.post("/api/login", json={"username": username, "password": password}).status_code == 200
    client.headers["X-JWS-CSRF"] = client.get("/api/session").json()["csrf_token"]
    return client


def test_file_routes_roundtrip_with_csrf_and_download_headers():
    anon = TestClient(server_mod.app)
    assert anon.get("/api/files").status_code == 401
    assert anon.post("/api/files", json={"name": "a.txt", "data_base64": _b64(b"x")}).status_code == 401
    c = _client()
    no_csrf = TestClient(server_mod.app)
    no_csrf.cookies = c.cookies
    assert no_csrf.post("/api/files", json={"name": "a.txt", "data_base64": _b64(b"x")}).status_code == 403
    r = c.post("/api/files", json={"name": "季度 报告.pdf", "data_base64": _b64(b"%PDF-1.4 body")})
    assert r.status_code == 200
    meta = r.json()
    assert meta["name"] == "季度 报告.pdf" and meta["url"] == f"/api/files/{meta['id']}"
    listing = c.get("/api/files").json()
    assert [f["id"] for f in listing["files"]] == [meta["id"]]
    assert listing["used"] == len(b"%PDF-1.4 body") and listing["quota"] == files.QUOTA_BYTES
    download = c.get(meta["url"])
    assert download.status_code == 200 and download.content == b"%PDF-1.4 body"
    assert download.headers["content-type"].startswith("application/pdf")
    disposition = download.headers["content-disposition"]
    assert disposition.startswith("attachment;") and quote("季度 报告.pdf", safe="") in disposition
    assert download.headers["x-content-type-options"] == "nosniff"
    assert "no-store" in download.headers["cache-control"]
    assert anon.get(meta["url"]).status_code == 401
    assert c.post("/api/files", json={"name": "x", "data_base64": "!!!"}).status_code == 422
    assert c.delete(meta["url"]).json() == {"ok": True}
    assert c.get(meta["url"]).status_code == 404
    assert c.delete(meta["url"]).status_code == 404


def test_member_cannot_download_or_delete_owner_files():
    accounts = AccountStore()
    accounts._ensure_bootstrap()
    assert accounts.create_user("member-files", "member-pass", "Member")
    owner, member = _client(), _client("member-files", "member-pass")
    meta = owner.post("/api/files", json={"name": "工资表.xlsx", "data_base64": _b64(b"PK salary")}).json()
    assert member.get(meta["url"]).status_code == 404
    assert member.delete(meta["url"]).status_code == 404
    assert member.get("/api/files").json()["files"] == []
    for evil in ("..%2F..%2Faccounts.sqlite3", "%2E%2E", "..", meta["id"] + "%2F..%2F.."):
        assert member.get(f"/api/files/{evil}").status_code in (404, 405)
    assert owner.get(meta["url"]).content == b"PK salary"


def test_html_uploads_download_as_octet_stream():
    c = _client()
    meta = c.post("/api/files", json={"name": "x.html", "data_base64": _b64(b"<script>alert(1)</script>")}).json()
    r = c.get(meta["url"])
    assert r.headers["content-type"].startswith("application/octet-stream")
    assert r.headers["content-disposition"].startswith("attachment;")
    assert "sandbox" in r.headers["content-security-policy"]


def test_file_route_rejects_oversized_payload(monkeypatch):
    monkeypatch.setattr(files, "MAX_FILE_BYTES", 8)
    c = _client()
    r = c.post("/api/files", json={"name": "big.bin", "data_base64": _b64(b"x" * 64)})
    assert r.status_code == 413 and "上限" in r.json()["error"]


# ---------- 对话附件：📎 上传时同时存进文件空间 ----------

def _xlsx_bytes():
    from openpyxl import Workbook
    book = Workbook()
    sheet = book.active
    sheet.append(["部门", "金额"])
    sheet.append(["销售部", 1200])
    sheet.append(["市场部", 800])
    buffer = io.BytesIO()
    book.save(buffer)
    return buffer.getvalue()


def test_chat_upload_keeps_office_files_and_returns_marker():
    c = _client()
    r = c.post("/api/upload", json={"name": "报销.xlsx", "content_b64": _b64(_xlsx_bytes())}).json()
    assert r["ok"] is True and r["kind"] == "table"
    assert "| 部门 | 金额 |" in r["text"] and "销售部" in r["text"]
    attached = r["file"]
    assert attached["name"] == "报销.xlsx" and attached["url"] == f"/api/files/{attached['id']}"
    assert attached["marker"] == f"［附件：报销.xlsx · file_id={attached['id']}］"
    assert c.get(attached["url"]).content == _xlsx_bytes()
    csv = c.post("/api/upload", json={"name": "名单.csv", "content_b64": _b64("姓名,电话\n张三,123\n".encode("gbk"))}).json()
    assert csv["kind"] == "table" and "张三" in csv["text"] and csv["file"]["name"] == "名单.csv"
    # 纯文本不进文件空间（没有对应的办公工具）
    txt = c.post("/api/upload", json={"name": "a.txt", "content_b64": _b64("你好".encode())}).json()
    assert txt["file"] is None and txt["kind"] == "document"


def test_chat_upload_explains_old_formats_and_keeps_unreadable_pdfs():
    c = _client()
    xls = c.post("/api/upload", json={"name": "老表.xls", "content_b64": _b64(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1")})
    assert xls.status_code == 422 and "另存为" in xls.json()["error"] and ".xlsx" in xls.json()["error"]
    doc = c.post("/api/upload", json={"name": "老文档.doc", "content_b64": _b64(b"\xd0\xcf\x11\xe0")})
    assert doc.status_code == 422 and ".docx" in doc.json()["error"]
    from pypdf import PdfWriter
    writer = PdfWriter()
    writer.add_blank_page(width=200, height=200)
    buffer = io.BytesIO()
    writer.write(buffer)
    scanned = c.post("/api/upload", json={"name": "扫描件.pdf", "content_b64": _b64(buffer.getvalue())}).json()
    assert scanned["ok"] is True and scanned["text"] == "" and "读到文字" in scanned["note"]
    assert scanned["file"]["name"] == "扫描件.pdf"   # 读不出字也先存下，PDF 工具照样能拆分合并


def test_chat_upload_still_returns_text_when_space_is_full(monkeypatch):
    monkeypatch.setattr(files, "QUOTA_BYTES", 10)
    c = _client()
    r = c.post("/api/upload", json={"name": "名单.csv", "content_b64": _b64("姓名,电话\n张三,123456789\n".encode())}).json()
    assert r["ok"] is True and r["file"] is None and "已满" in r["file_error"] and "张三" in r["text"]
