"""抽签分组：随机分组、抽签、排值日表。每次结果附「抽签码」，同一名单 + 同一抽签码 = 同一结果，可当众复核。"""
from __future__ import annotations

import datetime as dt
import math
import random
import re
import secrets

from langchain_core.tools import tool
from pydantic import BaseModel, Field

MAX_NAMES = 200
MAX_NAME_CHARS = 20
MAX_GROUPS = 50
MAX_DAYS = 62
WEEKDAYS = "一二三四五六日"
_SEPARATORS = re.compile(r"[,，、;；|/\n]+")


def parse_names(text: str) -> tuple[list[str], list[str]]:
    """名单拆成人名列表：逗号、顿号、分号、换行都算分隔（都没有时才按空格分，保住「Li Lei」这类名字）；
    去重保序。返回 (名单, 重复的名字)。"""
    text = text or ""
    parts = _SEPARATORS.split(text) if _SEPARATORS.search(text) else text.split()
    names, seen, dups = [], set(), []
    for raw in parts:
        name = raw.strip()[:MAX_NAME_CHARS]
        if not name:
            continue
        if name in seen:
            dups.append(name)
            continue
        seen.add(name)
        names.append(name)
    return names, dups


def _rng(seed: str) -> tuple[random.Random, str]:
    seed = (seed or "").strip()[:32] or secrets.token_hex(3)
    return random.Random(seed), seed   # 字符串种子在不同进程间结果一致（不受 hash 随机化影响）


def _check(names: list[str], minimum: int = 1) -> str | None:
    if len(names) < minimum:
        return f"名单里至少要有 {minimum} 个名字，请用逗号、顿号或换行隔开。"
    if len(names) > MAX_NAMES:
        return f"名单太长了（上限 {MAX_NAMES} 人），请分批来。"
    return None


def _footer(seed: str, dups: list[str]) -> str:
    note = f"\n（去掉了重复的名字：{'、'.join(dict.fromkeys(dups))}）" if dups else ""
    return f"{note}\n抽签码：{seed}（同一名单、同一抽签码会得到同样的结果，可以当众复核）"


def make_groups(text: str, group_count: int = 0, group_size: int = 0, seed: str = "") -> str:
    names, dups = parse_names(text)
    problem = _check(names, 2)
    if problem:
        return problem
    if group_count <= 0:
        group_count = math.ceil(len(names) / group_size) if group_size > 0 else 2
    group_count = min(group_count, len(names))
    if group_count > MAX_GROUPS:
        return f"最多分 {MAX_GROUPS} 组。"
    rng, seed = _rng(seed)
    shuffled = names[:]
    rng.shuffle(shuffled)
    groups = [shuffled[i::group_count] for i in range(group_count)]   # 轮流发牌，各组人数最多差 1
    lines = [f"共 {len(names)} 人，分成 {group_count} 组："]
    lines += [f"第 {i} 组（{len(g)} 人）：{'、'.join(g)}" for i, g in enumerate(groups, 1)]
    return "\n".join(lines) + _footer(seed, dups)


def draw(text: str, count: int = 1, seed: str = "") -> str:
    names, dups = parse_names(text)
    problem = _check(names)
    if problem:
        return problem
    if count < 1:
        return "至少抽 1 个。"
    if count > len(names):
        return f"名单只有 {len(names)} 人，抽不出 {count} 个。"
    rng, seed = _rng(seed)
    picked = rng.sample(names, count)
    if count == 1:
        body = f"从 {len(names)} 人里抽中：{picked[0]}"
    else:
        body = f"从 {len(names)} 人里按顺序抽出 {count} 位：\n" + "\n".join(
            f"{i}. {name}" for i, name in enumerate(picked, 1))
    return body + _footer(seed, dups)


def parse_day(text: str) -> dt.date | None:
    match = re.fullmatch(r"\s*(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*[日号]?\s*", text or "")
    if not match:
        return None
    try:
        return dt.date(*(int(x) for x in match.groups()))
    except ValueError:
        return None


def rota(text: str, start_date: str, days: int = 5, per_day: int = 1,
         skip_weekends: bool = False, seed: str = "") -> str:
    names, dups = parse_names(text)
    problem = _check(names)
    if problem:
        return problem
    start = parse_day(start_date)
    if start is None:
        return f"开始日期「{start_date}」看不懂，请写成 2026-10-08 这样的格式。"
    if not 1 <= days <= MAX_DAYS:
        return f"值日表最多排 {MAX_DAYS} 天。"
    if not 1 <= per_day <= len(names):
        return f"每天值日人数要在 1 到 {len(names)} 之间。"
    rng, seed = _rng(seed)
    order = names[:]
    rng.shuffle(order)
    lines, cursor, day = [f"值日表（{len(names)} 人轮流，每天 {per_day} 人）："], 0, start
    while len(lines) - 1 < days:
        if skip_weekends and day.weekday() >= 5:
            day += dt.timedelta(days=1)
            continue
        today = [order[(cursor + k) % len(order)] for k in range(per_day)]
        cursor += per_day
        lines.append(f"{day.month}月{day.day}日 周{WEEKDAYS[day.weekday()]}：{'、'.join(today)}")
        day += dt.timedelta(days=1)
    return "\n".join(lines) + _footer(seed, dups)


# ---------- 工具 ----------

_NAMES_DESC = "名单原文，人名之间用逗号、顿号、空格或换行隔开，如「张三、李四、王五」"
_SEED_DESC = "抽签码，可空；用户想复核上次结果时填上次给出的抽签码"


class GroupsArgs(BaseModel):
    names: str = Field(description=_NAMES_DESC)
    group_count: int = Field(default=0, ge=0, le=MAX_GROUPS, description="分几组；0 表示按 group_size 算")
    group_size: int = Field(default=0, ge=0, le=MAX_NAMES, description="每组几人；两项都为 0 时默认分 2 组")
    seed: str = Field(default="", description=_SEED_DESC)


class DrawArgs(BaseModel):
    names: str = Field(description=_NAMES_DESC)
    count: int = Field(default=1, ge=1, le=MAX_NAMES, description="抽几个人")
    seed: str = Field(default="", description=_SEED_DESC)


class RotaArgs(BaseModel):
    names: str = Field(description=_NAMES_DESC)
    start_date: str = Field(description="从哪天开始排，YYYY-MM-DD；用户说「下周一」时先换算成具体日期")
    days: int = Field(default=5, ge=1, le=MAX_DAYS, description="排几天")
    per_day: int = Field(default=1, ge=1, le=MAX_NAMES, description="每天几个人")
    skip_weekends: bool = Field(default=False, description="是否跳过周六周日")
    seed: str = Field(default="", description=_SEED_DESC)


@tool(args_schema=GroupsArgs)
def lottery_groups(names: str, group_count: int = 0, group_size: int = 0, seed: str = "") -> str:
    """把一份名单随机分组（各组人数尽量平均）。用户说「把这些人随机分成 3 组」「每组 4 个人分一下」时使用。
    把工具结果里的抽签码原样告诉用户。"""
    return make_groups(names, group_count, group_size, seed)


@tool(args_schema=DrawArgs)
def lottery_draw(names: str, count: int = 1, seed: str = "") -> str:
    """从名单里随机抽人（不重复），如抽奖、抽人回答问题、决定谁先。不要自己编随机结果，一律用它。
    把工具结果里的抽签码原样告诉用户。"""
    return draw(names, count, seed)


@tool(args_schema=RotaArgs)
def lottery_rota(names: str, start_date: str, days: int = 5, per_day: int = 1,
                 skip_weekends: bool = False, seed: str = "") -> str:
    """随机打乱顺序后排值日表 / 轮班表，按天轮流。用户说「帮我排下周的值日」「店员排个班」时使用。"""
    return rota(names, start_date, days, per_day, skip_weekends, seed)


TOOLS = [lottery_groups, lottery_draw, lottery_rota]
