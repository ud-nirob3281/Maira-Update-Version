"""
Snapshot cache, lifecycle management, and screen change detection.
Tracks and invalidates snapshots/screenshots based on time and UI changes.
"""

from __future__ import annotations

import hashlib
import json
import logging
import time
import uuid
import os
import platform
from typing import Any, Dict, List, Optional, Tuple

from .registry import ToolError, register

log = logging.getLogger("myraa.snapshot_manager")


class SnapshotCacheManager:
    def __init__(self) -> None:
        self.snapshot_id: str = ""
        self.timestamp: float = 0.0
        self.expiration_time: float = 1.0  # 1.0 second expiration time
        
        # State signatures
        self.screen_hash: str = ""
        self.window_title: str = ""
        self.url: str = ""
        self.dom_hash: str = ""
        self.ocr_hash: str = ""
        self.uia_hash: str = ""
        
        # Cached payloads
        self.cached_aria_snapshot: Optional[Dict[str, Any]] = None
        self.cached_screenshot: Optional[Dict[str, Any]] = None
        self.cached_ocr_result: Optional[Dict[str, Any]] = None
        self.cached_read_screen: Optional[Dict[str, Any]] = None

    def invalidate(self) -> None:
        """Manually invalidate all cached snapshots and screenshots."""
        self.snapshot_id = ""
        self.timestamp = 0.0
        self.screen_hash = ""
        self.window_title = ""
        self.url = ""
        self.dom_hash = ""
        self.ocr_hash = ""
        self.uia_hash = ""
        self.cached_aria_snapshot = None
        self.cached_screenshot = None
        self.cached_ocr_result = None
        self.cached_read_screen = None
        log.info("Snapshot Cache invalidated.")

    def compute_uia_hash(self) -> str:
        """Get structural representation of all visible windows and return its MD5 hash."""
        if platform.system() != "Windows":
            return ""
        try:
            import win32gui
            windows = []
            def cb(hwnd, _):
                if win32gui.IsWindowVisible(hwnd):
                    title = win32gui.GetWindowText(hwnd)
                    if title:
                        try:
                            rect = win32gui.GetWindowRect(hwnd)
                            windows.append((hwnd, title, rect))
                        except Exception:
                            pass
                return True
            win32gui.EnumWindows(cb, None)
            windows_str = json.dumps(windows, sort_keys=True)
            return hashlib.md5(windows_str.encode("utf-8")).hexdigest()
        except Exception as e:
            log.warning("Failed to compute UIA hash: %s", e)
            return ""

    def get_active_window_title(self) -> str:
        if platform.system() != "Windows":
            return ""
        try:
            import win32gui
            hwnd = win32gui.GetForegroundWindow()
            return win32gui.GetWindowText(hwnd) if hwnd else ""
        except Exception:
            return ""

    def get_browser_url(self, worker: Any) -> str:
        if worker and hasattr(worker, "page") and worker.page:
            try:
                return worker.page.url
            except Exception:
                pass
        return ""

    def get_dom_hash(self, worker: Any) -> str:
        if worker and hasattr(worker, "page") and worker.page:
            try:
                content = worker.page.content()
                return hashlib.md5(content.encode("utf-8")).hexdigest()
            except Exception:
                pass
        return ""

    def compute_screen_hash(self, img: Any) -> str:
        try:
            # Resize to small grayscale image to be fast and tolerate minor artifacts
            small = img.resize((128, 128)).convert("L")
            return hashlib.md5(small.tobytes()).hexdigest()
        except Exception as e:
            log.warning("Failed to compute screen hash: %s", e)
            return ""

    def is_expired(self) -> bool:
        """Check if the cache has expired based on time (1 second)."""
        if not self.snapshot_id or self.timestamp == 0.0:
            return True
        return (time.time() - self.timestamp) > self.expiration_time

    def detect_screen_change(self, worker: Any, current_img: Optional[Any] = None) -> bool:
        """Detect if the screen state has changed compared to the cached state.
        
        Evaluates Screen Hash, Window Title, URL, DOM State, and UIA Tree.
        """
        if not self.snapshot_id:
            return True
            
        # 1. Window Title Change
        new_title = self.get_active_window_title()
        if new_title != self.window_title:
            log.info("Screen change detected: Window title changed from '%s' to '%s'", self.window_title, new_title)
            return True
            
        # 2. URL Change
        new_url = self.get_browser_url(worker)
        if new_url != self.url:
            log.info("Screen change detected: Browser URL changed from '%s' to '%s'", self.url, new_url)
            return True
            
        # 3. UIA Tree / Window Layout Change
        new_uia = self.compute_uia_hash()
        if new_uia != self.uia_hash:
            log.info("Screen change detected: UIA window layout changed.")
            return True
            
        # 4. DOM Change
        if worker and hasattr(worker, "page") and worker.page:
            new_dom = self.get_dom_hash(worker)
            if new_dom != self.dom_hash:
                log.info("Screen change detected: DOM content changed.")
                return True

        # 5. Physical Screen Hash Change
        if current_img:
            new_screen_hash = self.compute_screen_hash(current_img)
            if new_screen_hash != self.screen_hash:
                log.info("Screen change detected: Physical screen hash changed.")
                return True
                
        return False

    def check_and_update_state(self, worker: Any, current_img: Optional[Any] = None) -> bool:
        """Check if cached state is valid. If not, refresh signatures and return False.
        
        If valid, returns True.
        """
        if self.is_expired():
            log.info("Cache expired by time limit.")
            self.invalidate()
            return False
            
        if self.detect_screen_change(worker, current_img):
            self.invalidate()
            return False
            
        return True

    def populate_cache(self, worker: Any, current_img: Optional[Any], aria_snapshot: Optional[Dict[str, Any]] = None, screenshot_data: Optional[Dict[str, Any]] = None, ocr_result: Optional[Dict[str, Any]] = None, read_screen_data: Optional[Dict[str, Any]] = None) -> None:
        """Cache the outputs and snapshot state signatures."""
        self.snapshot_id = str(uuid.uuid4())
        self.timestamp = time.time()
        
        # Populate signatures
        self.window_title = self.get_active_window_title()
        self.url = self.get_browser_url(worker)
        self.dom_hash = self.get_dom_hash(worker)
        self.uia_hash = self.compute_uia_hash()
        
        if current_img:
            self.screen_hash = self.compute_screen_hash(current_img)
        
        # Populate actual cached results
        if aria_snapshot is not None:
            self.cached_aria_snapshot = aria_snapshot
        if screenshot_data is not None:
            self.cached_screenshot = screenshot_data
        if ocr_result is not None:
            self.cached_ocr_result = ocr_result
        if read_screen_data is not None:
            self.cached_read_screen = read_screen_data
            
        log.info("Snapshot cache populated with ID: %s", self.snapshot_id)


# Global Singleton Snapshot Cache Manager
SNAPSHOT_CACHE = SnapshotCacheManager()


def is_browser_page_loading(worker: Any) -> bool:
    """Helper to detect if the active browser page is currently loading or blank."""
    if not worker or not hasattr(worker, "page") or not worker.page:
        return False
    try:
        # Check standard document ready state
        ready_state = worker.page.evaluate("document.readyState")
        if ready_state != "complete":
            return True
            
        # Check for typical loading spinner elements/overlays that are currently visible
        loading_selectors = [
            ".loading-spinner", ".spinner", ".loading", "#loading", 
            ".loader", ".loading-overlay", "[class*='spinner']", "[class*='loading']"
        ]
        for sel in loading_selectors:
            try:
                el = worker.page.locator(sel).first
                if el and el.is_visible():
                    log.info("Loading indicator detected visible: %s", sel)
                    return True
            except Exception:
                pass
                
        # If the page content is completely blank, we consider it loading
        content = worker.page.content()
        if not content or len(content.strip()) < 150:
            log.info("Page is completely blank (content length < 150), considering as loading.")
            return True
            
        return False
    except Exception as e:
        log.warning("Error checking if page is loading: %s", e)
        return False


def wait_for_browser_load(worker: Any, timeout: float = 10.0, check_interval: float = 0.5) -> None:
    """Blocks and waits until the browser page is fully loaded or the timeout is reached."""
    if not worker or not hasattr(worker, "page") or not worker.page:
        return
    t_start = time.time()
    while True:
        if not is_browser_page_loading(worker):
            break
        if time.time() - t_start > timeout:
            log.info("Timed out waiting for page to load (%s seconds elapsed). Proceeding anyway.", timeout)
            break
        log.info("Page is currently loading... Waiting %s seconds...", check_interval)
        time.sleep(check_interval)
