"""文字体检插件测试：直接测工具函数，不需要模型。"""
import importlib.util
import json
import re
from pathlib import Path

PLUGIN_DIR = Path(__file__).resolve().parents[1]
MANIFEST = json.loads((PLUGIN_DIR / "plugin.json").read_text(encoding="utf-8"))


def _load_tools():
    spec = importlib.util.spec_from_file_location(f"plugin_{MANIFEST['id']}_tools", PLUGIN_DIR / "tools.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


tools = _load_tools()
AD = "本店草莓全网最低价，绝对新鲜，100%产地直发。草莓酸甜，草莓个大，草莓现摘。我们的的草莓最好，，快来买。"


def test_manifest_matches_exports():
    assert re.fullmatch(r"[a-z][a-z0-9_]{1,30}", MANIFEST["id"])
    assert [t.name for t in tools.TOOLS] == MANIFEST["tools"]
    assert all(t.name.startswith(MANIFEST["id"]) and t.description.strip() for t in tools.TOOLS)


def test_stats_counts():
    s = tools.stats("第一段，有八个字。\n\nHello world 2026!")
    assert s["han"] == 7 and s["en_words"] == 2 and s["digits"] == 1
    assert s["paragraphs"] == 2 and s["sentences"] == 2


def test_reading_time():
    report = tools.check("字" * 900)
    assert "默读约 3 分钟" in report
    assert "不到 1 分钟" in tools.check("很短的一句话。")


def test_repeated_words_prefers_longest_fragment():
    words = dict(tools.repeated_words("贾维斯很好用。贾维斯很聪明。贾维斯会记事。"))
    assert words.get("贾维斯") == 3
    assert "贾维" not in words and "维斯" not in words


def test_ad_words_longest_match_and_exceptions():
    hits = [h["word"] for h in tools.find_words(AD, tools.AD_WORDS)]
    assert hits == ["全网最低", "绝对", "100%", "最好"]          # 「最低价」不重复记
    assert tools.find_words("数学课讲绝对值和绝对零度", tools.AD_WORDS) == []


def test_full_report():
    report = tools.check(AD)
    assert "「草莓」" in report
    assert "「的的」" in report and "「，，」" in report
    assert "广告极限词 4 处" in report and "改成「很好」" in report


def test_custom_sensitive_words():
    report = tools.check_ad_words("加我微信，代购正品", "代购, 返利")
    assert "你指定的敏感词 1 处" in report and "「代购」" in report


def test_clean_text_and_empty_text():
    assert tools.check_ad_words("今天天气不错，常常去散步。").startswith("✅ 没发现")
    assert "没有收到" in tools.check("   ")


def test_long_text_is_capped():
    report = tools.check("好" * (tools.MAX_TEXT_CHARS + 10))
    assert f"只检查了前 {tools.MAX_TEXT_CHARS} 字" in report


def test_tool_invoke():
    out = tools.text_check.invoke({"text": "一句话。"})
    assert out.startswith("📋 文字体检报告")
    assert "顶级" in tools.text_check_ad_words.invoke({"text": "顶级好茶"})
