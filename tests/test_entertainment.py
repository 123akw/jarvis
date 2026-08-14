"""电影评分、电竞比分和票务搜索的垂直行为测试。"""
import json
import importlib.util
from datetime import datetime, timezone

import httpx
import jarvis.tools.entertainment as entertainment_mod
from jarvis.search.models import (
    DEFAULT_CACHE_POLICY,
    ProviderCapabilities,
    REALTIME_CACHE_POLICY,
    SearchResponse,
    SearchResult,
)
from jarvis.search.providers import TavilyProvider
from jarvis.search.providers.base import ProviderTimeoutError
from jarvis.search.service import SearchService


def _search_payload(results):
    return {
        "query": "test",
        "answer": None,
        "images": [],
        "results": results,
        "response_time": "0.52",
        "auto_parameters": {"topic": "general", "search_depth": "basic"},
        "usage": {"credits": 1},
        "request_id": "req-entertainment-test",
    }


def _search_result(title, url, content, published_date="2026-08-10"):
    return {
        "title": title,
        "url": url,
        "content": content,
        "score": 0.9,
        "raw_content": None,
        "favicon": "",
        "images": [],
        "id": title,
        "published_date": published_date,
    }


def _tavily_service(handler):
    return SearchService(
        [
            TavilyProvider(
                api_key_getter=lambda: "tvly-test",
                transport=httpx.MockTransport(handler),
            )
        ],
        now=lambda: datetime(2026, 8, 11, 6, 30, tzinfo=timezone.utc),
    )


class _RecordingSearchService:
    generation = 17

    def __init__(self, results):
        self.requests = []
        self.response = SearchResponse(
            results=tuple(results),
            checked_at=datetime(2026, 8, 11, 6, 30, tzinfo=timezone.utc),
            attempted_providers=("fake-public",),
        )

    def search(self, request):
        self.requests.append(request)
        return self.response

    def format_response(self, response):
        return SearchService.format_response(self, response)


def _public_result(title, url, snippet, published_at="2026-08-10"):
    return SearchResult(
        title=title,
        url=url,
        snippet=snippet,
        published_at=published_at,
        provider="fake-public",
    )


class _TimeoutProvider:
    name = "stub"
    capabilities = ProviderCapabilities(
        topics=frozenset(("general",)),
        time_ranges=frozenset(("",)),
    )

    def __init__(self):
        self.errors = [
            ProviderTimeoutError("https://user:token@example.test/?secret=timeout"),
            ProviderTimeoutError("https://user:token@example.test/?secret=timeout"),
        ]

    def configured(self):
        return True

    def configuration_token(self):
        return "opaque-revision"

    def search(self, request):
        raise self.errors.pop(0)

    def close(self):
        pass


def test_entertainment_module_is_available():
    """删除垂直模块会让三类实时问题退回无约束通用搜索。"""
    assert importlib.util.find_spec("jarvis.tools.entertainment") is not None


def test_entertainment_service_is_available():
    """垂直查询需要可注入真实搜索边界的服务对象。"""
    assert hasattr(entertainment_mod, "EntertainmentSearch")


def test_entertainment_search_reports_provider_timeout_instead_of_not_found():
    """An entertainment fallback timeout must stop further search rather than look empty."""
    search = SearchService([_TimeoutProvider()], sleep=lambda _seconds: None)
    service = entertainment_mod.EntertainmentSearch(
        search_service=search,
        pandascore_token_getter=lambda: "",
    )

    out = service.esports_scores("BLG", game="League of Legends")

    assert "请求超时" in out
    assert "未找到带有效 HTTP(S) 来源" not in out
    assert "user:token" not in out
    assert "secret=timeout" not in out


def test_movie_ratings_keeps_platform_scales_and_voter_counts_separate():
    """泛化或合并站点评分会产出不存在的“综合分”。"""
    requests = []
    results = [
        _search_result(
            "豆瓣电影：哪吒之魔童闹海",
            "https://movie.douban.com/subject/34780991/",
            "豆瓣评分 8.5/10，123456 人评价。",
        ),
        _search_result(
            "Ne Zha 2 (2025) - IMDb",
            "https://www.imdb.com/title/tt34956443/",
            "IMDb rating 8.1/10 from 20K users.",
        ),
    ]

    def handler(request):
        requests.append(json.loads(request.content))
        return httpx.Response(200, json=_search_payload(results))

    service = entertainment_mod.EntertainmentSearch(
        search_service=_tavily_service(handler)
    )

    out = service.movie_ratings("哪吒之魔童闹海", year="2025")

    assert "豆瓣评分 8.5/10，123456 人评价" in out
    assert "IMDb rating 8.1/10 from 20K users" in out
    assert "不同平台分制与评价人数必须分别引用，不得合并" in out
    assert set(requests[0]["include_domains"]) == {
        "douban.com", "imdb.com", "rottentomatoes.com", "metacritic.com"
    }
    assert "哪吒之魔童闹海" in requests[0]["query"] and "2025" in requests[0]["query"]


def test_movie_ratings_uses_default_cache_and_preserves_public_rating_metadata():
    """A realtime override or lossy formatter would distort stable platform ratings."""
    search = _RecordingSearchService(
        [
            _public_result(
                "豆瓣电影：哪吒之魔童闹海",
                "https://movie.douban.com/subject/34780991/",
                "豆瓣评分 8.5/10，123456 人评价。",
            ),
            _public_result(
                "Ne Zha 2 - Rotten Tomatoes",
                "https://www.rottentomatoes.com/m/ne_zha_2",
                "Tomatometer 91%，verified audience 20K ratings。",
            ),
        ]
    )
    service = entertainment_mod.EntertainmentSearch(search_service=search)

    out = service.movie_ratings("哪吒之魔童闹海", year="2025")

    assert search.requests[0].cache_policy == DEFAULT_CACHE_POLICY
    assert "checked_at：2026-08-11 14:30:00 CST" in out
    assert "来源：https://movie.douban.com/subject/34780991/" in out
    assert "来源：https://www.rottentomatoes.com/m/ne_zha_2" in out
    assert "8.5/10" in out and "123456 人评价" in out
    assert "91%" in out and "20K ratings" in out


def test_movie_ratings_explicitly_flags_conflicting_scores_from_the_same_platform():
    """同一平台的不同公开分数不能静默并列后让模型任选其一。"""
    results = [
        _search_result(
            "豆瓣电影条目",
            "https://movie.douban.com/subject/34780991/",
            "豆瓣评分 8.5/10，123456 人评价。",
        ),
        _search_result(
            "豆瓣电影榜单缓存",
            "https://m.douban.com/movie/subject/34780991/",
            "豆瓣评分 8.7/10，120000 人评价。",
        ),
    ]
    service = entertainment_mod.EntertainmentSearch(
        search_service=_tavily_service(
            lambda _request: httpx.Response(200, json=_search_payload(results))
        )
    )

    out = service.movie_ratings("哪吒之魔童闹海", year="2025")

    assert "8.5/10" in out and "8.7/10" in out
    assert "评分来源冲突" in out
    assert "douban.com" in out


def test_movie_ratings_does_not_treat_two_metrics_on_one_page_as_source_conflict():
    """烂番茄同页的影评人分和观众分是不同指标，不是来源互相矛盾。"""
    result = _search_result(
        "Ne Zha 2 - Rotten Tomatoes",
        "https://www.rottentomatoes.com/m/ne_zha_2",
        "Tomatometer 91%; verified audience score 95%.",
    )
    service = entertainment_mod.EntertainmentSearch(
        search_service=_tavily_service(
            lambda _request: httpx.Response(200, json=_search_payload([result]))
        )
    )

    out = service.movie_ratings("哪吒之魔童闹海", year="2025")

    assert "91%" in out and "95%" in out
    assert "评分来源冲突" not in out


def test_ticket_search_returns_two_platforms_prices_links_and_disclaimer():
    """漏平台、漏链接或把展示价说成成交价会误导购票决策。"""
    requests = []
    results = [
        _search_result(
            "大麦：上海音乐节",
            "https://detail.damai.cn/item.htm?id=123",
            "公开票面价 380元起，余票以购票页为准。",
        ),
        _search_result(
            "秀动：上海音乐节",
            "https://www.showstart.com/event/456",
            "预售票 ¥420，现场票信息待公布。",
        ),
    ]

    def handler(request):
        requests.append(json.loads(request.content))
        return httpx.Response(200, json=_search_payload(results))

    service = entertainment_mod.EntertainmentSearch(
        search_service=_tavily_service(handler)
    )

    out = service.ticket_search("上海音乐节", city="上海", date="2026-09")

    assert "大麦：上海音乐节" in out and "秀动：上海音乐节" in out
    assert "380元起" in out and "¥420" in out
    assert "https://detail.damai.cn/item.htm?id=123" in out
    assert "https://www.showstart.com/event/456" in out
    assert "展示价/起价/票面价，不是最终成交价" in out
    assert "上海" in requests[0]["query"] and "2026-09" in requests[0]["query"]


def test_ticket_search_uses_realtime_cache_and_preserves_public_prices_and_sources():
    """Caching quotes as ordinary pages or stripping price provenance can mislead buyers."""
    search = _RecordingSearchService(
        [
            _public_result(
                "大麦：上海音乐节",
                "https://detail.damai.cn/item.htm?id=123",
                "公开票面价 380元起，余票以购票页为准。",
            ),
            _public_result(
                "秀动：上海音乐节",
                "https://www.showstart.com/event/456",
                "预售票 ¥420，现场票信息待公布。",
            ),
        ]
    )
    service = entertainment_mod.EntertainmentSearch(search_service=search)

    out = service.ticket_search("上海音乐节", city="上海", date="2026-09")

    assert search.requests[0].cache_policy == REALTIME_CACHE_POLICY
    assert "checked_at：2026-08-11 14:30:00 CST" in out
    assert "来源：https://detail.damai.cn/item.htm?id=123" in out
    assert "来源：https://www.showstart.com/event/456" in out
    assert "380元起" in out and "¥420" in out
    assert "不是最终成交价" in out


def test_ticket_search_explicitly_says_when_no_reliable_public_price_exists():
    """没有数字价格时若不标空缺，模型容易自行补一个报价。"""
    result = _search_result(
        "活动官方页",
        "https://official.example.com/event",
        "活动即将开售，具体信息以后续公告为准。",
    )
    service = entertainment_mod.EntertainmentSearch(
        search_service=_tavily_service(
            lambda _request: httpx.Response(200, json=_search_payload([result]))
        )
    )

    out = service.ticket_search("某演唱会", city="北京")

    assert "未查到可靠公开价" in out


def test_esports_scores_uses_pandascore_and_formats_latest_match():
    """有结构化 Token 时仍走网页摘要会降低比分准确性。"""
    requests = []
    team = {
        "id": 2064,
        "name": "Bilibili Gaming",
        "acronym": "BLG",
        "slug": "bilibili-gaming",
        "location": "CN",
        "image_url": None,
        "modified_at": "2026-08-10T00:00:00Z",
        "current_videogame": {
            "id": 1, "name": "League of Legends", "slug": "league-of-legends"
        },
    }
    match = {
        "id": 98765,
        "name": "Bilibili Gaming vs Top Esports",
        "slug": "blg-vs-tes",
        "status": "finished",
        "begin_at": "2026-08-10T11:00:00Z",
        "end_at": "2026-08-10T13:00:00Z",
        "match_type": "best_of",
        "number_of_games": 3,
        "winner_id": 2064,
        "results": [
            {"score": 2, "team_id": 2064},
            {"score": 1, "team_id": 318},
        ],
        "opponents": [
            {"opponent": {"id": 2064, "name": "Bilibili Gaming"}, "type": "Team"},
            {"opponent": {"id": 318, "name": "Top Esports"}, "type": "Team"},
        ],
        "league": {"id": 209, "name": "LPL", "slug": "lpl"},
        "serie": {"id": 100, "name": "Summer", "full_name": "LPL 2026 Summer"},
        "tournament": {"id": 300, "name": "Playoffs", "slug": "playoffs"},
        "videogame": {"id": 1, "name": "League of Legends", "slug": "league-of-legends"},
        "streams_list": [],
        "official_stream_url": None,
        "modified_at": "2026-08-10T13:10:00Z",
    }

    def panda_handler(request):
        requests.append(request)
        if request.url.path == "/teams":
            return httpx.Response(200, json=[team])
        if request.url.path == "/teams/2064/matches":
            return httpx.Response(200, json=[match])
        return httpx.Response(404)

    service = entertainment_mod.EntertainmentSearch(
        search_service=_tavily_service(
            lambda _request: httpx.Response(500, json={"unexpected": True})
        ),
        pandascore_token_getter=lambda: "panda-secret",
        pandascore_transport=httpx.MockTransport(panda_handler),
        now=lambda: datetime(2026, 8, 11, 6, 30, tzinfo=timezone.utc),
    )

    out = service.esports_scores("BLG", game="League of Legends")

    assert "数据源：PandaScore" in out
    assert "项目：League of Legends" in out
    assert "赛事：LPL · LPL 2026 Summer · Playoffs" in out
    assert "Bilibili Gaming 2 - 1 Top Esports" in out
    assert "状态：finished" in out
    assert "比赛时间：2026-08-10 19:00:00 CST" in out
    assert "https://api.pandascore.co/matches/98765" in out
    assert all(request.headers["authorization"] == "Bearer panda-secret" for request in requests)


def test_esports_scores_without_pandascore_token_falls_back_to_tavily():
    """免费结构化 Token 未配置时仍需给出明确来源的网页检索结果。"""
    result = _search_result(
        "BLG 2:1 TES - LPL",
        "https://lolesports.com/standings/lpl",
        "BLG defeated TES 2-1 in the latest LPL match.",
    )
    service = entertainment_mod.EntertainmentSearch(
        search_service=_tavily_service(
            lambda _request: httpx.Response(200, json=_search_payload([result]))
        ),
        pandascore_token_getter=lambda: "",
    )

    out = service.esports_scores("BLG", game="League of Legends")

    assert "PandaScore 未配置，已回退公开网页搜索" in out
    assert "BLG defeated TES 2-1" in out
    assert "https://lolesports.com/standings/lpl" in out


def test_esports_public_fallback_uses_realtime_cache_and_preserves_score_metadata():
    """Live score fallbacks must be short-lived and retain their timestamp and source."""
    search = _RecordingSearchService(
        [
            _public_result(
                "BLG 2:1 TES - LPL",
                "https://lolesports.com/standings/lpl",
                "BLG defeated TES 2-1 in the latest LPL match.",
            )
        ]
    )
    service = entertainment_mod.EntertainmentSearch(
        search_service=search,
        pandascore_token_getter=lambda: "",
    )

    out = service.esports_scores("BLG", game="League of Legends")

    assert search.requests[0].cache_policy == REALTIME_CACHE_POLICY
    assert "checked_at：2026-08-11 14:30:00 CST" in out
    assert "来源：https://lolesports.com/standings/lpl" in out
    assert "BLG defeated TES 2-1" in out


def test_esports_scores_falls_back_when_pandascore_rejects_request():
    """PandaScore 403 不应让整个比分查询失败。"""
    result = _search_result(
        "Valorant match result",
        "https://www.vlr.gg/123/match",
        "EDG won 2-0.",
    )
    service = entertainment_mod.EntertainmentSearch(
        search_service=_tavily_service(
            lambda _request: httpx.Response(200, json=_search_payload([result]))
        ),
        pandascore_token_getter=lambda: "panda-test",
        pandascore_transport=httpx.MockTransport(
            lambda _request: httpx.Response(403, json={"error": "forbidden"})
        ),
    )

    out = service.esports_scores("EDG", game="Valorant")

    assert "PandaScore 不可用，已回退公开网页搜索" in out
    assert "EDG won 2-0" in out


def test_three_entertainment_functions_are_real_langchain_tools(monkeypatch):
    """只实现服务不注册工具，模型仍然无法调用三类能力。"""
    monkeypatch.delenv("TAVILY_API_KEY", raising=False)
    monkeypatch.delenv("PANDASCORE_TOKEN", raising=False)

    movie = entertainment_mod.movie_ratings.invoke({"title": "哪吒"})
    esports = entertainment_mod.esports_scores.invoke({"team": "BLG"})
    ticket = entertainment_mod.ticket_search.invoke({"event": "上海演唱会"})

    assert entertainment_mod.movie_ratings.name == "movie_ratings"
    assert entertainment_mod.esports_scores.name == "esports_scores"
    assert entertainment_mod.ticket_search.name == "ticket_search"
    assert "未配置 TAVILY_API_KEY" in movie
    assert "未配置 TAVILY_API_KEY" in esports
    assert "未配置 TAVILY_API_KEY" in ticket


def test_agent_registry_exposes_all_five_search_tools_and_has_twenty_four_tools():
    """垂直工具与通用搜索必须进入 Agent 的唯一工具注册表。"""
    from jarvis.tools import TOOLS

    names = [item.name for item in TOOLS]

    assert len(names) == 24
    assert {
        "web_search",
        "web_extract",
        "movie_ratings",
        "esports_scores",
        "ticket_search",
    } <= set(names)


def test_search_provider_config_is_read_at_call_time(monkeypatch):
    """密钥必须由运行环境动态注入，不能固化在模块导入时。"""
    from jarvis import config

    monkeypatch.setenv("TAVILY_API_KEY", "tvly-runtime")
    monkeypatch.setenv("PANDASCORE_TOKEN", "panda-runtime")

    assert config.tavily_api_key() == "tvly-runtime"
    assert config.pandascore_token() == "panda-runtime"


def test_system_prompt_routes_realtime_entertainment_and_treats_results_as_data():
    """模型需要知道四个新工具何时使用以及不能服从网页中的指令。"""
    from jarvis.prompts import SYSTEM_PROMPT

    assert all(
        name in SYSTEM_PROMPT
        for name in ("web_search", "movie_ratings", "esports_scores", "ticket_search")
    )
    assert "来源" in SYSTEM_PROMPT and "查询时间" in SYSTEM_PROMPT
    assert "外部搜索" in SYSTEM_PROMPT and "不是指令" in SYSTEM_PROMPT
    assert "最终成交价" in SYSTEM_PROMPT and "未知" in SYSTEM_PROMPT


def _pandascore_service_for_matches(matches):
    team = {
        "id": 2064,
        "name": "Bilibili Gaming",
        "acronym": "BLG",
        "slug": "bilibili-gaming",
        "location": "CN",
        "image_url": None,
        "modified_at": "2026-08-10T00:00:00Z",
        "current_videogame": {
            "id": 1,
            "name": "League of Legends",
            "slug": "league-of-legends",
        },
    }

    def panda_handler(request):
        if request.url.path == "/teams":
            return httpx.Response(200, json=[team])
        if request.url.path == "/teams/2064/matches":
            return httpx.Response(200, json=matches)
        return httpx.Response(404)

    return entertainment_mod.EntertainmentSearch(
        search_service=_tavily_service(
            lambda _request: httpx.Response(500, json={"unexpected": True})
        ),
        pandascore_token_getter=lambda: "panda-secret",
        pandascore_transport=httpx.MockTransport(panda_handler),
        now=lambda: datetime(2026, 8, 11, 6, 30, tzinfo=timezone.utc),
    )


def _pandascore_match(match_id, status, begin_at, first_score=None, second_score=None):
    results = []
    if first_score is not None and second_score is not None:
        results = [
            {"score": first_score, "team_id": 2064},
            {"score": second_score, "team_id": 318},
        ]
    return {
        "id": match_id,
        "name": "Bilibili Gaming vs Top Esports",
        "slug": f"blg-vs-tes-{match_id}",
        "status": status,
        "begin_at": begin_at,
        "end_at": None,
        "match_type": "best_of",
        "number_of_games": 3,
        "winner_id": 2064 if status == "finished" else None,
        "results": results,
        "opponents": [
            {"opponent": {"id": 2064, "name": "Bilibili Gaming"}, "type": "Team"},
            {"opponent": {"id": 318, "name": "Top Esports"}, "type": "Team"},
        ],
        "league": {"id": 209, "name": "LPL", "slug": "lpl"},
        "serie": {"id": 100, "name": "Summer", "full_name": "LPL 2026 Summer"},
        "tournament": {"id": 300, "name": "Playoffs", "slug": "playoffs"},
        "videogame": {
            "id": 1,
            "name": "League of Legends",
            "slug": "league-of-legends",
        },
        "streams_list": [],
        "official_stream_url": None,
        "modified_at": "2026-08-10T13:10:00Z",
    }


def test_pandascore_accepts_lol_alias_for_league_of_legends():
    """把 LoL 当普通子串会错过 PandaScore 的 League of Legends 项目。"""
    finished = _pandascore_match(98765, "finished", "2026-08-10T11:00:00Z", 2, 1)
    service = _pandascore_service_for_matches([finished])

    out = service.esports_scores("BLG", game="LoL")

    assert "数据源：PandaScore" in out
    assert "Bilibili Gaming 2 - 1 Top Esports" in out


def test_pandascore_prefers_a_scored_finished_match_over_future_fixture():
    """未来赛程排在前面时不能遮住最近一场已有比分的比赛。"""
    future = _pandascore_match(99999, "not_started", "2026-08-20T11:00:00Z")
    finished = _pandascore_match(98765, "finished", "2026-08-10T11:00:00Z", 2, 1)
    service = _pandascore_service_for_matches([future, finished])

    out = service.esports_scores("BLG", game="League of Legends")

    assert "https://api.pandascore.co/matches/98765" in out
    assert "Bilibili Gaming 2 - 1 Top Esports" in out


def test_pandascore_schedule_source_keeps_the_requested_team_id():
    """格式化对手时不能覆盖战队 ID 并链接到对手赛程。"""
    finished = _pandascore_match(98765, "finished", "2026-08-10T11:00:00Z", 2, 1)
    service = _pandascore_service_for_matches([finished])

    out = service.esports_scores("BLG", game="League of Legends")

    assert "战队赛程源：https://api.pandascore.co/teams/2064/matches" in out
