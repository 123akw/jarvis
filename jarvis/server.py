"""网页端后端：FastAPI。自研登录（cookie 会话）+ SSE 流式聊天 + 仪表盘接口。"""
import datetime
import hashlib
import hmac
import json
import os
import secrets
import time
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
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

_USER = "admin"
_PASSWORD = "admin"  # 领导点名的口令；公网弱口令风险已当面提示
_COOKIE = "jws_session"
_SESSION_DAYS = 30


def _secret() -> bytes:
    """会话签名密钥，落盘持久化，重启不掉登录态。"""
    p = config.data_dir() / "session_secret"
    if not p.exists():
        p.write_text(secrets.token_hex(32), encoding="utf-8")
        p.chmod(0o600)
    return p.read_text(encoding="utf-8").strip().encode()


def _session_token() -> str:
    return hmac.new(_secret(), b"jws-session-v1", hashlib.sha256).hexdigest()


def _authed(request: Request) -> bool:
    got = request.cookies.get(_COOKIE, "")
    return bool(got) and hmac.compare_digest(got, _session_token())


def _deny() -> JSONResponse:
    return JSONResponse({"error": "未登录"}, status_code=401)


def _get_agent():
    global _agent
    if _agent is None:
        _agent = build_agent()
    return _agent


def _sse(obj: dict) -> str:
    return f"data: {json.dumps(obj, ensure_ascii=False)}\n\n"


# ---------- 登录 ----------

class LoginIn(BaseModel):
    username: str
    password: str


@app.post("/api/login")
def login(body: LoginIn):
    ok = hmac.compare_digest(body.username, _USER) and hmac.compare_digest(body.password, _PASSWORD)
    if not ok:
        time.sleep(0.8)  # 失败节流，拖慢暴力猜解
        return JSONResponse({"error": "账号或口令不对"}, status_code=401)
    resp = JSONResponse({"ok": True})
    resp.set_cookie(
        _COOKIE, _session_token(), max_age=_SESSION_DAYS * 86400,
        httponly=True, samesite="lax", path="/",
    )
    return resp


@app.post("/api/logout")
def logout():
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(_COOKIE, path="/")
    return resp


@app.get("/api/session")
def session(request: Request):
    return {"authed": _authed(request)}


# ---------- 业务接口（登录后可用） ----------

@app.get("/api/dashboard")
def dashboard(request: Request):
    if not _authed(request):
        return _deny()
    todos = all_todos()
    pending = [t for t in todos if not t["done"]]
    return {
        "version": __version__,
        "model": config.model_name(),
        "time": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "uptime_min": int((datetime.datetime.now() - _started).total_seconds() // 60),
        "chats": _chat_count,
        "memos": all_memos(),
        "schedule": all_schedule(),
        "todos": pending,
        "todos_done": len(todos) - len(pending),
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
def chat(request: Request, body: ChatIn):
    if not _authed(request):
        return _deny()

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


# ---------- 静态页 ----------

@app.get("/")
def index():
    return FileResponse(_WEB / "index.html")


if (_WEB / "assets").is_dir():
    app.mount("/assets", StaticFiles(directory=_WEB / "assets"), name="assets")


def run() -> None:
    import uvicorn

    config.load_env()
    port = int(os.getenv("JARVIS_PORT", "7789"))
    print(f"J.A.R.V.I.S. 网页端已上线：http://127.0.0.1:{port}")
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")


if __name__ == "__main__":
    run()
