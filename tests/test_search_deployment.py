"""Deployment contracts for the free-first web research stack."""
from __future__ import annotations

import configparser
import importlib.util
import json
import re
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import urlsplit

import pytest
import yaml
from packaging.requirements import Requirement
from packaging.utils import canonicalize_name


ROOT = Path(__file__).resolve().parent.parent
COMPOSE_PATH = ROOT / "deploy" / "searxng" / "compose.yaml"
SETTINGS_PATH = ROOT / "deploy" / "searxng" / "settings.yml"
TOX_PATH = ROOT / "tox.ini"
LOCK_PATH = ROOT / "requirements.lock"
PINNED_IMAGE = (
    "ghcr.io/searxng/searxng:2026.7.28-c01178d03@"
    "sha256:5d6d903ab82afa56ee32792d477f36bc63d3e5ca04fcb6947e28a5cfd987fad3"
)
PINNED_HEALTHCHECK_TEST = [
    "CMD-SHELL",
    (
        "wget --quiet --tries=1 --timeout=5 --output-document=- "
        "http://127.0.0.1:8080/healthz >/dev/null || exit 1"
    ),
]
RUNTIME_SECRET_ENV_FILE = [
    {
        "path": "${SEARXNG_ENV_FILE:-/etc/jarvis/searxng-runtime.env}",
        "required": False,
    },
]
OFFICIAL_SECRET_PLACEHOLDER = "ultrasecretkey"
DEV_ONLY_PACKAGES = {"pip-tools", "playwright", "pytest", "tox"}
VCS_PREFIXES = ("git+", "hg+", "svn+", "bzr+")


def _yaml(path: Path) -> dict:
    assert path.is_file(), f"missing deployment file: {path.relative_to(ROOT)}"
    loaded = yaml.safe_load(path.read_text(encoding="utf-8"))
    assert isinstance(loaded, dict)
    return loaded


def _load_search_smoke_module():
    path = ROOT / "scripts" / "search_smoke.py"
    spec = importlib.util.spec_from_file_location("search_smoke_deployment_tests", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _assert_http_readiness(healthcheck: dict) -> None:
    assert healthcheck["test"] == PINNED_HEALTHCHECK_TEST


def _assert_runtime_secret_contract(service: dict, settings: dict) -> None:
    assert service.get("env_file") == RUNTIME_SECRET_ENV_FILE
    environment = service.get("environment", {})
    if isinstance(environment, dict):
        assert "SEARXNG_SECRET" not in environment
    else:
        assert not any(
            str(item).split("=", 1)[0] == "SEARXNG_SECRET" for item in environment
        )
    assert settings.get("server", {}).get("secret_key") == OFFICIAL_SECRET_PLACEHOLDER


def _lock_requirement_lines(lock: str) -> list[str]:
    return [
        line.strip()
        for line in lock.splitlines()
        if line.strip() and not line.lstrip().startswith(("#", "--"))
    ]


def _assert_safe_lock_line(line: str) -> None:
    stripped = line.strip()
    lowered = stripped.casefold()
    assert "file:" not in lowered
    assert not any(prefix in lowered for prefix in VCS_PREFIXES)
    for url in re.findall(r"https?://[^\s]+", stripped, flags=re.IGNORECASE):
        parsed = urlsplit(url)
        assert parsed.username is None and parsed.password is None
        assert parsed.query == "" and parsed.fragment == ""
    if stripped.startswith("#"):
        return
    if lowered.startswith("--index-url"):
        parts = stripped.split(maxsplit=1)
        assert len(parts) == 2
        parsed = urlsplit(parts[1])
        assert parsed.scheme == "https"
        assert parsed.hostname == "pypi.org"
        assert parsed.username is None and parsed.password is None
        assert parsed.query == "" and parsed.fragment == ""
        return
    assert not lowered.startswith(
        ("--extra-index-url", "--find-links", "--trusted-host", "-i ")
    )
    assert not lowered.startswith(("-e ", "--editable ", "/", "./", "../"))
    assert not re.match(r"^[a-zA-Z]:[\\/]", stripped)
    requirement = Requirement(stripped)
    assert canonicalize_name(requirement.name) not in DEV_ONLY_PACKAGES
    assert requirement.url is None


def test_searxng_compose_pins_exact_image_and_only_publishes_loopback():
    """A mutable image or wildcard host bind would weaken reproducibility and isolation."""
    compose = _yaml(COMPOSE_PATH)
    service = compose["services"]["searxng"]

    assert service["image"] == PINNED_IMAGE
    assert service["ports"] == ["127.0.0.1:18888:8080"]
    assert service.get("network_mode") != "host"


def test_searxng_compose_has_bounded_lifecycle_and_local_healthcheck():
    """Missing readiness, restart, or resource bounds would make the unit unsafe to operate."""
    service = _yaml(COMPOSE_PATH)["services"]["searxng"]
    healthcheck = service["healthcheck"]
    limits = service["deploy"]["resources"]["limits"]

    assert service["restart"] == "unless-stopped"
    assert {"test", "interval", "timeout", "retries", "start_period"} <= healthcheck.keys()
    _assert_http_readiness(healthcheck)
    assert float(limits["cpus"]) > 0
    assert limits["memory"]


@pytest.mark.parametrize(
    "unsafe_test",
    [
        ["CMD", "wget", "http://127.0.0.1:8080/healthz"],
        ["CMD-SHELL", "echo http://127.0.0.1:8080/healthz"],
        ["CMD-SHELL", "true"],
        ["CMD-SHELL", "wget http://127.0.0.1:8080/"],
        ["CMD-SHELL", "wget http://127.0.0.1:8080/healthz || exit 0"],
        ["CMD-SHELL", "wget http://127.0.0.1:8080/healthz ; exit 0"],
        [
            "CMD-SHELL",
            (
                "/bin/true || wget --quiet --tries=1 --timeout=5 "
                "--output-document=- http://127.0.0.1:8080/healthz "
                ">/dev/null || exit 1"
            ),
        ],
    ],
)
def test_healthcheck_contract_rejects_non_http_readiness_mutations(unsafe_test):
    """No-op, exec-form, or wrong-path checks must not satisfy readiness."""
    with pytest.raises(AssertionError):
        _assert_http_readiness({"test": unsafe_test})


def test_searxng_settings_enable_json_and_are_mounted_read_only():
    """SearchService cannot consume a deployment that omits JSON or mutable settings."""
    settings = _yaml(SETTINGS_PATH)
    service = _yaml(COMPOSE_PATH)["services"]["searxng"]

    assert "json" in settings["search"]["formats"]
    assert "html" in settings["search"]["formats"]
    assert service["volumes"] == [
        "./settings.yml:/etc/searxng/settings.yml:ro",
    ]


def test_searxng_secret_is_loaded_only_from_the_external_runtime_env_file():
    """A missing env file contract or embedded value would leave unsafe secret handling."""
    service = _yaml(COMPOSE_PATH)["services"]["searxng"]
    settings = _yaml(SETTINGS_PATH)

    _assert_runtime_secret_contract(service, settings)


@pytest.mark.parametrize(
    ("service", "settings"),
    [
        (
            {"env_file": RUNTIME_SECRET_ENV_FILE},
            {"server": {"secret_key": "not-the-official-placeholder"}},
        ),
        (
            {
                "env_file": RUNTIME_SECRET_ENV_FILE,
                "environment": {"SEARXNG_SECRET": "must-not-be-embedded"},
            },
            {"server": {"secret_key": OFFICIAL_SECRET_PLACEHOLDER}},
        ),
        (
            {
                "env_file": RUNTIME_SECRET_ENV_FILE,
                "environment": ["SEARXNG_SECRET=must-not-be-embedded"],
            },
            {"server": {"secret_key": OFFICIAL_SECRET_PLACEHOLDER}},
        ),
    ],
)
def test_searxng_secret_contract_rejects_literals_outside_the_placeholder(
    service, settings
):
    """Only the documented upstream placeholder may be tracked; runtime values stay external."""
    with pytest.raises(AssertionError):
        _assert_runtime_secret_contract(service, settings)


def test_packaging_keeps_browser_optional_and_pins_reproducibility_tools():
    """Moving Playwright into runtime or floating build tools breaks the packaging boundary."""
    import tomllib

    project = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))["project"]
    extras = project["optional-dependencies"]

    assert "playwright" not in " ".join(project["dependencies"]).casefold()
    assert extras["browser"] == ["playwright==1.61.0"]
    assert "pip-tools==7.6.0" in extras["dev"]
    assert "tox==4.58.0" in extras["dev"]
    assert any(item.casefold().startswith("pyyaml") for item in extras["dev"])


def test_tox_covers_both_supported_runtimes_and_consumes_runtime_lock():
    """A skipped Python or unlocked tox install could hide incompatible dependency resolution."""
    assert TOX_PATH.is_file(), "missing tox.ini"
    parser = configparser.ConfigParser()
    parser.read(TOX_PATH, encoding="utf-8")

    env_list = {item.strip() for item in parser["tox"]["env_list"].split(",")}
    assert env_list == {"py310", "py314"}
    assert parser["tox"].getboolean("skip_missing_interpreters") is False
    assert "-r requirements.lock" in parser["testenv"]["deps"]
    assert "python -m pytest -q" in parser["testenv"]["commands"]


def test_runtime_lock_is_pip_compiled_from_pyproject_without_browser_extra():
    """A hand-written or extras-expanded file would not be the required runtime lock artifact."""
    assert LOCK_PATH.is_file(), "missing requirements.lock"
    lock = LOCK_PATH.read_text(encoding="utf-8")

    assert "autogenerated by pip-compile" in lock
    assert "pyproject.toml" in lock
    assert "ddgs==9.14.4" in lock
    assert "trafilatura==2.1.0" in lock
    assert "playwright==" not in lock.casefold()


def test_runtime_lock_covers_every_direct_dependency_with_an_exact_pin():
    """Omitting one direct runtime dependency would make the lock incomplete."""
    import tomllib

    project = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))["project"]
    direct_names = {
        canonicalize_name(Requirement(item).name)
        for item in project["dependencies"]
    }
    locked = {
        canonicalize_name(requirement.name): requirement
        for line in _lock_requirement_lines(LOCK_PATH.read_text(encoding="utf-8"))
        if not line.startswith("-")
        for requirement in [Requirement(line)]
    }

    assert direct_names <= locked.keys()
    for name in direct_names:
        specifiers = list(locked[name].specifier)
        assert len(specifiers) == 1
        assert specifiers[0].operator == "=="


@pytest.mark.parametrize(
    "unsafe_line",
    [
        "--index-url https://packages.example/simple",
        "--index-url https://user:secret@pypi.org/simple",
        "--extra-index-url https://pypi.org/simple",
        "demo @ https://user:secret@files.pythonhosted.org/demo.whl",
        "demo @ https://files.pythonhosted.org/demo.whl?token=secret",
        "# source https://user:secret@files.pythonhosted.org/demo.whl",
        "demo @ git+https://github.com/example/demo.git",
        "demo @ file:///tmp/demo.whl",
        "-e ../demo",
        "/tmp/demo.whl",
        "playwright==1.61.0",
        "pip-tools==7.6.0",
        "pytest==9.0.2",
        "tox==4.58.0",
    ],
)
def test_lock_line_contract_rejects_unsafe_or_non_runtime_mutations(unsafe_line):
    """Unsafe origins and dev/browser packages must never enter the runtime lock."""
    with pytest.raises((AssertionError, ValueError)):
        _assert_safe_lock_line(unsafe_line)


def test_runtime_lock_lines_have_only_official_reproducible_origins():
    """Every emitted lock line must reject private origins and local source references."""
    for line in LOCK_PATH.read_text(encoding="utf-8").splitlines():
        if line.strip():
            _assert_safe_lock_line(line)


def test_python310_lock_includes_anyio_exceptiongroup_marker():
    """Resolving only on Python 3.14 drops anyio's Python 3.10 compatibility dependency."""
    lock = LOCK_PATH.read_text(encoding="utf-8")
    assert "autogenerated by pip-compile with Python 3.10" in lock
    requirements = {
        canonicalize_name(requirement.name): requirement
        for line in _lock_requirement_lines(lock)
        for requirement in [Requirement(line)]
    }

    assert "anyio" in requirements
    assert "exceptiongroup" in requirements
    exceptiongroup = requirements["exceptiongroup"]
    specifiers = list(exceptiongroup.specifier)
    assert len(specifiers) == 1
    assert specifiers[0].operator == "=="

    marker = Requirement('exceptiongroup; python_version < "3.11"').marker
    assert marker is not None
    assert marker.evaluate({"python_version": "3.10"}) is True
    assert marker.evaluate({"python_version": "3.14"}) is False


class _StubFreeAgent:
    def invoke(self, payload, config):
        question = payload["messages"][0]["content"]
        if "娱乐新闻" in question:
            scenario = "news"
            tool_name = "web_search"
            urls = ("https://news.example/a", "https://media.example/b")
            detail = "provider：ddgs"
        elif "评分" in question:
            scenario = "movie"
            tool_name = "movie_ratings"
            urls = ("https://movie.example/a", "https://review.example/b")
            detail = "provider：searxng；豆瓣 8.1/10，IMDb 7.8/10"
        elif "BLG" in question:
            scenario = "esports"
            tool_name = "esports_scores"
            urls = ("https://score.example/a", "https://league.example/b")
            detail = "provider：ddgs；BLG 2:1 TES"
        else:
            scenario = "tickets"
            tool_name = "ticket_search"
            urls = (
                "https://user:password@damai.cn/event/a?token=secret-query",
                "https://ticketmaster.com/event/b?Authorization=Bearer-secret",
            )
            detail = "provider：searxng；公开票面价 380 元，不是最终成交价"
        tool_output = (
            "checked_at：2026-08-11 14:30:00 CST\n"
            f"{detail}\n来源：{urls[0]}\n来源：{urls[1]}"
        )
        answer = (
            f"截至 2026-08-11 14:30，{detail}。"
            f"来源：{urls[0]} 来源：{urls[1]}"
        )
        return {
            "messages": [
                SimpleNamespace(type="human", content=question),
                SimpleNamespace(type="tool", name=tool_name, content=tool_output),
                SimpleNamespace(type="ai", content=answer),
            ],
            "scenario": scenario,
            "config": config,
        }


def test_search_smoke_accepts_injected_free_chain_and_redacts_sensitive_urls(monkeypatch):
    """Offline provider-neutral verification must pass without Tavily or leaking URL secrets."""
    smoke = _load_search_smoke_module()
    monkeypatch.delenv("TAVILY_API_KEY", raising=False)
    monkeypatch.setattr(
        "jarvis.config.load_env",
        lambda: (_ for _ in ()).throw(AssertionError("read .env")),
    )

    code, payload = smoke.run(
        agent_factory=_StubFreeAgent,
        load_environment=lambda: None,
        run_id_factory=lambda: "offline-test",
        now=lambda: datetime(2026, 8, 11, 14, 30),
    )
    rendered = json.dumps(payload, ensure_ascii=False)

    assert code == 0
    assert payload["passed"] == payload["total"] == 4
    assert "Tavily" not in rendered
    assert "user:password" not in rendered
    assert "secret-query" not in rendered
    assert "Bearer-secret" not in rendered


def test_search_smoke_cli_defaults_to_deterministic_offline_mode(monkeypatch, capsys):
    """The default command must never construct the live model or contact a provider."""
    smoke = _load_search_smoke_module()
    monkeypatch.setattr(
        "jarvis.config.load_env",
        lambda: (_ for _ in ()).throw(AssertionError("read .env")),
    )
    monkeypatch.setattr(
        "jarvis.graph.build_agent",
        lambda: (_ for _ in ()).throw(AssertionError("constructed live agent")),
    )

    code = smoke.main([])
    rendered = capsys.readouterr().out

    assert code == 0
    assert '"passed": 4' in rendered
    assert '"total": 4' in rendered
