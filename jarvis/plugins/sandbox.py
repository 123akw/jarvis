"""第三方插件在子进程里执行（隔离原则第 5 条）。

- 独立解释器：``sys.executable -I sandbox_runner.py``（忽略 PYTHON* 环境变量与用户 site-packages）；
- 最小环境变量：只给 PATH / LANG / HOME / TMPDIR，**不继承**主进程的任何变量（模型 key、飞书密钥……）；
- 限时：超时就杀掉整个进程组；子进程里另设 CPU 秒数与写文件大小上限；
- 每次调用一个新的临时工作目录，用完即删；
- 只传文本：参数是 JSON，结果是一段文字（≤ 8000 字）。崩溃、超时、输出不合法都只影响这一次调用。
"""
from __future__ import annotations

import json
import logging
import os
import shutil
import signal
import subprocess
import sys
import tempfile
from pathlib import Path

log = logging.getLogger(__name__)

RUNNER = Path(__file__).with_name("sandbox_runner.py")
DEFAULT_TIMEOUT = 20.0
DESCRIBE_TIMEOUT = 15.0
MAX_OUTPUT_BYTES = 256 * 1024


class SandboxError(RuntimeError):
    """子进程执行失败；message 是人话（不含插件输出的原文细节以外的东西）。"""


def minimal_env(workdir: str) -> dict[str, str]:
    return {
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "HOME": workdir,
        "TMPDIR": workdir,
        "PYTHONDONTWRITEBYTECODE": "1",
    }


def _kill(process: subprocess.Popen) -> None:
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError, OSError):
        try:
            process.kill()
        except OSError:
            pass


def run(mode: str, folder: Path, entry: str, *, tool: str = "", args: dict | None = None,
        timeout: float = DEFAULT_TIMEOUT) -> dict:
    """起一个子进程跑 describe / call，返回 runner 的那行 JSON（dict）。"""
    workdir = tempfile.mkdtemp(prefix="jarvis-plugin-")
    request = {"dir": str(folder), "entry": entry, "tool": tool, "args": args or {}, "limit": timeout,
               "workdir": workdir}
    try:
        process = subprocess.Popen(
            [sys.executable, "-I", "-B", str(RUNNER), mode],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            cwd=workdir, env=minimal_env(workdir), start_new_session=True, close_fds=True,
        )
    except OSError as exc:
        shutil.rmtree(workdir, ignore_errors=True)
        raise SandboxError("插件进程没能启动") from exc
    try:
        try:
            out, _ = process.communicate(json.dumps(request, ensure_ascii=False).encode("utf-8") + b"\n",
                                         timeout=timeout)
        except subprocess.TimeoutExpired:
            _kill(process)
            process.communicate()
            raise SandboxError(f"超时（超过 {int(timeout)} 秒）") from None
        finally:
            if process.poll() is None:
                _kill(process)
        lines = [line for line in out[-MAX_OUTPUT_BYTES:].splitlines() if line.strip()]
        if not lines:
            raise SandboxError("插件进程意外退出" + (f"（退出码 {process.returncode}）" if process.returncode else ""))
        try:
            reply = json.loads(lines[-1].decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise SandboxError("插件返回的结果格式不对") from None
        if not isinstance(reply, dict):
            raise SandboxError("插件返回的结果格式不对")
        return reply
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


def describe(folder: Path, entry: str, *, timeout: float = DESCRIBE_TIMEOUT) -> list[dict]:
    """在子进程里导入插件，读出工具清单 [{name, description, parameters}]。"""
    reply = run("describe", folder, entry, timeout=timeout)
    if not reply.get("ok"):
        raise SandboxError(f"插件代码加载失败（{str(reply.get('error') or '未知错误')[:120]}）")
    tools = reply.get("tools")
    if not isinstance(tools, list):
        raise SandboxError("插件没有导出 TOOLS")
    clean = []
    for item in tools:
        if not isinstance(item, dict) or not isinstance(item.get("name"), str):
            continue
        params = item.get("parameters") if isinstance(item.get("parameters"), dict) else {}
        if params.get("type") != "object":
            params = {"type": "object", "properties": {}}
        clean.append({"name": item["name"][:64], "description": str(item.get("description") or "")[:1000],
                      "parameters": params})
    return clean


def call(folder: Path, entry: str, tool: str, args: dict, *, timeout: float = DEFAULT_TIMEOUT) -> str:
    """在子进程里调一次工具，返回文字结果；失败抛 SandboxError。"""
    reply = run("call", folder, entry, tool=tool, args=args, timeout=timeout)
    if not reply.get("ok"):
        error = str(reply.get("error") or "未知错误")
        log.info("sandboxed plugin tool failed: %s", error.split(":", 1)[0][:60])
        raise SandboxError(f"插件代码报错（{error[:160]}）")
    text = reply.get("text")
    return text if isinstance(text, str) else json.dumps(text, ensure_ascii=False)
