"""单位换算：长度、重量、面积、体积、温度，含斤两、亩、尺寸等市制单位。纯标准库，不联网。"""
from __future__ import annotations

import math

from langchain_core.tools import tool
from pydantic import BaseModel, Field

MAX_ABS_VALUE = 1e15

# 每类：{标准名: (换算到基准单位的系数, 别名...)}；温度单独处理（不是比例换算）
CATEGORIES: dict[str, dict] = {
    "长度": {"base": "米", "units": {
        "千米": (1000, "公里", "km", "KM"), "米": (1, "m", "公尺"), "分米": (0.1, "dm"),
        "厘米": (0.01, "cm", "公分"), "毫米": (0.001, "mm"), "微米": (1e-6, "um", "μm"),
        "里": (500, "华里", "市里"), "丈": (10 / 3, "市丈"), "尺": (1 / 3, "市尺"), "寸": (1 / 30, "市寸"),
        "分": (1 / 300, "市分"),
        "英里": (1609.344, "mile", "mi"), "码": (0.9144, "yd", "yard"), "英尺": (0.3048, "ft", "foot", "feet", "呎"),
        "英寸": (0.0254, "in", "inch", "吋"), "海里": (1852, "nmi"),
    }},
    "重量": {"base": "千克", "units": {
        "吨": (1000, "t", "公吨"), "千克": (1, "公斤", "kg", "KG"), "克": (0.001, "g"), "毫克": (1e-6, "mg"),
        "担": (50, "市担"), "斤": (0.5, "市斤"), "两": (0.05, "市两"), "钱": (0.005, "市钱"),
        "分": (0.0005,), "磅": (0.45359237, "lb", "lbs"), "盎司": (0.028349523125, "oz"),
        "克拉": (0.0002, "ct"),
    }},
    "面积": {"base": "平方米", "units": {
        "平方千米": (1e6, "平方公里", "km2", "km²"), "公顷": (1e4, "ha"), "亩": (10000 / 15, "市亩"),
        "分": (10000 / 150, "分地"), "平方米": (1, "平米", "平", "m2", "m²", "㎡"),
        "平方分米": (0.01, "dm2", "dm²"), "平方厘米": (1e-4, "cm2", "cm²"),
        "英亩": (4046.8564224, "acre"), "平方英尺": (0.09290304, "sqft", "ft2", "ft²"),
        "平方英寸": (0.00064516, "sqin", "in2", "in²"),
    }},
    "体积": {"base": "升", "units": {
        "立方米": (1000, "方", "m3", "m³"), "升": (1, "公升", "L", "l"), "毫升": (0.001, "mL", "ml", "cc"),
        "立方厘米": (0.001, "cm3", "cm³"), "加仑": (3.785411784, "美制加仑", "gal"),
        "英制加仑": (4.54609,), "斗": (10, "市斗"), "石": (100, "市石"),
    }},
}
TEMPERATURES = {
    "摄氏度": ("℃", "°C", "C", "摄氏"),
    "华氏度": ("℉", "°F", "F", "华氏"),
    "开尔文": ("K", "开", "k"),
}


def _alias_table() -> dict[str, list[tuple[str, str]]]:
    """别名 → [(类别, 标准名)]；同一个字可能属于多类（如「分」）。"""
    table: dict[str, list[tuple[str, str]]] = {}
    for category, spec in CATEGORIES.items():
        for name, (_factor, *aliases) in spec["units"].items():
            for alias in (name, *aliases):
                table.setdefault(alias.strip(), []).append((category, name))
    for name, aliases in TEMPERATURES.items():
        for alias in (name, *aliases):
            table.setdefault(alias, []).append(("温度", name))
    return table


ALIASES = _alias_table()


def _normalize(unit: str) -> str:
    unit = (unit or "").strip().replace(" ", "")
    if unit.startswith("市") and unit not in ALIASES and unit[1:] in ALIASES:
        unit = unit[1:]
    return unit


def resolve(from_unit: str, to_unit: str, category: str = "") -> tuple[str, str, str] | str:
    """找出两个单位共同所属的类别；返回 (类别, 源标准名, 目标标准名) 或一句说明问题的话。"""
    src, dst = _normalize(from_unit), _normalize(to_unit)
    for raw, unit in ((from_unit, src), (to_unit, dst)):
        if unit not in ALIASES:
            return f"不认识单位「{raw}」。可以先用 unit_convert_units 看看支持哪些单位。"
    shared = {c for c, _ in ALIASES[src]} & {c for c, _ in ALIASES[dst]}
    if category:
        shared &= {category}
    if not shared:
        kinds = lambda u: "、".join(sorted({c for c, _ in ALIASES[u]}))   # noqa: E731
        return f"「{from_unit}」是{kinds(src)}单位，「{to_unit}」是{kinds(dst)}单位，没法互相换算。"
    if len(shared) > 1:
        return f"「{from_unit}」和「{to_unit}」在{'、'.join(sorted(shared))}里都有，请说明是哪一类（category 参数）。"
    chosen = shared.pop()
    pick = lambda u: next(name for c, name in ALIASES[u] if c == chosen)   # noqa: E731
    return chosen, pick(src), pick(dst)


def _to_celsius(value: float, unit: str) -> float:
    return {"摄氏度": value, "华氏度": (value - 32) * 5 / 9, "开尔文": value - 273.15}[unit]


def _from_celsius(value: float, unit: str) -> float:
    return {"摄氏度": value, "华氏度": value * 9 / 5 + 32, "开尔文": value + 273.15}[unit]


def fmt(number: float) -> str:
    """去掉浮点尾巴：0.30000000000000004 → 0.3；很大或很小的数用科学计数。"""
    if number == 0:
        return "0"
    if abs(number) >= 1e12 or abs(number) < 1e-6:
        return f"{number:.6g}"
    text = f"{round(number, 6):.6f}".rstrip("0").rstrip(".")
    return "0" if text in ("-0", "") else text


def convert(value: float, from_unit: str, to_unit: str, category: str = "") -> str:
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value):
        return "数值看不懂，请给一个普通数字。"
    if abs(value) > MAX_ABS_VALUE:
        return "数值太大了，换个小一点的数再算。"
    resolved = resolve(from_unit, to_unit, category)
    if isinstance(resolved, str):
        return resolved
    kind, src, dst = resolved
    if kind == "温度":
        celsius = _to_celsius(value, src)
        result = _from_celsius(celsius, dst)
        note = "（注意：低于绝对零度，现实中不存在这个温度）" if celsius < -273.15 else ""
        return f"{fmt(value)} {src} = {fmt(result)} {dst}{note}"
    units = CATEGORIES[kind]["units"]
    result = value * units[src][0] / units[dst][0]
    rate = units[src][0] / units[dst][0]
    return f"{fmt(value)} {src} = {fmt(result)} {dst}（1 {src} = {fmt(rate)} {dst}）"


def list_units(category: str = "") -> str:
    lines = []
    for kind, spec in CATEGORIES.items():
        if category and category != kind:
            continue
        lines.append(f"{kind}：" + "、".join(spec["units"]))
    if not category or category == "温度":
        lines.append("温度：" + "、".join(TEMPERATURES))
    return "\n".join(lines) or f"没有「{category}」这一类；可选：{'、'.join([*CATEGORIES, '温度'])}。"


# ---------- 工具 ----------

class ConvertArgs(BaseModel):
    value: float = Field(description="要换算的数值，如 3.5")
    from_unit: str = Field(description="原单位，如「斤」「亩」「英尺」「华氏度」「km」")
    to_unit: str = Field(description="目标单位，如「千克」「平方米」「厘米」「摄氏度」")
    category: str = Field(default="", description="可空；单位有歧义时填 长度/重量/面积/体积/温度，如「分」")


class UnitsArgs(BaseModel):
    category: str = Field(default="", description="可空；长度/重量/面积/体积/温度 之一，空表示全部")


@tool(args_schema=ConvertArgs)
def unit_convert(value: float, from_unit: str, to_unit: str, category: str = "") -> str:
    """单位换算：长度、重量、面积、体积、温度，含斤、两、亩、尺、寸等市制单位和英制单位。
    用户问「3 斤是几公斤」「一亩地多少平方米」「6 英尺多高」「华氏 100 度是几度」时使用，不要心算。"""
    return convert(value, from_unit, to_unit, category)


@tool(args_schema=UnitsArgs)
def unit_convert_units(category: str = "") -> str:
    """列出单位换算支持的单位。用户问「能换算哪些单位」或 unit_convert 说不认识某个单位时使用。"""
    return list_units(category.strip())


TOOLS = [unit_convert, unit_convert_units]
