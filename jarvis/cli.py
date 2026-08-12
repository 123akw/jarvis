"""终端入口：交互式对话，或 --once 单发一句。"""
import argparse

from jarvis.accounts import AccountStore
from jarvis.graph import build_agent
from jarvis.tenancy import TenantStore, tenant_scope


def chat(agent, text: str, thread_id: str) -> str:
    owner = AccountStore().unique_active_owner()
    if owner is None:
        raise RuntimeError("CLI requires exactly one active Owner")
    with tenant_scope(owner.user_id):
        store = TenantStore()
        store.migrate_legacy()
        thread = store.upsert_thread(thread_id, text)
        result = agent.invoke(
            {"messages": [{"role": "user", "content": text}]},
            config={"configurable": {"thread_id": thread.checkpoint_thread_id}},
        )
    return str(result["messages"][-1].content)


def main() -> None:
    parser = argparse.ArgumentParser(description="私人管家贾维斯")
    parser.add_argument("--once", metavar="消息", help="单发一句并退出")
    parser.add_argument("--thread", default="main", help="会话线程 id（默认 main）")
    args = parser.parse_args()
    agent = build_agent()
    if args.once:
        print(chat(agent, args.once, args.thread))
        return
    print("贾维斯就绪。输 quit 退出。")
    while True:
        try:
            text = input("你: ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            break
        if not text:
            continue
        if text.lower() in {"quit", "exit"}:
            break
        print("贾维斯:", chat(agent, text, args.thread))


if __name__ == "__main__":
    main()
