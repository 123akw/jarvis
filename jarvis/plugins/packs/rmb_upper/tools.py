"""金额大写：阿拉伯数字金额 → 人民币大写（票据、合同、报销单的写法）。纯标准库，不联网。

写法依据中国人民银行《正确填写票据和结算凭证的基本规定》：
- 大写数字用 壹贰叁肆伍陆柒捌玖拾佰仟万亿元角分零整；
- 到「元」为止的在「元」后写「整」，到「角」为止的在「角」后写「整」，有「分」的不写「整」；
- 数字中间连续有几个 0 时只写一个「零」；万位（亿位）是 0 而紧跟的仟位不是 0 时不写「零」
  （¥107,000.53 → 壹拾万柒仟元零伍角叁分，同规定里的例子）；元位是 0 而角、分不是 0 时，「元」后写「零」；
- 壹拾几的「壹」字不能省（10 → 壹拾元整）。
金额先按四舍五入保留到分；只支持 0 到 1 万亿（不含）之间的金额。
"""
from __future__ import annotations

import re
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation

from langchain_core.tools import tool
from pydantic import BaseModel, Field

DIGITS = "零壹贰叁肆伍陆柒捌玖"
POSITIONS = ("", "拾", "佰", "仟")
GROUPS = ("", "万", "亿")
LIMIT = Decimal("1000000000000")          # 1 万亿：仟亿级以内
MAX_INPUT_CHARS = 40
CENT = Decimal("0.01")
_SUFFIX = {"万": Decimal(10000), "亿": Decimal(100000000), "千": Decimal(1000), "百": Decimal(100)}
_STRIP = re.compile(r"[\s,，_'’￥¥]|人民币|RMB|rmb|CNY|cny")


def parse_amount(text) -> Decimal | str:
    """「1234.5」「12,345.67」「¥3,000」「1.2万」「3亿」「1e8」→ Decimal；看不懂返回一句人话。"""
    raw = str(text if text is not None else "").strip()
    if not raw:
        return "没有收到金额，请给一个数字，比如 1680.32。"
    if len(raw) > MAX_INPUT_CHARS:
        return "金额写得太长了，请只给数字，比如 1680.32。"
    cleaned = _STRIP.sub("", raw)
    cleaned = cleaned.removesuffix("元整").removesuffix("元正").removesuffix("元")
    factor = Decimal(1)
    if cleaned and cleaned[-1] in _SUFFIX:
        factor = _SUFFIX[cleaned[-1]]
        cleaned = cleaned[:-1]
    if not re.fullmatch(r"[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d{1,2})?", cleaned or ""):
        return f"「{raw}」不像一个金额，请只给阿拉伯数字，比如 1680.32 或 1.2万。"
    try:
        value = Decimal(cleaned) * factor
    except InvalidOperation:
        return f"「{raw}」不像一个金额，请只给阿拉伯数字，比如 1680.32。"
    if not value.is_finite():
        return f"「{raw}」不像一个金额，请只给阿拉伯数字。"
    return value


def _integer_upper(number: int) -> str:
    """整数部分（0 < number < 1 万亿）→ 大写，不带「元」。

    「零」只在上一段（万 / 亿）的尾巴是 0、下一段从仟位开始时省掉，与规定里的例子一致：
    107000 → 壹拾万柒仟（不写「零」），100010000 → 壹亿零壹万，100001000 → 壹亿零壹仟。"""
    text = str(number)
    size = len(text)
    out: list[str] = []
    zero_pending = False
    group_has_digit = False
    last_pos = -1
    for index, char in enumerate(text):
        pos = size - 1 - index
        digit = int(char)
        if digit == 0:
            zero_pending = True
        else:
            skip = pos % 4 == 3 and last_pos // 4 == pos // 4 + 1
            if zero_pending and out and not skip:
                out.append("零")
            zero_pending = False
            out.append(DIGITS[digit] + POSITIONS[pos % 4])
            group_has_digit = True
            last_pos = pos
        if pos % 4 == 0 and pos > 0:
            if group_has_digit:
                out.append(GROUPS[pos // 4])
            group_has_digit = False
    return "".join(out)


def to_upper(amount: Decimal) -> str:
    """已经四舍五入到分、0 ≤ amount < 1 万亿的金额 → 大写（不带「人民币」前缀）。"""
    cents = int((amount * 100).to_integral_value(rounding=ROUND_HALF_UP))
    yuan, rest = divmod(cents, 100)
    jiao, fen = divmod(rest, 10)
    if yuan == 0 and rest == 0:
        return "零元整"
    parts: list[str] = []
    if yuan:
        parts.append(_integer_upper(yuan) + "元")
        if rest and (yuan % 10 == 0 or jiao == 0):
            parts.append("零")                       # 元位是 0，或角位是 0 而分不是 0
    if jiao:
        parts.append(DIGITS[jiao] + "角")
    if fen:
        parts.append(DIGITS[fen] + "分")
    else:
        parts.append("整")
    return "".join(parts)


def lower_form(amount: Decimal) -> str:
    """¥1,680.32 这种小写写法。"""
    return f"¥{amount:,.2f}"


def convert(text) -> str:
    """给对话用的完整回答：大写、小写，必要时提示四舍五入。"""
    value = parse_amount(text)
    if isinstance(value, str):
        return value
    if value < 0:
        return ("负数没有大写写法。如果是退款、冲红，请按正数写大写金额，"
                "再在凭证上按单位的规定注明（例如红字或「退款」字样）。")
    rounded = value.quantize(CENT, rounding=ROUND_HALF_UP)
    if rounded >= LIMIT:
        return "金额太大了：这里只支持 1 万亿以内（到「仟亿」级）的金额。"
    note = ""
    if rounded != value:
        note = f"\n（原数 {value.normalize():f} 超过两位小数，已按四舍五入保留到分）"
    if rounded == 0:
        return (f"**大写**：零元整\n**小写**：{lower_form(rounded)}"
                f"{note}\n金额是 0，一般不用开票据；确实要写时就写「零元整」。")
    return (f"**大写**：{to_upper(rounded)}\n**小写**：{lower_form(rounded)}{note}\n"
            "合同里可写成「人民币（大写）" + to_upper(rounded) + "（¥" + f"{rounded:,.2f}" + "）」；"
            "票据上大写金额要紧挨「人民币」字样书写，中间不留空白。")


# ---------- 工具 ----------

class UpperArgs(BaseModel):
    amount: str = Field(description="阿拉伯数字金额，如「1680.32」「12,345.67」「1.2万」；"
                                    "「12万5千」这种口语先换成 125000 再传")


@tool(args_schema=UpperArgs)
def rmb_upper(amount: str) -> str:
    """把数字金额转成人民币大写（票据、合同、报销单写法），同时给出 ¥ 小写写法。
    用户说「1680.32 大写怎么写」「帮我把这个金额转成大写」「报销单金额大写」时使用，不要心算。"""
    return convert(amount)


TOOLS = [rmb_upper]
