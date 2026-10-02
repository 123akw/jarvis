import pytest


@pytest.fixture(autouse=True)
def isolated_data_dir(tmp_path, monkeypatch):
    """每条测试用独立临时目录存备忘，不碰真实 data/。"""
    monkeypatch.setenv("JARVIS_DATA_DIR", str(tmp_path))
    # 账户测试明确注入的测试启动凭据；个别 fail-closed 用例会主动移除它们。
    monkeypatch.setenv("JARVIS_ADMIN_USERNAME", "admin")
    monkeypatch.setenv("JARVIS_ADMIN_PASSWORD", "admin")
    monkeypatch.setenv("JARVIS_SESSION_SECRET", "test-session-secret-is-at-least-256-bits-long")
    monkeypatch.setenv("JARVIS_ENV", "test")
    monkeypatch.setenv("JARVIS_ALLOW_INSECURE_COOKIE", "1")
    # 飞书渠道：外部 shell 里的真实凭据不能让 TestClient 的 lifespan 连上真飞书
    monkeypatch.delenv("FEISHU_APP_ID", raising=False)
    monkeypatch.delenv("FEISHU_APP_SECRET", raising=False)
    return tmp_path


@pytest.fixture(autouse=True)
def no_background_home_model(monkeypatch):
    """智能体主页的模型生成默认关掉：测试不打真模型、不留后台线程；要测的用例自己换 HomeService。"""
    from jarvis import platform_home
    monkeypatch.setattr(platform_home, "_service", platform_home.HomeService())
