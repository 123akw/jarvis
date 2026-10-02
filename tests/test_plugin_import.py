"""第十四轮：从 GitHub / Gitee / zip 导入插件、插件源（marketplace.json）、检查更新与权限。

下载一律 mock（importer.http_get），不连外网。"""
import base64
import io
import json
import shutil
import zipfile
from pathlib import Path

import jarvis.server as server_mod
import pytest
from fastapi.testclient import TestClient

from jarvis import plugins
from jarvis.accounts import AccountStore
from jarvis.plugins import importer, loader

FIXTURES = Path(__file__).parent / "fixtures" / "plugins"
SHA1 = "1" * 40
SHA2 = "2" * 40


def zip_folder(folder: Path, prefix: str = "", extra: dict | None = None) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for path in sorted(folder.rglob("*")):
            if path.is_file() and "__pycache__" not in path.parts:
                archive.write(path, prefix + str(path.relative_to(folder)))
        for name, data in (extra or {}).items():
            archive.writestr(name, data)
    return buffer.getvalue()


class FakeWeb:
    """按 URL 回放：commit 查询返回 sha，codeload 返回 zip；记下请求过的地址。"""

    def __init__(self, archives: dict[str, bytes], head: str = SHA1):
        self.archives, self.head, self.calls = archives, head, []

    def __call__(self, url, *, max_bytes=importer.MAX_DOWNLOAD_BYTES, accept=""):
        self.calls.append(url)
        if "api.github.com" in url and "/commits/" in url:
            return self.head.encode()
        for key, data in self.archives.items():
            if key in url:
                if len(data) > max_bytes:
                    raise importer.ImportFailure("仓库压缩包太大了", "TOO_LARGE", 413)
                return data
        raise importer.ImportFailure("找不到这个仓库、分支或目录", "NOT_FOUND", 404)


@pytest.fixture
def accounts():
    store = AccountStore()
    store._ensure_bootstrap()
    return store


def _client(username=None, password=None):
    client = TestClient(server_mod.app)
    if username:
        assert client.post("/api/login", json={"username": username, "password": password}).status_code == 200
        client.headers["X-JWS-CSRF"] = client.get("/api/session").json()["csrf_token"]
    return client


@pytest.fixture
def owner(accounts):
    return _client("admin", "admin")


def _audit(action):
    with AccountStore()._connect() as c:
        return [dict(r) for r in c.execute("SELECT user_id, detail FROM audit WHERE action=?", (action,))]


# ---------- 地址解析 ----------

@pytest.mark.parametrize("url,expected", [
    ("https://github.com/acme/tools", ("github", "acme", "tools", "", "")),
    ("https://github.com/acme/tools.git", ("github", "acme", "tools", "", "")),
    ("github.com/acme/tools/tree/main/plugins/echo", ("github", "acme", "tools", "main", "plugins/echo")),
    (f"https://github.com/acme/tools/commit/{SHA1}", ("github", "acme", "tools", SHA1, "")),
    ("https://gitee.com/acme/tools/tree/master/x", ("gitee", "acme", "tools", "master", "x")),
    ("acme/tools@v1.2", ("github", "acme", "tools", "v1.2", "")),
])
def test_repo_urls_parse(url, expected):
    ref = importer.parse_repo_url(url)
    assert (ref.host, ref.owner, ref.repo, ref.ref, ref.path) == expected


@pytest.mark.parametrize("url", ["https://evil.example.com/a/b", "ftp://github.com/a/b", "not a url",
                                 "https://github.com/a/b/tree/main/../../etc"])
def test_bad_urls_are_rejected(url):
    with pytest.raises(importer.ImportFailure):
        importer.parse_repo_url(url)


def test_only_whitelisted_https_hosts_are_fetched():
    assert importer._host_allowed("https://codeload.github.com/a/b/zip/x")
    assert not importer._host_allowed("http://github.com/a/b")
    assert not importer._host_allowed("https://github.com.evil.io/a")
    assert not importer._host_allowed("https://169.254.169.254/latest")


# ---------- 预览 + 确认（GitHub） ----------

def test_github_import_preview_confirm_and_use(owner, monkeypatch, tmp_path):
    web = FakeWeb({"codeload.github.com/acme/echo/zip/" + SHA1: zip_folder(FIXTURES / "echo_tool", "echo-111/")})
    monkeypatch.setattr(importer, "http_get", web)
    response = owner.post("/api/plugins/import/preview", json={"url": "https://github.com/acme/echo"})
    assert response.status_code == 200, response.text
    preview = response.json()
    assert preview["plugin"]["id"] == "echo_tool" and preview["plugin"]["version"] == "0.1.0"
    assert preview["plugin"]["author"] == "测试"
    assert {t["name"] for t in preview["tools"]} >= {"echo_shout", "echo_count"}
    assert preview["source"] == {"type": "github", "repo": "acme/echo", "ref": SHA1, "track": "", "path": "",
                                 "url": f"https://github.com/acme/echo/tree/{SHA1}"}
    keys = {p["key"] for p in preview["permissions"]}
    assert {"subprocess", "network", "tools"} <= keys
    assert any("第三方代码将在服务器上运行" in w for w in preview["warnings"])
    assert any("许可证" in w for w in preview["warnings"])        # 没写 license 要提醒
    assert {f["path"] for f in preview["files"]} >= {"plugin.json", "tools.py", "helper.py"}
    assert not plugins.is_plugin("echo_tool")                     # 预览不安装
    confirmed = owner.post("/api/plugins/import/confirm", json={"token": preview["token"]})
    assert confirmed.status_code == 201 and confirmed.json()["status"] == "ok"
    entry = plugins.get_plugin("echo_tool")
    assert entry["builtin"] is False and entry["source"]["ref"] == SHA1 and entry["status"] == "ok"
    tool = {t.name: t for t in plugins.pack_tools()}["echo_shout"]
    assert tool.invoke({"text": "ok"}) == "OK！"
    assert (tmp_path / "plugins" / "echo_tool" / "tools.py").is_file()
    state = loader.read_state()
    assert state["installed"]["echo_tool"]["source"]["ref"] == SHA1
    assert _audit("plugin_import") and "echo_tool" in _audit("plugin_import")[0]["detail"]
    # 令牌只能用一次
    again = owner.post("/api/plugins/import/confirm", json={"token": preview["token"]})
    assert again.status_code == 404
    # 目录里带着「社区」所需的字段
    catalog = owner.get("/api/market/catalog").json()
    item = next(p for p in catalog["plugins"] if p["id"] == "echo_tool")
    assert item["builtin"] is False and item["source"]["type"] == "github"


def test_subdirectory_and_multiple_plugins(owner, monkeypatch):
    repo = zip_folder(FIXTURES / "echo_tool", "mono-1/plugins/echo/") + b""
    buffer = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(repo)) as src, zipfile.ZipFile(buffer, "w") as dst:
        for info in src.infolist():
            dst.writestr(info.filename, src.read(info))
        for path in sorted((FIXTURES / "community_skill").rglob("*")):
            dst.write(path, "mono-1/plugins/skill/" + str(path.relative_to(FIXTURES / "community_skill")))
    web = FakeWeb({"codeload.github.com/acme/mono/zip/": buffer.getvalue()})
    monkeypatch.setattr(importer, "http_get", web)
    many = owner.post("/api/plugins/import/preview", json={"url": "https://github.com/acme/mono"})
    assert many.status_code == 422 and many.json()["code"] == "MULTIPLE"
    one = owner.post("/api/plugins/import/preview", json={"url": "https://github.com/acme/mono/tree/main/plugins/skill"})
    assert one.status_code == 200 and one.json()["plugin"]["id"] == "polite_reply"
    assert one.json()["source"]["path"] == "plugins/skill" and one.json()["source"]["track"] == "main"


def test_download_failures_offer_the_zip_fallback(owner, monkeypatch):
    def offline(url, **kwargs):
        raise importer.httpx.ConnectError("boom")
    monkeypatch.setattr(importer, "http_get", offline)
    response = owner.post("/api/plugins/import/preview", json={"url": "https://github.com/acme/echo"})
    assert response.status_code == 502
    body = response.json()
    assert body["code"] == "DOWNLOAD_FAILED" and "Download ZIP" in body["hint"]


# ---------- 上传 zip ----------

def _upload(client, data: bytes, **extra):
    return client.post("/api/plugins/import/preview",
                       json={"zip_base64": base64.b64encode(data).decode(), "zip_name": "p.zip", **extra})


def test_zip_upload_skill_only_folder(owner):
    response = _upload(owner, zip_folder(FIXTURES / "community_skill"))
    assert response.status_code == 200, response.text
    preview = response.json()
    assert preview["plugin"]["kind"] == "skill" and preview["skill"]["title"] == "礼貌回复"
    assert preview["permissions"][0]["key"] == "prompt" and preview["tools"] == []
    assert preview["source"]["type"] == "zip"
    assert owner.post("/api/plugins/import/confirm", json={"token": preview["token"]}).status_code == 201
    assert plugins.get_plugin("polite_reply")["kind"] == "skill"


def test_oversized_zip_is_rejected(owner, monkeypatch):
    monkeypatch.setattr(importer, "MAX_DOWNLOAD_BYTES", 1000)
    response = _upload(owner, zip_folder(FIXTURES / "echo_tool", extra={"big.bin": b"x" * 5000}))
    assert response.status_code == 413 and response.json()["code"] == "TOO_LARGE"


def test_too_many_files_is_rejected(owner, monkeypatch):
    monkeypatch.setattr(importer, "MAX_PLUGIN_FILES", 2)
    response = _upload(owner, zip_folder(FIXTURES / "echo_tool"))
    assert response.status_code == 413


@pytest.mark.parametrize("name", ["../escape.py", "/etc/passwd", "a/../../b.py", "C:/x.py"])
def test_path_traversal_is_rejected(owner, name):
    data = zip_folder(FIXTURES / "echo_tool", extra={name: b"print(1)"})
    response = _upload(owner, data)
    assert response.status_code == 422 and response.json()["code"] == "UNSAFE_ZIP"


def test_symlinks_are_rejected(owner):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.write(FIXTURES / "echo_tool" / "plugin.json", "plugin.json")
        link = zipfile.ZipInfo("tools.py")
        link.external_attr = (0o120777 << 16)
        archive.writestr(link, "/etc/passwd")
    response = _upload(owner, buffer.getvalue())
    assert response.status_code == 422 and response.json()["code"] == "UNSAFE_ZIP"


def test_missing_manifest_and_garbage(owner):
    response = _upload(owner, _zip_of({"README.md": b"# hi"}))
    assert response.status_code == 422 and response.json()["code"] == "NO_MANIFEST"
    assert _upload(owner, b"not a zip").json()["code"] == "BAD_ZIP"
    bad = _zip_of({"plugin.json": json.dumps({"id": "Bad Id", "name": "x", "summary": "y"}).encode()})
    assert _upload(owner, bad).json()["code"] == "BAD_MANIFEST"
    steps = _zip_of({"plugin.json": json.dumps({"id": "step_thing", "name": "x", "summary": "y", "kind": "step",
                                                 "entry": "tools.py", "steps": ["step_thing"]}).encode(),
                     "tools.py": b"STEPS = {}"})
    assert "第三方插件暂不支持流程积木" in _upload(owner, steps).json()["error"]


def _zip_of(files: dict) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for name, data in files.items():
            archive.writestr(name, data)
    return buffer.getvalue()


def test_missing_dependencies_are_shown_and_install_marks_unavailable(owner):
    manifest = json.loads((FIXTURES / "echo_tool" / "plugin.json").read_text(encoding="utf-8"))
    manifest.update({"id": "needs_dep", "python_packages": ["surely-not-installed-pkg"], "tools": ["echo_shout"]})
    data = _zip_of({"plugin.json": json.dumps(manifest).encode(),
                    "tools.py": (FIXTURES / "echo_tool" / "tools.py").read_bytes(),
                    "helper.py": (FIXTURES / "echo_tool" / "helper.py").read_bytes()})
    preview = _upload(owner, data).json()
    assert preview["missing_packages"] == ["surely-not-installed-pkg"]
    assert preview["python_packages"][0]["installed"] is False
    assert owner.post("/api/plugins/import/confirm", json={"token": preview["token"]}).status_code == 201
    entry = next(p for p in plugins.catalog(None)["plugins"] if p["id"] == "needs_dep")
    assert entry["status"] == "unavailable" and "surely-not-installed-pkg" in entry["reason"]
    assert entry["available"] is False and plugins.tools_for(["needs_dep"]) == set()


def test_duplicate_ids_and_tool_conflicts(owner):
    clash = _zip_of({"SKILL.md": "---\nname: todo\n---\n# 抢名字\n正文".encode()})
    response = _upload(owner, clash)
    assert response.status_code == 409 and response.json()["code"] == "DUPLICATE" and "内置插件" in response.json()["error"]
    first = _upload(owner, zip_folder(FIXTURES / "community_skill")).json()
    owner.post("/api/plugins/import/confirm", json={"token": first["token"]})
    second = _upload(owner, zip_folder(FIXTURES / "community_skill"))
    assert second.status_code == 409 and "检查更新" in second.json()["error"]
    core = _zip_of({"plugin.json": json.dumps({"id": "core_tool", "name": "x", "summary": "y", "entry": "tools.py",
                                                "tools": ["todo_add"]}).encode(),
                    "tools.py": b"from langchain_core.tools import tool\n@tool\ndef todo_add() -> str:\n    '''x'''\n    return 'x'\nTOOLS=[todo_add]\n"})
    response = _upload(owner, core)
    assert response.status_code == 409 and "核心工具" in response.json()["error"]


# ---------- 启停 / 卸载 / 权限 ----------

def test_enable_disable_uninstall(owner):
    preview = _upload(owner, zip_folder(FIXTURES / "community_skill")).json()
    owner.post("/api/plugins/import/confirm", json={"token": preview["token"]})
    assert owner.post("/api/plugins/polite_reply/disable").json()["status"] == "disabled"
    assert not plugins.is_plugin("polite_reply")
    rows = {r["id"]: r for r in owner.get("/api/plugins").json()["plugins"]}
    assert rows["polite_reply"]["enabled"] is False and rows["polite_reply"]["builtin"] is False
    assert owner.post("/api/plugins/polite_reply/enable").json()["status"] == "ok"
    builtin = owner.delete("/api/plugins/todo")
    assert builtin.status_code == 400 and "只能停用" in builtin.json()["error"]
    assert owner.post("/api/plugins/todo/disable").status_code == 200
    assert not plugins.is_plugin("todo")
    assert owner.post("/api/plugins/todo/enable").status_code == 200
    removed = owner.delete("/api/plugins/polite_reply")
    assert removed.status_code == 200 and not plugins.is_plugin("polite_reply")
    assert not (loader.data_root() / "polite_reply").exists()
    for action in ("plugin_disable", "plugin_enable", "plugin_uninstall"):
        assert _audit(action), action


def test_non_owner_and_guest_are_refused(accounts):
    accounts.create_user("member1", "Member-pass-123", "Member")
    member = _client("member1", "Member-pass-123")
    guest = _client()
    data = base64.b64encode(zip_folder(FIXTURES / "community_skill")).decode()
    for client, status in ((member, 403), (guest, 401)):
        assert client.get("/api/plugins").status_code == status
        assert client.post("/api/plugins/import/preview", json={"zip_base64": data}).status_code == status
        assert client.post("/api/plugins/import/confirm", json={"token": "x" * 20}).status_code == status
        assert client.post("/api/plugins/todo/disable").status_code == status
        assert client.delete("/api/plugins/todo").status_code == status
        assert client.post("/api/plugins/sources", json={"url": "https://github.com/a/b"}).status_code == status
    assert plugins.is_plugin("todo")


def test_owner_writes_need_csrf(accounts):
    client = _client("admin", "admin")
    client.headers.pop("X-JWS-CSRF")
    response = client.post("/api/plugins/todo/disable")
    assert response.status_code == 403 and plugins.is_plugin("todo")


def test_preview_token_belongs_to_its_owner(owner, accounts, monkeypatch):
    preview = _upload(owner, zip_folder(FIXTURES / "community_skill")).json()
    with pytest.raises(importer.ImportFailure):
        importer.confirm(preview["token"], "someone-else")


# ---------- Agent Plugins 格式与插件源 ----------

def test_agent_plugin_with_mcp_installs_skill_and_flags_mcp(owner):
    preview = _upload(owner, zip_folder(FIXTURES / "agent_plugin")).json()
    assert preview["format"] == "agent-plugin" and preview["plugin"]["name"] == "会议助手"
    assert preview["links"]["privacy"] == "https://example.com/privacy"
    assert {p["key"] for p in preview["permissions"]} >= {"prompt", "read", "write", "mcp"}
    assert preview["mcp"][0]["url"] == "https://mcp.example.com/notes"
    assert any("MCP" in w for w in preview["warnings"])
    owner.post("/api/plugins/import/confirm", json={"token": preview["token"]})
    assert plugins.get_plugin("meeting_helper")["status"] == "ok"       # 技能部分能用


def test_multi_skill_agent_plugin_splits_into_skill_plugins(owner):
    folder = FIXTURES / "agent_plugin"
    data = zip_folder(folder, extra={"skills/follow-up/SKILL.md": "# 跟进提醒\n会后第二天提醒负责人。".encode()})
    preview = _upload(owner, data).json()
    assert [p["id"] for p in preview["skill"]["split"]] == ["meeting_helper_follow_up", "meeting_helper_meeting_notes"]
    result = owner.post("/api/plugins/import/confirm", json={"token": preview["token"]}).json()
    assert {p["id"] for p in result["plugins"]} == {"meeting_helper_follow_up", "meeting_helper_meeting_notes"}
    assert plugins.get_plugin("meeting_helper_follow_up")["name"] == "跟进提醒"
    owner.delete("/api/plugins/meeting_helper_follow_up")
    assert not plugins.is_plugin("meeting_helper_meeting_notes")       # 同一个包一起卸载


def test_marketplace_source_sync_and_install(owner, monkeypatch):
    repo = zip_folder(FIXTURES / "marketplace", "examples-111/")
    web = FakeWeb({"codeload.github.com/acme/market/zip/" + SHA1: repo,
                   "codeload.github.com/123akw/jarvis/zip/": zip_folder(FIXTURES / "unit_convert",
                                                                       "jarvis-1/examples/plugins/unit_convert/")})
    monkeypatch.setattr(importer, "http_get", web)
    added = owner.post("/api/plugins/sources", json={"url": "https://github.com/acme/market"})
    assert added.status_code == 201, added.text
    source = added.json()
    assert source["display_name"] == "贾维斯示例插件源" and source["id"] == "jarvis_examples"
    names = [p["name"] for p in source["plugins"]]
    assert names[0] == "festival-greetings" and "unit_convert" in names
    preview = owner.post(f"/api/plugins/sources/{source['id']}/preview", json={"name": "festival-greetings"})
    assert preview.status_code == 200, preview.text
    body = preview.json()
    assert body["plugin"]["id"] == "festival_greetings" and body["source"]["marketplace"] == "jarvis_examples"
    assert body["source"]["ref"] == SHA1 and body["source"]["path"] == "plugins/festival-greetings"
    owner.post("/api/plugins/import/confirm", json={"token": body["token"]})
    remote = owner.post(f"/api/plugins/sources/{source['id']}/preview", json={"name": "unit_convert"}).json()
    assert remote["plugin"]["id"] == "unit_convert" and remote["source"]["path"] == "examples/plugins/unit_convert"
    listed = owner.get("/api/plugins").json()["sources"][0]
    festival = next(p for p in listed["plugins"] if p["name"] == "festival-greetings")
    assert festival["installed"] is True and festival["installed_version"] == "1.0.0"
    assert owner.delete(f"/api/plugins/sources/{source['id']}").status_code == 200
    assert owner.get("/api/plugins/sources").json()["sources"] == []
    assert plugins.is_plugin("festival_greetings")                      # 删插件源不卸载已装的插件


def test_marketplace_policies_and_npm():
    parsed = importer.parse_marketplace({"name": "x", "plugins": [
        {"name": "hidden", "source": {"source": "local", "path": "./a"}, "policy": {"installation": "NOT_AVAILABLE"}},
        {"name": "auto", "source": {"source": "local", "path": "./b"}, "policy": {"installation": "INSTALLED_BY_DEFAULT"}},
        {"name": "node-thing", "source": {"source": "npm", "package": "x"}},
        {"name": "escape", "source": {"source": "local", "path": "../../etc"}},
    ]})
    assert [p["name"] for p in parsed["plugins"]] == ["auto"] and "不自动安装" in parsed["plugins"][0]["note"]
    assert parsed["skipped"][0]["name"] == "node-thing" and "Node" in parsed["skipped"][0]["reason"]


def test_check_update_upgrades_after_confirmation(owner, monkeypatch, tmp_path):
    old = zip_folder(FIXTURES / "echo_tool", "echo-1/")
    web = FakeWeb({"codeload.github.com/acme/echo/zip/" + SHA1: old})
    monkeypatch.setattr(importer, "http_get", web)
    first = owner.post("/api/plugins/import/preview", json={"url": "https://github.com/acme/echo/tree/main"}).json()
    owner.post("/api/plugins/import/confirm", json={"token": first["token"]})
    same = owner.post("/api/plugins/echo_tool/check-update").json()
    assert same["has_update"] is False and same["current_version"] == "0.1.0"
    manifest = json.loads((FIXTURES / "echo_tool" / "plugin.json").read_text(encoding="utf-8"))
    manifest["version"] = "0.2.0"
    new = zip_folder(FIXTURES / "echo_tool", "echo-2/")
    buffer = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(new)) as src, zipfile.ZipFile(buffer, "w") as dst:
        for info in src.infolist():
            data = json.dumps(manifest).encode() if info.filename.endswith("plugin.json") else src.read(info)
            dst.writestr(info.filename, data)
    web.archives["codeload.github.com/acme/echo/zip/" + SHA2] = buffer.getvalue()
    web.head = SHA2
    update = owner.post("/api/plugins/echo_tool/check-update").json()
    assert update["has_update"] is True and update["latest_version"] == "0.2.0" and update["latest_ref"] == SHA2
    assert update["preview"]["upgrade"] == {"from_version": "0.1.0", "to_version": "0.2.0"}
    assert plugins.get_plugin("echo_tool")["version"] == "0.1.0"        # 没确认前不动
    done = owner.post("/api/plugins/import/confirm", json={"token": update["preview"]["token"]})
    assert done.status_code == 201 and done.json()["upgraded"] is True
    entry = plugins.get_plugin("echo_tool")
    assert entry["version"] == "0.2.0" and entry["source"]["ref"] == SHA2
    assert _audit("plugin_upgrade")
