"""飞书 open_id ↔ 贾维斯账号绑定 + 一次性绑定码。

与微信桥「谁发命令绑谁」的确定性命令词同一思路，但飞书机器人对整个企业可见，
不能像微信那样默认把所有消息都交给唯一 Owner——未绑定的人一律只收到绑定指引。

- 绑定码：贾维斯用户登录后通过 POST /api/feishu/bind-code（或服务器上
  ``python -m jarvis.channels.feishu bind-code <用户名>``）领取 6 位数字码，10 分钟有效、一次性；
  再在飞书私聊机器人发「绑定 123456」。码只以 sha256 落盘，文件权限 0600，
  所以 API 进程与 CLI 进程可以共用。
- 防暴力：同一 open_id 每小时最多错 5 次，超过即锁定到窗口结束。
"""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import os
import secrets
import threading
import time
from pathlib import Path
from typing import Callable

from jarvis import config

BIND_CODE_TTL_SECONDS = 600
MAX_BIND_FAILURES = 5
BIND_FAILURE_WINDOW_SECONDS = 3600

_LOCK = threading.Lock()


def _digest(code: str) -> str:
    return hashlib.sha256(("feishu-bind-v1:" + code).encode("utf-8")).hexdigest()


def _read_json(path: Path) -> dict:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return payload if isinstance(payload, dict) else {}


def _write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    pending = path.with_name(path.name + ".tmp")
    fd = os.open(pending, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False)
    pending.replace(path)
    path.chmod(0o600)


class BindingStore:
    """open_id → user_id 的持久映射（JARVIS_DATA_DIR/feishu_bindings.json）。"""

    def __init__(self, data_dir_getter: Callable[[], Path] | None = None,
                 clock: Callable[[], float] = time.time) -> None:
        self._data_dir = data_dir_getter or config.data_dir
        self._clock = clock

    def _path(self) -> Path:
        return self._data_dir() / "feishu_bindings.json"

    def _codes_path(self) -> Path:
        return self._data_dir() / "feishu_bind_codes.json"

    def _bindings(self) -> dict:
        raw = _read_json(self._path()).get("bindings", {})
        return raw if isinstance(raw, dict) else {}

    def user_for(self, open_id: str) -> str | None:
        entry = self._bindings().get(open_id)
        user_id = entry.get("user_id") if isinstance(entry, dict) else None
        return user_id if isinstance(user_id, str) and user_id else None

    def bind(self, open_id: str, user_id: str) -> None:
        with _LOCK:
            bindings = self._bindings()
            bindings[open_id] = {
                "user_id": user_id,
                "bound_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
            }
            _write_json(self._path(), {"version": 1, "bindings": bindings})

    def unbind_open_id(self, open_id: str) -> bool:
        with _LOCK:
            bindings = self._bindings()
            if bindings.pop(open_id, None) is None:
                return False
            _write_json(self._path(), {"version": 1, "bindings": bindings})
            return True

    def unbind_user(self, user_id: str) -> int:
        with _LOCK:
            bindings = self._bindings()
            keep = {k: v for k, v in bindings.items() if not (isinstance(v, dict) and v.get("user_id") == user_id)}
            removed = len(bindings) - len(keep)
            if removed:
                _write_json(self._path(), {"version": 1, "bindings": keep})
            return removed

    def count_for(self, user_id: str) -> int:
        return sum(1 for v in self._bindings().values() if isinstance(v, dict) and v.get("user_id") == user_id)

    def all(self) -> dict[str, str]:
        return {k: v.get("user_id", "") for k, v in self._bindings().items() if isinstance(v, dict)}

    # ---- 一次性绑定码 ----

    def issue_code(self, user_id: str) -> str:
        """为某个贾维斯用户发一个新码；同一用户之前未用的码作废。"""
        code = f"{secrets.randbelow(1_000_000):06d}"
        now = self._clock()
        with _LOCK:
            state = _read_json(self._codes_path())
            codes = {k: v for k, v in (state.get("codes") or {}).items()
                     if isinstance(v, dict) and v.get("expires", 0) > now and v.get("user_id") != user_id}
            codes[_digest(code)] = {"user_id": user_id, "expires": now + BIND_CODE_TTL_SECONDS}
            state["codes"] = codes
            _write_json(self._codes_path(), state)
        return code

    def redeem(self, code: str, open_id: str) -> tuple[str, str | None]:
        """返回 ("ok", user_id) / ("invalid", None) / ("locked", None)。成功即绑定并销码。"""
        now = self._clock()
        with _LOCK:
            state = _read_json(self._codes_path())
            failures = {k: [t for t in v if isinstance(t, (int, float)) and t > now - BIND_FAILURE_WINDOW_SECONDS]
                        for k, v in (state.get("failures") or {}).items() if isinstance(v, list)}
            failures = {k: v for k, v in failures.items() if v}
            if len(failures.get(open_id, [])) >= MAX_BIND_FAILURES:
                state["failures"] = failures
                _write_json(self._codes_path(), state)
                return "locked", None
            codes = {k: v for k, v in (state.get("codes") or {}).items()
                     if isinstance(v, dict) and v.get("expires", 0) > now}
            entry = codes.pop(_digest(code.strip()), None)
            if entry is None:
                failures.setdefault(open_id, []).append(now)
                state.update(codes=codes, failures=failures)
                _write_json(self._codes_path(), state)
                return "invalid", None
            failures.pop(open_id, None)
            state.update(codes=codes, failures=failures)
            _write_json(self._codes_path(), state)
        user_id = str(entry.get("user_id", ""))
        if not user_id:
            return "invalid", None
        self.bind(open_id, user_id)
        return "ok", user_id
