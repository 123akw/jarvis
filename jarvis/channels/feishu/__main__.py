"""服务器端管理命令（无网页按钮时的绑定入口）。

    python -m jarvis.channels.feishu bind-code <用户名>   # 发 6 位绑定码（10 分钟有效）
    python -m jarvis.channels.feishu bindings             # 列出已绑定的飞书账号
    python -m jarvis.channels.feishu unbind <用户名>      # 解除该用户的全部飞书绑定

绑定码以 sha256 写入 JARVIS_DATA_DIR/feishu_bind_codes.json，运行中的服务直接可用。
"""
from __future__ import annotations

import argparse
import sys

from jarvis import config
from jarvis.accounts import AccountStore
from jarvis.channels.feishu.bindings import BIND_CODE_TTL_SECONDS, BindingStore


def _user_id(accounts: AccountStore, username: str) -> str | None:
    for row in accounts.list_users():
        if str(row["username"]).casefold() == username.strip().casefold() and row["active"]:
            return str(row["id"])
    return None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m jarvis.channels.feishu", description="飞书渠道绑定管理")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("bind-code", help="为贾维斯用户发绑定码").add_argument("username")
    sub.add_parser("bindings", help="列出绑定")
    sub.add_parser("unbind", help="解除用户的飞书绑定").add_argument("username")
    args = parser.parse_args(argv)
    config.load_env()
    accounts, store = AccountStore(), BindingStore()
    if args.command == "bindings":
        names = {str(row["id"]): str(row["username"]) for row in accounts.list_users()}
        for open_id, user_id in sorted(store.all().items()):
            print(f"{open_id}\t{names.get(user_id, '(已删除用户)')}")
        return 0
    user_id = _user_id(accounts, args.username)
    if user_id is None:
        print(f"找不到启用中的贾维斯用户：{args.username}", file=sys.stderr)
        return 1
    if args.command == "unbind":
        print(f"已解除 {store.unbind_user(user_id)} 个飞书绑定")
        return 0
    code = store.issue_code(user_id)
    print(f"绑定码：{code}（{BIND_CODE_TTL_SECONDS // 60} 分钟内有效）\n在飞书里私聊机器人发送：绑定 {code}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
