"""冒烟检查：调真模型问时间，必须真的走了一次工具调用。PASS 退出 0，否则非 0。"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from jarvis.graph import build_agent  # noqa: E402


def main() -> int:
    agent = build_agent()
    result = agent.invoke(
        {"messages": [{"role": "user", "content": "现在几点了？"}]},
        config={"configurable": {"thread_id": "smoke"}},
    )
    msgs = result["messages"]
    last_human = max(i for i, m in enumerate(msgs) if m.type == "human")
    tool_msgs = [m for m in msgs[last_human:] if m.type == "tool"]
    final = msgs[-1]
    print("贾维斯回复：", final.content)
    if not tool_msgs:
        print("FAIL：本轮没有任何工具调用（ToolMessage=0）")
        return 1
    if final.type != "ai" or not str(final.content).strip():
        print("FAIL：最终回复为空或不是 AI 消息")
        return 1
    print(f"PASS：本轮工具调用 {len(tool_msgs)} 次，回复非空")
    return 0


if __name__ == "__main__":
    sys.exit(main())
