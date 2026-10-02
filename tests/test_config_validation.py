"""配置校验（第十一轮）：环境变量写错不能让服务起不来，关键密钥配错要在日志里说清原因。"""
import base64
import logging
import os
import subprocess
import sys
from pathlib import Path

import pytest

from jarvis import config, periodic
from jarvis.accounts import AccountStore, session_secret_configured
from jarvis.provider_settings import SecretStore
from jarvis.wechat_voice import DEFAULT_SEND_ITEM_TYPE, build_voice_items

ROOT = Path(__file__).resolve().parent.parent


@pytest.fixture(autouse=True)
def fresh_throttle(monkeypatch):
    """warn_throttled 是进程级限频：每条用例清零，保证本用例的告警一定打得出来。"""
    monkeypatch.setattr(periodic, "_last_warned", {})


def _warnings(caplog):
    return [r.getMessage() for r in caplog.records if r.levelno >= logging.WARNING]


@pytest.mark.parametrize("raw,expected,warned", [
    (None, 8, False), ("", 8, False), ("12", 12, False),
    ("abc", 8, True), ("8.5", 8, True), ("0", 1, True), ("-3", 1, True),
])
def test_env_int_falls_back_with_warning(monkeypatch, caplog, raw, expected, warned):
    if raw is None:
        monkeypatch.delenv("JARVIS_TEST_INT", raising=False)
    else:
        monkeypatch.setenv("JARVIS_TEST_INT", raw)
    with caplog.at_level(logging.WARNING):
        assert config.env_int("JARVIS_TEST_INT", 8, minimum=1) == expected
    assert bool([m for m in _warnings(caplog) if "JARVIS_TEST_INT" in m]) is warned


def test_env_int_upper_bound(monkeypatch):
    monkeypatch.setenv("JARVIS_PORT", "70000")
    assert config.env_int("JARVIS_PORT", 7789, minimum=1, maximum=65535) == 65535


@pytest.mark.parametrize("raw,expected", [(None, "WARNING"), ("info", "INFO"), (" debug ", "DEBUG"),
                                          ("verbose", "WARNING"), ("5", "WARNING")])
def test_log_level_never_breaks_basic_config(monkeypatch, raw, expected):
    if raw is None:
        monkeypatch.delenv("JARVIS_LOG_LEVEL", raising=False)
    else:
        monkeypatch.setenv("JARVIS_LOG_LEVEL", raw)
    level = config.log_level()
    assert level == expected
    logging.getLogger("jarvis-test-level").setLevel(level)   # 有效级别名，setLevel/basicConfig 不会抛错


def test_server_imports_with_garbage_numeric_env(tmp_path):
    """实测：JARVIS_AGENT_WORKERS=abc 时 import jarvis.server 直接 ValueError，服务起不来。"""
    env = {**os.environ, "JARVIS_AGENT_WORKERS": "abc", "JARVIS_DATA_DIR": str(tmp_path),
           "PYTHONPATH": str(ROOT)}
    result = subprocess.run([sys.executable, "-c", "import jarvis.server as s; print(s._agent_pool._max_workers)"],
                            cwd=tmp_path, env=env, capture_output=True, text=True, timeout=120)
    assert result.returncode == 0, result.stderr[-2000:]
    assert result.stdout.strip().endswith("8")
    assert "JARVIS_AGENT_WORKERS" in result.stderr


def test_wechat_voice_item_type_typo_falls_back(monkeypatch):
    monkeypatch.setenv("JARVIS_WECHAT_VOICE_SEND_ITEM_TYPE", "thirty-four")
    assert build_voice_items(b"silk", 1000)[0]["type"] == DEFAULT_SEND_ITEM_TYPE


def test_wrong_length_secrets_key_is_explained_without_leaking(caplog, tmp_path):
    hex_key = "ab" * 32    # openssl rand -hex 32 的样子：解码后 48 字节，不是 32
    with caplog.at_level(logging.WARNING):
        store = SecretStore(tmp_path, master_key=hex_key, write_enabled=True)
    assert store.writable is False
    messages = [m for m in _warnings(caplog) if "JARVIS_SECRETS_KEY" in m]
    assert messages and "48" in messages[0] and hex_key not in "".join(_warnings(caplog))


def test_valid_secrets_key_is_silent(caplog, tmp_path):
    with caplog.at_level(logging.WARNING):
        SecretStore(tmp_path, master_key=base64.urlsafe_b64encode(b"k" * 32).decode())
    assert not [m for m in _warnings(caplog) if "JARVIS_SECRETS_KEY" in m]


@pytest.mark.parametrize("value,needle", [("", "未配置"), ("<at-least-32-byte-random-secret>", "占位符"),
                                          ("too-short-secret", "16 字节")])
def test_bad_session_secret_is_explained(monkeypatch, caplog, value, needle):
    monkeypatch.setenv("JARVIS_SESSION_SECRET", value)
    with caplog.at_level(logging.WARNING):
        assert session_secret_configured() is False
    messages = [m for m in _warnings(caplog) if "JARVIS_SESSION_SECRET" in m]
    assert messages and needle in messages[0]
    if value:
        assert value not in messages[0]


def test_missing_bootstrap_credentials_are_explained(monkeypatch, caplog):
    monkeypatch.delenv("JARVIS_ADMIN_PASSWORD", raising=False)
    with caplog.at_level(logging.WARNING):
        assert AccountStore().unique_active_owner() is None
    assert any("JARVIS_ADMIN_USERNAME" in m for m in _warnings(caplog))


def test_configured_bootstrap_is_silent(caplog):
    with caplog.at_level(logging.WARNING):
        assert AccountStore().unique_active_owner() is not None
    assert not [m for m in _warnings(caplog) if "JARVIS_ADMIN" in m or "SESSION_SECRET" in m]


def test_run_reads_dotenv_before_choosing_log_level(monkeypatch):
    """实测：run() 先 basicConfig 后 load_env，写在 .env 里的 JARVIS_LOG_LEVEL=INFO 从不生效。"""
    import uvicorn

    import jarvis.server as server_mod

    seen = {}
    monkeypatch.delenv("JARVIS_LOG_LEVEL", raising=False)
    monkeypatch.setenv("JARVIS_PORT", "18972")
    monkeypatch.setattr(server_mod.config, "load_env", lambda: monkeypatch.setenv("JARVIS_LOG_LEVEL", "info"))
    monkeypatch.setattr(logging, "basicConfig", lambda **kwargs: seen.update(kwargs))
    monkeypatch.setattr(server_mod, "_initialize_runtime", lambda: None)
    monkeypatch.setattr(uvicorn, "run", lambda *_args, **kwargs: seen.update(port=kwargs.get("port")))
    server_mod.run()
    assert seen == {"level": "INFO", "port": 18972}
