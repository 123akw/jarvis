"""飞书绑定存储：一次性码、过期、只存哈希、0600 权限，以及服务器端 CLI。"""
import stat

from jarvis.accounts import AccountStore
from jarvis.channels.feishu import __main__ as cli
from jarvis.channels.feishu.bindings import BIND_CODE_TTL_SECONDS, BindingStore


class Clock:
    now = 1_000.0

    def __call__(self):
        return self.now


def test_codes_expire_are_single_use_and_reissue_revokes_previous(tmp_path):
    clock = Clock()
    store = BindingStore(lambda: tmp_path, clock=clock)
    first = store.issue_code("user-1")
    second = store.issue_code("user-1")
    if first != second:
        assert store.redeem(first, "ou_a") == ("invalid", None)  # 重新领码后旧码作废

    clock.now += BIND_CODE_TTL_SECONDS + 1
    assert store.redeem(second, "ou_a") == ("invalid", None)

    third = store.issue_code("user-1")
    assert store.redeem(third, "ou_b") == ("ok", "user-1")
    assert store.redeem(third, "ou_c") == ("invalid", None)
    assert store.user_for("ou_b") == "user-1" and store.count_for("user-1") == 1


def test_files_are_private_and_never_hold_plain_codes(tmp_path):
    store = BindingStore(lambda: tmp_path)
    code = store.issue_code("user-1")
    store.bind("ou_x", "user-1")
    for name in ("feishu_bind_codes.json", "feishu_bindings.json"):
        path = tmp_path / name
        assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert code not in (tmp_path / "feishu_bind_codes.json").read_text()


def test_unbind_by_user_and_by_open_id(tmp_path):
    store = BindingStore(lambda: tmp_path)
    store.bind("ou_1", "u1")
    store.bind("ou_2", "u1")
    store.bind("ou_3", "u2")
    assert store.unbind_open_id("ou_3") is True and store.unbind_open_id("ou_3") is False
    assert store.unbind_user("u1") == 2 and store.all() == {}


def test_cli_issues_code_for_existing_user(capsys, monkeypatch):
    monkeypatch.setattr(cli.config, "load_env", lambda: None)  # 不读真实 .env
    AccountStore()._ensure_bootstrap()
    assert cli.main(["bind-code", "admin"]) == 0
    out = capsys.readouterr().out
    code = out.split("绑定码：")[1][:6]
    assert BindingStore().redeem(code, "ou_cli")[0] == "ok"

    assert cli.main(["bindings"]) == 0
    assert "ou_cli\tadmin" in capsys.readouterr().out
    assert cli.main(["unbind", "admin"]) == 0
    assert cli.main(["bind-code", "nobody"]) == 1
