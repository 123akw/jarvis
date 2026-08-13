"""句子切分器测试：确定性，不联网。"""
from jarvis.voice.segment import SentenceSegmenter, speakable


def test_hard_boundary_emits_sentence():
    seg = SentenceSegmenter()
    out = []
    for piece in ["你好，", "我是贾", "维斯。", "有什么", "吩咐？"]:
        out.extend(seg.push(piece))
    assert out == ["你好，我是贾维斯。", "有什么吩咐？"]
    assert seg.flush() is None


def test_short_fragment_not_emitted_until_long_enough():
    seg = SentenceSegmenter(min_chars=6)
    assert seg.push("好。") == []  # 太短，攒着
    assert seg.push("马上办。") == ["好。马上办。"]


def test_flush_returns_tail_without_punctuation():
    seg = SentenceSegmenter()
    assert seg.push("明天九点提醒你开会") == []
    assert seg.flush() == "明天九点提醒你开会"
    assert seg.flush() is None


def test_overlong_buffer_cuts_at_soft_boundary():
    seg = SentenceSegmenter(min_chars=6, max_chars=20)
    text = "第一段内容比较长，第二段内容也比较长而且没有句号一直在继续说下去"
    out = seg.push(text)
    assert out, "超长必须强制切"
    assert all(len(s) <= 20 for s in out)
    assert out[0].endswith("，")


def test_speakable_strips_markdown():
    assert speakable("**加粗** 和 `代码`") == "加粗 和 代码"
    assert speakable("看[这里](https://example.com)就好") == "看这里就好"
    assert "（代码略）" in speakable("前文\n```python\nprint(1)\n```\n后文")
