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


def test_first_clause_goes_to_tts_at_first_comma():
    """首句在第一个逗号就送 TTS（真 DeepSeek 时间轴回放：比旧规则早 40–50ms、首句短一半）。"""
    seg = FirstFastSegmenter()
    out = []
    for piece in ["北极", "熊", "的", "毛", "其实是", "透明的", "，"]:
        out.extend(seg.push(piece))
    assert out == ["北极熊的毛其实是透明的，"], "不用再等缓冲超过 24 字"
    # 开口后恢复正常节奏：同一次 push 里也不再按逗号碎切
    assert seg.push("不是白色，你看到的白，是光线散射出来的错觉。顺带") == [
        "不是白色，你看到的白，是光线散射出来的错觉。"]


def test_first_clause_too_short_waits_for_next_pause():
    seg = FirstFastSegmenter()
    assert seg.push("好的，") == [], "3 字太短不值一次 TTS 往返"
    assert seg.push("没问题，马上办") == ["好的，没问题，"]


def test_first_clause_does_not_split_numbers():
    """数字里的 ASCII 冒号/逗号不是停顿：10:30、1,000 不能被念断。"""
    seg = FirstFastSegmenter()
    assert seg.push("会议改到10:") == [], "冒号后的字还没到，先等"
    assert seg.push("30开始，记得带电脑。") == ["会议改到10:30开始，", "记得带电脑。"]
    seg = FirstFastSegmenter()
    assert seg.push("预算一共1,000元, 够用") == ["预算一共1,000元,"]


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
