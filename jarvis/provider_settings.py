"""Encrypted, generation-based per-user Provider settings.

The active manifest is deliberately non-secret.  Every managed snapshot is
authenticated encryption; individual credentials are additionally bound to
their owner/provider/origin/generation before the outer snapshot is sealed.
"""
from __future__ import annotations

import base64
from contextlib import contextmanager
from copy import deepcopy
from dataclasses import dataclass
import fcntl
import hashlib
import json
import os
from pathlib import Path
import threading
import time
from typing import Any, Callable
from urllib.parse import urlsplit, urlunsplit

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from jarvis import config


CATALOG = (
    {"id": "openai", "name": "OpenAI 官方", "base_url": "https://api.openai.com/v1", "key_url": "https://platform.openai.com/api-keys", "editable": False},
    {"id": "deepseek", "name": "DeepSeek 官方", "base_url": "https://api.deepseek.com", "key_url": "https://platform.deepseek.com/api_keys", "editable": False},
    {"id": "bailian", "name": "阿里云百炼", "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1", "key_url": "https://help.aliyun.com/zh/model-studio/get-api-key", "editable": True},
    {"id": "siliconflow", "name": "SiliconFlow", "base_url": "https://api.siliconflow.cn/v1", "key_url": "https://cloud.siliconflow.cn/account/ak", "editable": False},
    {"id": "custom", "name": "自定义中转", "base_url": "", "key_url": "", "editable": True},
)
_CATALOG = {item["id"]: item for item in CATALOG}
_OFFICIAL_HOSTS = {
    "openai": "api.openai.com",
    "deepseek": "api.deepseek.com",
    "bailian": "dashscope.aliyuncs.com",
    "siliconflow": "api.siliconflow.cn",
}
_INTEGRATIONS = frozenset(("searxng", "tavily", "pandascore"))


class ProviderSettingsError(RuntimeError):
    def __init__(self, code: str, message: str, *, status: int = 400):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


class ConfigConflict(ProviderSettingsError):
    def __init__(self):
        super().__init__("CONFIG_CONFLICT", "配置已被更新，请刷新后重试", status=409)


class ManagedConfigUnavailable(ProviderSettingsError):
    def __init__(self):
        super().__init__("READ_ONLY", "托管配置存在，但服务器主密钥不可用", status=503)


def _master_key(value: str | None) -> bytes | None:
    raw = (value if value is not None else os.getenv("JARVIS_SECRETS_KEY", "")).strip()
    if not raw:
        return None
    try:
        decoded = base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4))
    except (ValueError, TypeError):
        return None
    return decoded if len(decoded) == 32 else None


def normalize_base_url(provider: str, value: str) -> str:
    if provider not in _CATALOG:
        raise ProviderSettingsError("INVALID_URL", "未知模型 Provider")
    raw = (value or _CATALOG[provider]["base_url"]).strip()
    try:
        parsed = urlsplit(raw)
    except ValueError:
        raise ProviderSettingsError("INVALID_URL", "API 地址格式无效") from None
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        raise ProviderSettingsError("INVALID_URL", "API 地址必须是无凭据的 HTTPS 地址")
    if parsed.query or parsed.fragment:
        raise ProviderSettingsError("INVALID_URL", "API 地址不能包含查询参数或片段")
    host = parsed.hostname.lower().rstrip(".")
    if provider in _OFFICIAL_HOSTS and host != _OFFICIAL_HOSTS[provider]:
        raise ProviderSettingsError("INVALID_URL", "官方 Provider 只能使用官方主机")
    if provider != "custom" and parsed.port not in (None, 443):
        raise ProviderSettingsError("INVALID_URL", "官方 Provider 不允许自定义端口")
    netloc = host if parsed.port in (None, 443) else f"{host}:{parsed.port}"
    path = (parsed.path or "").rstrip("/")
    return urlunsplit(("https", netloc, path, "", ""))


def credential_scope(provider: str, base_url: str) -> str:
    parsed = urlsplit(normalize_base_url(provider, base_url))
    port = parsed.port or 443
    return f"{provider}|{parsed.scheme}://{parsed.hostname}:{port}"


def normalize_searxng_url(value: str) -> str:
    raw = value.strip().rstrip("/")
    if raw in {"http://127.0.0.1:18888", "http://[::1]:18888"}:
        return raw
    parsed = urlsplit(raw)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ProviderSettingsError("INVALID_URL", "SearXNG 仅允许公开 HTTPS 或本机 18888")
    return urlunsplit(("https", parsed.netloc.lower(), parsed.path.rstrip("/"), "", ""))


@dataclass(frozen=True)
class ResolvedLLM:
    provider: str
    base_url: str
    model: str
    api_key: str
    generation: int
    source: str


class SecretStore:
    """Immutable encrypted generations with atomic manifest CAS."""

    def __init__(self, data_dir: Path | None = None, *, master_key: str | None = None,
                 write_enabled: bool | None = None, now: Callable[[], float] = time.time):
        self.data_dir = data_dir or config.data_dir()
        self.generations = self.data_dir / "provider-generations"
        self.manifest = self.data_dir / "provider-active.json"
        self.lock_path = self.data_dir / "provider-settings.lock"
        self.audit_path = self.data_dir / "provider-audit.jsonl"
        self._key = _master_key(master_key)
        self._write_enabled = (os.getenv("JARVIS_SETTINGS_WRITE_ENABLED", "").lower() in {"1", "true", "yes"}) if write_enabled is None else bool(write_enabled)
        self._now = now
        self._thread_lock = threading.RLock()

    @property
    def writable(self) -> bool:
        return bool(self._write_enabled and self._key)

    @contextmanager
    def _locked(self):
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.data_dir.chmod(0o700)
        with self._thread_lock:
            with self.lock_path.open("a+b") as handle:
                self.lock_path.chmod(0o600)
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
                try:
                    yield
                finally:
                    fcntl.flock(handle.fileno(), fcntl.LOCK_UN)

    @staticmethod
    def _empty_snapshot() -> dict[str, Any]:
        return {"version": 1, "root_generation": 0, "users": {}, "integrations": {"generation": 0, "items": {}}}

    def _read_manifest(self) -> dict[str, Any] | None:
        if not self.manifest.exists():
            return None
        try:
            value = json.loads(self.manifest.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            raise ManagedConfigUnavailable() from None
        return value if isinstance(value, dict) else None

    def _decrypt_generation(self, generation: int, digest: str) -> dict[str, Any]:
        if not self._key:
            raise ManagedConfigUnavailable()
        path = self.generations / f"{generation}.enc"
        payload = path.read_bytes()
        if hashlib.sha256(payload).hexdigest() != digest:
            raise ValueError("generation digest mismatch")
        envelope = json.loads(payload)
        nonce = base64.urlsafe_b64decode(envelope["nonce"])
        ciphertext = base64.urlsafe_b64decode(envelope["ciphertext"])
        plain = AESGCM(self._key).decrypt(nonce, ciphertext, f"jws-generation-v1\0{generation}".encode())
        value = json.loads(plain)
        if value.get("root_generation") != generation:
            raise ValueError("generation identity mismatch")
        return value

    def _load(self) -> tuple[dict[str, Any], dict[str, Any] | None]:
        manifest = self._read_manifest()
        if not manifest:
            return self._empty_snapshot(), None
        if manifest.get("mode") == "environment":
            snapshot = manifest.get("snapshot")
            if not isinstance(snapshot, dict):
                raise ManagedConfigUnavailable()
            return snapshot, manifest
        if not self._key:
            raise ManagedConfigUnavailable()
        attempts = (
            (manifest.get("active_generation"), manifest.get("sha256")),
            (manifest.get("previous_generation"), manifest.get("previous_sha256")),
        )
        for generation, digest in attempts:
            if isinstance(generation, int) and generation > 0 and isinstance(digest, str):
                try:
                    return self._decrypt_generation(generation, digest), manifest
                except Exception:
                    continue
        raise ManagedConfigUnavailable()

    def _secret_aad(self, owner: str, provider: str, origin: str, generation: int) -> bytes:
        return f"jws-secret-v1\0{owner}\0{provider}\0{origin}\0{generation}".encode()

    def _seal_secret(self, value: str, owner: str, provider: str, origin: str, generation: int) -> dict[str, str]:
        if not self._key:
            raise ProviderSettingsError("READ_ONLY", "服务器主密钥未配置", status=503)
        nonce = os.urandom(12)
        cipher = AESGCM(self._key).encrypt(nonce, value.encode(), self._secret_aad(owner, provider, origin, generation))
        return {"nonce": base64.urlsafe_b64encode(nonce).decode(), "ciphertext": base64.urlsafe_b64encode(cipher).decode()}

    def _open_secret(self, record: dict[str, str], owner: str, provider: str, origin: str, generation: int) -> str:
        if not self._key:
            raise ManagedConfigUnavailable()
        try:
            nonce = base64.urlsafe_b64decode(record["nonce"])
            ciphertext = base64.urlsafe_b64decode(record["ciphertext"])
            return AESGCM(self._key).decrypt(nonce, ciphertext, self._secret_aad(owner, provider, origin, generation)).decode()
        except Exception:
            raise ManagedConfigUnavailable() from None

    def _has_managed(self, snapshot: dict[str, Any]) -> bool:
        if any(row.get("llm") is not None for row in snapshot["users"].values()):
            return True
        return bool(snapshot["integrations"]["items"])

    @staticmethod
    def _atomic(path: Path, content: bytes, mode: int = 0o600) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(f".{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
        try:
            with temporary.open("xb") as handle:
                handle.write(content)
                handle.flush()
                os.fsync(handle.fileno())
            temporary.chmod(mode)
            os.replace(temporary, path)
            path.chmod(mode)
            directory_fd = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        finally:
            temporary.unlink(missing_ok=True)

    def _persist(self, snapshot: dict[str, Any], prior: dict[str, Any] | None) -> None:
        generation = snapshot["root_generation"]
        previous_generation = prior.get("active_generation") if prior else None
        previous_sha = prior.get("sha256") if prior else None
        if not self._has_managed(snapshot):
            manifest = {"version": 1, "mode": "environment", "active_generation": generation,
                        "previous_generation": previous_generation, "previous_sha256": previous_sha,
                        "snapshot": snapshot}
            self._atomic(self.manifest, json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode())
            return
        if not self._key:
            raise ProviderSettingsError("READ_ONLY", "服务器主密钥未配置", status=503)
        nonce = os.urandom(12)
        plain = json.dumps(snapshot, sort_keys=True, separators=(",", ":")).encode()
        encrypted = AESGCM(self._key).encrypt(nonce, plain, f"jws-generation-v1\0{generation}".encode())
        payload = json.dumps({"nonce": base64.urlsafe_b64encode(nonce).decode(),
                              "ciphertext": base64.urlsafe_b64encode(encrypted).decode()},
                             sort_keys=True, separators=(",", ":")).encode()
        target = self.generations / f"{generation}.enc"
        self._atomic(target, payload)
        digest = hashlib.sha256(payload).hexdigest()
        manifest = {"version": 1, "mode": "managed", "active_generation": generation,
                    "previous_generation": previous_generation, "sha256": digest,
                    "previous_sha256": previous_sha}
        self._atomic(self.manifest, json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode())

    def _environment_llm(self) -> ResolvedLLM:
        provider = os.getenv("JARVIS_PROVIDER", "deepseek").strip().lower() or "deepseek"
        base = normalize_base_url(provider, os.getenv("JARVIS_BASE_URL", "") or _CATALOG.get(provider, _CATALOG["deepseek"])["base_url"])
        model = os.getenv("JARVIS_MODEL", "deepseek-chat").strip() or "deepseek-chat"
        key = os.getenv("JARVIS_API_KEY", "").strip()
        if not key and provider == "openai": key = os.getenv("OPENAI_API_KEY", "").strip()
        if not key and provider == "deepseek": key = os.getenv("DEEPSEEK_API_KEY", "").strip()
        return ResolvedLLM(provider, base, model, key, 0, "environment")

    def resolved_llm(self, user_id: str) -> ResolvedLLM:
        with self._locked():
            snapshot, _ = self._load()
        row = snapshot["users"].get(user_id, {"generation": 0, "llm": None})
        managed = row.get("llm")
        if managed is None:
            env = self._environment_llm()
            return ResolvedLLM(env.provider, env.base_url, env.model, env.api_key, int(row.get("generation", 0)), "environment")
        generation = int(row["generation"])
        key = self._open_secret(managed["secret"], user_id, managed["provider"], managed["origin"], generation)
        return ResolvedLLM(managed["provider"], managed["base_url"], managed["model"], key, generation, "managed")

    def status(self, user_id: str, *, owner: bool) -> dict[str, Any]:
        with self._locked():
            snapshot, _ = self._load()
        row = snapshot["users"].get(user_id, {"generation": 0, "llm": None})
        managed = row.get("llm")
        if managed is None:
            llm = self._environment_llm()
            llm_status = {"provider": llm.provider, "base_url": llm.base_url, "model": llm.model,
                          "key_configured": bool(llm.api_key), "source": "environment",
                          "generation": int(row.get("generation", 0))}
        else:
            llm_status = {"provider": managed["provider"], "base_url": managed["base_url"],
                          "model": managed["model"], "key_configured": True, "source": "managed",
                          "generation": int(row["generation"])}
        integrations = self._integration_status(snapshot) if owner else {}
        return {"writable": self.writable, "llm": llm_status, "integrations": integrations,
                "catalog": [dict(item) for item in CATALOG]}

    def _integration_status(self, snapshot: dict[str, Any]) -> dict[str, Any]:
        generation = int(snapshot["integrations"].get("generation", 0))
        items = snapshot["integrations"].get("items", {})
        result = {}
        for name in sorted(_INTEGRATIONS):
            row = items.get(name)
            if row is None:
                if name == "searxng": configured = bool(os.getenv("SEARXNG_BASE_URL", "").strip())
                elif name == "tavily": configured = bool(os.getenv("TAVILY_API_KEY", "").strip())
                else: configured = bool(os.getenv("PANDASCORE_TOKEN", "").strip())
                result[name] = {"enabled": configured, "source": "environment",
                                "key_configured": configured if name != "searxng" else False,
                                "healthy": None, "generation": generation}
                if name == "searxng":
                    result[name]["base_url"] = os.getenv("SEARXNG_BASE_URL", "").strip()
            else:
                result[name] = {"enabled": bool(row["enabled"]), "source": "managed",
                                "key_configured": bool(row.get("secret")), "healthy": row.get("healthy"),
                                "generation": generation}
                if name == "searxng": result[name]["base_url"] = row.get("base_url", "")
        return result

    def commit_llm(self, user_id: str, candidate: dict[str, Any], *, expected_generation: int,
                   keep_existing_key: bool = False, action: str = "save") -> ResolvedLLM:
        if not self.writable:
            raise ProviderSettingsError("READ_ONLY", "设置写入未启用或主密钥未配置", status=403)
        provider = str(candidate.get("provider", "")).strip().lower()
        base = normalize_base_url(provider, str(candidate.get("base_url", "")))
        model = str(candidate.get("model", "")).strip()
        if not model or len(model) > 200:
            raise ProviderSettingsError("MODEL_NOT_FOUND", "模型名称无效")
        supplied_key = str(candidate.get("api_key", "") or "")
        with self._locked():
            snapshot, manifest = self._load()
            row = snapshot["users"].get(user_id, {"generation": 0, "llm": None})
            if int(row.get("generation", 0)) != expected_generation:
                raise ConfigConflict()
            new_generation = expected_generation + 1
            scope = credential_scope(provider, base)
            if not supplied_key and keep_existing_key:
                current = row.get("llm")
                if not current or current.get("origin") != scope:
                    raise ProviderSettingsError("PROVIDER_AUTH", "Provider 或地址变化后必须填写新 API Key")
                supplied_key = self._open_secret(current["secret"], user_id, current["provider"], current["origin"], expected_generation)
            if not supplied_key:
                raise ProviderSettingsError("PROVIDER_AUTH", "请填写 API Key")
            updated = deepcopy(snapshot)
            updated["root_generation"] = int(snapshot["root_generation"]) + 1
            updated["users"][user_id] = {"generation": new_generation, "llm": {
                "provider": provider, "base_url": base, "model": model, "origin": scope,
                "secret": self._seal_secret(supplied_key, user_id, provider, scope, new_generation),
            }}
            self._persist(updated, manifest)
            self._audit(action, user_id, provider, model, new_generation)
        return ResolvedLLM(provider, base, model, supplied_key, new_generation, "managed")

    def delete_llm(self, user_id: str, *, expected_generation: int) -> ResolvedLLM:
        if not self.writable:
            raise ProviderSettingsError("READ_ONLY", "设置写入未启用或主密钥未配置", status=403)
        with self._locked():
            snapshot, manifest = self._load()
            row = snapshot["users"].get(user_id, {"generation": 0, "llm": None})
            if int(row.get("generation", 0)) != expected_generation:
                raise ConfigConflict()
            updated = deepcopy(snapshot)
            updated["root_generation"] = int(snapshot["root_generation"]) + 1
            updated["users"][user_id] = {"generation": expected_generation + 1, "llm": None}
            self._persist(updated, manifest)
            self._audit("restore_environment", user_id, "environment", "", expected_generation + 1)
        return self.resolved_llm(user_id)

    def integration_values(self) -> dict[str, dict[str, Any]]:
        with self._locked(): snapshot, _ = self._load()
        generation = int(snapshot["integrations"].get("generation", 0))
        values: dict[str, dict[str, Any]] = {}
        for name in _INTEGRATIONS:
            row = snapshot["integrations"]["items"].get(name)
            if row is None:
                values[name] = {"source": "environment", "generation": generation,
                                "enabled": True, "base_url": "", "api_key": ""}
                if name == "searxng": values[name].update(enabled=bool(os.getenv("SEARXNG_BASE_URL", "").strip()), base_url=os.getenv("SEARXNG_BASE_URL", "").strip())
                elif name == "tavily": values[name].update(enabled=bool(os.getenv("TAVILY_API_KEY", "").strip()), api_key=os.getenv("TAVILY_API_KEY", "").strip())
                else: values[name].update(enabled=bool(os.getenv("PANDASCORE_TOKEN", "").strip()), api_key=os.getenv("PANDASCORE_TOKEN", "").strip())
            else:
                value = {"source": "managed", "generation": generation, "enabled": bool(row["enabled"]),
                         "base_url": row.get("base_url", ""), "api_key": ""}
                if row.get("secret"):
                    secret_generation = int(row.get("generation", generation))
                    value["api_key"] = self._open_secret(row["secret"], "system", name, name, secret_generation)
                values[name] = value
        return values

    def commit_integration(self, name: str, candidate: dict[str, Any], *, expected_generation: int,
                           keep_existing_key: bool = False) -> dict[str, Any]:
        if name not in _INTEGRATIONS:
            raise ProviderSettingsError("INVALID_URL", "未知联网 Provider")
        if not self.writable:
            raise ProviderSettingsError("READ_ONLY", "设置写入未启用或主密钥未配置", status=403)
        with self._locked():
            snapshot, manifest = self._load()
            current_generation = int(snapshot["integrations"].get("generation", 0))
            if current_generation != expected_generation: raise ConfigConflict()
            generation = current_generation + 1
            enabled = bool(candidate.get("enabled"))
            current = snapshot["integrations"]["items"].get(name)
            row: dict[str, Any] = {"enabled": enabled, "healthy": candidate.get("healthy"), "generation": generation}
            if name == "searxng":
                row["base_url"] = normalize_searxng_url(str(candidate.get("base_url", "")))
            else:
                key = str(candidate.get("api_key", "") or "")
                if not key and keep_existing_key and current and current.get("secret"):
                    secret_generation = int(current.get("generation", current_generation))
                    key = self._open_secret(current["secret"], "system", name, name, secret_generation)
                if enabled and not key:
                    raise ProviderSettingsError("PROVIDER_AUTH", "启用后必须填写 API Key")
                if key:
                    row["secret"] = self._seal_secret(key, "system", name, name, generation)
            updated = deepcopy(snapshot)
            updated["root_generation"] = int(snapshot["root_generation"]) + 1
            items = deepcopy(snapshot["integrations"]["items"])
            for existing in items.values():
                existing.setdefault("generation", current_generation)
            updated["integrations"] = {"generation": generation, "items": items}
            updated["integrations"]["items"][name] = row
            self._persist(updated, manifest)
            self._audit("integration_save", "system", name, "", generation)
        return self._integration_status(updated)[name]

    def delete_integration(self, name: str, *, expected_generation: int) -> dict[str, Any]:
        if name not in _INTEGRATIONS: raise ProviderSettingsError("INVALID_URL", "未知联网 Provider")
        if not self.writable: raise ProviderSettingsError("READ_ONLY", "设置写入未启用或主密钥未配置", status=403)
        with self._locked():
            snapshot, manifest = self._load()
            current_generation = int(snapshot["integrations"].get("generation", 0))
            if current_generation != expected_generation: raise ConfigConflict()
            updated = deepcopy(snapshot)
            updated["root_generation"] = int(snapshot["root_generation"]) + 1
            items = deepcopy(snapshot["integrations"]["items"]); items.pop(name, None)
            for existing in items.values():
                existing.setdefault("generation", current_generation)
            updated["integrations"] = {"generation": current_generation + 1, "items": items}
            self._persist(updated, manifest)
            self._audit("integration_restore", "system", name, "", current_generation + 1)
        return self._integration_status(updated)[name]

    def _audit(self, action: str, owner: str, provider: str, model: str, generation: int) -> None:
        record = {"time": int(self._now()), "action": action, "owner": owner,
                  "provider": provider, "model": model, "generation": generation}
        self.audit_path.parent.mkdir(parents=True, exist_ok=True)
        with self.audit_path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
        self.audit_path.chmod(0o600)


def generated_master_key() -> str:
    """Convenience for operators; callers must store the result outside Git."""
    return base64.urlsafe_b64encode(os.urandom(32)).decode()


__all__ = [
    "CATALOG", "ConfigConflict", "ManagedConfigUnavailable", "ProviderSettingsError",
    "ResolvedLLM", "SecretStore", "credential_scope", "generated_master_key",
    "normalize_base_url", "normalize_searxng_url",
]
