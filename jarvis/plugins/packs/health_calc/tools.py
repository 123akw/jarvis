"""BMI 与热量估算：体重指数分档、腰围判断、基础代谢与每日消耗。纯标准库，不联网。

依据：
- BMI 与腰围分档：国家卫生行业标准 WS/T 428—2013《成人体重判定》——
  BMI < 18.5 体重过低，18.5 ≤ BMI < 24.0 体重正常，24.0 ≤ BMI < 28.0 超重，BMI ≥ 28.0 肥胖；
  腰围 男 85–90 cm、女 80–85 cm（不含上限）为中心型肥胖前期，男 ≥ 90 cm、女 ≥ 85 cm 为中心型肥胖。
- 基础代谢：Mifflin-St Jeor 公式（1990）：10 × 体重 kg + 6.25 × 身高 cm − 5 × 年龄 + 5（男）/ − 161（女）；
  每日消耗 = 基础代谢 × 活动系数（久坐 1.2、轻度 1.375、中度 1.55、高强度 1.725、极高 1.9）。
只适用于 18 岁以上成人，不适用孕妇、哺乳期、职业运动员；结果仅供参考，不是诊断。
"""
from __future__ import annotations

import math

from langchain_core.tools import tool
from pydantic import BaseModel, Field

HEIGHT_RANGE = (100.0, 250.0)
WEIGHT_RANGE = (20.0, 300.0)
WAIST_RANGE = (40.0, 200.0)
AGE_RANGE = (18, 100)
DISCLAIMER = "只适用于 18 岁以上成人，不适用孕妇、哺乳期和职业运动员；结果仅供参考，不是诊断，身体有不舒服或想系统减重，请问医生或注册营养师。"
SEXES = {"男": "男", "male": "男", "m": "男", "男性": "男", "男生": "男",
         "女": "女", "female": "女", "f": "女", "女性": "女", "女生": "女"}
ACTIVITIES = {
    "久坐": (1.2, "几乎不运动，坐着上班"),
    "轻度": (1.375, "每周运动 1–3 天"),
    "中度": (1.55, "每周运动 3–5 天"),
    "高强度": (1.725, "每周运动 6–7 天"),
    "极高": (1.9, "重体力劳动，或每天练两次"),
}
_ACTIVITY_ALIASES = {"sedentary": "久坐", "light": "轻度", "moderate": "中度", "active": "高强度",
                     "very_active": "极高", "不运动": "久坐", "很少运动": "久坐", "轻": "轻度", "中": "中度",
                     "高": "高强度", "重体力": "极高"}


def _in_range(value, low: float, high: float) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and low <= value <= high


def _check_body(height_cm, weight_kg) -> str:
    if not _in_range(height_cm, *HEIGHT_RANGE):
        return "身高请按厘米给，在 100 到 250 之间，比如 170。"
    if not _in_range(weight_kg, *WEIGHT_RANGE):
        return "体重请按公斤给，在 20 到 300 之间，比如 65（斤要先除以 2）。"
    return ""


def normalize_sex(sex: str) -> str | None:
    """「男 / 女」；空返回 ""，看不懂返回 None。"""
    text = str(sex or "").strip().lower()
    if not text:
        return ""
    return SEXES.get(text)


def bmi_value(height_cm: float, weight_kg: float) -> float:
    meters = height_cm / 100
    return weight_kg / (meters * meters)


def bmi_level(bmi: float) -> str:
    if bmi < 18.5:
        return "体重过低"
    if bmi < 24:
        return "体重正常"
    if bmi < 28:
        return "超重"
    return "肥胖"


def waist_level(waist_cm: float, sex: str) -> str:
    pre, obese = (85, 90) if sex == "男" else (80, 85)
    if waist_cm >= obese:
        return "中心型肥胖"
    if waist_cm >= pre:
        return "中心型肥胖前期"
    return "腰围正常"


def bmi_text(height_cm: float, weight_kg: float, waist_cm: float = 0, sex: str = "") -> str:
    problem = _check_body(height_cm, weight_kg)
    if problem:
        return problem
    who = normalize_sex(sex)
    if who is None:
        return "性别请写「男」或「女」，不想说可以留空。"
    bmi = bmi_value(height_cm, weight_kg)
    meters2 = (height_cm / 100) ** 2
    low, high = 18.5 * meters2, 23.9 * meters2
    lines = [f"身高 {height_cm:g} cm、体重 {weight_kg:g} kg：**BMI {bmi:.1f}，{bmi_level(bmi)}**",
             "（中国成人标准：< 18.5 过低，18.5–23.9 正常，24.0–27.9 超重，≥ 28 肥胖）",
             f"这个身高的正常体重大约在 {low:.1f}–{high:.1f} kg。"]
    if weight_kg > high:
        lines.append(f"比正常上限多 {weight_kg - high:.1f} kg。")
    elif weight_kg < low:
        lines.append(f"比正常下限少 {low - weight_kg:.1f} kg。")
    if waist_cm:
        if not _in_range(waist_cm, *WAIST_RANGE):
            lines.append("腰围请按厘米给（40 到 200 之间），这次先不判断腰围。")
        elif who:
            lines.append(f"腰围 {waist_cm:g} cm（{who}）：**{waist_level(waist_cm, who)}**"
                         f"（{who}性 {'85–89.9' if who == '男' else '80–84.9'} cm 为前期，"
                         f"≥ {'90' if who == '男' else '85'} cm 为中心型肥胖）")
        else:
            lines.append(f"腰围 {waist_cm:g} cm：按男性标准是「{waist_level(waist_cm, '男')}」，"
                         f"按女性标准是「{waist_level(waist_cm, '女')}」（告诉我性别可以只看一个）。")
    lines += ["依据：WS/T 428—2013《成人体重判定》。BMI 不区分肌肉和脂肪，肌肉多的人会偏高。", DISCLAIMER]
    return "\n".join(lines)


def normalize_activity(activity: str) -> str | None:
    text = str(activity or "").strip().lower()
    if not text:
        return "久坐"
    if text in ACTIVITIES:
        return text
    if text in _ACTIVITY_ALIASES:
        return _ACTIVITY_ALIASES[text]
    return next((name for name in ACTIVITIES if name in text), None)


def bmr_value(sex: str, age: int, height_cm: float, weight_kg: float) -> float:
    """Mifflin-St Jeor 基础代谢（千卡 / 天）。"""
    return 10 * weight_kg + 6.25 * height_cm - 5 * age + (5 if sex == "男" else -161)


def energy_text(sex: str, age: int, height_cm: float, weight_kg: float, activity: str = "久坐") -> str:
    who = normalize_sex(sex)
    if not who:
        return "算基础代谢要知道性别，请告诉我「男」或「女」。"
    if not _in_range(age, *AGE_RANGE):
        return "年龄要在 18 到 100 岁之间；未成年人的热量需求请问儿科医生或营养师。"
    problem = _check_body(height_cm, weight_kg)
    if problem:
        return problem
    level = normalize_activity(activity)
    if level is None:
        return "活动量请从「久坐、轻度、中度、高强度、极高」里选一个。"
    factor, meaning = ACTIVITIES[level]
    bmr = bmr_value(who, int(age), height_cm, weight_kg)
    tdee = bmr * factor
    low, high = max(tdee - 500, bmr), max(tdee - 300, bmr)
    if high - low < 1:
        cut = (f"- 想减重：按这个活动量，再少吃就低于基础代谢（约 {bmr:,.0f} 千卡）了，"
               "建议先多动一动，而不是继续少吃。")
    else:
        cut = (f"- 想慢慢减重：每天比消耗少吃 300–500 千卡，大约吃 {low:,.0f}–{high:,.0f} 千卡；"
               "不建议长期吃得比基础代谢还少。")
    lines = [f"{who}，{int(age)} 岁，{height_cm:g} cm，{weight_kg:g} kg，活动量「{level}」（{meaning}）：",
             f"- 基础代谢约 **{bmr:,.0f} 千卡 / 天**（躺着不动也要消耗的）",
             f"- 每日总消耗约 **{tdee:,.0f} 千卡 / 天**（基础代谢 × {factor}）",
             cut,
             f"- 想保持体重：每天吃到 {tdee:,.0f} 千卡左右。",
             "依据：Mifflin-St Jeor 公式 + 常用活动系数，个人差异可能有 10% 上下。", DISCLAIMER]
    return "\n".join(lines)


# ---------- 工具 ----------

class BmiArgs(BaseModel):
    height_cm: float = Field(description="身高，厘米，如 170；用户说米就乘 100")
    weight_kg: float = Field(description="体重，公斤，如 65；用户说斤就除以 2")
    waist_cm: float = Field(default=0, description="腰围，厘米，可不填（0）")
    sex: str = Field(default="", description="男 / 女，可空；判断腰围时用")


class EnergyArgs(BaseModel):
    sex: str = Field(description="男 / 女")
    age: int = Field(description="年龄，18–100 岁")
    height_cm: float = Field(description="身高，厘米，如 170")
    weight_kg: float = Field(description="体重，公斤，如 65；用户说斤就除以 2")
    activity: str = Field(default="久坐", description="活动量：久坐 / 轻度（每周运动1–3天）/ 中度（3–5天）/ 高强度（6–7天）/ 极高（重体力）")


@tool(args_schema=BmiArgs)
def health_calc_bmi(height_cm: float, weight_kg: float, waist_cm: float = 0, sex: str = "") -> str:
    """按中国成人标准算 BMI 并分档（过低 / 正常 / 超重 / 肥胖），给出正常体重区间，可选判断腰围。
    用户说「我 170 公分 75 公斤胖不胖」「算一下我的 BMI」「腰围 88 算不算肥胖」时用，不要心算。"""
    return bmi_text(height_cm, weight_kg, waist_cm, sex)


@tool(args_schema=EnergyArgs)
def health_calc_energy(sex: str, age: int, height_cm: float, weight_kg: float, activity: str = "久坐") -> str:
    """估算基础代谢和每日热量消耗（Mifflin-St Jeor 公式 × 活动系数），给减重 / 保持体重的一般参考。
    用户说「我一天大概消耗多少热量」「想减肥每天吃多少合适」「基础代谢是多少」时用，不要心算。"""
    return energy_text(sex, age, height_cm, weight_kg, activity)


TOOLS = [health_calc_bmi, health_calc_energy]
