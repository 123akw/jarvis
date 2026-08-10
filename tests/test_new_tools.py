"""新技能（日程/待办/天气/计算器）单元测试：全部确定性判定，不碰网络与大模型。"""
import datetime

import importlib

from jarvis.tools import calc, schedule_add, schedule_del, schedule_list
from jarvis.tools import todo_add, todo_done, todo_list, weather

# 包 __init__ 里工具对象 weather 遮住了同名子模块，取模块本体要走 importlib
weather_mod = importlib.import_module("jarvis.tools.weather")


# ---------- 日程 ----------

def test_schedule_add_and_list():
    schedule_add.invoke({"title": "见投资人", "when": "2030-01-05 09:30"})
    out = schedule_list.invoke({})
    assert "见投资人" in out and "2030-01-05 09:30" in out


def test_schedule_add_rejects_bad_time():
    out = schedule_add.invoke({"title": "开会", "when": "明天九点"})
    assert "不合法" in out
    assert "开会" not in schedule_list.invoke({})


def test_schedule_list_sorted_by_time():
    schedule_add.invoke({"title": "晚的", "when": "2030-06-01 20:00"})
    schedule_add.invoke({"title": "早的", "when": "2030-06-01 08:00"})
    out = schedule_list.invoke({})
    assert out.index("早的") < out.index("晚的")


def test_schedule_today_is_tagged():
    today = datetime.date.today().strftime("%Y-%m-%d")
    schedule_add.invoke({"title": "今日事", "when": f"{today} 23:59"})
    assert "【今天】" in schedule_list.invoke({})


def test_schedule_del():
    receipt = schedule_add.invoke({"title": "要删的", "when": "2030-02-02 10:00"})
    sid = int("".join(ch for ch in receipt.split("编号")[1].split("）")[0] if ch.isdigit()))
    assert "已删除" in schedule_del.invoke({"schedule_id": sid})
    assert "要删的" not in schedule_list.invoke({})


def test_schedule_del_bad_id():
    assert "没找到" in schedule_del.invoke({"schedule_id": 424242})


# ---------- 待办 ----------

def test_todo_empty():
    assert "空" in todo_list.invoke({})


def test_todo_add_and_list():
    todo_add.invoke({"content": "给车做保养"})
    assert "给车做保养" in todo_list.invoke({})


def test_todo_done_removes_from_pending():
    receipt = todo_add.invoke({"content": "交物业费"})
    tid = int("".join(ch for ch in receipt.split("编号")[1].split("）")[0] if ch.isdigit()))
    out = todo_done.invoke({"todo_id": tid})
    assert "已完成" in out
    listing = todo_list.invoke({})
    assert "交物业费" not in listing.split("（已完成")[0]


def test_todo_done_bad_id():
    assert "没找到" in todo_done.invoke({"todo_id": 424242})


# ---------- 计算器 ----------

def test_calc_basic():
    assert "= 27600" in calc.invoke({"expression": "2300*12"})


def test_calc_precedence_and_paren():
    assert "= 21" in calc.invoke({"expression": "(1+2)*7"})


def test_calc_rejects_code():
    out = calc.invoke({"expression": "__import__('os').system('ls')"})
    assert "看不懂" in out


def test_calc_zero_division():
    assert "除数为零" in calc.invoke({"expression": "1/0"})


# ---------- 天气（网络层打桩） ----------

def _fake_get_json(url, params):
    if "geocoding" in url:
        return {"results": [{"name": "北京", "latitude": 39.9, "longitude": 116.4}]}
    return {
        "current": {"temperature_2m": 31.5, "apparent_temperature": 35.0,
                    "relative_humidity_2m": 60, "weather_code": 1, "wind_speed_10m": 8.5},
        "daily": {"time": ["2026-08-10", "2026-08-11", "2026-08-12"],
                  "weather_code": [1, 61, 95],
                  "temperature_2m_max": [33.0, 30.0, 28.0],
                  "temperature_2m_min": [25.0, 24.0, 23.0]},
    }


def test_weather_formats_forecast(monkeypatch):
    monkeypatch.setattr(weather_mod, "_get_json", _fake_get_json)
    out = weather.invoke({"city": "北京"})
    assert "北京 当前：基本晴，31.5°C" in out
    assert "2026-08-11：小雨，24.0~30.0°C" in out


def test_weather_city_not_found(monkeypatch):
    monkeypatch.setattr(weather_mod, "_get_json", lambda u, p: {"results": []})
    assert "没查到城市" in weather.invoke({"city": "不存在市"})
