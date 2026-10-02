"""第十三轮顶层页面：市场、平台入口、流程拼接都回单页应用的 index.html（前端 routes.js 再分发）。"""
import jarvis.server as server_mod
import pytest
from fastapi.testclient import TestClient


@pytest.mark.parametrize("path", ["/market", "/flows", "/p/ab12cd34"])
def test_top_level_pages_serve_the_spa_without_login(path):
    response = TestClient(server_mod.app).get(path)
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/html")
    assert '<div id="root">' in response.text
