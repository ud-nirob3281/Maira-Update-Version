"""
Window management: minimize / maximize / close the active window or switch apps.

Uses win32gui for the foreground window and pygetwindow for title-based lookups,
with graceful degradation if a backend isn't present.
"""

from __future__ import annotations

import platform
import subprocess
import time
from typing import Any, Dict, Optional

from .registry import ToolError, register

SW_MINIMIZE = 6
SW_MAXIMIZE = 3
SW_RESTORE = 9
SW_HIDE = 0


def _get_foreground_window():
    if platform.system() != "Windows":
        return None
    try:
        import win32gui

        hwnd = win32gui.GetForegroundWindow()
        if not hwnd:
            return None
        return hwnd
    except Exception:
        return None


def _window_title(hwnd) -> str:
    try:
        import win32gui

        return win32gui.GetWindowText(hwnd)
    except Exception:
        return ""


def _show_window(hwnd, cmd) -> None:
    try:
        import win32gui

        win32gui.ShowWindow(hwnd, cmd)
    except Exception as e:  # noqa: BLE001
        raise ToolError(f"Could not change window state: {e}")


def _close_window_hwnd(hwnd) -> None:
    try:
        import win32con
        import win32gui

        win32gui.PostMessage(hwnd, win32con.WM_CLOSE, 0, 0)
    except Exception as e:  # noqa: BLE001
        raise ToolError(f"Could not close window: {e}")


def _find_window_by_title(query: str):
    """Return the hwnd of the first window whose title contains query."""
    if platform.system() != "Windows":
        return None
    try:
        import win32gui

        matches = []

        def cb(hwnd, _):
            if win32gui.IsWindowVisible(hwnd):
                title = win32gui.GetWindowText(hwnd)
                if title and query.lower() in title.lower():
                    matches.append(hwnd)
            return True

        win32gui.EnumWindows(cb, None)
        return matches[0] if matches else None
    except Exception:
        return None


def _focus(hwnd) -> None:
    try:
        import win32gui

        win32gui.SetForegroundWindow(hwnd)
    except Exception:
        # Restore first, then try again
        _show_window(hwnd, SW_RESTORE)
        time.sleep(0.1)
        try:
            import win32gui

            win32gui.SetForegroundWindow(hwnd)
        except Exception as e:  # noqa: BLE001
            raise ToolError(f"Could not focus window: {e}")


def _resolve_target(args: Dict[str, Any]):
    """Pick the hwnd to operate on: explicit title, or the foreground window."""
    title: Optional[str] = args.get("title") or args.get("application")
    if title:
        hwnd = _find_window_by_title(str(title))
        if not hwnd:
            raise ToolError(f"No visible window with title containing '{title}'.")
        return hwnd, str(title)
    hwnd = _get_foreground_window()
    if not hwnd:
        raise ToolError("No active window found.")
    return hwnd, _window_title(hwnd)


def _get_window_rect(hwnd) -> Optional[tuple]:
    """Return (left, top, right, bottom) with DPI awareness."""
    try:
        import win32gui
        rect = win32gui.GetWindowRect(hwnd)
        return rect
    except Exception:
        return None


def _get_monitor_info() -> Dict[str, Any]:
    """Return multi-monitor info (all monitors, virtual screen, DPI)."""
    try:
        import ctypes
        user32 = ctypes.windll.user32
        monitors = []
        # EnumDisplayMonitors
        def cb(hmonitor, hdc, rect, data):
            r = rect.contents
            monitors.append({
                "left": r.left, "top": r.top,
                "right": r.right, "bottom": r.bottom,
                "width": r.right - r.left, "height": r.bottom - r.top,
            })
            return True
        import ctypes.wintypes
        MONITORENUMPROC = ctypes.WINFUNCTYPE(
            ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p,
            ctypes.POINTER(ctypes.wintypes.RECT), ctypes.c_double
        )
        if ctypes.windll.user32.EnumDisplayMonitors(0, 0, MONITORENUMPROC(cb), 0):
            pass
        vx = user32.GetSystemMetrics(76)  # SM_XVIRTUALSCREEN
        vy = user32.GetSystemMetrics(77)  # SM_YVIRTUALSCREEN
        vw = user32.GetSystemMetrics(78)  # SM_CXVIRTUALSCREEN
        vh = user32.GetSystemMetrics(79)  # SM_CYVIRTUALSCREEN
        # DPI
        dpi = 96
        try:
            hdc = user32.GetDC(0)
            dpi = ctypes.windll.gdi32.GetDeviceCaps(hdc, 88)
            user32.ReleaseDC(0, hdc)
        except Exception:
            pass
        return {
            "monitors": monitors,
            "virtual_screen": {"x": vx, "y": vy, "width": vw, "height": vh},
            "dpi": dpi,
            "scaling": round(dpi / 96.0, 2),
        }
    except Exception:
        return {"monitors": [], "virtual_screen": {}, "dpi": 96, "scaling": 1.0}


@register("getMonitorInfo")
def get_monitor_info(args: Dict[str, Any]) -> Dict[str, Any]:
    """Get multi-monitor layout info, DPI scaling factor, and virtual screen bounds."""
    info = _get_monitor_info()
    mons = info.get("monitors", [])
    vs = info.get("virtual_screen", {})
    summary_parts = [f"{len(mons)} monitor(s)"]
    for i, m in enumerate(mons):
        summary_parts.append(f"Monitor {i+1}: {m['width']}x{m['height']} at ({m['left']},{m['top']})")
    summary_parts.append(f"DPI: {info['dpi']} ({info['scaling']:.0%} scaling)")
    summary_parts.append(f"Virtual screen: {vs['width']}x{vs['height']} at ({vs.get('x',0)},{vs.get('y',0)})")
    return {
        "result": ". ".join(summary_parts) + ".",
        "monitors": mons,
        "virtual_screen": vs,
        "dpi": info["dpi"],
        "scaling": info["scaling"],
    }


@register("getActiveWindowInfo")
def get_active_window_info(args: Dict[str, Any]) -> Dict[str, Any]:
    """Get detailed info about the active window: title, rect, process, monitor."""
    hwnd = _get_foreground_window()
    if not hwnd:
        raise ToolError("No active window found.")
    title = _window_title(hwnd)
    rect = _get_window_rect(hwnd)
    process_name = ""
    try:
        import ctypes
        class DWORD(ctypes.Structure):
            _fields_ = [("value", ctypes.c_ulong)]
        pid = DWORD()
        ctypes.windll.user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        import psutil
        proc = psutil.Process(pid.value)
        process_name = proc.name()
    except Exception:
        pass
    mon_info = _get_monitor_info()
    result = {
        "result": f"Active window: '{title}' ({process_name})",
        "title": title,
        "process": process_name,
        "rect": {"left": rect[0], "top": rect[1], "right": rect[2], "bottom": rect[3]} if rect else None,
        "dpi_scaling": mon_info.get("scaling", 1.0),
    }
    if rect:
        result["width"] = rect[2] - rect[0]
        result["height"] = rect[3] - rect[1]
    return result


@register("minimizeWindow")
def minimize_window(args: Dict[str, Any]) -> Dict[str, Any]:
    hwnd, title = _resolve_target(args)
    _show_window(hwnd, SW_MINIMIZE)
    return {"result": f"Minimized window: {title or 'active window'}."}


@register("maximizeWindow")
def maximize_window(args: Dict[str, Any]) -> Dict[str, Any]:
    hwnd, title = _resolve_target(args)
    _show_window(hwnd, SW_MAXIMIZE)
    return {"result": f"Maximized window: {title or 'active window'}."}


@register("closeWindow")
def close_window(args: Dict[str, Any]) -> Dict[str, Any]:
    hwnd, title = _resolve_target(args)
    _close_window_hwnd(hwnd)
    return {"result": f"Closed window: {title or 'active window'}."}


@register("switchApplication")
def switch_application(args: Dict[str, Any]) -> Dict[str, Any]:
    """Focus a window by title, or cycle windows (Alt+Tab) if no title given."""
    title = args.get("title") or args.get("application")
    if title:
        hwnd = _find_window_by_title(str(title))
        if not hwnd:
            raise ToolError(f"No visible window matching '{title}'.")
        _show_window(hwnd, SW_RESTORE)
        _focus(hwnd)
        return {"result": f"Switched to: {str(title)}."}

    # No specific title -> Alt+Tab cycle.
    try:
        import pyautogui

        pyautogui.hotkey("alt", "tab")
        return {"result": "Cycled to the next window."}
    except Exception:
        # Fallback: cycle by enumerating windows and focusing the next one.
        if platform.system() == "Windows":
            try:
                import win32gui

                order = []

                def cb(hwnd, _):
                    if win32gui.IsWindowVisible(hwnd) and win32gui.GetWindowText(hwnd):
                        order.append(hwnd)
                    return True

                win32gui.EnumWindows(cb, None)
                fg = win32gui.GetForegroundWindow()
                if order:
                    idx = order.index(fg) if fg in order else -1
                    nxt = order[(idx + 1) % len(order)]
                    _focus(nxt)
                    return {"result": f"Switched to: {win32gui.GetWindowText(nxt)}."}
            except Exception:
                pass
        raise ToolError("Could not switch applications.")


__all__ = [
    "minimize_window",
    "maximize_window",
    "close_window",
    "switch_application",
]
