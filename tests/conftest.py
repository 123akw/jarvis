import pytest


@pytest.fixture(autouse=True)
def isolated_data_dir(tmp_path, monkeypatch):
    """每条测试用独立临时目录存备忘，不碰真实 data/。"""
    monkeypatch.setenv("JARVIS_DATA_DIR", str(tmp_path))
    return tmp_path
