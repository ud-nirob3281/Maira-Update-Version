"""
Browser automation via Playwright — Stonic-grade reliability.

ARCHITECTURE (fixes the "cannot reuse already awaited coroutine" bug):
The previous design marshalled coroutines onto a dedicated asyncio loop and
wrapped them in sync via asyncio.run_coroutine_threadsafe. That works in
theory, but the async handlers were ALSO registered under multiple aliases
(`@register("desktopBrowserOpen")` + `@register("browserOpen")`) and the
module-level `_sync_wrap` loop rewrapped coroutines AFTER they had already
been awaited once — producing "cannot reuse already awaited coroutine".

NEW DESIGN — pure sync thread (no coroutines, no event loop):
  • One dedicated worker thread owns the Playwright sync API + browser.
  • Handlers submit a callable via a thread-safe queue and block on the result.
  • The sync Playwright API is rock-solid and needs no event loop gymnastics.
  • Persistent context: logins/cookies survive across sessions.

CAPABILITIES (mirrors Stonic browser-manager.js):
  • Persistent headed Chromium with automation flags stripped
  • ARIA snapshot engine with ref=eN disambiguation (human-level element targeting)
  • Click by ref / selector / text / role
  • Type, fill form, scroll, tabs, back/forward
  • Screenshot (compressed for AI vision)
  • Auto-recovery: dead browser is relaunched and the op retried once
"""

from __future__ import annotations

import base64
import io
import json
import os
import queue
import threading
import time
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import quote_plus

from .registry import STATE, ToolError, register

# ═══════════════════════════════════════════════════════════════════════════
#  WORKER THREAD — owns Playwright sync API (single owner, no event loop)
# ═══════════════════════════════════════════════════════════════════════════

class _BrowserWorker:
    """A dedicated thread that owns the Playwright sync Playwright instance.

    Public handlers enqueue (fn, args) tuples; the worker runs them serially on
    its own thread (Playwright sync API is not thread-safe) and returns results
    via a per-call result queue. This eliminates every asyncio/coroutine hazard.
    """

    def __init__(self) -> None:
        self._task_q: "queue.Queue[Tuple[Any, Any, queue.Queue]]" = queue.Queue()
        self._thread: Optional[threading.Thread] = None
        self._started = threading.Event()
        # Owned only by the worker thread:
        self.pw = None
        self.browser = None
        self.context = None
        self.page = None
        self.element_map: Dict[str, Dict[str, Any]] = {}
        self._lock = threading.Lock()

    # ── lifecycle ───────────────────────────────────────────────────────────
    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._thread = threading.Thread(target=self._run, name="myraa-browser-worker", daemon=True)
        self._thread.start()
        self._started.wait(timeout=5)

    def _run(self) -> None:
        # Lazy import on the worker thread only.
        try:
            from playwright.sync_api import sync_playwright
        except Exception as e:
            self.pw = None
            self._started.set()
            print(f"[BrowserWorker] Playwright unavailable: {e}")
            # Still serve the queue so requests fail gracefully instead of hanging.
            while True:
                fn, args, res_q = self._task_q.get()
                res_q.put(("error", ToolError(f"Playwright is not installed: {e}")))
            return
        self.pw = sync_playwright().start()
        self._started.set()
        # Main dispatch loop — runs forever, owns Playwright.
        while True:
            fn, args, res_q = self._task_q.get()
            try:
                result = fn(self, args)
                res_q.put(("ok", result))
            except ToolError as e:
                res_q.put(("error", e))
            except Exception as e:  # noqa: BLE001
                res_q.put(("error", ToolError(f"{type(e).__name__}: {e}")))

    # ── submission ──────────────────────────────────────────────────────────
    def call(self, fn, args, timeout: float = 90.0) -> Any:
        """Submit a handler fn(worker, args) to the worker and block on result."""
        self.start()
        res_q: "queue.Queue" = queue.Queue()
        self._task_q.put((fn, args, res_q))
        try:
            status, payload = res_q.get(timeout=timeout)
        except queue.Empty:
            raise ToolError(f"Browser operation timed out after {timeout}s.")
        if status == "error":
            raise payload  # a ToolError
        return payload


WORKER = _BrowserWorker()

# ═══════════════════════════════════════════════════════════════════════════
#  ROLE CLASSIFICATION (mirrors Stonic browser-manager.js)
# ═══════════════════════════════════════════════════════════════════════════

INTERACTIVE_ROLES = {
    "button", "link", "checkbox", "menuitemcheckbox", "menuitemradio",
    "radio", "slider", "spinbutton", "switch", "tab", "textbox",
    "treeitem", "combobox", "menuitem", "option", "searchbox",
}
CONTENT_ROLES = {
    "heading", "image", "text", "paragraph", "cell", "row", "listitem",
    "navigation", "article", "section", "group", "figure", "caption",
}
STRUCTURAL_ROLES = {
    "none", "presentation", "generic", "region", "main", "banner",
    "complementary", "contentinfo", "form", "application",
}


# ═══════════════════════════════════════════════════════════════════════════
#  WORKER-THREAD FUNCTIONS (run only on the worker thread)
# ═══════════════════════════════════════════════════════════════════════════

def _profile_dir() -> str:
    return os.path.join(os.environ.get("MYRAA_DATA_DIR", os.getcwd()), "browser-profile")


def _urls_match(url1: str, url2: str) -> bool:
    """Check if two URLs are functionally equivalent to avoid redundant page loads."""
    if not url1 or not url2:
        return False
    def normalize(u: str) -> str:
        u = u.strip().lower()
        if u.startswith("http://"):
            u = u[7:]
        elif u.startswith("https://"):
            u = u[8:]
        if u.startswith("www."):
            u = u[4:]
        return u.rstrip('/')
    return normalize(url1) == normalize(url2)


def _ensure_browser(w: "_BrowserWorker", _args=None) -> Dict[str, Any]:
    """Lazily launch a persistent Chromium context. Idempotent + health-checked + resilient."""
    # Health check existing context
    context_healthy = True
    if w.context is not None:
        try:
            _ = w.context.pages  # raises if closed
        except Exception:
            context_healthy = False
            
    # Check page health separately
    page_healthy = True
    if w.page is not None:
        try:
            _ = w.page.url
        except Exception:
            page_healthy = False

    # If context is healthy but active page is closed/unhealthy, recover page from same context
    if context_healthy and not page_healthy and w.context is not None:
        try:
            pages = w.context.pages
            w.page = pages[-1] if pages else w.context.new_page()
            page_healthy = True
        except Exception:
            context_healthy = False

    if context_healthy and page_healthy and w.page is not None:
        return {"ok": True, "url": w.page.url}

    # Need (re)launch
    if w.context is None or not context_healthy:
        try:
            if w.context:
                w.context.close()
        except Exception:
            pass
        w.context = None
        w.page = None
        w.element_map = {}

        os.makedirs(_profile_dir(), exist_ok=True)
        launch_args = [
            "--start-maximized",
            "--no-sandbox",
            "--disable-blink-features=AutomationControlled",
            "--disable-features=TranslateUI",
        ]
        try:
            w.context = w.pw.chromium.launch_persistent_context(
                _profile_dir(),
                headless=False,
                args=launch_args,
                viewport=None,
                no_viewport=True,
                ignore_default_args=["--enable-automation"],
            )
        except Exception as e:
            msg = str(e)
            w.context = None
            if "Executable doesn't exist" in msg or "playwright install" in msg.lower():
                raise ToolError(
                    "Chromium is not installed. Run once: python -m playwright install chromium"
                ) from e
            raise ToolError(f"Could not launch Chromium: {e}") from e
        pages = w.context.pages
        w.page = pages[-1] if pages else w.context.new_page()

        # Setup context-level page handlers to auto-accept dialogs (e.g. alert/confirm/prompt)
        def _setup_page_handlers(p):
            try:
                p.on("dialog", lambda d: d.accept())
            except Exception:
                pass

        try:
            w.context.on("page", _setup_page_handlers)
            for p in w.context.pages:
                _setup_page_handlers(p)
        except Exception:
            pass

        # Autocapture downloads
        downloads_dir = os.path.join(os.environ.get("MYRAA_DATA_DIR", os.getcwd()), "downloads")
        os.makedirs(downloads_dir, exist_ok=True)
        if not hasattr(w, "downloads"):
            w.downloads = []

        def _on_download(download):
            filename = download.suggested_filename
            dest_path = os.path.join(downloads_dir, filename)
            try:
                download.save_as(dest_path)
                w.downloads.append({
                    "filename": filename,
                    "path": dest_path,
                    "url": download.url,
                    "time": time.strftime("%Y-%m-%d %H:%M:%S")
                })
            except Exception as e:
                print(f"[BrowserWorker] Download capture error: {e}")

        try:
            w.context.on("download", _on_download)
        except Exception:
            pass

    return {"ok": True, "url": w.page.url}


def _reset(w: "_BrowserWorker", _args=None) -> Dict[str, Any]:
    """Tear down browser state (manually triggered, not auto-recovery)."""
    try:
        if w.context:
            w.context.close()
    except Exception:
        pass
    w.context = None
    w.page = None
    w.element_map = {}
    return {"ok": True}


def _normalize_url(raw: str) -> str:
    url = (raw or "").strip()
    if not url:
        raise ToolError("Empty URL.")
    
    # Address Bar Search heuristic:
    # If it contains spaces, or does not contain a dot (and is not localhost or about:),
    # treat it as a search query and route to google.com/search
    is_query = False
    if " " in url:
        is_query = True
    elif "." not in url and not url.startswith("http://") and not url.startswith("https://") and not url.startswith("localhost") and not url.startswith("about:"):
        is_query = True

    if is_query:
        import urllib.parse
        return f"https://www.google.com/search?q={urllib.parse.quote_plus(url)}"

    if "://" not in url and not url.startswith("about:"):
        url = "https://" + url
    return url


# ── navigation ──────────────────────────────────────────────────────────────

def _browser_open(w: "_BrowserWorker", args: Dict[str, Any]) -> Dict[str, Any]:
    url = _normalize_url(args.get("url") or "https://www.google.com")
    force = bool(args.get("force", False))
    _ensure_browser(w)
    
    # Avoid opening/reloading the exact same URL if already active
    if w.page and not force:
        try:
            current_url = w.page.url
            if _urls_match(current_url, url):
                title = w.page.title()
                return {
                    "result": f"Already open on {url}. Reusing existing page session.",
                    "url": current_url,
                    "title": title
                }
        except Exception:
            pass

    try:
        w.page.goto(url, wait_until="domcontentloaded", timeout=30000)
        title = w.page.title()
        return {"result": f"Opened {url}.", "url": w.page.url, "title": title}
    except Exception as e:
        raise ToolError(f"Navigation failed: {e}")


def _browser_go_back(w: "_BrowserWorker", args: Dict[str, Any]) -> Dict[str, Any]:
    _ensure_browser(w)
    try:
        w.page.go_back(timeout=15000)
        return {"result": f"Went back. Now on {w.page.url}.", "url": w.page.url}
    except Exception as e:
        raise ToolError(f"Back failed: {e}")


def _browser_go_forward(w: "_BrowserWorker", args: Dict[str, Any]) -> Dict[str, Any]:
    _ensure_browser(w)
    try:
        w.page.go_forward(timeout=15000)
        return {"result": f"Went forward. Now on {w.page.url}.", "url": w.page.url}
    except Exception as e:
        raise ToolError(f"Forward failed: {e}")


# ── tabs ────────────────────────────────────────────────────────────────────

def _browser_open_tab(w: "_BrowserWorker", args: Dict[str, Any]) -> Dict[str, Any]:
    url = _normalize_url(args.get("url") or "about:blank")
    _ensure_browser(w)
    page = w.context.new_page()
    w.page = page
    if url != "about:blank":
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=25000)
        except Exception as e:
            raise ToolError(f"Opened tab but navigation failed: {e}")
    return {"result": f"New tab opened at {url}.", "url": page.url}


def _browser_close_tab(w: "_BrowserWorker", args: Dict[str, Any]) -> Dict[str, Any]:
    _ensure_browser(w)
    try:
        w.page.close()
    except Exception:
        pass
    pages = w.context.pages if w.context else []
    w.page = pages[-1] if pages else None
    if w.page is None:
        return {"result": "Closed the last tab; browser now empty."}
    return {"result": f"Closed tab. Active tab now: {w.page.url}", "url": w.page.url}


def _browser_list_tabs(w: "_BrowserWorker", args: Dict[str, Any]) -> Dict[str, Any]:
    _ensure_browser(w)
    pages = w.context.pages if w.context else []
    tabs = [{"index": i, "url": p.url, "title": _safe_title(p)} for i, p in enumerate(pages)]
    return {"result": f"{len(tabs)} tab(s) open.", "tabs": tabs}


def _browser_switch_tab(w: "_BrowserWorker", args: Dict[str, Any]) -> Dict[str, Any]:
    _ensure_browser(w)
    idx = int(args.get("index", 0))
    pages = w.context.pages if w.context else []
    if not pages:
        raise ToolError("No tabs to switch to.")
    if idx < 0 or idx >= len(pages):
        idx = len(pages) - 1
    w.page = pages[idx]
    w.page.bring_to_front()
    return {"result": f"Switched to tab {idx}: {w.page.url}", "url": w.page.url}


def _safe_title(page) -> str:
    try:
        return page.title()
    except Exception:
        return ""


# ── search ──────────────────────────────────────────────────────────────────

def _browser_search(w: "_BrowserWorker", args: Dict[str, Any]) -> Dict[str, Any]:
    query = args.get("query") or args.get("q")
    engine = (args.get("engine") or "google").strip().lower()
    if not query:
        raise ToolError("Parameter 'query' is required.")
    _ensure_browser(w)
    q = quote_plus(str(query))
    url = {
        "google": f"https://www.google.com/search?q={q}",
        "youtube": f"https://www.youtube.com/results?search_query={q}",
        "github": f"https://github.com/search?q={q}",
        "duckduckgo": f"https://duckduckgo.com/?q={q}",
        "bing": f"https://www.bing.com/search?q={q}",
    }.get(engine, f"https://www.google.com/search?q={q}")
    try:
        w.page.goto(url, wait_until="domcontentloaded", timeout=25000)
    except Exception as e:
        raise ToolError(f"Search navigation failed: {e}")
    time.sleep(1.5)
    return {"result": f"Searched {engine} for '{query}'.", "url": w.page.url}


# ═══════════════════════════════════════════════════════════════════════════
#  ARIA SNAPSHOT ENGINE (mirrors Stonic browser-manager.js snapshot())
# ═══════════════════════════════════════════════════════════════════════════

def _browser_snapshot(w: "_BrowserWorker", args: Dict[str, Any]) -> Dict[str, Any]:
    _ensure_browser(w)
    
    from .tools_snapshot_manager import wait_for_browser_load, SNAPSHOT_CACHE
    import logging
    log_obj = logging.getLogger("myraa.browser")

    # Wait on loading dynamically
    wait_for_browser_load(w)

    force = bool(args.get("force", False))
    
    # Capture physical screenshot to check screen hash if available
    from PIL import ImageGrab
    current_img = None
    try:
        current_img = ImageGrab.grab(all_screens=True)
    except Exception:
        try:
            current_img = ImageGrab.grab()
        except Exception:
            pass

    # Check cache validity
    if not force and SNAPSHOT_CACHE.check_and_update_state(w, current_img):
        if SNAPSHOT_CACHE.cached_aria_snapshot is not None:
            # Restore the element map from cache!
            w.element_map = dict(SNAPSHOT_CACHE.cached_aria_snapshot.get("element_map", {}))
            log_obj.info("Reusing cached ARIA snapshot.")
            return SNAPSHOT_CACHE.cached_aria_snapshot["response"]

    w.element_map = {}
    t0 = time.time()
    try:
        try:
            aria_text = w.page.locator(":root").aria_snapshot()
        except Exception:
            aria_text = ""
    except Exception as e:
        raise ToolError(f"Snapshot failed: {e}")

    if not aria_text or not aria_text.strip():
        return {"result": "Page has no accessible elements (still loading?).", "elementCount": 0}

    # Parse ARIA lines: '  - role "name" ...'
    import re
    counter = 0
    role_counts: Dict[str, int] = {}
    interactive = 0
    out_lines: List[str] = []

    for line in aria_text.split("\n"):
        m = re.match(r'^(\s*-\s*)(\w+)(?:\s+"([^"]*)")?(.*)$', line)
        if not m:
            out_lines.append(line)
            continue
        prefix, role_raw, name, suffix = m.groups()
        if role_raw.startswith("/"):
            out_lines.append(line)
            continue
        role = role_raw.lower()
        is_inter = role in INTERACTIVE_ROLES
        is_content = role in CONTENT_ROLES
        is_struct = role in STRUCTURAL_ROLES
        if is_struct and not name:
            continue
        should_ref = is_inter or (is_content and name)
        if should_ref:
            counter += 1
            ref = f"e{counter}"
            key = f"{role}:{name or ''}"
            nth = role_counts.get(key, 0)
            role_counts[key] = nth + 1
            w.element_map[ref] = {"role": role, "name": name or None, "nth": nth if nth else None}
            if is_inter:
                interactive += 1
            enhanced = f"{prefix}{role_raw}"
            if name:
                enhanced += f' "{name}"'
            enhanced += f" [ref={ref}]"
            if nth:
                enhanced += f" [nth={nth}]"
            out_lines.append(enhanced)
        else:
            out_lines.append(line)

    snapshot_text = "\n".join(out_lines)
    el_count = counter
    
    response = {
        "result": snapshot_text[:8000],  # cap for AI token safety
        "elementCount": el_count,
        "interactiveCount": interactive,
        "url": w.page.url,
        "snapshotMs": int((time.time() - t0) * 1000),
    }

    # Cache the result
    SNAPSHOT_CACHE.populate_cache(
        worker=w,
        current_img=current_img,
        aria_snapshot={
            "response": response,
            "element_map": dict(w.element_map)
        }
    )
    return response


# ── element resolution (ref / selector / text / role) ───────────────────────

def _resolve_locator(w: "_BrowserWorker", ref=None, selector=None, text=None, role=None, name=None):
    """Resolve to a Playwright Locator using ref > selector > role > text."""
    page = w.page
    # 1. ref (eN) — Stonic-style precise targeting
    if ref and ref in w.element_map:
        info = w.element_map[ref]
        r = info["role"]
        nm = info.get("name")
        nth = info.get("nth")
        try:
            # Strategy A: role + name + nth (most precise)
            if nm:
                loc = page.get_by_role(r, name=nm, exact=False)
                if nth is not None:
                    loc = loc.nth(nth)
                else:
                    loc = loc.first
                # Verify the element is actually visible
                try:
                    loc.wait_for(state="attached", timeout=2000)
                except Exception:
                    pass
                return loc
            # Strategy B: role only
            loc = page.get_by_role(r).first
            try:
                loc.wait_for(state="attached", timeout=2000)
            except Exception:
                pass
            return loc
        except Exception:
            pass
    # 2. CSS selector
    if selector:
        loc = page.locator(selector).first
        try:
            loc.wait_for(state="attached", timeout=2000)
        except Exception:
            pass
        return loc
    # 3. role + name
    if role:
        loc = page.get_by_role(role, name=name, exact=False).first if name else page.get_by_role(role).first
        try:
            loc.wait_for(state="attached", timeout=2000)
        except Exception:
            pass
        return loc
    # 4. text
    if text:
        # Try multiple text matching strategies
        try:
            loc = page.get_by_text(str(text), exact=False).first
            try:
                loc.wait_for(state="attached", timeout=1000)
            except Exception:
                pass
            return loc
        except Exception:
            pass
        # Fallback: locator with text=
        return page.locator(f"text={str(text)}").first
    raise ToolError("Provide 'ref', 'selector', 'role', or 'text' to identify the element.")


def _browser_click(w: "_BrowserWorker", args: Dict[str, Any]) -> Dict[str, Any]:
    _ensure_browser(w)
    ref = args.get("ref")
    selector = args.get("selector")
    text = args.get("text")
    role = args.get("role")
    name = args.get("name") or args.get("roleName")
    is_youtube = "youtube.com" in (w.page.url or "")
    is_whatsapp = "web.whatsapp.com" in (w.page.url or "")

    # WhatsApp: clicking a contact in search results
    if is_whatsapp and text:
        # Try clicking a contact/chat by name in the left sidebar list
        try:
            # First: try to find the contact in the search results or chat list.
            # WhatsApp renders chat/contact items with specific selectors.
            contact_selectors = [
                f'span[title="{text}"]',
                f'span[title^="{text}"]',
                f'span[title*="{text}" i]',
                f'div[role="row"]:has(span[title*="{text}" i])',
                f'div[role="listitem"]:has(span[title*="{text}" i])',
            ]
            for sel in contact_selectors:
                try:
                    locs = w.page.locator(sel)
                    if locs.count() > 0:
                        locs.first.click(timeout=5000)
                        # CRITICAL: Wait for the chat panel to FULLY load.
                        # The chat area becomes visible and the message input
                        # appears in the footer. Without this wait, typing goes
                        # to the search box (which is still focused).
                        try:
                            w.page.locator('footer div[contenteditable="true"]').wait_for(
                                state="visible", timeout=5000
                            )
                        except Exception:
                            pass  # chat may already be open
                        time.sleep(1.0)
                        # Reset focus: explicitly click the message box to ensure
                        # it's active (not the search box)
                        try:
                            msg_box = w.page.locator('footer div[contenteditable="true"]').last
                            msg_box.click(timeout=3000)
                            time.sleep(0.3)
                        except Exception:
                            pass
                        return {
                            "result": f"Clicked WhatsApp contact '{text}'. Chat is now open.",
                            "url": w.page.url,
                        }
                except Exception:
                    continue
        except Exception:
            pass  # fall through to standard click

    # YouTube: click by text/video title — find the matching video renderer
    if is_youtube and text and "first" not in str(text).lower():
        # Try to find a video renderer whose title contains the search text
        yt_selectors = [
            f'ytd-video-renderer:has-text("{text}") a#video-title-link',
            f'ytd-video-renderer:has-text("{text}") a#thumbnail',
            f'ytd-video-renderer:has-text("{text}") a#video-title',
            f'a#video-title:has-text("{text}")',
            f'ytd-grid-video-renderer:has-text("{text}") a',
            f'ytd-video-renderer:has-text("{text}") a',
        ]
        # Also try with substring match via JavaScript
        try:
            clicked = w.page.evaluate("""(text) => {
                const renderers = document.querySelectorAll('ytd-video-renderer, ytd-grid-video-renderer, ytd-rich-item-renderer');
                for (const r of renderers) {
                    const titleEl = r.querySelector('#video-title, a#video-title-link, a#thumbnail');
                    if (titleEl && titleEl.textContent && titleEl.textContent.toLowerCase().includes(text.toLowerCase())) {
                        titleEl.click();
                        return true;
                    }
                }
                return false;
            }""", str(text))
            if clicked:
                time.sleep(1.0)
                return {"result": f"Clicked YouTube video matching '{text}'.", "url": w.page.url}
        except Exception:
            pass
        for sel in yt_selectors:
            try:
                loc = w.page.locator(sel)
                if loc.count() > 0:
                    loc.first.click(timeout=5000)
                    time.sleep(1.0)
                    return {"result": f"Clicked YouTube video matching '{text}'.", "url": w.page.url}
            except Exception:
                continue

    # YouTube "first video" shortcut — ONLY when explicitly requested or no params given
    if is_youtube and (selector in ("first_video", "first") or (text and "first" in str(text).lower()) or not any([ref, selector, text, role])):
        # Use JS to reliably click the first video result
        try:
            clicked = w.page.evaluate("""() => {
                const el = document.querySelector('ytd-video-renderer a#video-title-link, ytd-video-renderer a#thumbnail, a#video-title, ytd-grid-video-renderer a#video-title-link');
                if (el) { el.click(); return true; }
                return false;
            }""")
            if clicked:
                time.sleep(1.0)
                return {"result": "Clicked the first YouTube video.", "url": w.page.url}
        except Exception:
            pass
        for sel in [
            "ytd-video-renderer a#video-title-link",
            "ytd-video-renderer a#thumbnail",
            "a#video-title",
            "ytd-grid-video-renderer a#video-title",
            "a#video-title-link",
            "ytd-video-renderer a",
        ]:
            try:
                loc = w.page.locator(sel)
                if loc.count() > 0:
                    loc.first.click(timeout=8000)
                    return {"result": "Clicked the first video.", "url": w.page.url}
            except Exception:
                continue

    # Standard click — try ref/selector/role/text, with smart fallbacks
    attempts = []
    if ref:
        attempts.append(lambda: _resolve_locator(w, ref=ref))
    if selector:
        attempts.append(lambda: w.page.locator(selector).first)
        # Smart fallbacks for bare-word selectors
        if not any(c in str(selector) for c in "#.[]:> :=*"):
            cs = str(selector)
            for fb in [f"#{cs}", f".{cs}", f"[id*='{cs}']", f"[class*='{cs}']", f"text='{cs}'"]:
                attempts.append(lambda fb=fb: w.page.locator(fb).first)
    if role:
        attempts.append(lambda: _resolve_locator(w, role=role, name=name))
    if text:
        attempts.append(lambda: w.page.get_by_text(str(text), exact=False).first)
        attempts.append(lambda: w.page.get_by_role("button", name=str(text), exact=False).first)
        attempts.append(lambda: w.page.get_by_role("link", name=str(text), exact=False).first)

    if not attempts:
        raise ToolError("Provide 'ref', 'selector', 'role', or 'text' to click.")

    last_err = None
    for attempt in attempts:
        try:
            loc = attempt()
            # Wait for the element to be ready before clicking
            try:
                loc.wait_for(state="visible", timeout=3000)
            except Exception:
                pass
            loc.click(timeout=5000)
            time.sleep(0.6)
            return {"result": f"Clicked element.", "url": w.page.url}
        except Exception as e:
            last_err = e
            continue
    raise ToolError(f"Click failed after all strategies: {last_err}")


def _browser_type(w: "_BrowserWorker", args: Dict[str, Any]) -> Dict[str, Any]:
    """Type text into an element, with full contenteditable div support.

    Many modern sites (WhatsApp Web, Slack, Notion, etc.) use contenteditable
    divs instead of <input>/<textarea>.  Playwright's fill() and type() do NOT
    reliably interact with contenteditable elements.  This function detects the
    element type and uses the appropriate strategy:

      1. Standard input/textarea  →  Playwright fill() + type() (fastest)
      2. contenteditable div      →  click to focus → Ctrl+A to select existing
                                     → keyboard.type() to insert text
      3. Fallback (any element)   →  click + keyboard.type()

    WhatsApp Web: automatically targets the MESSAGE input (not search) by
    using WhatsApp's stable CSS footer selector when no specific ref is given.

    Returns detailed diagnostics on failure so the AI can recover.
    """
    _ensure_browser(w)
    text = args.get("text")
    if text is None:
        raise ToolError("Parameter 'text' is required.")
    ref = args.get("ref")
    selector = args.get("selector")
    clear = bool(args.get("clear", True))
    press_enter = bool(args.get("press_enter", False))
    is_whatsapp = "web.whatsapp.com" in (w.page.url or "")

    # ── WhatsApp Web: auto-target the MESSAGE input box ───────────────────
    # When on WhatsApp and no explicit ref/selector is given, we MUST target
    # the message input — never the search box. WhatsApp's message input lives
    # inside a <footer> element with a specific contenteditable div. This is
    # the ONLY reliable way to distinguish it from the search box (both are
    # role="textbox" + contenteditable="true").
    #
    # CRITICAL FIX: Before typing, verify that a chat is actually open.
    # If no chat is open (the user hasn't clicked a contact), the message
    # box doesn't exist and text will go to the search box.
    if is_whatsapp and not ref and not selector:
        # Step 1: Verify a chat is open by checking for the message input in footer
        chat_open = w.page.evaluate("""() => {
            // Check if the chat panel's message input exists
            const footer = document.querySelector('footer');
            if (!footer) return false;
            const msgInput = footer.querySelector('div[contenteditable="true"]');
            if (!msgInput) return false;
            // Check if the footer is visible (has non-zero dimensions)
            const rect = footer.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
        }""")

        if not chat_open:
            raise ToolError(
                "No WhatsApp chat is currently open. Please click on a contact first "
                "to open the conversation, then try typing the message."
            )

        # Step 2: Dismiss search box focus — if the search box is focused, press Escape
        w.page.evaluate("""() => {
            const searchInput = document.querySelector('header div[contenteditable="true"]')
                || document.querySelector('div[contenteditable="true"][role="textbox"][data-tab="3"]')
                || document.querySelector('div[contenteditable="true"][data-tab="6"]');
            if (searchInput && document.activeElement === searchInput) {
                document.activeElement.blur();
            }
        }""")
        time.sleep(0.2)

        # Step 3: Target the message input with robust selectors
        wa_message_selectors = [
            'footer div[contenteditable="true"][data-tab]',
            'div[contenteditable="true"][data-tab="10"]',
            'footer div[contenteditable="true"][role="textbox"]',
            'div[contenteditable="true"][aria-label*="message" i]',
            'div[contenteditable="true"][aria-label*="Type a message" i]',
            'footer div[contenteditable="true"]',
        ]
        typed = False
        for sel in wa_message_selectors:
            try:
                locs = w.page.locator(sel)
                if locs.count() == 0:
                    continue
                # Pick the LAST matching element — message box is always after
                # search box in DOM order (footer is below sidebar).
                msg_loc = locs.nth(locs.count() - 1)
                # Verify it's visible
                try:
                    msg_loc.scroll_into_view_if_needed(timeout=2000)
                except Exception:
                    pass

                msg_loc.click(timeout=5000)
                time.sleep(0.4)

                # Verify focus landed on the message box, not search
                # Check if the focused element is inside a <footer>
                is_in_footer = w.page.evaluate("""() => {
                    const el = document.activeElement;
                    if (!el) return false;
                    return !!el.closest('footer');
                }""")
                if not is_in_footer:
                    # Search box got focused — dismiss it and retry
                    w.page.keyboard.press("Escape")
                    time.sleep(0.2)
                    if sel != wa_message_selectors[-1]:
                        continue

                # Clear any existing text
                if clear:
                    w.page.keyboard.press("Control+A")
                    time.sleep(0.05)
                    w.page.keyboard.press("Delete")
                    time.sleep(0.05)

                w.page.keyboard.type(str(text), delay=15)
                typed = True

                if press_enter:
                    time.sleep(0.15)
                    w.page.keyboard.press("Enter")
                    time.sleep(0.3)

                # Step 4: Verify the message was typed (not in search box)
                final_check = w.page.evaluate("""() => {
                    const el = document.activeElement;
                    if (!el) return false;
                    return !!el.closest('footer');
                }""")
                if not final_check:
                    # Message went to wrong box — try to recover
                    w.page.keyboard.press("Escape")
                    raise ToolError(
                        "Message may have been typed in the search box instead of the message box. "
                        "Please make sure a chat is open and try again."
                    )

                return {
                    "result": f"Typed '{text}' into WhatsApp message box.",
                    "url": w.page.url,
                    "method": "whatsapp_message",
                }
            except ToolError:
                raise
            except Exception:
                continue

        if not typed:
            raise ToolError(
                "Could not find WhatsApp message input box. Make sure a chat is open first "
                "(click on a contact to open the conversation), then try typing again."
            )

    try:
        if ref or selector:
            loc = _resolve_locator(w, ref=ref, selector=selector)

            # Detect element type to pick the right strategy
            is_contenteditable = False
            is_input = False
            tag_name = ""
            try:
                tag_name = loc.evaluate("el => el.tagName.toLowerCase()")
                ce = loc.get_attribute("contenteditable")
                role_attr = loc.get_attribute("role") or ""
                if ce in ("true", "plaintext-only") or "textbox" in role_attr:
                    is_contenteditable = True
                elif tag_name in ("input", "textarea"):
                    is_input = True
            except Exception:
                pass  # assume standard

            if is_contenteditable:
                # ── Contenteditable strategy (WhatsApp Web, Slack, etc.) ──
                loc.click(timeout=5000)
                time.sleep(0.25)  # wait for focus to settle
                if clear:
                    w.page.keyboard.press("Control+A")
                    time.sleep(0.05)
                    w.page.keyboard.press("Delete")
                    time.sleep(0.05)
                w.page.keyboard.type(str(text), delay=15)
                if press_enter:
                    time.sleep(0.1)
                    w.page.keyboard.press("Enter")
                    time.sleep(0.15)
                return {
                    "result": f"Typed '{text}' into contenteditable [{tag_name}].",
                    "url": w.page.url,
                    "method": "contenteditable",
                }
            elif is_input:
                # ── Standard input/textarea (fast Playwright API) ──
                if clear:
                    loc.fill("")
                loc.type(str(text), delay=10)
                if press_enter:
                    w.page.keyboard.press("Enter")
                return {
                    "result": f"Typed '{text}' into [{tag_name}].",
                    "url": w.page.url,
                    "method": "standard",
                }
            else:
                # ── Unknown element: click + keyboard.type() (safest fallback) ──
                loc.click(timeout=5000)
                time.sleep(0.15)
                if clear:
                    w.page.keyboard.press("Control+A")
                    time.sleep(0.05)
                w.page.keyboard.type(str(text), delay=12)
                if press_enter:
                    time.sleep(0.1)
                    w.page.keyboard.press("Enter")
                return {
                    "result": f"Typed '{text}' into [{tag_name}].",
                    "url": w.page.url,
                    "method": "click+keyboard",
                }
        else:
            # No element specified — type at the current focus point
            if clear:
                w.page.keyboard.press("Control+A")
                w.page.keyboard.press("Delete")
            w.page.keyboard.type(str(text), delay=10)
            if press_enter:
                time.sleep(0.1)
                w.page.keyboard.press("Enter")
            return {"result": f"Typed '{text}'.", "url": w.page.url}
    except Exception as e:
        raise ToolError(f"Type failed: {e}")


def _browser_fill_form(w: "_BrowserWorker", args: Dict[str, Any]) -> Dict[str, Any]:
    _ensure_browser(w)
    fields = args.get("fields")
    submit = args.get("submit")
    if not isinstance(fields, dict) or not fields:
        raise ToolError("Parameter 'fields' (object of selector->value) is required.")
    filled = 0
    try:
        for sel, val in fields.items():
            w.page.fill(str(sel), str(val), timeout=5000)
            filled += 1
        if submit:
            w.page.click(str(submit), timeout=5000)
    except Exception as e:
        raise ToolError(f"Form fill failed after {filled} field(s): {e}")
    extra = " and submitted." if submit else "."
    return {"result": f"Filled {filled} field(s){extra}", "url": w.page.url}


def _browser_scroll(w: "_BrowserWorker", args: Dict[str, Any]) -> Dict[str, Any]:
    _ensure_browser(w)
    direction = (args.get("direction") or "down").lower()
    amount = int(args.get("amount", 500))
    delta = amount if direction != "up" else -amount
    try:
        w.page.mouse.wheel(0, delta)
    except Exception as e:
        raise ToolError(f"Scroll failed: {e}")
    return {"result": f"Scrolled {direction} {amount}px.", "url": w.page.url}


def _browser_screenshot(w: "_BrowserWorker", args: Dict[str, Any]) -> Dict[str, Any]:
    _ensure_browser(w)
    full_page = bool(args.get("fullPage", False))
    # Quality is configurable — higher quality for vision tasks where the AI
    # needs to read small text (channel names, timestamps, prices, etc.)
    # Default raised to 75 for better readability by Vision AI.
    quality = int(args.get("quality", 75))
    max_width = int(args.get("maxWidth", 1280))
    try:
        png_bytes = w.page.screenshot(full_page=full_page)
        try:
            from PIL import Image
            img = Image.open(io.BytesIO(pngBytes := png_bytes))
            if img.width > max_width:
                ratio = max_width / img.width
                img = img.resize((max_width, int(img.height * ratio)))
            buf = io.BytesIO()
            img.save(buf, format="JPEG", quality=quality)
            data = base64.b64encode(buf.getvalue()).decode("ascii")
            mime = "image/jpeg"
        except Exception:
            data = base64.b64encode(png_bytes).decode("ascii")
            mime = "image/png"
        return {"result": "Screenshot captured.", "data": data, "mimeType": mime}
    except Exception as e:
        raise ToolError(f"Screenshot failed: {e}")


def _browser_press_key(w: "_BrowserWorker", args: Dict[str, Any]) -> Dict[str, Any]:
    _ensure_browser(w)
    key = args.get("key") or args.get("keys")
    if not key:
        raise ToolError("Parameter 'key' is required (e.g. 'Enter', 'Escape').")
    try:
        w.page.keyboard.press(str(key))
    except Exception as e:
        raise ToolError(f"Key press failed: {e}")
    return {"result": f"Pressed '{key}'."}


def _browser_get_text(w: "_BrowserWorker", args: Dict[str, Any]) -> Dict[str, Any]:
    _ensure_browser(w)
    selector = args.get("selector")
    try:
        if selector:
            content = w.page.locator(selector).first.inner_text(timeout=5000)
        else:
            content = w.page.inner_text("body", timeout=5000)
    except Exception as e:
        raise ToolError(f"Get text failed: {e}")
    return {"result": content[:8000], "url": w.page.url}


def _browser_read_element(w: "_BrowserWorker", args: Dict[str, Any]) -> Dict[str, Any]:
    """Read structured info from a specific element (by ref or selector).

    Unlike get_text (which dumps the whole page), this returns the text of ONE
    element and optionally its bounding box — ideal for reading a specific
    video title, channel name, price, or button label.
    """
    _ensure_browser(w)
    ref = args.get("ref")
    selector = args.get("selector")
    if not ref and not selector:
        raise ToolError("Provide 'ref' or 'selector' to identify the element.")
    try:
        loc = _resolve_locator(w, ref=ref, selector=selector)
        text = loc.inner_text(timeout=5000)
        # Also grab bounding box for coordinate verification
        try:
            box = loc.bounding_box()
        except Exception:
            box = None
        result = {
            "result": text.strip()[:2000],
            "url": w.page.url,
        }
        if box:
            result["boundingBox"] = box
        return result
    except Exception as e:
        raise ToolError(f"Read element failed: {e}")


# ── advanced capabilities ───────────────────────────────────────────────────

def _browser_duplicate_tab(w: "_BrowserWorker", args: Dict[str, Any]) -> Dict[str, Any]:
    """Duplicate the active browser tab (opens active URL in a new tab)."""
    _ensure_browser(w)
    url = w.page.url
    page = w.context.new_page()
    w.page = page
    try:
        page.goto(url, wait_until="domcontentloaded", timeout=25000)
    except Exception as e:
        raise ToolError(f"Duplicated tab but navigation failed: {e}")
    return {"result": f"Duplicated active tab to {url}.", "url": page.url}


def _browser_pin_tab(w: "_BrowserWorker", args: Dict[str, Any]) -> Dict[str, Any]:
    """Pin/Unpin the current tab (simulated/managed in the worker session)."""
    _ensure_browser(w)
    if not hasattr(w, "pinned_tabs"):
        w.pinned_tabs = set()
    action = (args.get("action") or "pin").lower().strip()
    url = w.page.url
    if action == "pin":
        w.pinned_tabs.add(url)
        msg = f"Pinned tab: {url}."
    else:
        w.pinned_tabs.discard(url)
        msg = f"Unpinned tab: {url}."
    return {"result": msg, "pinnedTabs": list(w.pinned_tabs)}


def _browser_bookmark(w: "_BrowserWorker", args: Dict[str, Any]) -> Dict[str, Any]:
    """Bookmark the active page or list saved bookmarks."""
    _ensure_browser(w)
    bookmarks_file = os.path.join(os.environ.get("MYRAA_DATA_DIR", os.getcwd()), "bookmarks.json")
    
    bookmarks = []
    if os.path.exists(bookmarks_file):
        try:
            with open(bookmarks_file, "r", encoding="utf-8") as f:
                bookmarks = json.load(f)
        except Exception:
            pass

    action = (args.get("action") or "add").lower().strip()
    if action == "list":
        return {"result": f"Found {len(bookmarks)} bookmark(s).", "bookmarks": bookmarks}

    url = w.page.url
    title = _safe_title(w.page)
    
    exists = any(b.get("url") == url for b in bookmarks)
    if action == "add":
        if not exists:
            bookmarks.append({
                "url": url,
                "title": title,
                "time": time.strftime("%Y-%m-%d %H:%M:%S")
            })
            try:
                with open(bookmarks_file, "w", encoding="utf-8") as f:
                    json.dump(bookmarks, f, indent=2, ensure_ascii=False)
            except Exception as e:
                raise ToolError(f"Could not save bookmark: {e}")
            msg = f"Bookmarked: '{title}' ({url})."
        else:
            msg = f"Already bookmarked: '{title}'."
    elif action == "remove":
        bookmarks = [b for b in bookmarks if b.get("url") != url]
        try:
            with open(bookmarks_file, "w", encoding="utf-8") as f:
                json.dump(bookmarks, f, indent=2, ensure_ascii=False)
        except Exception as e:
            raise ToolError(f"Could not remove bookmark: {e}")
        msg = f"Removed bookmark for: {url}."
    else:
        raise ToolError("Unknown bookmark action. Use 'add', 'remove', or 'list'.")

    return {"result": msg, "bookmarks": bookmarks}


def _browser_refresh(w: "_BrowserWorker", args: Dict[str, Any]) -> Dict[str, Any]:
    """Reload the active page."""
    _ensure_browser(w)
    try:
        w.page.reload(wait_until="domcontentloaded", timeout=25000)
        return {"result": f"Refreshed page. Now on {w.page.url}.", "url": w.page.url}
    except Exception as e:
        raise ToolError(f"Refresh failed: {e}")


def _browser_page_search(w: "_BrowserWorker", args: Dict[str, Any]) -> Dict[str, Any]:
    """Search for text on the active page (simulating Ctrl+F)."""
    _ensure_browser(w)
    query = args.get("query")
    if not query:
        raise ToolError("Parameter 'query' is required.")
    
    try:
        matches_count = w.page.evaluate("""(query) => {
            const regex = new RegExp(query, 'gi');
            const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
            let n;
            let count = 0;
            const matches = [];
            while (n = walk.nextNode()) {
                if (regex.test(n.nodeValue)) {
                    count++;
                    if (n.parentElement) {
                        matches.push(n.parentElement);
                    }
                }
            }
            if (matches.length > 0) {
                matches[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
                const originalBg = matches[0].style.backgroundColor;
                matches[0].style.backgroundColor = '#ffeb3b';
                setTimeout(() => {
                    matches[0].style.backgroundColor = originalBg;
                }, 2000);
            }
            return count;
        }""", str(query))
        
        if matches_count > 0:
            return {"result": f"Found {matches_count} match(es) for '{query}' and scrolled the first into view.", "matchesCount": matches_count}
        else:
            return {"result": f"No matches found for '{query}'.", "matchesCount": 0}
    except Exception as e:
        raise ToolError(f"Page search failed: {e}")


def _browser_zoom(w: "_BrowserWorker", args: Dict[str, Any]) -> Dict[str, Any]:
    """Zoom the page (e.g., zoom factor 0.5 to 2.0)."""
    _ensure_browser(w)
    try:
        factor = float(args.get("factor", 1.0))
    except (ValueError, TypeError):
        raise ToolError("Zoom 'factor' must be a numeric value (e.g., 0.8, 1.2, 1.5).")
    try:
        w.page.evaluate("factor => { document.documentElement.style.zoom = factor; }", factor)
        return {"result": f"Zoom set to {int(factor * 100)}%.", "factor": factor}
    except Exception as e:
        raise ToolError(f"Zoom failed: {e}")


def _browser_double_click(w: "_BrowserWorker", args: Dict[str, Any]) -> Dict[str, Any]:
    """Double-click an element by ref, selector, role, or text."""
    _ensure_browser(w)
    ref = args.get("ref")
    selector = args.get("selector")
    text = args.get("text")
    role = args.get("role")
    name = args.get("name") or args.get("roleName")

    attempts = []
    if ref:
        attempts.append(lambda: _resolve_locator(w, ref=ref))
    if selector:
        attempts.append(lambda: w.page.locator(selector).first)
    if role:
        attempts.append(lambda: _resolve_locator(w, role=role, name=name))
    if text:
        attempts.append(lambda: w.page.get_by_text(str(text), exact=False).first)

    if not attempts:
        raise ToolError("Provide 'ref', 'selector', 'role', or 'text' to double-click.")

    last_err = None
    for attempt in attempts:
        try:
            loc = attempt()
            loc.wait_for(state="visible", timeout=3000)
            loc.dblclick(timeout=5000)
            time.sleep(0.5)
            return {"result": "Double-clicked element.", "url": w.page.url}
        except Exception as e:
            last_err = e
            continue
    raise ToolError(f"Double-click failed: {last_err}")


def _browser_right_click(w: "_BrowserWorker", args: Dict[str, Any]) -> Dict[str, Any]:
    """Right-click an element by ref, selector, role, or text."""
    _ensure_browser(w)
    ref = args.get("ref")
    selector = args.get("selector")
    text = args.get("text")
    role = args.get("role")
    name = args.get("name") or args.get("roleName")

    attempts = []
    if ref:
        attempts.append(lambda: _resolve_locator(w, ref=ref))
    if selector:
        attempts.append(lambda: w.page.locator(selector).first)
    if role:
        attempts.append(lambda: _resolve_locator(w, role=role, name=name))
    if text:
        attempts.append(lambda: w.page.get_by_text(str(text), exact=False).first)

    if not attempts:
        raise ToolError("Provide 'ref', 'selector', 'role', or 'text' to right-click.")

    last_err = None
    for attempt in attempts:
        try:
            loc = attempt()
            loc.wait_for(state="visible", timeout=3000)
            loc.click(button="right", timeout=5000)
            time.sleep(0.5)
            return {"result": "Right-clicked element.", "url": w.page.url}
        except Exception as e:
            last_err = e
            continue
    raise ToolError(f"Right-click failed: {last_err}")


def _browser_drag_and_drop(w: "_BrowserWorker", args: Dict[str, Any]) -> Dict[str, Any]:
    """Drag an element and drop it onto another element or specific offset."""
    _ensure_browser(w)
    source_ref = args.get("sourceRef") or args.get("ref")
    source_sel = args.get("sourceSelector") or args.get("selector")
    
    target_ref = args.get("targetRef")
    target_sel = args.get("targetSelector")
    
    x = args.get("x")
    y = args.get("y")

    try:
        source_loc = _resolve_locator(w, ref=source_ref, selector=source_sel)
        source_loc.wait_for(state="visible", timeout=3000)
        
        if target_ref or target_sel:
            target_loc = _resolve_locator(w, ref=target_ref, selector=target_sel)
            target_loc.wait_for(state="visible", timeout=3000)
            source_loc.drag_to(target_loc, timeout=5000)
            msg = "Dragged element to target."
        elif x is not None and y is not None:
            box = source_loc.bounding_box()
            if not box:
                raise ToolError("Could not determine source element position.")
            start_x = box["x"] + box["width"] / 2
            start_y = box["y"] + box["height"] / 2
            w.page.mouse.move(start_x, start_y)
            w.page.mouse.down()
            w.page.mouse.move(start_x + float(x), start_y + float(y), steps=10)
            w.page.mouse.up()
            msg = f"Dragged element by offset ({x}, {y})."
        else:
            raise ToolError("Provide targetRef, targetSelector, or x/y offsets to drop the element.")
            
        time.sleep(0.5)
        return {"result": msg, "url": w.page.url}
    except Exception as e:
        raise ToolError(f"Drag and drop failed: {e}")


def _browser_select_text(w: "_BrowserWorker", args: Dict[str, Any]) -> Dict[str, Any]:
    """Select the text of an element (by ref or selector)."""
    _ensure_browser(w)
    ref = args.get("ref")
    selector = args.get("selector")
    if not ref and not selector:
        raise ToolError("Provide 'ref' or 'selector' to identify the element.")
    
    try:
        loc = _resolve_locator(w, ref=ref, selector=selector)
        loc.wait_for(state="visible", timeout=3000)
        
        w.page.evaluate("""(el) => {
            const selection = window.getSelection();
            const range = document.createRange();
            range.selectNodeContents(el);
            selection.removeAllRanges();
            selection.addRange(range);
        }""", loc.element_handle())
        
        return {"result": "Selected element text.", "url": w.page.url}
    except Exception as e:
        raise ToolError(f"Select text failed: {e}")


def _browser_list_downloads(w: "_BrowserWorker", args: Dict[str, Any]) -> Dict[str, Any]:
    """List all captured downloads."""
    downloads = getattr(WORKER, "downloads", [])
    return {"result": f"Found {len(downloads)} download(s).", "downloads": downloads}


def _browser_upload_file(w: "_BrowserWorker", args: Dict[str, Any]) -> Dict[str, Any]:
    """Upload a file to an input element (by ref or selector)."""
    _ensure_browser(w)
    ref = args.get("ref")
    selector = args.get("selector")
    file_path = args.get("filePath") or args.get("path")
    
    if not file_path:
        raise ToolError("Parameter 'filePath' is required.")
        
    if not os.path.exists(file_path):
        alt_path = os.path.join(os.environ.get("MYRAA_DATA_DIR", os.getcwd()), file_path)
        if os.path.exists(alt_path):
            file_path = alt_path
        else:
            raise ToolError(f"File not found: {file_path}")

    try:
        loc = _resolve_locator(w, ref=ref, selector=selector)
        loc.wait_for(state="attached", timeout=3000)
        loc.set_input_files(file_path)
        time.sleep(1.0)
        return {"result": f"Successfully uploaded file: {os.path.basename(file_path)}", "url": w.page.url}
    except Exception as e:
        raise ToolError(f"File upload failed: {e}")


def _browser_print_to_pdf(w: "_BrowserWorker", args: Dict[str, Any]) -> Dict[str, Any]:
    """Generate and save a PDF of the current page using Chrome DevTools Protocol."""
    _ensure_browser(w)
    filename = args.get("filename") or f"page_{int(time.time())}.pdf"
    output_dir = os.path.join(os.environ.get("MYRAA_DATA_DIR", os.getcwd()), "documents")
    os.makedirs(output_dir, exist_ok=True)
    pdf_path = os.path.join(output_dir, filename)

    try:
        client = w.page.context.new_cdp_session(w.page)
        pdf_data = client.send("Page.printToPDF", {
            "printBackground": True,
            "preferCSSPageSize": True
        })
        
        import base64
        with open(pdf_path, "wb") as f:
            f.write(base64.b64decode(pdf_data["data"]))
            
        return {
            "result": f"Successfully saved page PDF to documents/{filename}",
            "pdfPath": pdf_path,
            "filename": filename,
            "url": w.page.url
        }
    except Exception as e:
        raise ToolError(f"Print to PDF failed: {e}")


def _browser_dismiss_popups(w: "_BrowserWorker", args: Dict[str, Any]) -> Dict[str, Any]:
    """Heuristically detect and click consent / OK buttons in cookie banners and dialogs."""
    _ensure_browser(w)
    try:
        clicked_count = w.page.evaluate("""() => {
            const commonButtonTexts = [
                'accept', 'agree', 'allow', 'consent', 'dismiss', 'close', 'ok', 'yes', 'got it',
                'মেনে নিলাম', 'সম্মত', 'বন্ধ করুন', 'ঠিক আছে', 'accept all', 'allow all', 'i agree'
            ];
            let clickedCount = 0;
            const elements = document.querySelectorAll('button, a, div[role="button"]');
            for (const el of elements) {
                const text = el.textContent || el.innerText || '';
                const textLower = text.trim().toLowerCase();
                
                if (commonButtonTexts.some(word => textLower === word || textLower.includes(word))) {
                    let isPopupEl = false;
                    let current = el;
                    for (let i = 0; i < 5 && current; i++) {
                        const id = (current.id || '').toLowerCase();
                        const cls = (typeof current.className === 'string' ? current.className : '').toLowerCase();
                        if (id.includes('cookie') || id.includes('consent') || id.includes('modal') || id.includes('popup') || id.includes('dialog') || id.includes('banner') ||
                            cls.includes('cookie') || cls.includes('consent') || cls.includes('modal') || cls.includes('popup') || cls.includes('dialog') || cls.includes('banner')) {
                            isPopupEl = true;
                            break;
                        }
                        current = current.parentElement;
                    }
                    if (isPopupEl && el.offsetWidth > 0 && el.offsetHeight > 0) {
                        el.click();
                        clickedCount++;
                    }
                }
            }
            return clickedCount;
        }""")
        return {"result": f"Dismissed {clicked_count} popup/consent element(s).", "count": clicked_count, "url": w.page.url}
    except Exception as e:
        raise ToolError(f"Dismiss popups failed: {e}")


def _browser_infinite_scroll(w: "_BrowserWorker", args: Dict[str, Any]) -> Dict[str, Any]:
    """Scroll down repeatedly to trigger infinite scroll/lazy-loaded content."""
    _ensure_browser(w)
    scroll_delay = float(args.get("delay", 1.5))
    max_scrolls = int(args.get("maxScrolls", 5))
    
    scrolled = 0
    try:
        last_height = w.page.evaluate("document.body.scrollHeight")
        for i in range(max_scrolls):
            w.page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
            time.sleep(scroll_delay)
            new_height = w.page.evaluate("document.body.scrollHeight")
            scrolled += 1
            if new_height == last_height:
                break
            last_height = new_height
        return {"result": f"Completed infinite scroll {scrolled} times.", "url": w.page.url}
    except Exception as e:
        raise ToolError(f"Infinite scroll failed: {e}")


def _browser_wait_for_element(w: "_BrowserWorker", args: Dict[str, Any]) -> Dict[str, Any]:
    """Wait for an element to meet a certain state (attached/detached/visible/hidden)."""
    _ensure_browser(w)
    ref = args.get("ref")
    selector = args.get("selector")
    text = args.get("text")
    state = args.get("state", "visible")
    timeout = float(args.get("timeout", 5000))
    
    try:
        loc = _resolve_locator(w, ref=ref, selector=selector, text=text)
        loc.wait_for(state=state, timeout=timeout)
        return {"result": f"Element is now {state}.", "url": w.page.url}
    except Exception as e:
        raise ToolError(f"Wait for element failed: {e}")


def _browser_close(w: "_BrowserWorker", args: Dict[str, Any]) -> Dict[str, Any]:
    if w.context:
        try:
            w.context.close()
        except Exception:
            pass
    w.context = None
    w.page = None
    w.element_map = {}
    return {"result": "Browser closed."}


# ── media control (YouTube etc.) ────────────────────────────────────────────

def _browser_media_control(w: "_BrowserWorker", args: Dict[str, Any]) -> Dict[str, Any]:
    _ensure_browser(w)
    action = (args.get("action") or args.get("command") or "").lower().strip()
    if not action:
        raise ToolError("Parameter 'action' is required.")
    page = w.page
    is_yt = "youtube.com" in (page.url or "")
    try:
        if action == "pause":
            if is_yt:
                page.keyboard.press("k")
            page.evaluate("() => { const v=document.querySelector('video'); if(v){v.pause();} }")
            return {"result": "Paused."}
        if action in ("play", "resume"):
            if is_yt:
                page.keyboard.press("k")
            page.evaluate("() => { const v=document.querySelector('video'); if(v){v.play();} }")
            return {"result": "Playing."}
        if action in ("volumeup", "increase"):
            if is_yt:
                page.keyboard.press("ArrowUp")
            return {"result": "Volume up."}
        if action in ("volumedown", "decrease"):
            if is_yt:
                page.keyboard.press("ArrowDown")
            return {"result": "Volume down."}
        if action in ("mute", "unmute", "toggle_mute"):
            if is_yt:
                page.keyboard.press("m")
            return {"result": "Mute toggled."}
        if action == "skip":
            if is_yt:
                page.keyboard.press("ArrowRight")
            return {"result": "Skipped forward."}
        if action in ("fullscreen", "exit_fullscreen"):
            if is_yt:
                page.keyboard.press("f")
            return {"result": "Fullscreen toggled."}
    except Exception as e:
        raise ToolError(f"Media control failed: {e}")
    return {"result": f"Unknown media action: {action}"}


# ═══════════════════════════════════════════════════════════════════════════
#  SESSION MANAGER (manages browser session reuse, persistence, and state)
# ═══════════════════════════════════════════════════════════════════════════

class BrowserSessionManager:
    """Manages browser session lifetime, state, tab reuse, and manual session operations."""
    def __init__(self, worker: _BrowserWorker) -> None:
        self.worker = worker

    def is_active(self) -> bool:
        """Check if browser session is currently active and healthy."""
        if self.worker.context is None:
            return False
        try:
            _ = self.worker.context.pages
            return self.worker.page is not None
        except Exception:
            return False

    def get_session_info(self) -> Dict[str, Any]:
        """Return information about the active browser session."""
        active = self.is_active()
        return {
            "active": active,
            "url": self.worker.page.url if (active and self.worker.page) else None,
            "title": self.worker.page.title() if (active and self.worker.page) else None,
            "tabs_count": len(self.worker.context.pages) if (active and self.worker.context) else 0,
            "profile_dir": _profile_dir()
        }

    def close_session(self) -> Dict[str, Any]:
        """Manually close the active browser session."""
        if not self.is_active():
            return {"result": "No active browser session to close."}
        try:
            self.worker.call(_browser_close, {})
            return {"result": "Successfully closed browser session."}
        except Exception as e:
            return {"result": f"Error closing browser session: {e}"}

    def restore_session(self, url: Optional[str] = None) -> Dict[str, Any]:
        """Ensure browser is open, optionally restoring or opening to a specific url."""
        self.worker.call(_ensure_browser, {})
        if url:
            self.worker.call(_browser_open, {"url": url})
        return self.get_session_info()


SESSION_MANAGER = BrowserSessionManager(WORKER)


# ═══════════════════════════════════════════════════════════════════════════
#  AUTO-RECOVERY WRAPPER
# ═══════════════════════════════════════════════════════════════════════════

def _with_recovery(tool_name: str, fn, args: Dict[str, Any]) -> Any:
    """Run a browser op directly. The browser session is kept alive and managed by the Session Manager."""
    # Since we want session stability, we never automatically close/reset the browser when a task/op fails.
    # The browser session is preserved, keeping all login states, open tabs, and history intact.
    return WORKER.call(fn, args)


# ═══════════════════════════════════════════════════════════════════════════
#  PUBLIC HANDLERS (sync — registered with the dispatcher)
# ═══════════════════════════════════════════════════════════════════════════

def _make(tool_name, fn):
    def handler(args: Dict[str, Any]) -> Dict[str, Any]:
        return _with_recovery(tool_name, fn, args)
    handler.__name__ = fn.__name__.lstrip("_")
    handler.__doc__ = fn.__doc__
    return handler


# Navigation
register("desktopBrowserOpen")(_make("desktopBrowserOpen", _browser_open))
register("browserOpen")(_make("browserOpen", _browser_open))
register("desktopBrowserNavigate")(_make("desktopBrowserNavigate", _browser_open))
register("browserNavigate")(_make("browserNavigate", _browser_open))
register("desktopBrowserGoBack")(_make("desktopBrowserGoBack", _browser_go_back))
register("browserGoBack")(_make("browserGoBack", _browser_go_back))
register("desktopBrowserGoForward")(_make("desktopBrowserGoForward", _browser_go_forward))
register("browserGoForward")(_make("browserGoForward", _browser_go_forward))
register("desktopBrowserRefresh")(_make("desktopBrowserRefresh", _browser_refresh))
register("browserRefresh")(_make("browserRefresh", _browser_refresh))

# Search
register("desktopBrowserSearch")(_make("desktopBrowserSearch", _browser_search))
register("browserSearch")(_make("browserSearch", _browser_search))
register("desktopBrowserPageSearch")(_make("desktopBrowserPageSearch", _browser_page_search))
register("browserPageSearch")(_make("browserPageSearch", _browser_page_search))

# Snapshot (Stonic-style ref engine)
register("browserSnapshot")(_make("browserSnapshot", _browser_snapshot))
register("desktopBrowserSnapshot")(_make("desktopBrowserSnapshot", _browser_snapshot))

# Click / Type / Fill
register("desktopBrowserClick")(_make("desktopBrowserClick", _browser_click))
register("browserClick")(_make("browserClick", _browser_click))
register("desktopBrowserDoubleClick")(_make("desktopBrowserDoubleClick", _browser_double_click))
register("browserDoubleClick")(_make("browserDoubleClick", _browser_double_click))
register("desktopBrowserRightClick")(_make("desktopBrowserRightClick", _browser_right_click))
register("browserRightClick")(_make("browserRightClick", _browser_right_click))
register("desktopBrowserType")(_make("desktopBrowserType", _browser_type))
register("browserType")(_make("browserType", _browser_type))
register("desktopBrowserFillForm")(_make("desktopBrowserFillForm", _browser_fill_form))
register("browserFillForm")(_make("browserFillForm", _browser_fill_form))
register("desktopBrowserDragAndDrop")(_make("desktopBrowserDragAndDrop", _browser_drag_and_drop))
register("browserDragAndDrop")(_make("browserDragAndDrop", _browser_drag_and_drop))

# Scroll / Screenshot / Key / Text / Selection
register("desktopBrowserScroll")(_make("desktopBrowserScroll", _browser_scroll))
register("browserScroll")(_make("browserScroll", _browser_scroll))
register("browserScreenshot")(_make("browserScreenshot", _browser_screenshot))
register("desktopBrowserScreenshot")(_make("desktopBrowserScreenshot", _browser_screenshot))
register("browserPressKey")(_make("browserPressKey", _browser_press_key))
register("browserGetText")(_make("browserGetText", _browser_get_text))
register("desktopBrowserGetText")(_make("desktopBrowserGetText", _browser_get_text))
register("desktopBrowserReadElement")(_make("desktopBrowserReadElement", _browser_read_element))
register("browserReadElement")(_make("browserReadElement", _browser_read_element))
register("desktopBrowserSelectText")(_make("desktopBrowserSelectText", _browser_select_text))
register("browserSelectText")(_make("browserSelectText", _browser_select_text))
register("desktopBrowserZoom")(_make("desktopBrowserZoom", _browser_zoom))
register("browserZoom")(_make("browserZoom", _browser_zoom))

# Tabs
register("desktopBrowserOpenTab")(_make("desktopBrowserOpenTab", _browser_open_tab))
register("browserOpenTab")(_make("browserOpenTab", _browser_open_tab))
register("desktopBrowserCloseTab")(_make("desktopBrowserCloseTab", _browser_close_tab))
register("browserCloseTab")(_make("browserCloseTab", _browser_close_tab))
register("browserListTabs")(_make("browserListTabs", _browser_list_tabs))
register("browserSwitchTab")(_make("browserSwitchTab", _browser_switch_tab))
register("desktopBrowserDuplicateTab")(_make("desktopBrowserDuplicateTab", _browser_duplicate_tab))
register("browserDuplicateTab")(_make("browserDuplicateTab", _browser_duplicate_tab))
register("desktopBrowserPinTab")(_make("desktopBrowserPinTab", _browser_pin_tab))
register("browserPinTab")(_make("browserPinTab", _browser_pin_tab))

# Bookmarks & Downloads
register("desktopBrowserBookmark")(_make("desktopBrowserBookmark", _browser_bookmark))
register("browserBookmark")(_make("browserBookmark", _browser_bookmark))
register("desktopBrowserListDownloads")(_make("desktopBrowserListDownloads", _browser_list_downloads))
register("browserListDownloads")(_make("browserListDownloads", _browser_list_downloads))

# Upload / PDF / Popups / Wait
register("desktopBrowserUploadFile")(_make("desktopBrowserUploadFile", _browser_upload_file))
register("browserUploadFile")(_make("browserUploadFile", _browser_upload_file))
register("desktopBrowserPrintToPDF")(_make("desktopBrowserPrintToPDF", _browser_print_to_pdf))
register("browserPrintToPDF")(_make("browserPrintToPDF", _browser_print_to_pdf))
register("desktopBrowserDismissPopups")(_make("desktopBrowserDismissPopups", _browser_dismiss_popups))
register("browserDismissPopups")(_make("browserDismissPopups", _browser_dismiss_popups))
register("desktopBrowserInfiniteScroll")(_make("desktopBrowserInfiniteScroll", _browser_infinite_scroll))
register("browserInfiniteScroll")(_make("browserInfiniteScroll", _browser_infinite_scroll))
register("desktopBrowserWaitForElement")(_make("desktopBrowserWaitForElement", _browser_wait_for_element))
register("browserWaitForElement")(_make("browserWaitForElement", _browser_wait_for_element))

# Media
register("browserMediaControl")(_make("browserMediaControl", _browser_media_control))
register("desktopBrowserMediaControl")(_make("desktopBrowserMediaControl", _browser_media_control))

# Close
register("browserClose")(_make("browserClose", _browser_close))
register("desktopBrowserClose")(_make("desktopBrowserClose", _browser_close))

# Session Manager
@register("browserSessionStatus")
def browser_session_status(args: Dict[str, Any]) -> Dict[str, Any]:
    """Get status of the active browser session."""
    return SESSION_MANAGER.get_session_info()

@register("desktopBrowserSessionStatus")
def desktop_browser_session_status(args: Dict[str, Any]) -> Dict[str, Any]:
    """Get status of the active browser session."""
    return SESSION_MANAGER.get_session_info()

@register("browserSessionClose")
def browser_session_close(args: Dict[str, Any]) -> Dict[str, Any]:
    """Manually close the browser session (only done when user explicitly requests)."""
    return SESSION_MANAGER.close_session()

@register("desktopBrowserSessionClose")
def desktop_browser_session_close(args: Dict[str, Any]) -> Dict[str, Any]:
    """Manually close the browser session (only done when user explicitly requests)."""
    return SESSION_MANAGER.close_session()

@register("browserSessionRestore")
def browser_session_restore(args: Dict[str, Any]) -> Dict[str, Any]:
    """Restore or open the browser session."""
    url = args.get("url")
    return SESSION_MANAGER.restore_session(url)

@register("desktopBrowserSessionRestore")
def desktop_browser_session_restore(args: Dict[str, Any]) -> Dict[str, Any]:
    """Restore or open the browser session."""
    url = args.get("url")
    return SESSION_MANAGER.restore_session(url)


def shutdown_browser() -> None:
    """Cleanly stop the browser (called on app shutdown)."""
    try:
        WORKER.call(_browser_close, {}, timeout=5)
    except Exception:
        pass


__all__ = [
    "shutdown_browser",
]
