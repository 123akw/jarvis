"""天气工具：Open-Meteo 免费接口，无需 API key。网络请求收在 _get_json 里方便测试替换。"""
import os

import httpx
from langchain_core.tools import tool

_GEO = "https://geocoding-api.open-meteo.com/v1/search"
_FORECAST = "https://api.open-meteo.com/v1/forecast"

_CODES = {
    0: "晴", 1: "基本晴", 2: "局部多云", 3: "阴", 45: "雾", 48: "冻雾",
    51: "毛毛雨", 53: "小雨", 55: "中雨", 61: "小雨", 63: "中雨", 65: "大雨",
    66: "冻雨", 67: "强冻雨", 71: "小雪", 73: "中雪", 75: "大雪", 77: "霰",
    80: "阵雨", 81: "强阵雨", 82: "暴雨", 85: "阵雪", 86: "强阵雪",
    95: "雷阵雨", 96: "雷阵雨伴冰雹", 99: "强雷暴伴冰雹",
}


def _get_json(url: str, params: dict, timeout: float = 10) -> dict:
    # 本机 all_proxy 可能是 SOCKS（httpx 需装 socksio 才能用），
    # 故不读代理环境变量，只显式走 HTTP 代理。
    proxy = os.getenv("https_proxy") or os.getenv("HTTPS_PROXY") or None
    with httpx.Client(timeout=timeout, trust_env=False, proxy=proxy) as client:
        resp = client.get(url, params=params)
        resp.raise_for_status()
        return resp.json()


def _desc(code) -> str:
    return _CODES.get(code, f"天气码{code}")


def _forecast_lines(lat: float, lon: float, label: str) -> str:
    fc = _get_json(_FORECAST, {
        "latitude": lat, "longitude": lon,
        "current": "temperature_2m,apparent_temperature,relative_humidity_2m,"
                   "weather_code,wind_speed_10m",
        "daily": "temperature_2m_max,temperature_2m_min,weather_code",
        "timezone": "auto", "forecast_days": 3,
    })
    cur = fc["current"]
    lines = [
        f"{label} 当前：{_desc(cur['weather_code'])}，"
        f"{cur['temperature_2m']}°C（体感 {cur['apparent_temperature']}°C），"
        f"湿度 {cur['relative_humidity_2m']}%，风速 {cur['wind_speed_10m']} km/h",
    ]
    daily = fc["daily"]
    for i, day in enumerate(daily["time"]):
        lines.append(
            f"{day}：{_desc(daily['weather_code'][i])}，"
            f"{daily['temperature_2m_min'][i]}~{daily['temperature_2m_max'][i]}°C"
        )
    return "\n".join(lines)


@tool
def weather(city: str) -> str:
    """查询某个城市的当前天气和未来三天预报，city 用城市名（如 北京、上海、深圳）。"""
    try:
        geo = _get_json(_GEO, {"name": city, "count": 1, "language": "zh"})
        hits = geo.get("results") or []
        if not hits:
            return f"没查到城市「{city}」，换个写法试试（如去掉省名、用拼音）。"
        spot = hits[0]
        return _forecast_lines(spot["latitude"], spot["longitude"], spot["name"])
    except httpx.HTTPError as e:
        return f"天气服务暂时连不上（{type(e).__name__}），稍后再试。"


@tool
def weather_here() -> str:
    """领导没说城市时用这个：按领导当前定位查天气和未来三天预报。"""
    from jarvis.tools.location import get_location
    loc = get_location()
    if not loc:
        return "还没拿到定位，无法按位置查天气。请领导在网页端允许浏览器定位，或直接告诉我城市名。"
    label = loc.get("place") or f"坐标 {loc['lat']:.2f},{loc['lon']:.2f}"
    try:
        return _forecast_lines(loc["lat"], loc["lon"], label)
    except httpx.HTTPError as e:
        return f"天气服务暂时连不上（{type(e).__name__}），稍后再试。"
