"""定位：网页端上报浏览器坐标（优先）或服务端按 IP 兜底，落盘 data/location.json。"""
import datetime
import json

from langchain_core.tools import tool

from jarvis.config import data_dir
from jarvis.tools.weather import _get_json

_REVERSE = "https://api.bigdatacloud.net/data/reverse-geocode-client"
_IPAPI = "http://ip-api.com/json/{ip}"          # 海外可达
_MEITUAN = "https://apimobile.meituan.com/locate/v2/ip/loc"  # 大陆可达


def _path():
    return data_dir() / "location.json"


def get_location() -> dict | None:
    p = _path()
    if not p.exists():
        return None
    return json.loads(p.read_text(encoding="utf-8"))


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
    _path().write_text(json.dumps({
        "lat": lat, "lon": lon, "place": place, "source": source,
        "updated": datetime.datetime.now().isoformat(timespec="seconds"),
    }, ensure_ascii=False), encoding="utf-8")


def locate_by_ip(ip: str) -> dict | None:
    """公网 IP 定位兜底（先 ip-api 后美团，双源互备），城市级精度；内网/失败返回 None。"""
    if not ip or ip.startswith(("127.", "10.", "192.168.", "172.")):
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


@tool
def coding_status() -> str:
    """查询领导在 Claude Code 里的编程进度（由桌面端定时同步）。
    领导问「我在做什么任务」「编程进度怎么样」「刚才在写什么代码」时用。"""
    p = data_dir() / "local_status.json"
    if not p.exists():
        return "桌面端还没同步过编程状态。请领导确认桌面悬浮窗在运行。"
    d = json.loads(p.read_text(encoding="utf-8"))
    coding = d.get("coding", [])
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
            lines.append(f"  最近改动：{'、'.join(c['files'])}")
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
