"""主动送达：每个账号自己决定「走哪条渠道、几点闭嘴」，外加提醒的「稍后 / 完成」。

偏好全部存在 tenant_prefs，不加表：
- ``delivery_channels``：JSON 数组，网页 / 桌面 / 微信 / 飞书里勾选的那几个；没设置 = 全部渠道；
- ``dnd_hours``：免打扰时段「HH:MM-HH:MM」（可跨午夜）；没设置 = 不开；
- ``dnd_held``：免打扰期间攒下的非紧急消息（巡检 / 心跳），结束后由 ReminderScanner 合并成一条发出。

克制口径（docs/proposals/2026-10-feature-ideas.md F6）：免打扰只拦巡检这类「贾维斯自己想说」的话；
用户亲手设的日程提醒和晨报照常送达——设置页写明这一点，防漏发。渠道开关对三类主动消息
（日程提醒、晨报、巡检）一体生效。

提醒的「稍后 / 完成」统一走 POST /api/reminders/{id}/snooze|done（网页弹条、桌面通知），
微信 / 飞书的回复短语经 reminders.handle_quick_reply 落到同一套账本（TenantStore.ack_reminder）。
"""
from __future__ import annotations

import datetime
import json
import logging
import re
from dataclasses import dataclass
from typing import Annotated, Callable

from fastapi import Path as PathParam, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from jarvis import heartbeat
from jarvis.tenancy import MAX_ITEM_ID, TenantMigrationError, TenantStore, canonical_when, tenant_scope

log = logging.getLogger("jarvis")

CHANNELS = ("web", "desktop", "wechat", "feishu")
CHANNEL_LABELS = {"web": "网页", "desktop": "桌面", "wechat": "微信", "feishu": "飞书"}
PREF_CHANNELS = "delivery_channels"
PREF_DND = "dnd_hours"
PREF_HELD = "dnd_held"
MAX_HELD = 20
HELD_LINE_CHARS = 80
_CLOCK = re.compile(r"^\d{2}:\d{2}$")
ItemId = Annotated[int, PathParam(ge=1, le=MAX_ITEM_ID)]


@dataclass(frozen=True)
class DeliveryPrefs:
    channels: frozenset
    dnd: tuple | None

    def allows(self, channel: str) -> bool:
        return channel in self.channels

    def quiet(self, now: datetime.datetime) -> bool:
        return heartbeat.in_quiet_hours(now, self.dnd)


def _parse_channels(raw: str | None) -> frozenset:
    if raw is None:
        return frozenset(CHANNELS)
    try:
        value = json.loads(raw)
    except ValueError:
        return frozenset(CHANNELS)   # 偏好坏了宁可多送，不能静默全关
    if not isinstance(value, list):
        return frozenset(CHANNELS)
    return frozenset(c for c in value if c in CHANNELS)


def load_prefs(store) -> DeliveryPrefs:
    raw_dnd = (store.get_pref(PREF_DND) or "").strip()
    dnd = None
    if raw_dnd:
        try:
            dnd = heartbeat.parse_quiet_hours(raw_dnd)
        except ValueError:
            dnd = None
    return DeliveryPrefs(_parse_channels(store.get_pref(PREF_CHANNELS)), dnd)


def hold(store, text: str, now: datetime.datetime) -> None:
    """免打扰期间先攒着；只留最新的 MAX_HELD 条。"""
    try:
        rows = json.loads(store.get_pref(PREF_HELD) or "[]")
    except ValueError:
        rows = []
    rows = [r for r in rows if isinstance(r, dict) and isinstance(r.get("text"), str)] if isinstance(rows, list) else []
    rows.append({"at": now.strftime("%Y-%m-%d %H:%M"), "text": text})
    store.set_pref(PREF_HELD, json.dumps(rows[-MAX_HELD:], ensure_ascii=False))


def held(store) -> list[dict]:
    try:
        rows = json.loads(store.get_pref(PREF_HELD) or "[]")
    except ValueError:
        return []
    return [r for r in rows if isinstance(r, dict) and isinstance(r.get("text"), str)] if isinstance(rows, list) else []


def merge_held(rows: list[dict]) -> str:
    """攒下的几条合成一条：一条就直说，多条逐行列出时间。"""
    lines = [f"{str(r.get('at', ''))[11:16]} {' '.join(r['text'].split())[:HELD_LINE_CHARS]}".strip() for r in rows]
    if len(lines) == 1:
        return f"免打扰期间有 1 条消息：{lines[0]}"
    return f"免打扰期间攒下 {len(lines)} 条消息：\n" + "\n".join(f"· {line}" for line in lines)


class Notifier:
    """非日程类主动消息（巡检 / 心跳）的统一出口：按账号偏好分发，免打扰期间先攒着。

    - 微信桥只属于唯一 Owner：wechat_user() 返回其 user_id，其他账号不走微信；
    - 飞书按账号绑定推送：push_feishu(user_id, text)；
    - 网页 / 桌面共用领取箱（PendingOutbox），任一勾选即投递，由 /api/reminders/pending 按通道领取。
    """

    def __init__(self, *, push_wechat=None, wechat_user: Callable[[], str | None] | None = None,
                 push_feishu=None, outbox=None, store_factory=TenantStore):
        self._push_wechat = push_wechat
        self._wechat_user = wechat_user or (lambda: None)
        self._push_feishu = push_feishu
        self._outbox = outbox
        self._store_factory = store_factory

    def _prefs(self, user_id: str):
        with tenant_scope(user_id):
            store = self._store_factory()
            return store, load_prefs(store)

    def _fanout(self, user_id: str, prefs: DeliveryPrefs, text: str, title: str, now: datetime.datetime) -> bool:
        delivered = False
        if self._push_wechat is not None and prefs.allows("wechat"):
            try:
                if self._wechat_user() == user_id:
                    delivered = bool(self._push_wechat(text)) or delivered
            except Exception as exc:
                log.warning("notify wechat push failed: %s", type(exc).__name__)
        if self._push_feishu is not None and prefs.allows("feishu"):
            try:
                delivered = bool(self._push_feishu(user_id, text)) or delivered
            except Exception as exc:
                log.warning("notify feishu push failed: %s", type(exc).__name__)
        if self._outbox is not None and (prefs.allows("web") or prefs.allows("desktop")):
            try:
                self._outbox.put(user_id, title, now.strftime("%Y-%m-%d %H:%M"))
                delivered = True
            except Exception as exc:
                log.warning("notify outbox failed: %s", type(exc).__name__)
        return delivered

    def send(self, user_id: str, message: str, now: datetime.datetime, *, icon: str = "🔔") -> bool:
        """返回「已处理」：送出去了，或者免打扰期间已攒下（调用方据此记去重）。"""
        store, prefs = self._prefs(user_id)
        if prefs.quiet(now):
            with tenant_scope(user_id):
                hold(store, message, now)
            log.info("notify held for quiet hours: %s", message[:60])
            return True
        return self._fanout(user_id, prefs, f"{icon} {message}", message, now)

    def flush(self, user_id: str, now: datetime.datetime) -> bool:
        """免打扰结束后把攒下的合成一条发出去；发送失败也清掉，不在下一轮反复轰炸。"""
        store, prefs = self._prefs(user_id)
        if prefs.quiet(now):
            return False
        with tenant_scope(user_id):
            rows = held(store)
            if not rows:
                return False
            store.set_pref(PREF_HELD, None)
        text = merge_held(rows)
        return self._fanout(user_id, prefs, f"🌙 {text}", text, now)


# ---------- 接口 ----------

class DeliveryIn(BaseModel):
    channels: list[str]
    dnd_enabled: bool = False
    dnd_start: str = ""
    dnd_end: str = ""


class ReminderActIn(BaseModel):
    at: str
    minutes: int | None = None   # 只对「稍后」有效；不传 = 默认 10 分钟


def _dnd_view(store) -> dict:
    raw = (store.get_pref(PREF_DND) or "").strip()
    start, _, end = raw.partition("-")
    if _CLOCK.match(start) and _CLOCK.match(end):
        return {"enabled": True, "start": start, "end": end}
    return {"enabled": False, "start": "22:30", "end": "08:00"}


def register(app, *, request_principal, panel_write, tenant_store, deny,
             channel_status: Callable[[object], dict], now_fn=None) -> None:
    """挂上 /api/delivery（送达偏好）与 /api/reminders/{id}/snooze|done（提醒操作）。

    channel_status(principal) -> {"wechat": bool, "feishu": bool}：该账号是否已绑定，决定设置页显示哪些渠道。"""
    from jarvis import reminders   # reminders 在模块级引用本模块的偏好函数，这里延迟导入避免环

    now = now_fn or (lambda: datetime.datetime.now())   # 调用时再取，测试可替换 datetime

    def no_store(payload: dict, status_code: int = 200) -> JSONResponse:
        return JSONResponse(payload, status_code=status_code, headers={"Cache-Control": "no-store"})

    def migration_failed() -> JSONResponse:
        return no_store({"error": "个人数据迁移失败"}, 503)

    def available(principal) -> dict:
        try:
            bound = channel_status(principal) or {}
        except Exception as exc:
            log.warning("delivery channel status failed: %s", type(exc).__name__)
            bound = {}
        return {"web": True, "desktop": True, "wechat": bool(bound.get("wechat")), "feishu": bool(bound.get("feishu"))}

    @app.get("/api/delivery")
    def delivery_get(request: Request):
        principal, _token = request_principal(request)
        if not principal:
            return deny()
        try:
            with tenant_scope(principal.user_id):
                store = tenant_store()
                prefs = load_prefs(store)
                dnd = _dnd_view(store)
        except TenantMigrationError:
            return migration_failed()
        ready = available(principal)
        return no_store({
            "channels": [{"id": c, "label": CHANNEL_LABELS[c], "available": ready[c], "enabled": prefs.allows(c)}
                         for c in CHANNELS],
            "dnd": dnd,
        })

    @app.put("/api/delivery")
    def delivery_put(request: Request, body: DeliveryIn):
        principal, err = panel_write(request)
        if err:
            return err
        unknown = [c for c in body.channels if c not in CHANNELS]
        if unknown:
            return no_store({"error": "未知的送达渠道"}, 422)
        dnd = None
        if body.dnd_enabled:
            if not (_CLOCK.match(body.dnd_start) and _CLOCK.match(body.dnd_end)):
                return no_store({"error": "免打扰时间需要 HH:MM 格式"}, 422)
            try:
                heartbeat.parse_quiet_hours(f"{body.dnd_start}-{body.dnd_end}")
            except ValueError:
                return no_store({"error": "免打扰时间不合法"}, 422)
            if body.dnd_start == body.dnd_end:
                return no_store({"error": "免打扰的开始和结束不能相同"}, 422)
            dnd = f"{body.dnd_start}-{body.dnd_end}"
        chosen = [c for c in CHANNELS if c in set(body.channels)]
        try:
            with tenant_scope(principal.user_id):
                store = tenant_store()
                # 全选即「默认」：删掉偏好，以后新增的渠道自动生效
                store.set_pref(PREF_CHANNELS, None if len(chosen) == len(CHANNELS) else json.dumps(chosen))
                store.set_pref(PREF_DND, dnd)
        except TenantMigrationError:
            return migration_failed()
        return no_store({"ok": True, "channels": chosen, "dnd": dnd or ""})

    def act(request: Request, item_id: int, body: ReminderActIn, action: str):
        principal, err = panel_write(request)
        if err:
            return err
        try:
            at = canonical_when(body.at)
        except ValueError:
            return no_store({"error": "提醒时间格式不对"}, 422)
        minutes = reminders.SNOOZE_MINUTES if body.minutes is None else body.minutes
        if action == "snooze" and not 1 <= minutes <= reminders.MAX_SNOOZE_MINUTES:
            return no_store({"error": f"稍后时长需在 1–{reminders.MAX_SNOOZE_MINUTES} 分钟之间"}, 422)
        try:
            with tenant_scope(principal.user_id):
                result = reminders.resolve(tenant_store(), item_id, at, action, now(), minutes=minutes)
        except TenantMigrationError:
            return migration_failed()
        if result["status"] == "missing":
            return no_store({"error": "这条日程已经删除了"}, 404)
        if result["status"] == "stale":
            return no_store({"error": "这条日程的时间已经改过了"}, 409)
        return no_store({"ok": True, **result})

    @app.post("/api/reminders/{item_id}/snooze")
    def reminder_snooze(request: Request, item_id: ItemId, body: ReminderActIn):
        return act(request, item_id, body, "snooze")

    @app.post("/api/reminders/{item_id}/done")
    def reminder_done(request: Request, item_id: ItemId, body: ReminderActIn):
        return act(request, item_id, body, "done")
