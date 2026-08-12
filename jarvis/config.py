"""集中配置：路径、环境变量、模型参数。所有取值都在调用时读取，方便测试与热切换。"""
import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv


_SEARCH_PROVIDERS = frozenset(("searxng", "ddgs", "tavily"))
_EXTRACT_PROVIDERS = frozenset(("trafilatura", "playwright"))
_DEFAULT_SEARCH_BACKENDS = ("searxng", "ddgs", "tavily")
_DEFAULT_EXTRACT_BACKENDS = ("trafilatura", "playwright")


@dataclass(frozen=True)
class OptionalCredential:
    """Optional secret whose representation never contains its value."""

    _value: str = field(repr=False, compare=False)

    @property
    def configured(self) -> bool:
        return bool(self._value)

    def reveal(self) -> str:
        """Return the secret for a provider transport at the last responsible moment."""
        return self._value


@dataclass(frozen=True)
class SearchSettings:
    """One explicit, immutable configuration snapshot for the provider chain."""

    search_backends: tuple[str, ...]
    extract_backends: tuple[str, ...]
    _tavily: OptionalCredential = field(repr=False, compare=False)
    _searxng_endpoint: str = field(repr=False, compare=False)

    def provider_diagnostics(self) -> dict[str, bool]:
        """Expose configuration state without revealing endpoints or credentials."""
        return {
            "searxng": bool(self._searxng_endpoint),
            "ddgs": True,
            "tavily": self._tavily.configured,
            "trafilatura": True,
            "playwright": True,
        }

    def credential_for(self, provider_name: str) -> OptionalCredential:
        if provider_name != "tavily":
            raise ValueError(f"unknown credential provider: {provider_name}")
        return self._tavily

    def endpoint_for(self, provider_name: str) -> str:
        if provider_name != "searxng":
            raise ValueError(f"unknown endpoint provider: {provider_name}")
        return self._searxng_endpoint


def _parse_backend_chain(value: str, *, supported: frozenset[str], label: str) -> tuple[str, ...]:
    names = tuple(part.strip().lower() for part in value.split(",") if part.strip())
    if not names:
        raise ValueError(f"{label} must contain at least one provider")
    unknown = [name for name in names if name not in supported]
    if unknown:
        raise ValueError(f"unknown {label} provider: {unknown[0]}")
    if len(names) != len(set(names)):
        raise ValueError(f"duplicate {label} provider")
    return names


def load_search_settings() -> SearchSettings:
    """Assemble the web-research configuration once from the environment."""
    search_backends = _parse_backend_chain(
        os.getenv("JARVIS_SEARCH_BACKENDS", ",".join(_DEFAULT_SEARCH_BACKENDS)),
        supported=_SEARCH_PROVIDERS,
        label="search backend",
    )
    extract_backends = _parse_backend_chain(
        os.getenv("JARVIS_EXTRACT_BACKENDS", ",".join(_DEFAULT_EXTRACT_BACKENDS)),
        supported=_EXTRACT_PROVIDERS,
        label="extract backend",
    )
    return SearchSettings(
        search_backends=search_backends,
        extract_backends=extract_backends,
        _tavily=OptionalCredential(os.getenv("TAVILY_API_KEY", "").strip()),
        _searxng_endpoint=os.getenv("SEARXNG_BASE_URL", "").strip(),
    )

ROOT = Path(__file__).resolve().parent.parent


def load_env() -> None:
    """加载项目根 .env；已存在的环境变量优先，不被覆盖。
    读不到文件（不存在/无权限，如 systemd 已注入环境变量的部署场景）时静默跳过。"""
    try:
        load_dotenv(ROOT / ".env")
    except OSError:
        pass
    # SOCKS 代理需要额外的 socksio 包（不在依赖内）；
    # 摘掉 all_proxy 后 httpx 自动走 https_proxy 的 HTTP 代理。
    for var in ("all_proxy", "ALL_PROXY"):
        os.environ.pop(var, None)


def data_dir() -> Path:
    d = Path(os.getenv("JARVIS_DATA_DIR", str(ROOT / "data")))
    d.mkdir(parents=True, exist_ok=True)
    return d


def db_path() -> Path:
    return data_dir() / "jarvis.db"


def model_name() -> str:
    return os.getenv("JARVIS_MODEL", "deepseek-chat")


def base_url() -> str:
    return os.getenv("JARVIS_BASE_URL", "https://api.deepseek.com")


def api_key() -> str:
    generic = os.getenv("JARVIS_API_KEY", "").strip()
    if generic:
        return generic
    provider = os.getenv("JARVIS_PROVIDER", "deepseek").strip().lower()
    if provider == "openai" and os.getenv("OPENAI_API_KEY", "").strip():
        return os.environ["OPENAI_API_KEY"].strip()
    if provider == "deepseek" and os.getenv("DEEPSEEK_API_KEY", "").strip():
        return os.environ["DEEPSEEK_API_KEY"].strip()
    raise KeyError("JARVIS_API_KEY")


def tavily_api_key() -> str:
    """可选的实时网页搜索密钥；缺失时由工具返回可操作提示。"""
    return os.getenv("TAVILY_API_KEY", "").strip()


def pandascore_token() -> str:
    """可选的结构化电竞数据 Token；缺失时自动回退网页搜索。"""
    return os.getenv("PANDASCORE_TOKEN", "").strip()
