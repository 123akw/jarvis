"""集中配置：路径、环境变量、模型参数。所有取值都在调用时读取，方便测试与热切换。"""
import os
from pathlib import Path

from dotenv import load_dotenv

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
    return os.environ["DEEPSEEK_API_KEY"]


def tavily_api_key() -> str:
    """可选的实时网页搜索密钥；缺失时由工具返回可操作提示。"""
    return os.getenv("TAVILY_API_KEY", "").strip()


def pandascore_token() -> str:
    """可选的结构化电竞数据 Token；缺失时自动回退网页搜索。"""
    return os.getenv("PANDASCORE_TOKEN", "").strip()
