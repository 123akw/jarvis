"""官方工具插件「金额大写」：大写规则（按《正确填写票据和结算凭证的基本规定》）、输入解析、清单一致。"""
import json
from decimal import Decimal
from pathlib import Path

import pytest

from jarvis.plugins.packs.rmb_upper import tools as rmb_upper_tools

PACK = Path(rmb_upper_tools.__file__).resolve().parent
MANIFEST = json.loads((PACK / "plugin.json").read_text(encoding="utf-8"))


def _upper(text: str) -> str:
    out = rmb_upper_tools.convert(text)
    first = out.splitlines()[0]
    assert first.startswith("**大写**："), out
    return first.removeprefix("**大写**：")


def test_manifest_matches_exports():
    assert [t.name for t in rmb_upper_tools.TOOLS] == MANIFEST["tools"] == ["rmb_upper"]
    assert MANIFEST["license"] == "MIT-0" and MANIFEST["author"] == "JWS-Agent"


@pytest.mark.parametrize("amount,expected", [
    ("0.5", "伍角整"),
    ("0.05", "伍分"),
    ("0.55", "伍角伍分"),
    ("1", "壹元整"),
    ("10", "壹拾元整"),                       # 「壹拾」的壹不省
    ("10.00", "壹拾元整"),
    ("101", "壹佰零壹元整"),
    ("1001", "壹仟零壹元整"),
    ("1010", "壹仟零壹拾元整"),
    ("100000", "壹拾万元整"),
    ("107000.53", "壹拾万柒仟元零伍角叁分"),   # 规定原文的例子
    ("1680.32", "壹仟陆佰捌拾元零叁角贰分"),   # 规定原文的例子
    ("1409.50", "壹仟肆佰零玖元伍角整"),       # 规定原文的例子
    ("6007.14", "陆仟零柒元壹角肆分"),         # 规定原文的例子
    ("325.04", "叁佰贰拾伍元零肆分"),          # 规定原文的例子
    ("1680.02", "壹仟陆佰捌拾元零贰分"),
    ("1e8", "壹亿元整"),
    ("100000001", "壹亿零壹元整"),
    ("100010000", "壹亿零壹万元整"),
    ("100001000", "壹亿零壹仟元整"),
    ("1000100", "壹佰万零壹佰元整"),
    ("9999999999.99", "玖拾玖亿玖仟玖佰玖拾玖万玖仟玖佰玖拾玖元玖角玖分"),
    ("999999999999.99", "玖仟玖佰玖拾玖亿玖仟玖佰玖拾玖万玖仟玖佰玖拾玖元玖角玖分"),
])
def test_upper_follows_the_rules(amount, expected):
    assert _upper(amount) == expected


@pytest.mark.parametrize("text,expected", [
    ("12,345.67", "壹万贰仟叁佰肆拾伍元陆角柒分"),
    ("¥3,000", "叁仟元整"),
    ("1.2万", "壹万贰仟元整"),
    ("3亿", "叁亿元整"),
    ("RMB 50元", "伍拾元整"),
    ("1，280", "壹仟贰佰捌拾元整"),
])
def test_common_input_forms(text, expected):
    assert _upper(text) == expected


def test_lower_form_and_contract_hint():
    out = rmb_upper_tools.convert("1680.32")
    assert "**小写**：¥1,680.32" in out and "人民币（大写）壹仟陆佰捌拾元零叁角贰分（¥1,680.32）" in out


def test_rounds_half_up_to_cents_and_says_so():
    out = rmb_upper_tools.convert("1.005")
    assert out.startswith("**大写**：壹元零壹分") and "四舍五入" in out
    assert _upper("2.344") == "贰元叁角肆分"
    assert "四舍五入" not in rmb_upper_tools.convert("2.30")


@pytest.mark.parametrize("bad,hint", [
    ("abc", "不像一个金额"),
    ("", "没有收到金额"),
    ("壹佰元", "不像一个金额"),
    ("1.2.3", "不像一个金额"),
    ("1" * 60, "太长"),
    ("-5", "负数没有大写写法"),
    ("1000000000000", "金额太大"),
    ("999999999999.995", "金额太大"),          # 四舍五入后到 1 万亿
    ("inf", "不像一个金额"),
    ("nan", "不像一个金额"),
])
def test_bad_input_gets_plain_words_not_exceptions(bad, hint):
    assert hint in rmb_upper_tools.convert(bad)


def test_zero_is_explained():
    out = rmb_upper_tools.convert("0")
    assert "零元整" in out and "一般不用开票据" in out


def test_to_upper_on_decimal_directly():
    assert rmb_upper_tools.to_upper(Decimal("20000.40")) == "贰万元零肆角整"


def test_tool_invoke():
    out = rmb_upper_tools.rmb_upper.invoke({"amount": "107000.53"})
    assert "壹拾万柒仟元零伍角叁分" in out and "¥107,000.53" in out
