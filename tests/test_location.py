"""定位与按位置查天气：全部确定性判定，网络层打桩。"""
import importlib
import pytest

from jarvis.tools import my_location, weather_here
from jarvis.accounts import AccountStore
from jarvis.tenancy import tenant_scope


@pytest.fixture(autouse=True)
def tenant():
    accounts = AccountStore(); accounts._ensure_bootstrap()
    with tenant_scope(accounts.list_users()[0]["id"]):
        yield

location_mod = importlib.import_module("jarvis.tools.location")
weather_mod = importlib.import_module("jarvis.tools.weather")


def test_my_location_without_fix():
    assert "还没拿到定位" in my_location.invoke({})


def test_set_location_stores_and_reverse_geocodes(monkeypatch):
    monkeypatch.setattr(location_mod, "_reverse_geocode", lambda a, b: "广东省深圳市南山区")
    location_mod.set_location(22.53, 113.93, source="浏览器")
    out = my_location.invoke({})
    assert "广东省深圳市南山区" in out and "浏览器" in out


def test_set_location_skips_reverse_when_not_moved(monkeypatch):
    monkeypatch.setattr(location_mod, "_reverse_geocode", lambda a, b: "起点")
    location_mod.set_location(22.53, 113.93, source="浏览器")
    monkeypatch.setattr(location_mod, "_reverse_geocode",
                        lambda a, b: (_ for _ in ()).throw(AssertionError("不该再反查")))
    location_mod.set_location(22.531, 113.931, source="浏览器")  # 移动 <0.01°
    assert "起点" in my_location.invoke({})


def test_weather_here_without_fix():
    assert "还没拿到定位" in weather_here.invoke({})


def test_weather_here_uses_stored_location(monkeypatch):
    monkeypatch.setattr(location_mod, "_reverse_geocode", lambda a, b: "深圳市")
    location_mod.set_location(22.53, 113.93, source="浏览器")

    def fake_get_json(url, params):
        assert abs(params["latitude"] - 22.53) < 1e-6
        return {
            "current": {"temperature_2m": 30.0, "apparent_temperature": 33.0,
                        "relative_humidity_2m": 55, "weather_code": 2, "wind_speed_10m": 7.0},
            "daily": {"time": ["2026-08-10"], "weather_code": [2],
                      "temperature_2m_max": [32.0], "temperature_2m_min": [26.0]},
        }
    monkeypatch.setattr(weather_mod, "_get_json", fake_get_json)
    out = weather_here.invoke({})
    assert "深圳市 当前：局部多云，30.0°C" in out


def test_locate_by_ip_rejects_private():
    assert location_mod.locate_by_ip("127.0.0.1") is None
    assert location_mod.locate_by_ip("192.168.1.3") is None


def test_locate_by_ip_parses(monkeypatch):
    monkeypatch.setattr(location_mod, "_get_json",
                        lambda u, p, **kw: {"status": "success", "lat": 22.5, "lon": 114.0})
    assert location_mod.locate_by_ip("1.2.3.4") == {"lat": 22.5, "lon": 114.0}


def test_locate_by_ip_falls_back_to_meituan(monkeypatch):
    def fake(url, params, **kw):
        if "ip-api" in url:
            raise TimeoutError("大陆不通")
        return {"data": {"lat": 22.55, "lng": 114.06}}
    monkeypatch.setattr(location_mod, "_get_json", fake)
    assert location_mod.locate_by_ip("1.2.3.4") == {"lat": 22.55, "lon": 114.06}
