"""终端入口：交互式对话，或 --once 单发一句。"""
import argparse

from jarvis import config
from jarvis.accounts import AccountStore
from jarvis.provider_runtime import AgentRuntimeManager
from jarvis.provider_settings import SecretStore
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
    config.load_env()
    parser = argparse.ArgumentParser(description="私人管家贾维斯")
    parser.add_argument("--once", metavar="消息", help="单发一句并退出")
    parser.add_argument("--thread", default="main", help="会话线程 id（默认 main）")
    args = parser.parse_args()
    owner = AccountStore().unique_active_owner()
    if owner is None:
        raise RuntimeError("CLI requires exactly one active Owner")
    manager = AgentRuntimeManager(SecretStore())
    try:
        if args.once:
            with manager.acquire(owner.user_id) as bundle:
                print(chat(bundle.agent, args.once, args.thread))
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
            with manager.acquire(owner.user_id) as bundle:
                print("贾维斯:", chat(bundle.agent, text, args.thread))
    finally:
        manager.close()


if __name__ == "__main__":
    main()
