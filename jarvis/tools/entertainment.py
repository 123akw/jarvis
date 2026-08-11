"""电影、电竞与票务的可信实时搜索工具。"""
from __future__ import annotations

import re
from collections.abc import Callable
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import httpx
from langchain_core.tools import tool
from pydantic import BaseModel, Field

from jarvis import config
from jarvis.tools.search import TavilySearch


_PANDASCORE_API = "https://api.pandascore.co"
_CHINA_TZ = ZoneInfo("Asia/Shanghai")
_MOVIE_DOMAINS = [
    "douban.com",
    "imdb.com",
    "rottentomatoes.com",
    "metacritic.com",
]
_ESPORTS_DOMAINS = [
    "pandascore.co",
    "lolesports.com",
    "hltv.org",
    "vlr.gg",
    "liquipedia.net",
]
_TICKET_DOMAINS = [
    "damai.cn",
    "showstart.com",
    "maoyan.com",
    "taopiaopiao.com",
    "ctrip.com",
    "ticketmaster.com",
]
_PUBLIC_PRICE = re.compile(
    r"(?:[¥￥$€]\s*\d[\d,.]*|\d[\d,.]*\s*(?:元|CNY|RMB|USD|EUR))",
    re.IGNORECASE,
)
_HTTP_URL = re.compile(r"https?://[^\s)\]>\"，。；]+")
_RATING_TOKEN = re.compile(r"\b\d{1,3}(?:\.\d+)?\s*(?:/\s*(?:10|100)|%)")
_GAME_ALIASES = {
    "lol": "leagueoflegends",
    "leagueoflegends": "leagueoflegends",
    "cs2": "counterstrike2",
    "counterstrike2": "counterstrike2",
    "dota2": "dota2",
    "valorant": "valorant",
}


def _query(*parts: str) -> str:
    """Build one provider query without exceeding the public search boundary."""
    return " ".join(part.strip() for part in parts if part and part.strip())[:300]


def _china_time(value: object) -> str:
    if not isinstance(value, str) or not value:
        return "未知"
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return "未知"
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(_CHINA_TZ).strftime("%Y-%m-%d %H:%M:%S %Z")


def _movie_rating_conflicts(result: str) -> list[str]:
    scores_by_domain: dict[str, list[set[str]]] = {}
    blocks = re.split(r"(?m)(?=^\d+\. )", result)
    for block in blocks:
        domain = next((item for item in _MOVIE_DOMAINS if item in block), "")
        if not domain:
            continue
        scores = {
            re.sub(r"\s+", "", match.group(0))
            for match in _RATING_TOKEN.finditer(block)
        }
        if scores:
            scores_by_domain.setdefault(domain, []).append(scores)
    return [
        f"评分来源冲突：{domain} 同时出现 "
        f"{', '.join(sorted(set().union(*score_sets)))}，请分别列出来源与差异。"
        for domain, score_sets in scores_by_domain.items()
        if len({frozenset(scores) for scores in score_sets}) > 1
    ]


class EntertainmentSearch:
    """在通用搜索之上施加电影、电竞和票务的领域约束。"""

    def __init__(
        self,
        search_service: TavilySearch | None = None,
        pandascore_token_getter: Callable[[], str] | None = None,
        pandascore_transport: httpx.BaseTransport | None = None,
        now: Callable[[], datetime] | None = None,
    ):
        self._search = search_service or TavilySearch()
        self._pandascore_token_getter = pandascore_token_getter or config.pandascore_token
        self._pandascore_transport = pandascore_transport
        self._now = now or (lambda: datetime.now(timezone.utc))

    def movie_ratings(self, title: str, year: str = "") -> str:
        """Search rating platforms while preserving each platform's own scale."""
        result = self._search.search(
            query=_query(
                title,
                year,
                "电影 最新评分 豆瓣 IMDb Rotten Tomatoes Metacritic 评价人数",
            ),
            topic="general",
            domains=_MOVIE_DOMAINS,
            max_results=5,
        )
        lines = [
            "电影评分引用规则：不同平台分制与评价人数必须分别引用，不得合并；"
            "未找到的平台请明确写未知。",
            result,
        ]
        lines.extend(_movie_rating_conflicts(result))
        return "\n".join(lines)

    def ticket_search(self, event: str, city: str = "", date: str = "") -> str:
        """Search public ticket listings without presenting them as a final quote."""
        result = self._search.search(
            query=_query(
                event,
                city,
                date,
                "官方售票 公开票价 起价 余票 购票平台",
            ),
            topic="general",
            domains=_TICKET_DOMAINS,
            max_results=5,
        )
        lines = [
            "票务提示：以下仅为平台公开的展示价/起价/票面价，不是最终成交价；"
            "库存、手续费和结算价以购票页为准，不执行登录、下单或支付。",
            result,
        ]
        if not _PUBLIC_PRICE.search(result):
            lines.append("未查到可靠公开价；请以平台结算页为准。")
        if len(set(_HTTP_URL.findall(result))) < 2:
            lines.append("当前可核验的合规购票渠道不足 2 个，未找到的渠道不作推测。")
        return "\n".join(lines)

    def esports_scores(self, team: str, game: str = "", date: str = "") -> str:
        """Prefer structured PandaScore data and fall back to public web sources."""
        token = self._pandascore_token_getter()
        if not token:
            return (
                "PandaScore 未配置，已回退公开网页搜索。\n"
                f"{self._esports_web(team, game, date)}"
            )
        try:
            return self._pandascore_latest(token, team, game, date)
        except (httpx.HTTPError, TypeError, ValueError, KeyError):
            return (
                "PandaScore 不可用，已回退公开网页搜索。\n"
                f"{self._esports_web(team, game, date)}"
            )

    def _esports_web(self, team: str, game: str, date: str) -> str:
        return self._search.search(
            query=_query(team, game, date, "最近比赛 比分 赛果 赛事"),
            topic="general",
            domains=_ESPORTS_DOMAINS,
            max_results=5,
        )

    def _pandascore_latest(
        self,
        token: str,
        team_name: str,
        game: str,
        date: str,
    ) -> str:
        headers = {"Authorization": f"Bearer {token}"}
        with httpx.Client(
            base_url=_PANDASCORE_API,
            headers=headers,
            timeout=12,
            trust_env=False,
            transport=self._pandascore_transport,
        ) as client:
            team_response = client.get(
                "/teams",
                params={"search[name]": team_name, "per_page": 5},
            )
            team_response.raise_for_status()
            teams = team_response.json()
            team = self._select_team(teams, team_name)
            team_id = team.get("id")
            if not isinstance(team_id, int):
                raise ValueError("PandaScore team has no numeric id")

            match_response = client.get(
                f"/teams/{team_id}/matches",
                params={"sort": "-begin_at", "per_page": 10},
            )
            match_response.raise_for_status()
            matches = match_response.json()

        match = self._select_match(matches, game, date)
        return self._format_match(match, team_id)

    @staticmethod
    def _select_team(teams: object, requested: str) -> dict:
        if not isinstance(teams, list) or not teams:
            raise ValueError("PandaScore team not found")
        needle = requested.casefold().strip()
        candidates = [item for item in teams if isinstance(item, dict)]
        for item in candidates:
            aliases = (item.get("name"), item.get("acronym"), item.get("slug"))
            if any(isinstance(alias, str) and alias.casefold() == needle for alias in aliases):
                return item
        for item in candidates:
            aliases = (item.get("name"), item.get("acronym"), item.get("slug"))
            if any(
                isinstance(alias, str)
                and (needle in alias.casefold() or alias.casefold() in needle)
                for alias in aliases
            ):
                return item
        raise ValueError("PandaScore team did not match requested team")

    @staticmethod
    def _select_match(matches: object, game: str, date: str) -> dict:
        if not isinstance(matches, list):
            raise ValueError("PandaScore matches response is invalid")
        normalized_game = re.sub(r"[^a-z0-9]", "", game.casefold())
        game_needle = _GAME_ALIASES.get(normalized_game, normalized_game)
        candidates = []
        for item in matches:
            if not isinstance(item, dict):
                continue
            videogame = item.get("videogame")
            if game_needle:
                game_values = []
                if isinstance(videogame, dict):
                    game_values = [videogame.get("name"), videogame.get("slug")]
                normalized_values = {
                    _GAME_ALIASES.get(normalized, normalized)
                    for value in game_values
                    if isinstance(value, str)
                    for normalized in [re.sub(r"[^a-z0-9]", "", value.casefold())]
                }
                if not any(
                    game_needle in value or value in game_needle
                    for value in normalized_values
                ):
                    continue
            if date and date not in str(item.get("begin_at", "")):
                continue
            candidates.append(item)
        for item in candidates:
            results = item.get("results")
            has_score = (
                isinstance(results, list)
                and len(results) >= 2
                and all(
                    isinstance(result, dict) and isinstance(result.get("score"), int)
                    for result in results[:2]
                )
            )
            if item.get("status") == "finished" and has_score:
                return item
        if candidates:
            return candidates[0]
        raise ValueError("PandaScore match not found")

    def _format_match(self, match: dict, requested_team_id: int) -> str:
        match_id = match.get("id")
        if not isinstance(match_id, int):
            raise ValueError("PandaScore match has no numeric id")

        results = match.get("results")
        opponents = match.get("opponents")
        if not isinstance(results, list) or not isinstance(opponents, list):
            raise ValueError("PandaScore match score is invalid")
        score_by_team = {
            result.get("team_id"): result.get("score")
            for result in results
            if isinstance(result, dict)
        }
        scored_opponents: list[tuple[str, int]] = []
        for entry in opponents:
            opponent = entry.get("opponent") if isinstance(entry, dict) else None
            if not isinstance(opponent, dict):
                continue
            name = opponent.get("name")
            opponent_id = opponent.get("id")
            score = score_by_team.get(opponent_id)
            if isinstance(name, str) and isinstance(score, int):
                scored_opponents.append((name, score))
        if len(scored_opponents) != 2:
            raise ValueError("PandaScore match does not contain two scored opponents")
        first, second = scored_opponents
        scoreline = f"{first[0]} {first[1]} - {second[1]} {second[0]}"

        videogame = match.get("videogame") or {}
        league = match.get("league") or {}
        serie = match.get("serie") or {}
        tournament = match.get("tournament") or {}
        event_parts = [
            league.get("name"),
            serie.get("full_name") or serie.get("name"),
            tournament.get("name"),
        ]
        event = " · ".join(
            str(value) for value in event_parts if isinstance(value, str) and value
        ) or "未知"

        checked = self._now()
        if checked.tzinfo is None:
            checked = checked.replace(tzinfo=timezone.utc)
        checked_text = checked.astimezone(_CHINA_TZ).strftime("%Y-%m-%d %H:%M:%S %Z")
        return "\n".join([
            "[结构化电竞比分]",
            "数据源：PandaScore",
            f"查询时间：{checked_text}",
            f"checked_at：{checked_text}",
            f"项目：{videogame.get('name') or '未知'}",
            f"赛事：{event}",
            f"比分：{scoreline}",
            f"状态：{match.get('status') or '未知'}",
            f"比赛时间：{_china_time(match.get('begin_at'))}",
            f"来源：{_PANDASCORE_API}/matches/{match_id}",
            f"战队赛程源：{_PANDASCORE_API}/teams/{requested_team_id}/matches",
        ])


class MovieRatingsArgs(BaseModel):
    title: str = Field(min_length=1, max_length=160, description="电影名称")
    year: str = Field(default="", max_length=20, description="可选上映年份")


class EsportsScoresArgs(BaseModel):
    team: str = Field(min_length=1, max_length=120, description="电竞战队名称或简称")
    game: str = Field(default="", max_length=80, description="可选游戏项目")
    date: str = Field(default="", max_length=30, description="可选比赛日期")


class TicketSearchArgs(BaseModel):
    event: str = Field(min_length=1, max_length=160, description="演出、赛事或活动名称")
    city: str = Field(default="", max_length=60, description="可选城市")
    date: str = Field(default="", max_length=30, description="可选日期或月份")


_default_entertainment = EntertainmentSearch()


@tool(args_schema=MovieRatingsArgs)
def movie_ratings(title: str, year: str = "") -> str:
    """查询电影在多个评分平台的实时评分、分制和评价人数。"""
    return _default_entertainment.movie_ratings(title=title, year=year)


@tool(args_schema=EsportsScoresArgs)
def esports_scores(team: str, game: str = "", date: str = "") -> str:
    """查询电竞战队的近期比赛、比分、状态和来源。"""
    return _default_entertainment.esports_scores(team=team, game=game, date=date)


@tool(args_schema=TicketSearchArgs)
def ticket_search(event: str, city: str = "", date: str = "") -> str:
    """查询活动的公开售票平台、展示价格、余票说明和购票链接。"""
    return _default_entertainment.ticket_search(event=event, city=city, date=date)
