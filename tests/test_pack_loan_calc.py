"""官方工具插件「房贷车贷计算」：等额本息 / 等额本金的已知值、提前还款、输入校验、清单一致。"""
import json
from pathlib import Path

import pytest

from jarvis.plugins.packs.loan_calc import tools as loan_calc_tools

PACK = Path(loan_calc_tools.__file__).resolve().parent
MANIFEST = json.loads((PACK / "plugin.json").read_text(encoding="utf-8"))


def test_manifest_matches_exports():
    assert [t.name for t in loan_calc_tools.TOOLS] == MANIFEST["tools"] == ["loan_calc_payment", "loan_calc_prepay"]
    assert MANIFEST["license"] == "MIT-0" and MANIFEST["author"] == "JWS-Agent"


def test_equal_payment_known_values():
    # 100 万、30 年、3.1%：等额本息月供 4270.16 元（月利率 0.031/12，360 期）
    assert round(loan_calc_tools.equal_payment(1_000_000, 3.1, 360), 2) == 4270.16
    # 10 万、3 年、0 利率：每月 2777.78
    assert round(loan_calc_tools.equal_payment(100_000, 0, 36), 2) == 2777.78
    # 30 万、5 年、4.9%：月供 5647.64（常见房贷计算器同值）
    assert round(loan_calc_tools.equal_payment(300_000, 4.9, 60), 2) == 5647.64


def test_equal_principal_known_values():
    s = loan_calc_tools.equal_principal_summary(1_000_000, 3.1, 360)
    assert round(s["first"], 2) == 5361.11            # 2777.78 本金 + 2583.33 利息
    assert round(s["decrease"], 2) == 7.18
    assert round(s["last"], 2) == 2784.95
    assert round(s["interest"], 2) == 466291.67       # 本金 × 月利率 × (期数 + 1) ÷ 2


def test_schedules_are_consistent():
    rows = loan_calc_tools.equal_payment_schedule(1_000_000, 3.1, 360, 360)
    assert len(rows) == 360 and abs(rows[-1][4]) < 0.01                 # 最后一期还清
    assert abs(sum(r[2] for r in rows) - 1_000_000) < 0.01              # 本金之和 = 贷款额
    principal_rows = loan_calc_tools.equal_principal_schedule(1_000_000, 3.1, 360, 3)
    assert [round(r[1], 2) for r in principal_rows] == [5361.11, 5353.94, 5346.76]


def test_payment_text_compares_both_methods():
    out = loan_calc_tools.payment_text("100万", 3.1, 30)
    assert "贷款 100 万元 · 年利率 3.1% · 30 年（360 期）" in out
    assert "每月 4,270.16 元" in out and "537,259.04 元" in out          # 等额本息总利息
    assert "首月 5,361.11 元" in out and "466,291.67 元" in out
    assert "等额本金总利息少 70,967.37 元" in out
    assert "利率以合同为准" in out and "仅供参考" in out


def test_payment_text_single_method_and_details():
    out = loan_calc_tools.payment_text("10万", 4.5, months=36, method="等额本金", show_months=2)
    assert "**等额本金**：首月还 3,152.78 元" in out and "等额本息" not in out.split("\n\n")[1]
    assert "| 2 |" in out and "| 3 |" not in out
    capped = loan_calc_tools.payment_text("100万", 3.1, 30, show_months=99)
    assert "| 12 |" in capped and "| 13 |" not in capped and len(capped) <= 2000


def test_prepay_shorten_and_reduce():
    balance = loan_calc_tools.remaining_balance(1_000_000, 3.1, 360, 36)
    assert round(balance, 2) == 936446.66
    shorten = loan_calc_tools.prepay_text("100万", 3.1, 30, 36, "20万", "缩短年限")
    assert "月供还是 4,270.16 元" in shorten and "再还 229 期就还清" in shorten and "少还 95 期" in shorten
    reduce = loan_calc_tools.prepay_text("100万", 3.1, 30, 36, "20万", "reduce")
    assert "降到 3,358.17 元" in reduce and "还是 324 期还完" in reduce
    saved = lambda text: float(text.split("省利息约 ")[1].split(" 元")[0].replace(",", ""))   # noqa: E731
    assert saved(shorten) > saved(reduce) > 0                           # 缩短年限省得更多
    payoff = loan_calc_tools.prepay_text("100万", 3.1, 30, 36, "200万")
    assert "一次还清" in payoff and "936,446.66" in payoff
    assert "违约金" in shorten


def test_months_to_repay_zero_rate():
    count, total = loan_calc_tools.months_to_repay(10_000, 0, 3_000)
    assert count == 4 and abs(total - 10_000) < 0.01


@pytest.mark.parametrize("kwargs,hint", [
    ({"amount": "很多钱", "annual_rate": 3.1, "years": 30}, "看不懂"),
    ({"amount": "0", "annual_rate": 3.1, "years": 30}, "要大于 0"),
    ({"amount": "2亿", "annual_rate": 3.1, "years": 30}, "最多算 1 亿元"),
    ({"amount": "100万", "annual_rate": 3.1, "years": 40}, "最长按 30 年"),
    ({"amount": "100万", "annual_rate": 3.1}, "贷几年"),
    ({"amount": "100万", "annual_rate": 3.1, "years": 2.33}, "不是整数"),
    ({"amount": "100万", "annual_rate": 3.1, "months": 400}, "1 到 360"),
    ({"amount": "100万", "annual_rate": -1, "years": 30}, "0 或正数"),
    ({"amount": "100万", "annual_rate": 36, "years": 30}, "超过 24%"),
    ({"amount": "100万", "annual_rate": 3.1, "years": 30, "method": "随便"}, "还款方式只能是"),
])
def test_payment_bad_input(kwargs, hint):
    assert hint in loan_calc_tools.payment_text(**kwargs)


def test_prepay_bad_input():
    assert "已还期数要在 0 到 359" in loan_calc_tools.prepay_text("100万", 3.1, 30, 360, "10万")
    assert "提前还款金额" in loan_calc_tools.prepay_text("100万", 3.1, 30, 12, "不少")
    assert "缩短年限" in loan_calc_tools.prepay_text("100万", 3.1, 30, 12, "10万", "瞎填")


def test_rate_given_as_fraction_gets_a_hint():
    assert "请用 3.1 重新算" in loan_calc_tools.payment_text("100万", 0.031, 30)


def test_tool_invoke():
    out = loan_calc_tools.loan_calc_payment.invoke({"amount": "100万", "annual_rate": 3.1, "years": 30,
                                                    "method": "equal_payment"})
    assert "每月还 4,270.16 元" in out
    out = loan_calc_tools.loan_calc_prepay.invoke({"amount": "100万", "annual_rate": 3.1, "years": 30,
                                                   "paid_months": 36, "prepay_amount": "20万", "mode": "reduce"})
    assert "3,358.17" in out
