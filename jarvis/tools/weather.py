"""天气工具：Open-Meteo 免费接口，无需 API key。网络请求收在 _get_json 里方便测试替换。"""
import datetime
import os
import time

import httpx
from langchain_core.tools import tool
from pydantic import BaseModel, Field


class WeatherArgs(BaseModel):
    city: str = Field(description="城市名，中文或拼音，如「北京」「深圳」「shanghai」；"
                                  "不要带省名或「市」字后缀；区县可直接写，如「南山」")

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


RETRY_BACKOFF_SECONDS = 0.6


def _transient(exc: Exception) -> bool:
    """临时性错误才值得重试：超时、5xx。4xx、解析错误重试也没用。"""
    if isinstance(exc, httpx.TimeoutException):
        return True
    return isinstance(exc, httpx.HTTPStatusError) and exc.response.status_code >= 500


def _get_json_retrying(url: str, params: dict) -> dict:
    """工具路径上的查询：临时性错误退避后重试一次（定位等后台调用仍直接用 _get_json）。"""
    try:
        return _get_json(url, params)
    except httpx.HTTPError as exc:
        if not _transient(exc):
            raise
        time.sleep(RETRY_BACKOFF_SECONDS)
        return _get_json(url, params)


def _day_label(day: str) -> str:
    try:
        offset = (datetime.date.fromisoformat(day) - datetime.date.today()).days
    except ValueError:
        return ""
    return {0: "（今天）", 1: "（明天）", 2: "（后天）"}.get(offset, "")


def _forecast_lines(lat: float, lon: float, label: str) -> str:
    fc = _get_json_retrying(_FORECAST, {
        "latitude": lat, "longitude": lon,
        "current": "temperature_2m,apparent_temperature,relative_humidity_2m,"
                   "weather_code,wind_speed_10m",
        "daily": "temperature_2m_max,temperature_2m_min,weather_code,precipitation_probability_max",
        "timezone": "auto", "forecast_days": 3,
    })
    cur = fc["current"]
    lines = [
        f"{label} 当前：{_desc(cur['weather_code'])}，"
        f"{cur['temperature_2m']}°C（体感 {cur['apparent_temperature']}°C），"
        f"湿度 {cur['relative_humidity_2m']}%，风速 {cur['wind_speed_10m']} km/h",
    ]
    daily = fc["daily"]
    rain = daily.get("precipitation_probability_max") or []
    for i, day in enumerate(daily["time"]):
        chance = rain[i] if i < len(rain) and isinstance(rain[i], (int, float)) else None
        lines.append(
            f"{day}{_day_label(day)}：{_desc(daily['weather_code'][i])}，"
            f"{daily['temperature_2m_min'][i]}~{daily['temperature_2m_max'][i]}°C"
            + (f"，降水概率 {round(chance)}%" if chance is not None else "")
        )
    lines.append("（预报只覆盖今天起 3 天，更远的日子暂无数据）")
    return "\n".join(lines)


_UNREACHABLE = "天气服务暂时连不上（{}），这次查不到。请如实告诉领导，稍后再问或先看手机天气。"
_BROKEN = "天气服务返回的数据异常（{}），这次查不到。请如实告诉领导，稍后再问。"


@tool(args_schema=WeatherArgs)
def weather(city: str) -> str:
    """查询指定城市的当前天气和今天起 3 天预报（含降水概率）。
    领导说了城市（或上文聊到某个城市，如出差目的地）时使用；没提城市改用 weather_here，不要反问。
    超过 3 天的日子查不到，要如实说明。"""
    try:
        geo = _get_json_retrying(_GEO, {"name": city, "count": 1, "language": "zh"})
        hits = geo.get("results") or []
        if not hits:
            return f"没查到城市「{city}」：换个写法再查一次（去掉省名、只写城市名，或用拼音）。"
        spot = hits[0]
        return _forecast_lines(spot["latitude"], spot["longitude"], spot["name"])
    except httpx.HTTPError as e:
        return _UNREACHABLE.format(type(e).__name__)
    except (ValueError, KeyError, TypeError, IndexError, ImportError) as e:
        return _BROKEN.format(type(e).__name__)


@tool
def weather_here() -> str:
    """领导没说城市时用这个：按领导当前定位查天气和今天起 3 天预报（含降水概率）。
    「要带伞吗」「冷不冷」「明天天气」这类问题都用它。"""
    from jarvis.tools.location import get_location
    loc = get_location()
    if not loc:
        return "还没拿到定位，无法按位置查天气。请领导在网页端允许浏览器定位，或直接告诉我城市名。"
    label = loc.get("place") or f"坐标 {loc['lat']:.2f},{loc['lon']:.2f}"
    try:
        return _forecast_lines(loc["lat"], loc["lon"], label)
    except httpx.HTTPError as e:
        return _UNREACHABLE.format(type(e).__name__)
    except (ValueError, KeyError, TypeError, IndexError, ImportError) as e:
        return _BROKEN.format(type(e).__name__)
