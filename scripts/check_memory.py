"""记忆检查：两个独立进程先后对话，第二个必须加载到第一个存的历史。PASS 退出 0，否则非 0。"""
import sqlite3
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
DB = ROOT / "data" / "jarvis.db"


def run_once(text: str) -> None:
    proc = subprocess.run(
        [sys.executable, "-m", "jarvis.cli", "--once", text],
        cwd=ROOT, capture_output=True, text=True, timeout=120,
    )
    print(f"$ --once {text!r}\n{proc.stdout.strip()}")
    if proc.returncode != 0:
        print(proc.stderr)
        raise SystemExit(f"FAIL：子进程退出码 {proc.returncode}")


def main() -> int:
    for f in DB.parent.glob("jarvis.db*"):
        f.unlink()
    run_once("记住：周三交电费")
    run_once("我让你记过什么？")

    if not DB.exists():
        print("FAIL：data/jarvis.db 不存在，记忆没有落盘")
        return 1
    from langgraph.checkpoint.sqlite import SqliteSaver
    saver = SqliteSaver(sqlite3.connect(str(DB), check_same_thread=False))
    tup = saver.get_tuple({"configurable": {"thread_id": "main"}})
    if tup is None:
        print("FAIL：thread main 没有任何检查点")
        return 1
    msgs = tup.checkpoint["channel_values"]["messages"]
    humans = [m for m in msgs if m.type == "human"]
    if len(msgs) < 4 or len(humans) < 2:
        print(f"FAIL：历史消息 {len(msgs)} 条（人类 {len(humans)} 条），"
              "第二个进程没有加载到第一个进程的历史")
        return 1
    print(f"PASS：跨进程历史共 {len(msgs)} 条消息（人类 {len(humans)} 条），记忆持久化成立")
    return 0


if __name__ == "__main__":
    sys.exit(main())
