"""房贷车贷计算：等额本息 / 等额本金的月供、总利息，两种方式对比；等额本息的提前还款测算。纯标准库，不联网。

公式（按月计息，月利率 = 年利率 ÷ 12）：
- 等额本息：月供 = 本金 × 月利率 × (1+月利率)^期数 ÷ [(1+月利率)^期数 − 1]；
- 等额本金：每月本金 = 本金 ÷ 期数，每月利息 = 剩余本金 × 月利率，月供逐月递减「每月本金 × 月利率」；
- 提前还款：先算已还 k 期后的剩余本金，扣掉提前还的钱，再按「月供不变、缩短期数」或「期数不变、重算月供」。
不内置 LPR 等利率数值（会变），利率由用户按合同给；结果按分四舍五入展示，和银行的还款计划可能差几分钱。
"""
from __future__ import annotations

import math
import re

from langchain_core.tools import tool
from pydantic import BaseModel, Field

MAX_AMOUNT = 100_000_000          # 1 亿元
MAX_MONTHS = 360                  # 30 年
MAX_RATE = 24.0                   # 年利率上限（%）
MAX_SHOW = 12
NOTE = "利率以合同为准；结果仅供参考，和银行的还款计划可能有几分钱出入。"
METHODS = {
    "both": "both", "都算": "both", "对比": "both", "全部": "both", "": "both",
    "equal_payment": "equal_payment", "等额本息": "equal_payment", "本息": "equal_payment",
    "equal_principal": "equal_principal", "等额本金": "equal_principal", "本金": "equal_principal",
}
_UNITS = {"万": 10_000, "千": 1_000, "亿": 100_000_000}


# ---------- 输入 ----------

def parse_amount(text) -> float | str:
    """「100万」「35,0000」「800000元」「1.5亿」→ 元；看不懂返回一句人话。"""
    raw = str(text if text is not None else "").strip()
    cleaned = re.sub(r"[\s,，¥￥]|人民币|元", "", raw)
    factor = 1
    if cleaned and cleaned[-1] in _UNITS:
        factor, cleaned = _UNITS[cleaned[-1]], cleaned[:-1]
    if not re.fullmatch(r"\d+(\.\d+)?", cleaned or ""):
        return f"贷款金额「{raw[:20]}」看不懂，请给一个数，比如「100万」或「350000」。"
    value = float(cleaned) * factor
    if value <= 0:
        return "贷款金额要大于 0。"
    if value > MAX_AMOUNT:
        return "贷款金额太大了，这里最多算 1 亿元。"
    return value


def term_months(years: float = 0, months: int = 0) -> int | str:
    """年限或月数 → 期数；两个都给时以月数为准。"""
    if months:
        if months < 1 or months > MAX_MONTHS:
            return "贷款期数要在 1 到 360 个月（30 年）之间。"
        return int(months)
    if not years or years <= 0:
        return "请告诉我贷几年（或几个月）。"
    total = years * 12
    if abs(total - round(total)) > 1e-6:
        return "年限换成月数不是整数，请直接告诉我贷多少个月。"
    total = int(round(total))
    if total > MAX_MONTHS:
        return "贷款年限最长按 30 年（360 期）算。"
    return total


def check_rate(annual_rate: float) -> str:
    """利率合法返回空串，否则返回一句人话。"""
    if annual_rate is None or not math.isfinite(annual_rate) or annual_rate < 0:
        return "年利率要是 0 或正数，按百分数给，比如 3.1 表示 3.1%。"
    if annual_rate > MAX_RATE:
        return "年利率超过 24% 了，请核对一下（按百分数给，比如 3.1 表示 3.1%）。"
    return ""


def rate_hint(annual_rate: float) -> str:
    if 0 < annual_rate < 0.2:
        return f"\n提醒：年利率按 {annual_rate}% 算的；如果你说的是 {annual_rate * 100:g}%，请用 {annual_rate * 100:g} 重新算。"
    return ""


# ---------- 计算 ----------

def equal_payment(principal: float, annual_rate: float, months: int) -> float:
    """等额本息月供（未取整）。"""
    r = annual_rate / 100 / 12
    if r == 0:
        return principal / months
    growth = (1 + r) ** months
    return principal * r * growth / (growth - 1)


def equal_payment_schedule(principal: float, annual_rate: float, months: int, rows: int) -> list[tuple]:
    r = annual_rate / 100 / 12
    pay = equal_payment(principal, annual_rate, months)
    balance, out = principal, []
    for k in range(1, min(rows, months) + 1):
        interest = balance * r
        part = pay - interest
        balance -= part
        out.append((k, pay, part, interest, max(balance, 0.0)))
    return out


def equal_principal_summary(principal: float, annual_rate: float, months: int) -> dict:
    r = annual_rate / 100 / 12
    part = principal / months
    return {"first": part + principal * r, "last": part + part * r, "decrease": part * r,
            "interest": principal * r * (months + 1) / 2, "part": part}


def equal_principal_schedule(principal: float, annual_rate: float, months: int, rows: int) -> list[tuple]:
    r = annual_rate / 100 / 12
    part = principal / months
    out = []
    for k in range(1, min(rows, months) + 1):
        balance_before = principal - part * (k - 1)
        interest = balance_before * r
        out.append((k, part + interest, part, interest, max(balance_before - part, 0.0)))
    return out


def remaining_balance(principal: float, annual_rate: float, months: int, paid: int) -> float:
    """等额本息已还 paid 期后的剩余本金。"""
    r = annual_rate / 100 / 12
    pay = equal_payment(principal, annual_rate, months)
    if r == 0:
        return max(principal - pay * paid, 0.0)
    growth = (1 + r) ** paid
    return max(principal * growth - pay * (growth - 1) / r, 0.0)


def months_to_repay(balance: float, annual_rate: float, pay: float) -> tuple[int, float]:
    """月供 pay 不变时，还清 balance 要几期、一共还多少钱（最后一期按实际剩余收）。"""
    r = annual_rate / 100 / 12
    count, total = 0, 0.0
    while balance > 0.005 and count < MAX_MONTHS:
        interest = balance * r
        due = balance + interest
        if due <= pay:
            total += due
            balance = 0.0
        else:
            total += pay
            balance = due - pay
        count += 1
    return count, total


# ---------- 文本 ----------

def yuan(value: float) -> str:
    return f"{value:,.2f} 元"


def wan(value: float) -> str:
    """金额简写：35.6 万元 / 8,000 元。"""
    if value >= 10_000:
        return f"{value / 10_000:,.2f} 万元".replace(".00 万", " 万")
    return f"{value:,.0f} 元"


def term_text(months: int) -> str:
    years, rest = divmod(months, 12)
    if rest == 0:
        return f"{years} 年（{months} 期）"
    return f"{months} 个月（{months} 期）" if years == 0 else f"{years} 年 {rest} 个月（{months} 期）"


def _table(rows: list[tuple]) -> list[str]:
    lines = ["| 期数 | 月供 | 其中本金 | 其中利息 | 剩余本金 |", "| --- | --- | --- | --- | --- |"]
    for k, pay, part, interest, balance in rows:
        lines.append(f"| {k} | {pay:,.2f} | {part:,.2f} | {interest:,.2f} | {balance:,.2f} |")
    return lines


def payment_text(amount, annual_rate: float, years: float = 0, months: int = 0, method: str = "both",
                 show_months: int = 0) -> str:
    principal = parse_amount(amount)
    if isinstance(principal, str):
        return principal
    n = term_months(years, months)
    if isinstance(n, str):
        return n
    problem = check_rate(annual_rate)
    if problem:
        return problem
    chosen = METHODS.get(str(method or "").strip().lower(), METHODS.get(str(method or "").strip()))
    if chosen is None:
        return "还款方式只能是「等额本息」「等额本金」或「都算」。"
    rows = max(0, min(int(show_months or 0), MAX_SHOW))
    lines = [f"贷款 {wan(principal)} · 年利率 {annual_rate:g}% · {term_text(n)}", ""]
    pay = equal_payment(principal, annual_rate, n)
    ep_interest = pay * n - principal
    ap = equal_principal_summary(principal, annual_rate, n)
    if chosen == "both":
        lines += ["| 还款方式 | 月供 | 总利息 | 还款总额 |", "| --- | --- | --- | --- |",
                  f"| 等额本息 | 每月 {yuan(pay)} | {yuan(ep_interest)} | {yuan(principal + ep_interest)} |",
                  f"| 等额本金 | 首月 {yuan(ap['first'])}，每月少 {ap['decrease']:,.2f} 元，末月 {yuan(ap['last'])}"
                  f" | {yuan(ap['interest'])} | {yuan(principal + ap['interest'])} |", ""]
        saved = ep_interest - ap["interest"]
        if annual_rate > 0:
            lines.append(f"等额本金总利息少 {yuan(saved)}，但首月要比等额本息多还 {yuan(ap['first'] - pay)}；"
                         "收入稳定、想月供固定选等额本息，前期手头宽裕、想少付利息选等额本金。")
    elif chosen == "equal_payment":
        lines += [f"**等额本息**：每月还 {yuan(pay)}", f"总利息 {yuan(ep_interest)}，还款总额 {yuan(principal + ep_interest)}"]
    else:
        lines += [f"**等额本金**：首月还 {yuan(ap['first'])}，之后每月少 {ap['decrease']:,.2f} 元，末月 {yuan(ap['last'])}",
                  f"每月固定还本金 {yuan(ap['part'])}；总利息 {yuan(ap['interest'])}，还款总额 {yuan(principal + ap['interest'])}"]
    if rows:
        if chosen in ("both", "equal_payment"):
            lines += ["", f"等额本息前 {min(rows, n)} 期："] + _table(equal_payment_schedule(principal, annual_rate, n, rows))
        if chosen in ("both", "equal_principal"):
            lines += ["", f"等额本金前 {min(rows, n)} 期："] + _table(equal_principal_schedule(principal, annual_rate, n, rows))
    lines += ["", NOTE + rate_hint(annual_rate)]
    return "\n".join(lines)


def prepay_text(amount, annual_rate: float, years: float = 0, paid_months: int = 0, prepay_amount="",
                mode: str = "shorten", months: int = 0) -> str:
    principal = parse_amount(amount)
    if isinstance(principal, str):
        return principal
    n = term_months(years, months)
    if isinstance(n, str):
        return n
    problem = check_rate(annual_rate)
    if problem:
        return problem
    if paid_months is None or paid_months < 0 or paid_months >= n:
        return f"已还期数要在 0 到 {n - 1} 之间（总共 {n} 期）。"
    prepay = parse_amount(prepay_amount)
    if isinstance(prepay, str):
        return prepay.replace("贷款金额", "提前还款金额")
    mode_key = {"shorten": "shorten", "缩短年限": "shorten", "缩短期限": "shorten", "月供不变": "shorten",
                "reduce": "reduce", "减少月供": "reduce", "期限不变": "reduce", "年限不变": "reduce"}.get(
        str(mode or "shorten").strip().lower(), None)
    if mode_key is None:
        return "提前还款方式只能是「缩短年限」（月供不变）或「减少月供」（年限不变）。"
    pay = equal_payment(principal, annual_rate, n)
    left = n - paid_months
    balance = remaining_balance(principal, annual_rate, n, paid_months)
    future_total = pay * left                       # 不提前还，剩下还要还的钱
    head = [f"贷款 {wan(principal)} · 年利率 {annual_rate:g}% · {term_text(n)} · 等额本息，已还 {paid_months} 期",
            f"现在月供 {yuan(pay)}，剩余本金约 {yuan(balance)}，还剩 {left} 期。", ""]
    if prepay >= balance - 0.005:
        saved = future_total - balance
        return "\n".join(head + [f"提前还 {wan(prepay)}已经够一次还清（只需约 {yuan(balance)}），"
                                 f"能省下利息约 {yuan(saved)}。", "", NOTE + PREPAY_NOTE])
    new_balance = balance - prepay
    if mode_key == "shorten":
        count, total = months_to_repay(new_balance, annual_rate, pay)
        saved = future_total - total - prepay
        body = [f"**缩短年限（月供不变）**：提前还 {wan(prepay)}后，月供还是 {yuan(pay)}，",
                f"再还 {count} 期就还清，比原来少还 {left - count} 期（约 {(left - count) / 12:.1f} 年），省利息约 {yuan(saved)}。"]
    else:
        new_pay = equal_payment(new_balance, annual_rate, left)
        saved = future_total - new_pay * left - prepay
        body = [f"**减少月供（年限不变）**：提前还 {wan(prepay)}后，月供从 {yuan(pay)} 降到 {yuan(new_pay)}，"
                f"每月少还 {yuan(pay - new_pay)}；还是 {left} 期还完，省利息约 {yuan(saved)}。"]
    other = "减少月供" if mode_key == "shorten" else "缩短年限"
    body.append(f"一般来说「缩短年限」省的利息更多，「减少月供」每月压力更小；想对比可以再按「{other}」算一次。")
    return "\n".join(head + body + ["", NOTE + PREPAY_NOTE + rate_hint(annual_rate)])


PREPAY_NOTE = "有的银行对提前还款有违约金、预约或时间要求，办理前问一下贷款银行。这里只按等额本息测算。"


# ---------- 工具 ----------

class PaymentArgs(BaseModel):
    amount: str = Field(description="贷款金额，如「100万」「350000」")
    annual_rate: float = Field(description="年利率，百分数，如 3.1 表示 3.1%；按用户合同或用户说的利率，不要自己假设")
    years: float = Field(default=0, description="贷款年限，如 30；车贷常见 1–5 年")
    months: int = Field(default=0, description="贷款期数（月）；用户按月说时填这个，填了就不看 years")
    method: str = Field(default="both", description="both 两种都算对比 / equal_payment 等额本息 / equal_principal 等额本金")
    show_months: int = Field(default=0, description="列出前几期的还款明细，0–12，用户要明细时才填")


class PrepayArgs(BaseModel):
    amount: str = Field(description="当初的贷款金额，如「100万」")
    annual_rate: float = Field(description="年利率，百分数，如 3.1 表示 3.1%")
    years: float = Field(default=0, description="当初的贷款年限，如 30")
    paid_months: int = Field(description="已经还了多少期（月），如还了 3 年就是 36")
    prepay_amount: str = Field(description="这次打算提前还多少钱，如「20万」")
    mode: str = Field(default="shorten", description="shorten 缩短年限（月供不变） / reduce 减少月供（年限不变）")
    months: int = Field(default=0, description="当初的贷款期数（月）；按月说时填这个，填了就不看 years")


@tool(args_schema=PaymentArgs)
def loan_calc_payment(amount: str, annual_rate: float, years: float = 0, months: int = 0, method: str = "both",
                      show_months: int = 0) -> str:
    """房贷 / 车贷 / 消费贷月供计算：等额本息、等额本金的月供、总利息、还款总额，并对比两种方式。
    用户说「贷 100 万 30 年利率 3.1% 月供多少」「等额本金和等额本息哪个划算」「车贷 10 万 3 年每月还多少」时用，不要心算。"""
    return payment_text(amount, annual_rate, years, months, method, show_months)


@tool(args_schema=PrepayArgs)
def loan_calc_prepay(amount: str, annual_rate: float, paid_months: int, prepay_amount: str, years: float = 0,
                     mode: str = "shorten", months: int = 0) -> str:
    """等额本息贷款提前还一部分：算剩余本金、提前还款后的新月供或剩余期数、能省多少利息。
    用户说「房贷还了 3 年想提前还 20 万，缩短年限还是减少月供划算」时用，不要心算。"""
    return prepay_text(amount, annual_rate, years, paid_months, prepay_amount, mode, months)


TOOLS = [loan_calc_payment, loan_calc_prepay]
