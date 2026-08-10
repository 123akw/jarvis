"""网页端后端：FastAPI。/api/chat 走 SSE 流式（含工具调用事件），/api/dashboard 供仪表盘。"""
import datetime
import json
import os
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse, StreamingResponse
from langchain_core.messages import AIMessageChunk, ToolMessage
from pydantic import BaseModel

from jarvis import __version__, config
from jarvis.graph import build_agent
from jarvis.tools.memo import all_memos
from jarvis.tools.schedule import all_schedule
from jarvis.tools.todo import all_todos

app = FastAPI(title="J.A.R.V.I.S.")
_WEB = Path(__file__).parent / "web"
_agent = None
_started = datetime.datetime.now()
_chat_count = 0


def _get_agent():
    global _agent
    if _agent is None:
        _agent = build_agent()
    return _agent


def _sse(obj: dict) -> str:
    return f"data: {json.dumps(obj, ensure_ascii=False)}\n\n"


@app.get("/")
def index():
    return FileResponse(_WEB / "index.html")


@app.get("/api/dashboard")
def dashboard():
    pending = [t for t in all_todos() if not t["done"]]
    done = len(all_todos()) - len(pending)
    return {
        "version": __version__,
        "model": config.model_name(),
        "time": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "uptime_min": int((datetime.datetime.now() - _started).total_seconds() // 60),
        "chats": _chat_count,
        "memos": all_memos(),
        "schedule": all_schedule(),
        "todos": pending,
        "todos_done": done,
    }


class ChatIn(BaseModel):
    message: str
    thread_id: str = "web"


def _chunk_text(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(p.get("text", "") for p in content if isinstance(p, dict))
    return ""


@app.post("/api/chat")
def chat(body: ChatIn):
    def gen():
        global _chat_count
        _chat_count += 1
        seen_calls: set[str] = set()
        try:
            for chunk, _meta in _get_agent().stream(
                {"messages": [{"role": "user", "content": body.message}]},
                config={"configurable": {"thread_id": body.thread_id}},
                stream_mode="messages",
            ):
                if isinstance(chunk, ToolMessage):
                    yield _sse({"type": "tool_result", "name": chunk.name})
                elif isinstance(chunk, AIMessageChunk):
                    for tc in chunk.tool_call_chunks or []:
                        name, cid = tc.get("name"), tc.get("id")
                        if name and cid and cid not in seen_calls:
                            seen_calls.add(cid)
                            yield _sse({"type": "tool_start", "name": name})
                    text = _chunk_text(chunk.content)
                    if text:
                        yield _sse({"type": "token", "text": text})
            yield _sse({"type": "done"})
        except Exception as e:  # 网络/模型异常兜底，前端提示而不是断流
            yield _sse({"type": "error", "message": f"{type(e).__name__}: {e}"})

    return StreamingResponse(
        gen(), media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


def run() -> None:
    import uvicorn

    config.load_env()
    port = int(os.getenv("JARVIS_PORT", "7789"))
    print(f"J.A.R.V.I.S. 网页端已上线：http://127.0.0.1:{port}")
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")


if __name__ == "__main__":
    run()
