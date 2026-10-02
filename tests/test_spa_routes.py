"""顶层页面都回单页应用的 index.html（前端 routes.js 再分发）。

第十五轮：/ 是智能体市场（主域名首页），/login 登录页，/app 主应用；/flows、/p/<slug> 不变。
旧链接兼容：/market → /，/?u=X → /login?u=X，查询参数原样带上。
"""
from urllib.parse import parse_qs, urlsplit

import jarvis.server as server_mod
import pytest
from fastapi.testclient import TestClient


def _client():
    return TestClient(server_mod.app, follow_redirects=False)


@pytest.mark.parametrize("path", ["/", "/login", "/app", "/flows", "/p/ab12cd34", "/login?next=%2Fapp", "/?intro=off"])
def test_top_level_pages_serve_the_spa_without_login(path):
    response = _client().get(path)
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/html")
    assert '<div id="root">' in response.text


@pytest.mark.parametrize("path, target", [
    ("/market", "/"),
    ("/market?tab=official&q=%E5%86%99%E4%BD%9C", "/?tab=official&q=%E5%86%99%E4%BD%9C"),
    ("/?u=jvabc123", "/login?u=jvabc123"),
    ("/?u=%E9%99%88%E6%80%BB&intro=off", "/login?u=%E9%99%88%E6%80%BB&intro=off"),
    ("/market?u=jvabc123", "/login?u=jvabc123"),
])
def test_legacy_links_redirect_and_keep_query(path, target):
    response = _client().get(path)
    assert response.status_code == 302
    assert response.headers["location"] == target


def test_legacy_redirect_never_leaves_the_site():
    """查询参数里塞网址也只会落在本站 /login，不会被当成跳转目标"""
    response = _client().get("/?u=x&next=https://evil.example")
    location = response.headers["location"]
    assert urlsplit(location).netloc == "" and location.startswith("/login?")
    assert parse_qs(urlsplit(location).query)["next"] == ["https://evil.example"]   # 原样带过去，由前端 safeNext 拒绝


def test_legacy_market_redirect_lands_on_the_spa():
    response = TestClient(server_mod.app).get("/market?tab=official")
    assert response.status_code == 200
    assert str(response.url).endswith("/?tab=official")
    assert '<div id="root">' in response.text
