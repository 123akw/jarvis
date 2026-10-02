"""个税社保速算：月薪到手（累计预扣法）、年终奖单独计税与并入综合所得对比。纯标准库，不联网。

计算依据（2026 年 10 月核实，均为现行有效政策）：
- 《中华人民共和国个人所得税法》：综合所得适用 3%–45% 七级超额累进税率，基本减除费用每年 60000 元（每月 5000 元）；
- 国家税务总局公告 2018 年第 61 号《个人所得税扣缴申报管理办法（试行）》：工资薪金按「累计预扣法」预扣预缴，
  预扣率表即综合所得年度税率表；
- 财政部 税务总局公告 2023 年第 30 号：全年一次性奖金可不并入综合所得，除以 12 个月按「按月换算后的综合所得税率表」
  单独计税，也可选择并入；执行至 2027 年 12 月 31 日。
  https://www.gov.cn/zhengce/zhengceku/202308/content_6900595.htm
- 国发〔2023〕13 号：3 岁以下婴幼儿照护、子女教育每孩每月 2000 元，赡养老人每月 3000 元（非独生子女分摊、每人
  不超过 1500 元）。https://www.gov.cn/zhengce/zhengceku/202308/content_6901207.htm
- 个人社保比例按常见的养老 8%、医疗 2%、失业 0.5% 估算；各地比例、缴费基数上下限都不一样，以当地社保部门为准。

结果仅供参考，以税务机关和单位实际扣缴为准。
"""
from __future__ import annotations

import math

from langchain_core.tools import tool
from pydantic import BaseModel, Field

POLICY_YEAR = 2026
DISCLAIMER = f"按 {POLICY_YEAR} 年现行政策估算，结果仅供参考，以税务机关和单位实际扣缴为准。"
MAX_AMOUNT = 1e8                      # 单个金额上限：1 亿元
BASIC_DEDUCTION_MONTHLY = 5000.0      # 《个人所得税法》：每年 60000 元
DEFAULT_FUND_RATE = 7.0               # 公积金个人比例默认 7%（各地 5%–12%）
SOCIAL_RATES = (("养老保险", 0.08), ("医疗保险", 0.02), ("失业保险", 0.005))

# 综合所得年度税率表（个人所得税法附表；也是工资薪金累计预扣的预扣率表）：(全年应纳税所得额上限, 税率, 速算扣除数)
ANNUAL_BRACKETS = (
    (36000, 0.03, 0), (144000, 0.10, 2520), (300000, 0.20, 16920), (420000, 0.25, 31920),
    (660000, 0.30, 52920), (960000, 0.35, 85920), (math.inf, 0.45, 181920),
)
# 按月换算后的综合所得税率表（财政部 税务总局公告 2023 年第 30 号附件）：年终奖单独计税用
MONTHLY_BRACKETS = (
    (3000, 0.03, 0), (12000, 0.10, 210), (25000, 0.20, 1410), (35000, 0.25, 2660),
    (55000, 0.30, 4410), (80000, 0.35, 7160), (math.inf, 0.45, 15160),
)


def money(value: float) -> str:
    return f"{value:,.2f}"


def _bracket(amount: float, table) -> tuple[float, float]:
    for upper, rate, quick in table:
        if amount <= upper:
            return rate, quick
    return table[-1][1], table[-1][2]


def annual_tax(taxable: float) -> float:
    """综合所得全年应纳税额（应纳税所得额 ≤ 0 时为 0）。"""
    if taxable <= 0:
        return 0.0
    rate, quick = _bracket(taxable, ANNUAL_BRACKETS)
    return round(taxable * rate - quick, 2)


def social_contributions(base: float, fund_rate: float) -> dict:
    """个人每月缴的社保与公积金。"""
    items = [(name, round(base * rate, 2)) for name, rate in SOCIAL_RATES]
    fund = round(base * fund_rate / 100, 2)
    social = round(sum(value for _, value in items), 2)
    return {"items": items, "social": social, "fund": fund, "total": round(social + fund, 2)}


def _check_amount(value, label: str, *, allow_zero: bool = True) -> str | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return f"{label}看不懂，请给一个普通数字（单位：元）。"
    if value < 0 or (value == 0 and not allow_zero):
        return f"{label}要是正数。"
    if value > MAX_AMOUNT:
        return f"{label}太大了，超过 1 亿元的情况请找专业税务人员算。"
    return None


def withholding_schedule(monthly_salary: float, social_base: float, fund_rate: float,
                         special_deduction: float = 0, other_deduction: float = 0) -> dict:
    """累计预扣法：假设 1 月起每月工资相同、没有其他收入，算 1–12 月每月预扣个税和到手。"""
    contrib = social_contributions(social_base, fund_rate)
    per_month_deduct = BASIC_DEDUCTION_MONTHLY + contrib["total"] + special_deduction + other_deduction
    rows, paid = [], 0.0
    for month in range(1, 13):
        cum_income = monthly_salary * month
        cum_taxable = max(round(cum_income - per_month_deduct * month, 2), 0.0)
        rate, quick = _bracket(cum_taxable, ANNUAL_BRACKETS) if cum_taxable > 0 else (0.03, 0)
        cum_tax = max(round(cum_taxable * rate - quick, 2), 0.0)
        tax = max(round(cum_tax - paid, 2), 0.0)
        paid = round(paid + tax, 2)
        net = round(monthly_salary - contrib["total"] - tax, 2)
        rows.append({"month": month, "cum_income": round(cum_income, 2), "cum_taxable": cum_taxable,
                     "rate": rate, "quick": quick, "cum_tax": cum_tax, "tax": tax, "net": net})
    return {"contrib": contrib, "rows": rows, "annual_tax": paid,
            "annual_net": round(sum(r["net"] for r in rows), 2)}


def salary_report(monthly_salary: float, social_base: float = 0, housing_fund_rate: float = DEFAULT_FUND_RATE,
                  special_deduction: float = 0, other_deduction: float = 0, month: int = 0) -> str:
    for value, label in ((monthly_salary, "月薪"), (social_base, "缴费基数"), (special_deduction, "专项附加扣除"),
                         (other_deduction, "其他扣除")):
        problem = _check_amount(value, label, allow_zero=label != "月薪")
        if problem:
            return problem
    if isinstance(housing_fund_rate, bool) or not isinstance(housing_fund_rate, (int, float)) \
            or not 0 <= housing_fund_rate <= 12:
        return "公积金个人比例要在 0–12 之间（单位 %，各地常见 5–12；没交公积金填 0）。"
    if isinstance(month, bool) or not isinstance(month, int) or not 0 <= month <= 12:
        return "月份要是 1–12；想看全年就不填（或填 0）。"
    base = social_base or monthly_salary
    plan = withholding_schedule(monthly_salary, base, housing_fund_rate, special_deduction, other_deduction)
    c = plan["contrib"]
    social_text = "、".join(f"{name} {money(v)}" for name, v in c["items"])
    lines = [f"**税前月薪 {money(monthly_salary)} 元**（社保公积金基数 {money(base)} 元，公积金 {housing_fund_rate:g}%，"
             f"专项附加扣除 {money(special_deduction)} 元/月" + (f"，其他扣除 {money(other_deduction)} 元/月" if other_deduction else "")
             + "）",
             f"- 个人社保每月 {money(c['social'])} 元（{social_text}），公积金 {money(c['fund'])} 元，合计 {money(c['total'])} 元"]
    if month:
        row = plan["rows"][month - 1]
        lines += [f"- {month} 月：累计收入 {money(row['cum_income'])} − 累计减除（5000×{month} + 社保公积金 + 专项附加 + 其他）"
                  f"= 累计应纳税所得额 {money(row['cum_taxable'])} 元，适用预扣率 {row['rate']:.0%}、速算扣除数 {row['quick']:,}",
                  f"- {month} 月预扣个税 **{money(row['tax'])} 元**，到手 **{money(row['net'])} 元**"]
    else:
        lines += ["", "| 月份 | 预扣个税 | 到手 |", "| --- | ---: | ---: |"]
        lines += [f"| {r['month']} 月 | {money(r['tax'])} | {money(r['net'])} |" for r in plan["rows"]]
        lines.append("")
    lines.append(f"- 全年个税 {money(plan['annual_tax'])} 元，全年到手 {money(plan['annual_net'])} 元"
                 f"（不含年终奖；累计预扣法下年初税率低、后面会慢慢变高，所以到手前多后少）")
    lines.append("- 说明：按 1 月起每月工资相同、没有其他收入估算；社保按养老 8%、医疗 2%、失业 0.5%，"
                 "各地比例和基数上下限不同，以当地为准。")
    lines.append(DISCLAIMER)
    return "\n".join(lines)


# ---------- 年终奖 ----------

def bonus_separate_tax(bonus: float) -> float:
    """全年一次性奖金单独计税：奖金 ÷ 12 找月度税率表，应纳税额 = 奖金 × 税率 − 速算扣除数。"""
    if bonus <= 0:
        return 0.0
    rate, quick = _bracket(bonus / 12, MONTHLY_BRACKETS)
    return round(bonus * rate - quick, 2)


def bonus_dead_zones() -> list[tuple[float, float]]:
    """单独计税的「多发反而少拿」区间（不含左端点）：奖金落在这里，税后比发到左端点还少。"""
    zones = []
    for (upper, rate, quick), (_, next_rate, next_quick) in zip(MONTHLY_BRACKETS, MONTHLY_BRACKETS[1:]):
        edge = upper * 12
        after_tax_at_edge = edge - (edge * rate - quick)
        # 区间上端：bonus − (bonus × next_rate − next_quick) = after_tax_at_edge
        high = (after_tax_at_edge - next_quick) / (1 - next_rate)
        zones.append((float(edge), round(high, 2)))
    return zones


def bonus_report(bonus: float, annual_taxable_other: float | None = None) -> str:
    problem = _check_amount(bonus, "年终奖", allow_zero=False)
    if problem:
        return problem
    if annual_taxable_other is not None:
        if isinstance(annual_taxable_other, bool) or not isinstance(annual_taxable_other, (int, float)) \
                or not math.isfinite(annual_taxable_other) or abs(annual_taxable_other) > MAX_AMOUNT:
            return "其他综合所得的应纳税所得额看不懂，请给一个普通数字（单位：元，扣除没用完可以是负数）。"
    separate = bonus_separate_tax(bonus)
    rate, quick = _bracket(bonus / 12, MONTHLY_BRACKETS)
    lines = [f"**年终奖 {money(bonus)} 元**",
             f"- 单独计税：{money(bonus)} ÷ 12 = {money(bonus / 12)}，适用税率 {rate:.0%}、速算扣除数 {quick:,}，"
             f"个税 **{money(separate)} 元**，到手 {money(bonus - separate)} 元"]
    if annual_taxable_other is not None:
        other_tax = annual_tax(annual_taxable_other)
        plan_a = round(separate + other_tax, 2)
        plan_b = annual_tax(annual_taxable_other + bonus)
        lines.append(f"- 其他综合所得的应纳税所得额 {money(annual_taxable_other)} 元，这部分全年个税 {money(other_tax)} 元")
        lines.append(f"- 方案一 单独计税：全年个税合计 {money(plan_a)} 元")
        lines.append(f"- 方案二 并入综合所得：全年个税合计 {money(plan_b)} 元")
        if abs(plan_a - plan_b) < 0.01:
            lines.append("- 两种算法一样多，选哪个都行。")
        else:
            better = "单独计税" if plan_a < plan_b else "并入综合所得"
            lines.append(f"- 选 **{better}** 更省，少交 {money(abs(plan_a - plan_b))} 元（年度汇算时可以改选）。")
    else:
        lines.append("- 想比较「并入综合所得」是否更省：告诉我除年终奖外全年的应纳税所得额"
                     "（全年工资 − 60000 − 社保公积金 − 专项附加扣除 − 其他扣除）。")
    zone = next(((low, high) for low, high in bonus_dead_zones() if low < bonus < high), None)
    if zone:
        lines.append(f"- ⚠️ 这笔奖金落在单独计税的「多发反而少拿」区间（{money(zone[0])}, {money(zone[1])}）："
                     f"发 {money(zone[0])} 元时税后反而更多，可以和单位沟通发放金额或选择并入综合所得。")
    else:
        edges = "、".join(f"{money(low)}–{money(high)}" for low, high in bonus_dead_zones()[:3])
        lines.append(f"- 单独计税要避开的区间（多发 1 元可能多交几千元税）：{edges} 等。")
    lines.append("- 依据：财政部 税务总局公告 2023 年第 30 号，单独计税政策执行至 2027 年 12 月 31 日；"
                 "一个纳税年度内只能用一次。")
    lines.append(DISCLAIMER)
    return "\n".join(lines)


# ---------- 工具 ----------

class SalaryArgs(BaseModel):
    monthly_salary: float = Field(description="税前月薪（元），如 15000")
    social_base: float = Field(default=0, description="社保公积金缴费基数（元）；不知道就填 0，按月薪算")
    housing_fund_rate: float = Field(default=DEFAULT_FUND_RATE, description="公积金个人缴存比例（%），常见 5–12，默认 7；没交填 0")
    special_deduction: float = Field(default=0, description="每月专项附加扣除合计（元），如子女教育 2000 + 赡养老人 3000 = 5000")
    other_deduction: float = Field(default=0, description="每月其他扣除（元），如企业年金、商业健康险；没有填 0")
    month: int = Field(default=0, description="只看第几个月（1–12）；0 表示列出 1–12 月全年")


class BonusArgs(BaseModel):
    bonus: float = Field(description="全年一次性奖金（年终奖）金额（元），如 36000")
    annual_taxable_other: float | None = Field(
        default=None, description="可空；除年终奖外全年综合所得的应纳税所得额（元）"
                                  "= 全年工资 − 60000 − 社保公积金 − 专项附加扣除 − 其他扣除，扣除没用完可为负数")


@tool(args_schema=SalaryArgs)
def tax_calc_salary(monthly_salary: float, social_base: float = 0, housing_fund_rate: float = DEFAULT_FUND_RATE,
                    special_deduction: float = 0, other_deduction: float = 0, month: int = 0) -> str:
    """算工资到手：个人社保公积金 + 按累计预扣法算每月预扣个税和到手金额（按现行政策估算，仅供参考）。
    用户问「月薪一万五到手多少」「这个月个税扣多少」「为什么下半年到手变少了」时使用，不要心算。
    专项附加扣除请先让用户说清有哪几项再加总：子女教育 / 3 岁以下婴幼儿照护每孩每月 2000、赡养老人每月 3000
    （非独生子女每人最多 1500）、住房贷款利息每月 1000 或住房租金每月 800–1500。"""
    return salary_report(monthly_salary, social_base, housing_fund_rate, special_deduction, other_deduction, month)


@tool(args_schema=BonusArgs)
def tax_calc_bonus(bonus: float, annual_taxable_other: float | None = None) -> str:
    """算年终奖个税：全年一次性奖金单独计税，并可与「并入综合所得」对比哪个更省，提示多发反而少拿的区间。
    用户问「年终奖三万六交多少税」「年终奖单独计税还是并入划算」时使用，不要心算。"""
    return bonus_report(bonus, annual_taxable_other)


TOOLS = [tax_calc_salary, tax_calc_bonus]
