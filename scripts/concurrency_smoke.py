#!/usr/bin/env python3
"""网页端并发冒烟：N 路真实 /api/chat 并发时，/api/dashboard 的 P95 必须 < 2s。

用法：
    .venv/bin/python scripts/concurrency_smoke.py [--chats 3] [--dashboards 20]

- 自己拉起本地服务（端口取 JARVIS_PORT，缺省自动找空闲端口）；
- 独立临时数据目录，用 JARVIS_ADMIN_USERNAME/PASSWORD 引导 Owner 并登录；
- 聊天走真实模型（.env 提供的环境配置），问「现在几点」类快问题；
- 聊天在飞行中时并发打 20 次 /api/dashboard，打印每次延迟与 P95；
- 退出码 0 当且仅当：所有聊天真实完成（收到 token + done）且 P95 < 2000ms。
"""
from __future__ import annotations

import argparse
import math
import os
import secrets
import socket
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parent.parent
P95_BUDGET_MS = 2000.0


def find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def wait_ready(base: str, timeout: float = 90.0) -> None:
    deadline = time.monotonic() + timeout
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        try:
            response = httpx.get(f"{base}/api/session", timeout=5)
            if response.status_code == 200:
                return
        except Exception as exc:  # 服务还没起来
            last_error = exc
        time.sleep(0.5)
    raise RuntimeError(f"服务 {base} 在 {timeout}s 内未就绪: {last_error}")


def run_chat(client: httpx.Client, base: str, csrf: str, index: int, results: list) -> None:
    started = time.monotonic()
    tokens = 0
    done = False
    error = ""
    try:
        with client.stream(
            "POST",
            f"{base}/api/chat",
            json={"message": "现在几点了？直接告诉我时间。", "thread_id": f"smoke-{index}"},
            headers={"X-JWS-CSRF": csrf},
            timeout=httpx.Timeout(180, connect=10),
        ) as response:
            if response.status_code != 200:
                error = f"HTTP {response.status_code}"
            else:
                for line in response.iter_lines():
                    if not line.startswith("data: "):
                        continue
                    payload = line[len("data: "):]
                    if '"type": "token"' in payload or '"type":"token"' in payload:
                        tokens += 1
                    elif '"type": "done"' in payload or '"type":"done"' in payload:
                        done = True
                    elif '"type": "error"' in payload or '"type":"error"' in payload:
                        error = payload
    except Exception as exc:
        error = f"{type(exc).__name__}: {exc}"
    results.append({
        "index": index,
        "seconds": time.monotonic() - started,
        "tokens": tokens,
        "done": done,
        "error": error,
    })


def run_dashboard(client: httpx.Client, base: str, latencies: list, errors: list) -> None:
    started = time.monotonic()
    try:
        response = client.get(f"{base}/api/dashboard", timeout=30)
        elapsed_ms = (time.monotonic() - started) * 1000
        if response.status_code == 200:
            latencies.append(elapsed_ms)
        else:
            errors.append(f"HTTP {response.status_code}")
    except Exception as exc:
        errors.append(f"{type(exc).__name__}: {exc}")


def p95(values: list[float]) -> float:
    ordered = sorted(values)
    rank = max(0, min(len(ordered) - 1, math.ceil(0.95 * len(ordered)) - 1))
    return ordered[rank]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--chats", type=int, default=3, help="并发聊天路数（默认 3）")
    parser.add_argument("--dashboards", type=int, default=20, help="并发 dashboard 次数（默认 20）")
    args = parser.parse_args()

    port = int(os.getenv("JARVIS_PORT", "0")) or find_free_port()
    base = f"http://127.0.0.1:{port}"
    data_dir = tempfile.mkdtemp(prefix="jarvis-smoke-")
    admin_user, admin_pass = "smoke-owner", secrets.token_hex(12)

    env = dict(os.environ)
    env.update(
        JARVIS_PORT=str(port),
        JARVIS_DATA_DIR=data_dir,
        JARVIS_ADMIN_USERNAME=admin_user,
        JARVIS_ADMIN_PASSWORD=admin_pass,
        JARVIS_SESSION_SECRET=secrets.token_hex(32),
        JARVIS_ENV="development",
        JARVIS_ALLOW_INSECURE_COOKIE="1",
    )
    log_path = Path(data_dir) / "server.log"
    print(f"[smoke] 启动服务 port={port} data_dir={data_dir}")
    with log_path.open("wb") as log_file:
        server = subprocess.Popen(
            [sys.executable, "-c", "from jarvis.server import run; run()"],
            cwd=ROOT, env=env, stdout=log_file, stderr=subprocess.STDOUT,
        )
    try:
        wait_ready(base)

        client = httpx.Client(base_url=base)
        login = client.post("/api/login", json={"username": admin_user, "password": admin_pass})
        if login.status_code != 200:
            print(f"[smoke] 登录失败: HTTP {login.status_code} {login.text}")
            return 1
        csrf = client.get("/api/session").json().get("csrf_token", "")
        if not csrf:
            print("[smoke] 未取得 CSRF token")
            return 1
        print(f"[smoke] Owner 引导+登录成功（{admin_user}）")

        chat_results: list[dict] = []
        chat_threads = [
            threading.Thread(target=run_chat, args=(client, base, csrf, i, chat_results))
            for i in range(args.chats)
        ]
        window_start = time.monotonic()
        for thread in chat_threads:
            thread.start()
        time.sleep(0.5)  # 让聊天真正进入模型调用

        latencies: list[float] = []
        dash_errors: list[str] = []
        dash_threads = [
            threading.Thread(target=run_dashboard, args=(client, base, latencies, dash_errors))
            for _ in range(args.dashboards)
        ]
        for thread in dash_threads:
            thread.start()
        for thread in dash_threads:
            thread.join()
        dash_window = time.monotonic() - window_start

        for thread in chat_threads:
            thread.join()

        print(f"[smoke] chat 并发 {args.chats} 路（dashboard 压测发生在 chat 启动后 0.5s~{dash_window:.1f}s 窗口内）:")
        chat_ok = True
        for item in sorted(chat_results, key=lambda x: x["index"]):
            status = "OK" if item["done"] and item["tokens"] > 0 and not item["error"] else f"FAIL {item['error']}"
            print(f"  chat[{item['index']}] {item['seconds']:.1f}s tokens={item['tokens']} done={item['done']} -> {status}")
            if not (item["done"] and item["tokens"] > 0 and not item["error"]):
                chat_ok = False

        if dash_errors:
            print(f"[smoke] dashboard 出错 {len(dash_errors)} 次: {dash_errors[:3]}")
        if not latencies:
            print("[smoke] 没有成功的 dashboard 样本")
            return 1
        print(f"[smoke] dashboard 延迟 ms（{len(latencies)} 次并发）: "
              + ", ".join(f"{v:.0f}" for v in sorted(latencies)))
        value = p95(latencies)
        print(f"[smoke] dashboard P95 = {value:.0f} ms（预算 {P95_BUDGET_MS:.0f} ms）")

        if not chat_ok:
            print("[smoke] 失败：有聊天未真实完成（缺 token/done 或报错）")
            return 1
        if dash_errors:
            print("[smoke] 失败：dashboard 有报错样本")
            return 1
        if value >= P95_BUDGET_MS:
            print("[smoke] 失败：dashboard P95 超预算")
            return 1
        print("[smoke] 通过：聊天全部真实完成，dashboard P95 在预算内")
        return 0
    finally:
        server.terminate()
        try:
            server.wait(timeout=10)
        except subprocess.TimeoutExpired:
            server.kill()
        tail = log_path.read_text(encoding="utf-8", errors="replace").strip().splitlines()[-5:]
        if tail:
            print("[smoke] server.log 尾部: " + " | ".join(tail))


if __name__ == "__main__":
    sys.exit(main())
