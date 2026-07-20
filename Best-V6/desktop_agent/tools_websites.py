"""
Websites control: open target websites and format search engine links.
"""

from __future__ import annotations

import webbrowser
from typing import Any, Dict

from .registry import ToolError, register


def _build_search_url(engine: str, query: str) -> str:
    """Build a search engine URL for a given query."""
    engine_lower = engine.strip().lower()
    if "youtube" in engine_lower:
        return f"https://www.youtube.com/results?search_query={query}"
    elif "github" in engine_lower:
        return f"https://github.com/search?q={query}"
    else:
        # Default to google
        return f"https://www.google.com/search?q={query}"


def open_url(url: str) -> str:
    """Open a URL in the automated Playwright Chromium browser, adding https if missing."""
    target = url.strip()
    if not (target.startswith("http://") or target.startswith("https://")):
        target = "https://" + target
    try:
        # Use the new sync thread-based browser worker (no coroutines).
        from .tools_browser import WORKER, _browser_open, _with_recovery
        _with_recovery("browserOpen", _browser_open, {"url": target})
        return target
    except Exception as e:
        raise ToolError(f"Could not open website: {e}")


@register("openWebsite")
def open_website(args: Dict[str, Any]) -> Dict[str, Any]:
    url = args.get("url") or args.get("name")
    if not url:
        raise ToolError("Parameter 'url' or 'name' is required.")
    
    url_str = str(url).strip()
    
    # Common website name mappings
    common_sites = {
        "youtube": "youtube.com",
        "google": "google.com",
        "github": "github.com",
        "twitter": "twitter.com",
        "instagram": "instagram.com",
        "facebook": "facebook.com",
        "linkedin": "linkedin.com",
        "wikipedia": "wikipedia.org",
        "reddit": "reddit.com",
    }
    
    if url_str.lower() in common_sites:
        url_str = common_sites[url_str.lower()]
        
    resolved = open_url(url_str)
    return {"result": f"Opened website: {resolved}"}


__all__ = ["open_url", "_build_search_url", "open_website"]
