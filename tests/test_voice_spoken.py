"""语音「说人话」：口语规则片段 + TTS 前文本规整（纯函数，不联网）。"""
import datetime as dt

import pytest

from jarvis.voice import spoken

TODAY = dt.date(2026, 10, 2)


def say(text):
    return spoken.to_spoken(text, TODAY)


@pytest.mark.parametrize("n,text", [
    (0, "零"), (2, "二"), (10, "十"), (15, "十五"), (20, "二十"), (105, "一百零五"),
    (110, "一百一十"), (1001, "一千零一"), (2026, "两千零二十六"), (20500, "两万零五百"),
    (120000, "十二万"), (-3, "负三"),
])
def test_cn_number(n, text):
    assert spoken.cn_number(n) == text


@pytest.mark.parametrize("raw,expected", [
    ("会议在15:00开始。", "会议在下午三点开始。"),
    ("下午3:30见。", "下午三点半见。"),           # 已有时段词不重复加
    ("明早07:05出发", "明早七点零五分出发"),
    ("晚上22:00睡觉", "晚上十点睡觉"),
    ("12:00 吃饭", "中午十二点 吃饭"),
    ("14:00到", "下午两点到"),
    ("15:00-16:30 有个会", "下午三点到下午四点半 有个会"),
    ("比分 3:2", "比分 3:2"),                      # 不是时间不动
])
def test_times_read_as_spoken_chinese(raw, expected):
    assert say(raw) == expected


@pytest.mark.parametrize("raw,expected", [
    ("今天-3℃", "今天零下三度"),
    ("明天-3~5℃", "明天零下三到五度"),
    ("后天26°C。", "后天二十六度。"),
    ("气温2℃", "气温两度"),
    ("2026-10-02 是周五", "十月二号 是周五"),        # 今年的年份不念
    ("2027年1月5日上线", "二零二七年一月五号上线"),
    ("10月2日放假", "十月二号放假"),
    ("涨了3.5%", "涨了百分之三点五"),
    ("时速120km/h，重60kg", "时速120公里每小时，重60公斤"),
    ("价格¥12", "价格12元"),
    ("三到五天，3~5天", "三到五天，3到5天"),
    ("电话 138-0000-0000", "电话 138-0000-0000"),   # 电话号码不当区间
])
def test_units_dates_and_ranges(raw, expected):
    assert say(raw) == expected


@pytest.mark.parametrize("raw,expected", [
    ("**重点**：带伞 ☔️🙂", "重点：带伞"),
    ("详见 [官网](https://a.com/x)。", "详见 官网。"),
    ("北京晴。来源：https://news.qq.com/a/1", "北京晴。"),
    ("（来源：新华网）北京晴", "北京晴"),
    ("- 第一项\n- 第二项\n1. 第三项", "第一项，第二项，第三项"),
    ("## 结论\n明天有雨", "结论，明天有雨"),
    ("```py\nprint(1)\n```", "代码我就不念了，"),
])
def test_markup_links_emoji_are_not_read(raw, expected):
    assert say(raw) == expected


def test_unspeakable_sentence_becomes_empty():
    assert say("| a | b |") == ""
    assert say("https://example.com") == ""
    assert say("🙂") == ""


def test_spoken_rules_cover_the_contract():
    rules = spoken.SPOKEN_RULES
    for must in ("结论先说", "Markdown", "表情", "下午三点", "零下三度", "十月二号", "网址", "三项", "没听清"):
        assert must in rules, must


def test_interrupted_hint_quotes_heard_tail():
    hint = spoken.interrupted_hint("明天北京晴，最高二十六度，")
    assert "明天北京晴，最高二十六度" in hint and "打断" in hint and "不要从头重复" in hint
    long = spoken.interrupted_hint("很长" * 50)
    assert "……" in long and len(long) < 120
    assert "刚开口" in spoken.interrupted_hint("")


def test_emotion_hint_is_restrained():
    assert spoken.emotion_hint("neutral") == "" and spoken.emotion_hint("") == ""
    sad = spoken.emotion_hint("sad")
    assert "低落" in sad and "不要点破" in sad
