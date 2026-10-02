"""倒数日（插件模板）：算离某个日子还有几天。

复制本目录去建自己的插件时，按这个顺序改：
1. plugin.json 的 id / name / summary / tools / steps；
2. 本文件里的工具函数名（以插件 id 为前缀，全局唯一）与 docstring；
3. tests/ 里的用例。

写法约定（贾维斯加载器按这些假设工作）：
- 只依赖 Python 标准库与贾维斯已有的 langchain_core / pydantic；需要别的包写进 plugin.json 的
  python_packages，没装时整个插件被标成「暂不可用」，不会影响其他插件。
- 导入本模块不能有副作用：不联网、不读写文件、不起线程（加载器可能在子进程里只为读取工具清单而导入它）。
- 工具永远返回给用户看的中文文本；可预见的错误（参数不对、日期写错）自己接住并说人话，
  不要抛异常。万一漏了异常，贾维斯会兜底转成一句「插件出错了」。
- 一次调用要快（几秒内），不要 sleep、不要死循环；超时会被强制中止。
"""
from __future__ import annotations

import datetime as dt
import re

from langchain_core.tools import tool
from pydantic import BaseModel, Field

MAX_LABEL_CHARS = 30
MAX_STAMP_TEXT_CHARS = 20000
WEEKDAYS = "一二三四五六日"


# ---------- 纯函数：业务逻辑写在这里，测试直接测它（不需要模型、不需要贾维斯） ----------

def parse_date(text: str, today: dt.date) -> dt.date | None:
    """认「2027-02-06」「2027/2/6」「2027年2月6日」「2月6日」「2-6」；只写月日时取今天之后最近的那一天。"""
    text = (text or "").strip()
    match = re.fullmatch(r"(?:(\d{4})\s*[-/.年]\s*)?(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*[日号]?", text)
    if not match:
        return None
    year, month, day = match.groups()
    try:
        if year:
            return dt.date(int(year), int(month), int(day))
        candidate = dt.date(today.year, int(month), int(day))
        return candidate if candidate >= today else dt.date(today.year + 1, int(month), int(day))
    except ValueError:   # 2 月 30 日这类不存在的日期
        return None


def countdown_text(target: str, label: str, today: dt.date) -> str:
    day = parse_date(target, today)
    if day is None:
        return f"没看懂日期「{target}」，请写成 2027-02-06 或 2月6日 这样的格式。"
    label = (label or "").strip()[:MAX_LABEL_CHARS]
    name = f"{day.month}月{day.day}日（周{WEEKDAYS[day.weekday()]}）" + (f"「{label}」" if label else "")
    if day.year != today.year:
        name = f"{day.year}年" + name
    delta = (day - today).days
    if delta == 0:
        return f"就是今天：{name}。"
    if delta > 0:
        weeks, rest = divmod(delta, 7)
        extra = f"，约 {weeks} 周{f'零 {rest} 天' if rest else ''}" if weeks else ""
        return f"离 {name}还有 {delta} 天{extra}。"
    return f"{name} 已经过去 {-delta} 天了。"


def stamp_text(text: str, today: dt.date) -> str:
    """给一段文字末尾加一行落款日期（积木示例用）。"""
    return f"{text.rstrip()}\n\n（整理于 {today.year}年{today.month}月{today.day}日）"


# ---------- 工具：模型看到的就是函数名、docstring 和参数说明 ----------

class CountdownArgs(BaseModel):
    target: str = Field(description="目标日期，如「2027-02-06」「2月6日」；只说节日名时先换算成具体日期")
    label: str = Field(default="", description="这一天是什么日子，如「春节」「妈妈生日」；可空")


@tool(args_schema=CountdownArgs)
def my_plugin_countdown(target: str, label: str = "") -> str:
    """算今天离某个日期还有几天（或已经过去几天）。用户问「还有几天」「多久到」时使用。"""
    return countdown_text(target, label, dt.date.today())


TOOLS = [my_plugin_countdown]


# ---------- 可选：流程积木 STEPS ----------
# 积木签名沿用贾维斯 jarvis/flows/steps.py 的 StepSpec；在独立仓库里跑测试时没有贾维斯，
# 所以用 try 包住，导不进来就不提供积木（工具照常可用）。

try:
    from jarvis.flows.steps import ROLE_PROCESS, Outcome, StepFailure, StepSpec, preview
except ImportError:   # 不在贾维斯里运行
    STEPS: dict = {}
else:
    def _run_stamp(job, ctx: dict, options: dict) -> Outcome:
        text = (ctx.get("text") or "").strip()
        if not text:
            raise StepFailure("前面没有可以加落款的内容")
        ctx["text"] = stamp_text(text[:MAX_STAMP_TEXT_CHARS], dt.date.today())
        return Outcome("加好了落款日期", preview(ctx["text"]))

    STEPS = {
        "my_plugin_stamp": StepSpec("my_plugin_stamp", "加落款日期", ROLE_PROCESS,
                                    accepts=("text",), produces=("text",), run=_run_stamp),
    }
