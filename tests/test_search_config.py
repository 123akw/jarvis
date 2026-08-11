import pytest

from jarvis.config import load_search_settings


def test_search_settings_default_to_free_chain(monkeypatch):
    monkeypatch.delenv("TAVILY_API_KEY", raising=False)
    settings = load_search_settings()
    assert settings.search_backends == ("searxng", "ddgs", "tavily")
    assert settings.extract_backends == ("trafilatura", "playwright")
    assert "api_key" not in repr(settings).lower()


def test_search_settings_reject_unknown_search_provider(monkeypatch):
    """Would fail if a misspelled fallback were silently ignored at request time."""
    monkeypatch.setenv("JARVIS_SEARCH_BACKENDS", "searxng,unknown")

    with pytest.raises(ValueError, match="unknown"):
        load_search_settings()


def test_search_settings_reject_duplicate_fallback(monkeypatch):
    """Would fail if a duplicate fallback spent the same provider's quota twice."""
    monkeypatch.setenv("JARVIS_SEARCH_BACKENDS", "ddgs,ddgs")

    with pytest.raises(ValueError, match="duplicate"):
        load_search_settings()


def test_search_settings_diagnostics_redact_credentials(monkeypatch):
    """Would fail if diagnostics exposed a token rather than its configured state."""
    monkeypatch.setenv("TAVILY_API_KEY", "test-token-only")
    settings = load_search_settings()

    assert settings.provider_diagnostics() == {
        "searxng": False,
        "ddgs": True,
        "tavily": True,
        "trafilatura": True,
        "playwright": True,
    }
    assert "test-token-only" not in repr(settings)
