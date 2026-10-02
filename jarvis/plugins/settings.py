"""插件自己的设置（隔离原则第 4 条）：存在 tenant_prefs 的 ``plugin:<id>:<key>`` 命名空间下。

每个插件只能读写自己 id 下的键，键名受限，不会碰到别的插件或贾维斯本身的偏好（persona_* 等）。
不加表：tenant_prefs 是现成的「账号 × 键 → 值」存储。
"""
from __future__ import annotations

import re

from jarvis.plugins.manifest import ID_RE

PREFIX = "plugin:"
KEY_RE = re.compile(r"^[a-z0-9][a-z0-9_.-]{0,39}$")
MAX_VALUE_CHARS = 4000


class SettingsError(ValueError):
    pass


def pref_key(plugin_id: str, key: str) -> str:
    if not isinstance(plugin_id, str) or not ID_RE.match(plugin_id):
        raise SettingsError("插件 id 不对")
    if not isinstance(key, str) or not KEY_RE.match(key):
        raise SettingsError("设置项名称只能用小写字母、数字、点、短横线和下划线")
    return f"{PREFIX}{plugin_id}:{key}"


def _store():
    from jarvis.tenancy import TenantStore
    return TenantStore()


def get(plugin_id: str, key: str, default: str | None = None, *, owner_id: str | None = None) -> str | None:
    return _store().get_pref(pref_key(plugin_id, key), default, owner_id=owner_id)


def set(plugin_id: str, key: str, value: str | None, *, owner_id: str | None = None) -> None:  # noqa: A001
    """value 为 None 时删除。"""
    if value is not None:
        value = str(value)
        if len(value) > MAX_VALUE_CHARS:
            raise SettingsError(f"设置值最多 {MAX_VALUE_CHARS} 个字")
    _store().set_pref(pref_key(plugin_id, key), value, owner_id=owner_id)


def all_for(plugin_id: str, *, owner_id: str | None = None) -> dict[str, str]:
    """这个插件在当前账号下的全部设置 {key: value}。"""
    prefix = pref_key(plugin_id, "x")[:-1]
    return {key[len(prefix):]: value for key, value in _store().prefs_with_prefix(prefix, owner_id=owner_id).items()}
