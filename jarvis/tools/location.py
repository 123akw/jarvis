"""定位：网页端上报浏览器坐标（优先）或服务端按 IP 兜底，落盘 data/location.json。"""
import datetime
import threading
import time

from langchain_core.tools import tool

from jarvis.tenancy import TenantStore, current_owner_id, tenant_scope
from jarvis.tools.weather import _get_json

_REVERSE = "https://api.bigdatacloud.net/data/reverse-geocode-client"
_IPAPI = "http://ip-api.com/json/{ip}"          # 海外可达
_MEITUAN = "https://apimobile.meituan.com/locate/v2/ip/loc"  # 大陆可达


def get_location() -> dict | None:
    return TenantStore().get_location()


def _reverse_geocode(lat: float, lon: float) -> str:
    try:
        d = _get_json(_REVERSE, {"latitude": lat, "longitude": lon, "localityLanguage": "zh"})
        parts = [d.get("principalSubdivision", ""), d.get("city", ""), d.get("locality", "")]
        seen, out = set(), []
        for x in parts:
            if x and x not in seen:
                seen.add(x)
                out.append(x)
        return "".join(out)
    except Exception:
        return ""


def set_location(lat: float, lon: float, source: str) -> None:
    old = get_location()
    moved = not old or abs(old["lat"] - lat) > 0.01 or abs(old["lon"] - lon) > 0.01
    place = _reverse_geocode(lat, lon) if moved else old.get("place", "")
    TenantStore().set_location(lat, lon, source, place,
                               updated_at=datetime.datetime.now().isoformat(timespec="seconds"))


def _private_ip(ip: str) -> bool:
    return not ip or ip.startswith(("127.", "10.", "192.168.", "172."))


def locate_by_ip(ip: str) -> dict | None:
    """公网 IP 定位兜底（先 ip-api 后美团，双源互备），城市级精度；内网/失败返回 None。"""
    if _private_ip(ip):
        return None
    try:
        d = _get_json(_IPAPI.format(ip=ip),
                      {"lang": "zh-CN", "fields": "status,city,regionName,lat,lon"},
                      timeout=4)
        if d.get("status") == "success":
            return {"lat": d["lat"], "lon": d["lon"]}
    except Exception:
        pass
    try:
        d = _get_json(_MEITUAN, {"rgeo": "true", "ip": ip}, timeout=4)
        data = d.get("data") or {}
        if isinstance(data.get("lat"), (int, float)) and isinstance(data.get("lng"), (int, float)):
            return {"lat": data["lat"], "lon": data["lng"]}
    except Exception:
        pass
    return None


# ---- 聊天请求路径上的定位刷新：网络查询一律后台做，不挡首 token ----
# 此前 /api/chat 在返回流之前同步做 IP 定位（ip-api 4s + 美团 4s 超时）或地名反查
# （10s 超时）：实测本机网络下分别耗时 4.2s（且未命中——之后每次聊天都重来一遍）
# 与 3.2s，整段挡在首个字节之前。
IP_MISS_TTL_SECONDS = 600.0   # IP 定位失败后 10 分钟内不再重试同一 IP
_refresh_lock = threading.Lock()
_refresh_inflight: set[str] = set()
_ip_misses: dict[str, float] = {}


def _moved(old: dict | None, lat: float, lon: float) -> bool:
    return not old or abs(old["lat"] - lat) > 0.01 or abs(old["lon"] - lon) > 0.01


def _refresh_worker(owner_id: str, lat, lon, ip: str) -> None:
    try:
        with tenant_scope(owner_id):
            if lat is not None:
                set_location(lat, lon, source="浏览器")
                return
            if get_location() is not None:
                return
            hit = locate_by_ip(ip)
            if hit:
                set_location(hit["lat"], hit["lon"], source="IP")
            else:
                with _refresh_lock:
                    if len(_ip_misses) >= 256:   # 有界：只留未过期的失败记录
                        cutoff = time.monotonic() - IP_MISS_TTL_SECONDS
                        for stale in [k for k, v in _ip_misses.items() if v < cutoff]:
                            del _ip_misses[stale]
                    _ip_misses[ip] = time.monotonic()
    except Exception:
        pass  # 定位只是锦上添花，失败安静放弃
    finally:
        with _refresh_lock:
            _refresh_inflight.discard(owner_id)


def refresh_location(lat=None, lon=None, ip: str = "") -> threading.Thread | None:
    """按请求刷新当前租户定位：无需联网的部分就地完成，需联网的丢后台线程。

    返回后台线程（测试可 join），无需后台工作时返回 None。须在 tenant_scope 内调用。
    """
    owner_id = current_owner_id()
    if lat is not None and lon is not None:
        old = get_location()
        if not _moved(old, lat, lon):
            set_location(lat, lon, source="浏览器")   # 没挪窝：沿用旧地名，不联网
            return None
    else:
        lat = lon = None
        if _private_ip(ip) or get_location() is not None:
            return None
        with _refresh_lock:
            missed = _ip_misses.get(ip)
            if missed is not None and time.monotonic() - missed < IP_MISS_TTL_SECONDS:
                return None
    with _refresh_lock:
        if owner_id in _refresh_inflight:
            return None   # 同一用户已有一单在查，别叠加
        _refresh_inflight.add(owner_id)
    worker = threading.Thread(target=_refresh_worker, args=(owner_id, lat, lon, ip),
                              daemon=True, name="jarvis-locate")
    worker.start()
    return worker


@tool
def coding_status() -> str:
    """查询领导在 Claude Code 里的编程进度（由桌面端定时同步）。
    领导问「我在做什么任务」「编程进度怎么样」「刚才在写什么代码」时用。"""
    d = TenantStore().get_local_status()
    if not d:
        return "桌面端还没同步过编程状态。请领导确认桌面悬浮窗在运行。"
    coding = d.get("coding", [])
    # 桌面端同步来的数据不可全信：非 dict 条目直接跳过，字段类型不对也不能让工具抛异常
    coding = [c for c in coding if isinstance(c, dict)] if isinstance(coding, list) else []
    if not coding:
        return f"最近 48 小时没有 Claude Code 编程活动（同步于 {d.get('updated','?')}）。"
    lines = []
    for c in coding:
        state = "🟢进行中" if c.get("active") else "已暂停"
        lines.append(f"- {c.get('project','?')}（{state}，最近活动 {c.get('last_active','?')}）："
                     f"{c.get('task','（无任务摘要）')}")
        if c.get("step"):
            lines.append(f"  当前动作：{c['step']}")
        if c.get("files"):
            files = c["files"] if isinstance(c["files"], list) else [c["files"]]
            lines.append(f"  最近改动：{'、'.join(str(name) for name in files)}")
        if c.get("branch"):
            git = f"  Git：分支 {c['branch']}"
            if c.get("dirty"):
                git += f"，未提交改动 {c['dirty']} 处"
            if c.get("commits_today"):
                git += f"，今日提交 {c['commits_today']} 个（最近：{c.get('last_commit', '')}）"
            lines.append(git)
    lines.append(f"（桌面端同步于 {d.get('updated','?')}）")
    return "\n".join(lines)


@tool
def my_location() -> str:
    """查询领导当前所在位置（网页端定位或 IP 推断）。"""
    loc = get_location()
    if not loc:
        return "还没拿到定位。请领导在网页端允许浏览器定位，或直接告诉我所在城市。"
    place = loc.get("place") or f"坐标 {loc['lat']:.3f}, {loc['lon']:.3f}"
    return f"领导当前在：{place}（{loc['source']}定位，更新于 {loc['updated']}）"
