"""语音通话「说人话」：本回合口语规则（提示词片段）+ 送 TTS 前的文本规整兜底。

两层分工：
- SPOKEN_RULES / interrupted_hint / emotion_hint：由 gateway 拼进本回合一次性 system
  指令（场景规则之后），让模型从源头就用口语回答；
- to_spoken()：送 TTS 前的确定性兜底——模型偶尔还是会吐 Markdown、表情、
  「15:00」「-3℃」这类念出来别扭的写法，这里改写成中文口语。字幕（token 事件）
  不经过这里，屏幕上保留原文（含链接）。

纯函数、零依赖，单测见 tests/test_voice_spoken.py。
"""
from __future__ import annotations

import datetime as _dt
import re

SPOKEN_RULES = (
    "【说话方式】像真人管家打电话那样说：结论先说，一句一个意思，句子短；"
    "不用任何 Markdown、表格、代码、表情符号；时间、日期、温度、数字按中文口语说，"
    "比如「下午三点」「零下三度」「十月二号」；联网查到的内容只说要点，不念网址和来源；"
    "要列举时最多先说三项，再问一句要不要接着说；"
    "如果用户的话听着残缺或说不通，多半是没听清，用一句话自然地确认（比如「你是说……吗？」），"
    "别硬猜也别说识别出错。"
)

# 用户情绪 → 回应语气（克制：只调语气，不点破在识别情绪）
_EMOTION_TONE = {
    "happy": "主人刚才听起来挺开心，可以轻快一点。",
    "sad": "主人刚才听起来有点低落，语气放软、放慢，先接住情绪，少讲道理。",
    "angry": "主人刚才听起来有点生气，别辩解、别绕弯，直接说怎么解决。",
    "fearful": "主人刚才听起来有点紧张，语气沉稳，先让人安心，再说要点。",
    "surprised": "主人刚才听起来有点惊讶，先简短回应这份意外，再说要点。",
    "disgusted": "主人刚才听起来有点不耐烦，回答再短一点，直奔重点。",
}


def emotion_hint(emotion: str) -> str:
    tone = _EMOTION_TONE.get(emotion or "")
    return f"（语气感知：{tone}自然照应，不要点破你在识别情绪。）" if tone else ""


def interrupted_hint(heard: str) -> str:
    """上一回合被打断：告诉模型主人大概听到哪儿，这次直接回应新的话，不从头重复。"""
    heard = (heard or "").strip()
    if heard:
        tail = heard if len(heard) <= 40 else "……" + heard[-40:]
        said = f"你上一句说到「{tail}」就被主人打断了，后面的主人没听到。"
    else:
        said = "你上一句刚开口就被主人打断了。"
    return f"（{said}这次直接回应主人新说的话，不要从头重复；没说完的内容主人需要时再补。）"


# ---------------- TTS 前的文本规整 ----------------

_DIGITS = "零一二三四五六七八九"


def _below_10k(n: int) -> str:
    """1–9999 的中文读法（中间的零只念一次，末尾的零不念）。"""
    out, zero = [], False
    for value, unit in ((n // 1000, "千"), (n // 100 % 10, "百"), (n // 10 % 10, "十"), (n % 10, "")):
        if value == 0:
            zero = bool(out)
            continue
        if zero:
            out.append("零")
            zero = False
        out.append(("两" if value == 2 and unit == "千" and not out else _DIGITS[value]) + unit)
    return "".join(out)


def cn_number(n: int) -> str:
    """整数 → 中文读法（10→十，105→一百零五，20500→两万零五百，-3→负三）。"""
    if n < 0:
        return "负" + cn_number(-n)
    if n == 0:
        return "零"
    if 10 <= n < 20:
        return "十" + (_DIGITS[n - 10] if n > 10 else "")
    for base, name in ((10 ** 8, "亿"), (10 ** 4, "万")):
        if n >= base:
            head, rest = divmod(n, base)
            head_text = "两" if head == 2 else cn_number(head)
            if not rest:
                return head_text + name
            return head_text + name + ("零" if rest < base // 10 else "") + _below_10k_or_big(rest)
    return _below_10k(n)


def _below_10k_or_big(n: int) -> str:
    return cn_number(n) if n >= 10 ** 4 else _below_10k(n)


def _cn_digits(s: str) -> str:
    return "".join(_DIGITS[int(c)] for c in s)


def _hour_words(h: int, m: int, period_given: bool) -> str:
    if period_given:
        period, h12 = "", (h - 12 if h > 12 else h)
    elif h < 5 or h == 24:
        period, h12 = "凌晨", h % 24
    elif h < 9:
        period, h12 = "早上", h
    elif h < 12:
        period, h12 = "上午", h
    elif h == 12:
        period, h12 = "中午", 12
    elif h < 18:
        period, h12 = "下午", h - 12
    else:
        period, h12 = "晚上", h - 12
    hour = "两" if h12 == 2 else cn_number(h12)
    if m == 0:
        tail = "点"
    elif m == 30:
        tail = "点半"
    elif m < 10:
        tail = f"点零{_DIGITS[m]}分"
    else:
        tail = f"点{cn_number(m)}分"
    return period + hour + tail


_PERIOD_WORDS = ("凌晨", "早上", "上午", "中午", "下午", "傍晚", "晚上", "夜里", "今晚", "明早", "半夜")
_TIME = re.compile(r"(?<![\d:])([01]?\d|2[0-4])[:：]([0-5]\d)(?::[0-5]\d)?(?![\d:])")
_DATE_YMD = re.compile(r"(?<!\d)(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})[日号]?(?!\d)")
_DATE_MD = re.compile(r"(?<!\d)(\d{1,2})月(\d{1,2})[日号](?!\d)")
_TEMP = re.compile(r"([-−－]?)(\d+(?:\.\d+)?)(?:\s*[~～\-–—到至]\s*([-−－]?)(\d+(?:\.\d+)?))?\s*(?:℃|°C|°c|°|度C)")
_PERCENT = re.compile(r"([-−－]?)(\d+(?:\.\d+)?)\s*[%％]")
_RANGE = re.compile(r"(?<![\d\-])(\d{1,4}(?:\.\d+)?)\s*[~～–—]\s*(\d{1,4}(?:\.\d+)?)(?![\d\-])"
                    r"|(?<![\d\-])(\d{1,4}(?:\.\d+)?)-(\d{1,4}(?:\.\d+)?)(?![\d\-])")
_NEG = re.compile(r"(?<![\w\d)）])[-−－](\d+(?:\.\d+)?)")
_MONEY_PREFIX = re.compile(r"([¥￥$])\s*(\d+(?:\.\d+)?)")
_UNIT_WORDS = (
    ("km/h", "公里每小时"), ("m/s", "米每秒"), ("km", "公里"), ("kg", "公斤"),
    ("mm", "毫米"), ("cm", "厘米"), ("ms", "毫秒"), ("min", "分钟"),
)
_UNIT = re.compile(r"(\d)\s*(" + "|".join(re.escape(u) for u, _ in _UNIT_WORDS) + r")(?![A-Za-z])")

_MD_CODE_BLOCK = re.compile(r"```[\s\S]*?(?:```|$)")
_MD_IMAGE = re.compile(r"!\[([^\]]*)\]\([^)]*\)")
_MD_LINK = re.compile(r"\[([^\]]*)\]\([^)]*\)")
_BARE_URL = re.compile(r"(?:https?://|www\.)[^\s）)\]】>，。；;、！？]+")
_MD_TABLE_ROW = re.compile(r"^[ \t]*\|.*\|[ \t]*$", re.MULTILINE)
_MD_LIST = re.compile(r"^[ \t]*(?:[-*+•]|\d{1,2}[.)、])[ \t]+", re.MULTILINE)
_MD_HEADING = re.compile(r"^[ \t]*#{1,6}[ \t]*", re.MULTILINE)
_MD_QUOTE = re.compile(r"^[ \t]*>[ \t]?", re.MULTILINE)
_MD_INLINE = re.compile(r"\*\*|__|~~|[*`#]")
_EMOJI = re.compile(
    "[\U0001F000-\U0001FAFF\U00002600-\U000027BF\U0001F1E6-\U0001F1FF"
    "⬀-⯿⌀-⏿️‍⃣]+")
_SOURCE_TAIL = re.compile(r"[（(]\s*(?:来源|出处|参考|source)[:：][^）)]*[）)]", re.IGNORECASE)
_URL_LABEL = re.compile(r"(?:来源|出处|参考|链接|网址|原文|详见|source)\s*[:：]?\s*(?=(?:https?://|www\.))",
                        re.IGNORECASE)
_SPACES = re.compile(r"[ \t]{2,}")


def _num_text(sign: str, num: str) -> str:
    """「-3」「2.5」→ 中文；整数走 cn_number，小数整数部分中文 + 点 + 逐位。"""
    neg = bool(sign)
    if "." in num:
        whole, frac = num.split(".", 1)
        text = cn_number(int(whole)) + "点" + _cn_digits(frac)
    else:
        text = cn_number(int(num))
    return ("负" if neg else "") + text


def _temp(m: re.Match) -> str:
    def one(sign, num):
        value = _num_text("", num)
        if num == "2":
            value = "两"
        return ("零下" if sign else "") + value
    low = one(m.group(1), m.group(2))
    if m.group(4) is None:
        return low + "度"
    return low + "到" + one(m.group(3), m.group(4)) + "度"


def _date_ymd(m: re.Match, today: _dt.date) -> str:
    year, month, day = int(m.group(1)), int(m.group(2)), int(m.group(3))
    if not (1 <= month <= 12 and 1 <= day <= 31):
        return m.group(0)
    head = "" if year == today.year else _cn_digits(m.group(1)) + "年"
    return f"{head}{cn_number(month)}月{cn_number(day)}号"


def _time(m: re.Match, text: str) -> str:
    h, minute = int(m.group(1)), int(m.group(2))
    before = text[max(0, m.start() - 3):m.start()]
    given = any(before.endswith(word) for word in _PERIOD_WORDS)
    return _hour_words(h, minute, given)


def normalize_numbers(text: str, today: _dt.date | None = None) -> str:
    """数字/时间/日期/温度/百分比/单位 → 中文口语读法（只改写确定的格式，其余原样交给 TTS）。"""
    today = today or _dt.date.today()
    text = _DATE_YMD.sub(lambda m: _date_ymd(m, today), text)
    text = _DATE_MD.sub(lambda m: f"{cn_number(int(m.group(1)))}月{cn_number(int(m.group(2)))}号", text)
    text = _TIME.sub(lambda m: _time(m, m.string), text)
    text = re.sub(r"(点(?:半|[零一二三四五六七八九十]+分)?)\s*[-–—~～]\s*(?=[凌早上中下晚]|[零一二两三四五六七八九十]+点)",
                  r"\1到", text)
    text = _TEMP.sub(_temp, text)
    text = _PERCENT.sub(lambda m: ("负" if m.group(1) else "") + "百分之" + _num_text("", m.group(2)), text)
    text = _MONEY_PREFIX.sub(lambda m: m.group(2) + ("美元" if m.group(1) == "$" else "元"), text)
    text = _UNIT.sub(lambda m: m.group(1) + dict(_UNIT_WORDS)[m.group(2)], text)
    text = _RANGE.sub(lambda m: f"{m.group(1) or m.group(3)}到{m.group(2) or m.group(4)}", text)
    text = _NEG.sub(lambda m: "负" + m.group(1), text)
    return text


def strip_markup(text: str) -> str:
    """去掉念不出口的东西：Markdown 痕迹、代码块、链接网址、表格、列表符号、表情。"""
    text = _MD_CODE_BLOCK.sub("代码我就不念了，", text)
    text = _MD_IMAGE.sub(r"\1", text)
    text = _MD_LINK.sub(r"\1", text)
    text = _SOURCE_TAIL.sub("", text)
    text = _URL_LABEL.sub("", text)         # 「来源：https://…」整段不念
    text = _BARE_URL.sub("", text)
    text = _MD_TABLE_ROW.sub("", text)      # 表格不出声，结论由正文句子承担
    text = _MD_LIST.sub("", text)
    text = _MD_HEADING.sub("", text)
    text = _MD_QUOTE.sub("", text)
    text = _MD_INLINE.sub("", text)
    text = _EMOJI.sub("", text)
    text = re.sub(r"[（(]\s*[）)]", "", text)  # 删掉网址后留下的空括号
    text = re.sub(r"\s*\n\s*", "，", text)
    text = _SPACES.sub(" ", text)
    text = re.sub(r"\s+([，。！？、；：,.!?;:])", r"\1", text)
    text = re.sub(r"^[，。！？、；：,.!?;:\s]+", "", text)
    return text.strip(" ，,：:")


def to_spoken(text: str, today: _dt.date | None = None) -> str:
    """一句回答 → 念得出口的中文。结果为空表示这句不必出声（比如整句是表格/链接）。"""
    text = strip_markup(text or "")
    if not re.search(r"[\w]", text):
        return ""
    return normalize_numbers(text, today).strip()
