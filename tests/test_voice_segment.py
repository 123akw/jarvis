"""句子切分器测试：确定性，不联网。"""
from jarvis.voice.segment import FirstFastSegmenter, SentenceSegmenter, speakable


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


def test_first_fast_segmenter_speaks_early_then_steady():
    """首句在软标点提前开口；之后恢复正常句长，不再碎切。"""
    seg = FirstFastSegmenter(min_chars=6, max_chars=80, first_max_chars=24)
    text = "那我给您讲一个冷知识：蜂鸟是唯一能倒着飞的鸟，而且它们的心跳每分钟能跳一千多次。"
    out = []
    for i in range(0, len(text), 4):  # 模拟流式 token 分片
        out.extend(seg.push(text[i:i + 4]))
    assert out, "整段只有末尾句号时首句必须提前切出来"
    assert len(out[0]) <= 25 and out[0][-1] in "，,、：:"
    assert seg.max_chars == 80, "开口后恢复正常阈值"
    # 后续内容不再按 24 字碎切：40 字无硬标点应继续攒着
    assert seg.push("接下来这一段没有硬标点也没有软标点但是长度不超过八十所以要攒着不切") == []


def test_first_fast_segmenter_hard_boundary_still_wins():
    seg = FirstFastSegmenter()
    assert seg.push("好的，收到。后面还有话") == ["好的，收到。"]


def test_speakable_strips_markdown():
    assert speakable("**加粗** 和 `代码`") == "加粗 和 代码"
    assert speakable("看[这里](https://example.com)就好") == "看这里就好"
    assert "（代码略）" in speakable("前文\n```python\nprint(1)\n```\n后文")


def test_speakable_skips_bare_urls():
    assert speakable("详情见 https://example.com/a?b=1 这里") == "详情见 （链接略） 这里"
    assert "http" not in speakable("官网：https://jws.gkgeek-set.cn/path。")


def test_speakable_skips_table_rows():
    text = "结论是这样。\n| 平台 | 评分 |\n| 豆瓣 | 9.0 |\n口语补充。"
    spoken = speakable(text)
    assert "豆瓣" not in spoken and "|" not in spoken, "表格不出声"
    assert "结论是这样。" in spoken and "口语补充。" in spoken
