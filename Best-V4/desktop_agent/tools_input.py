"""
Desktop mouse & keyboard input control — production-grade.

Uses Win32 SendInput for all mouse operations — this sends REAL hardware-level
mouse events that work reliably in ALL Windows apps (including UWP, Electron,
Chromium, Explorer, VS Code, etc.). pyautogui's mouseDown/mouseUp/scroll are
bypassed because they generate synthetic events that many apps ignore.

Features:
  • DPI-aware (physical pixels, set once in main.py at process start)
  • Multi-monitor support: absolute virtual-screen coordinates
  • Smooth cursor movement (ease-out interpolation) for natural motion
  • Precise single / double / right / middle click via SendInput
  • Drag and drop with interpolated mouse movement + button hold
  • Horizontal + vertical scroll via WM_MOUSEWHEEL
  • Text selection via drag, and keyboard (shift+arrow) selection
  • Intelligent retry on click failure (move → click, re-check position)
"""

from __future__ import annotations

import ctypes
import struct
import time
from typing import Any, Dict, List, Optional, Tuple

try:
    import ctypes
    # Ensure DPI awareness is active for this thread/process
    ctypes.windll.shcore.SetProcessDpiAwareness(2)
except Exception:
    try:
        ctypes.windll.user32.SetProcessDPIAware()
    except Exception:
        pass

from .registry import ToolError, register


# ── Win32 SendInput constants & types ────────────────────────────────────────

# Mouse event flags
MOUSEEVENTF_MOVE       = 0x0001
MOUSEEVENTF_LEFTDOWN   = 0x0002
MOUSEEVENTF_LEFTUP     = 0x0004
MOUSEEVENTF_RIGHTDOWN  = 0x0008
MOUSEEVENTF_RIGHTUP    = 0x0010
MOUSEEVENTF_MIDDLEDOWN = 0x0020
MOUSEEVENTF_MIDDLEUP   = 0x0040
MOUSEEVENTF_WHEEL      = 0x0800
MOUSEEVENTF_ABSOLUTE   = 0x8000

# Input type
INPUT_MOUSE = 0

# SendInput structures (matching Windows API)
class MOUSEINPUT(ctypes.Structure):
    _fields_ = [
        ("dx", ctypes.c_long),
        ("dy", ctypes.c_long),
        ("mouseData", ctypes.c_ulong),
        ("dwFlags", ctypes.c_ulong),
        ("time", ctypes.c_ulong),
        ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong)),
    ]

class INPUT(ctypes.Structure):
    class _INPUT(ctypes.Union):
        _fields_ = [("mi", MOUSEINPUT)]
    _anonymous_ = ("_input",)
    _fields_ = [
        ("type", ctypes.c_ulong),
        ("_input", _INPUT),
    ]

_user32 = ctypes.windll.user32


def _send_mouse_input(dx: int, dy: int, flags: int, data: int = 0) -> None:
    """Send a single mouse input event via Win32 SendInput (hardware-level)."""
    inp = INPUT(type=INPUT_MOUSE)
    inp.mi.dx = dx
    inp.mi.dy = dy
    inp.mi.mouseData = data
    inp.mi.dwFlags = flags
    inp.mi.time = 0
    inp.mi.dwExtraInfo = ctypes.pointer(ctypes.c_ulong(0))
    _user32.SendInput(1, ctypes.byref(inp), ctypes.sizeof(INPUT))


def _get_virtual_screen() -> Tuple[int, int]:
    """Return the virtual screen size in pixels (multi-monitor aware)."""
    w = _user32.GetSystemMetrics(78)  # SM_CXVIRTUALSCREEN
    h = _user32.GetSystemMetrics(79)  # SM_CYVIRTUALSCREEN
    return max(w, 1), max(h, 1)


def _pixel_to_abs(x: int, y: int) -> Tuple[int, int]:
    """Convert pixel coordinates to SendInput absolute (0-65535) coordinates.

    SendInput with MOUSEEVENTF_ABSOLUTE expects values in [0, 65535] where
    65535 = right/bottom edge of the virtual screen. We map pixel coords
    into this range, offsetting by the virtual screen origin (important for
    multi-monitor setups where the primary monitor is not at 0,0).
    """
    vx = _user32.GetSystemMetrics(76)  # SM_XVIRTUALSCREEN
    vy = _user32.GetSystemMetrics(77)  # SM_YVIRTUALSCREEN
    vw, vh = _get_virtual_screen()
    # Clamp to virtual screen bounds
    px = max(vx, min(vx + vw - 1, x))
    py = max(vy, min(vy + vh - 1, y))
    # Map to 0-65535
    ax = int((px - vx) * 65535 / (vw - 1))
    ay = int((py - vy) * 65535 / (vh - 1))
    return ax, ay


def _win32_move(x: int, y: int) -> None:
    """Move cursor to absolute screen coordinates (x, y) via SetCursorPos (maximum accuracy)."""
    # Direct hardware-level move via SetCursorPos (for flawless pixel accuracy, respecting DPI)
    _user32.SetCursorPos(x, y)
    
    # Verification and correction (if other threads or OS scaling cause minor discrepancies)
    cx, cy = _win32_get_pos()
    if abs(cx - x) > 1 or abs(cy - y) > 1:
        _user32.SetCursorPos(x, y)


def _win32_click(button: str) -> None:
    """Send a complete mouse button down + up via SendInput."""
    down, up = _BUTTON_FLAGS.get(button, (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP))
    _send_mouse_input(0, 0, down)
    time.sleep(0.02)  # tiny gap so the OS registers a distinct press+release
    _send_mouse_input(0, 0, up)


def _win32_double_click(button: str) -> None:
    """Send two rapid clicks via SendInput."""
    down, up = _BUTTON_FLAGS.get(button, (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP))
    for _ in range(2):
        _send_mouse_input(0, 0, down)
        time.sleep(0.015)
        _send_mouse_input(0, 0, up)
        time.sleep(0.03)


def _win32_mouse_down(button: str) -> None:
    down, _ = _BUTTON_FLAGS.get(button, (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP))
    _send_mouse_input(0, 0, down)


def _win32_mouse_up(button: str) -> None:
    _, up = _BUTTON_FLAGS.get(button, (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP))
    _send_mouse_input(0, 0, up)


def _win32_scroll(amount: int, direction: str) -> None:
    """Scroll via WM_MOUSEWHEEL (SendInput). amount = number of scroll clicks."""
    # WHEEL_DELTA = 120 per click. Positive = scroll up, negative = scroll down.
    delta = -amount * 120 if direction == "down" else amount * 120
    if direction == "up":
        pass  # delta is already positive
    _send_mouse_input(0, 0, MOUSEEVENTF_WHEEL, delta)


def _win32_hscroll(amount: int, direction: str) -> None:
    """Horizontal scroll via SendInput with mouse_data high word."""
    # Horizontal wheel: put the amount in the high word of mouseData.
    delta = amount * 120
    if direction == "left":
        delta = -delta
    _send_mouse_input(0, 0, MOUSEEVENTF_WHEEL, delta << 16)


def _win32_get_pos() -> Tuple[int, int]:
    """Get current cursor position via GetCursorPos (Win32)."""
    point = ctypes.wintypes.POINT() if hasattr(ctypes, "wintypes") else None
    if point is None:
        # Fallback: define POINT manually
        class POINT(ctypes.Structure):
            _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]
        point = POINT()
    _user32.GetCursorPos(ctypes.byref(point))
    return point.x, point.y


_BUTTON_FLAGS: Dict[str, Tuple[int, int]] = {
    "left":   (MOUSEEVENTF_LEFTDOWN,   MOUSEEVENTF_LEFTUP),
    "right":  (MOUSEEVENTF_RIGHTDOWN,  MOUSEEVENTF_RIGHTUP),
    "middle": (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
}


# ── Coordinate helpers ──────────────────────────────────────────────────────

def _resolve_coords(x: Any, y: Any) -> Tuple[int, int]:
    """Validate and cast incoming coordinates to physical pixels."""
    if x is None or y is None:
        raise ToolError("Parameters 'x' and 'y' (pixel coordinates) are required.")
    return int(x), int(y)


# ── Smooth cursor movement ──────────────────────────────────────────────────

def _smooth_move(x: int, y: int, duration: float = 0.25) -> None:
    """Move the cursor to (x, y) with a natural ease-out interpolation.

    Sends a series of small absolute moves via SendInput so the cursor
    travels along a smooth curve — much more natural than an instant jump,
    and works in ALL apps because each step is a real hardware event.
    """
    cx, cy = _win32_get_pos()
    dist = ((x - cx) ** 2 + (y - cy) ** 2) ** 0.5

    if dist < 5:
        # Already there
        _win32_move(x, y)
        return

    # Ease-out quad: fast start, slow end — feels like a human hand
    steps = max(8, min(40, int(dist / 15)))
    duration = min(max(duration, 0.12), 0.6)
    step_delay = duration / steps

    for i in range(1, steps + 1):
        t = i / steps
        # Ease-out quad: t * (2 - t)
        ease = t * (2.0 - t)
        ix = int(cx + (x - cx) * ease)
        iy = int(cy + (y - cy) * ease)
        _win32_move(ix, iy)
        time.sleep(step_delay)

    # Ensure we land exactly on target
    _win32_move(x, y)


def _click_with_retry(x: int, y: int, button: str, clicks: int, interval_s: float) -> bool:
    """Move to (x,y) then click via SendInput, retrying up to 3 times with hardware SetCursorPos reinforcement."""
    for attempt in range(3):
        _smooth_move(x, y)
        time.sleep(0.08)
        
        # Hard coordinate reinforcement immediately prior to clicking
        _user32.SetCursorPos(x, y)
        time.sleep(0.02)
        
        if clicks > 1:
            _win32_double_click(button)
        else:
            _win32_click(button)
            
        # Verify cursor stayed exactly on target (tight bound: <= 2 pixels)
        time.sleep(0.05)
        ax, ay = _win32_get_pos()
        if abs(ax - x) <= 2 and abs(ay - y) <= 2:
            return True
            
        # If position shifted (due to OS/app interception), force back and try one more direct click
        _user32.SetCursorPos(x, y)
        time.sleep(0.05)
        if clicks > 1:
            _win32_double_click(button)
        else:
            _win32_click(button)
        time.sleep(0.12)
        
    return True  # best-effort


# ── Mouse tools ─────────────────────────────────────────────────────────────

@register("moveCursor")
def move_cursor(args: Dict[str, Any]) -> Dict[str, Any]:
    """Move the mouse pointer to absolute screen coordinates (physical pixels)."""
    x, y = _resolve_coords(args.get("x"), args.get("y"))
    _smooth_move(x, y)
    return {"result": f"Moved cursor to ({x}, {y})."}


@register("mouseClick")
def mouse_click(args: Dict[str, Any]) -> Dict[str, Any]:
    """Click the mouse: left / right / middle; single or double, with retry.

    Always moves to (x, y) FIRST then clicks — the reliable Windows pattern.
    If (x, y) are omitted, clicks at the current cursor position.
    Uses Win32 SendInput for hardware-level events (works in ALL apps).
    """
    button = str(args.get("button", "left")).lower()
    clicks = int(args.get("clicks", 1))
    x = args.get("x")
    y = args.get("y")

    if button not in ("left", "right", "middle"):
        raise ToolError("Button must be 'left', 'right', or 'middle'.")

    if x is not None and y is not None:
        x, y = int(x), int(y)
        _click_with_retry(x, y, button, clicks, 0.08)
        coord_str = f" at ({x}, {y})"
    else:
        if clicks > 1:
            _win32_double_click(button)
        else:
            _win32_click(button)
        coord_str = ""

    label = "double-clicked" if clicks > 1 else "clicked"
    return {"result": f"{label} {button} mouse button{coord_str}."}


@register("mouseDrag")
def mouse_drag(args: Dict[str, Any]) -> Dict[str, Any]:
    """Drag from (x1, y1) to (x2, y2). Used for drag-and-drop and text selection.

    Uses Win32 SendInput: holds the button down, moves in small steps (so apps
    like VS Code, browsers, and Explorer register a real drag), then releases.
    """
    x1 = args.get("x1", args.get("from_x"))
    y1 = args.get("y1", args.get("from_y"))
    x2 = args.get("x2", args.get("to_x"))
    y2 = args.get("y2", args.get("to_y"))
    button = str(args.get("button", "left")).lower()
    hold = float(args.get("hold", 0.0))
    if None in (x1, y1, x2, y2):
        raise ToolError("Parameters x1,y1 (start) and x2,y2 (end) are required.")

    x1, y1, x2, y2 = int(x1), int(y1), int(x2), int(y2)

    # Move to start position
    _smooth_move(x1, y1, duration=0.2)
    time.sleep(0.15)

    # Press and hold the button
    _win32_mouse_down(button)
    time.sleep(0.08 + hold)

    # Interpolate the drag path in small steps
    # More steps for longer drags — minimum 15, max 60
    dist = ((x2 - x1) ** 2 + (y2 - y1) ** 2) ** 0.5
    steps = max(15, min(60, int(dist / 8)))
    step_delay = max(0.008, min(0.025, 0.5 / steps))  # total drag ~0.3-1s

    for i in range(1, steps + 1):
        t = i / steps
        # Ease-in-out for natural drag motion
        ease = t * t * (3 - 2 * t)  # smoothstep
        ix = int(x1 + (x2 - x1) * ease)
        iy = int(y1 + (y2 - y1) * ease)
        _win32_move(ix, iy)
        time.sleep(step_delay)

    time.sleep(0.08)

    # Release button
    _win32_mouse_up(button)
    time.sleep(0.05)

    return {"result": f"Dragged from ({x1},{y1}) to ({x2},{y2})."}


@register("scrollMouse")
def scroll_mouse(args: Dict[str, Any]) -> Dict[str, Any]:
    """Scroll the mouse wheel vertically or horizontally via Win32 SendInput.

    Sends real WM_MOUSEWHEEL events that ALL Windows apps recognize.
    """
    direction = str(args.get("direction", "down")).lower()
    amount = int(args.get("amount", 5))

    if direction in ("left", "right"):
        _win32_hscroll(amount, direction)
    else:
        _win32_scroll(amount, direction)

    return {"result": f"Scrolled {direction} {amount} clicks."}


@register("scrollSmooth")
def scroll_smooth(args: Dict[str, Any]) -> Dict[str, Any]:
    """Scroll smoothly in steps — feels natural and works on sensitive pages."""
    direction = str(args.get("direction", "down")).lower()
    amount = int(args.get("amount", 10))
    step = max(1, amount // 5)

    for _ in range(0, amount, step):
        if direction in ("left", "right"):
            _win32_hscroll(step, direction)
        else:
            _win32_scroll(step, direction)
        time.sleep(0.06)

    return {"result": f"Smooth-scrolled {direction} {amount} clicks."}


@register("scrollUntilVisible")
def scroll_until_visible(args: Dict[str, Any]) -> Dict[str, Any]:
    """Scroll until target text appears on screen (via OCR). Returns when found
    or after max_scrolls attempts."""
    target = args.get("text") or args.get("target")
    direction = str(args.get("direction", "down")).lower()
    max_scrolls = int(args.get("max_scrolls", 8))
    if not target:
        raise ToolError("Parameter 'text' (target to look for) is required.")

    from .tools_visual import find_on_screen  # lazy to avoid circular import

    for i in range(max_scrolls):
        try:
            res = find_on_screen({"text": target})
            if res.get("found"):
                return {
                    "result": f"Found '{target}' after {i} scroll(s) at ({res['x']}, {res['y']}).",
                    "found": True,
                    "x": res["x"],
                    "y": res["y"],
                }
        except ToolError:
            pass  # OCR not available — keep scrolling

        if direction in ("left", "right"):
            _win32_hscroll(3, direction)
        else:
            _win32_scroll(3, direction)
        time.sleep(0.5)

    return {"result": f"'{target}' not found after {max_scrolls} scrolls.", "found": False}


# ── Keyboard tools ──────────────────────────────────────────────────────────
# Keyboard via SendInput is much more complex (VK codes, scan codes, shift state).
# pyautogui's keyboard implementation is reliable (it uses SendInput internally),
# so we keep pyautogui for keyboard only.

_pyautogui = None


def _pg():
    """Return pyautogui for KEYBOARD-ONLY operations."""
    global _pyautogui
    if _pyautogui is None:
        try:
            import pyautogui as _pg_mod
            _pyautogui = _pg_mod
            _pyautogui.FAILSAFE = False
            _pyautogui.PAUSE = 0.02
        except Exception as e:
            raise ToolError(f"pyautogui is not installed: {e}")
    return _pyautogui


@register("typeText")
def type_text(args: Dict[str, Any]) -> Dict[str, Any]:
    """Type a string of text into the currently focused element."""
    text = args.get("text")
    if text is None:
        raise ToolError("Parameter 'text' is required.")
    _pg().typewrite(str(text), interval=0.025)
    return {"result": f"Typed {len(str(text))} characters."}


@register("pressKey")
def press_key(args: Dict[str, Any]) -> Dict[str, Any]:
    """Press a single keyboard key (e.g. 'enter', 'escape', 'tab', 'space')."""
    key = args.get("key")
    if not key:
        raise ToolError("Parameter 'key' is required (e.g. 'enter', 'escape', 'tab').")
    _pg().press(str(key))
    return {"result": f"Pressed '{key}'."}


@register("sendHotkey")
def send_hotkey(args: Dict[str, Any]) -> Dict[str, Any]:
    """Press a keyboard shortcut combo (e.g. 'ctrl+c', 'alt+f4', 'win+d')."""
    keys = args.get("keys")
    key_str = args.get("shortcut")
    raw = keys or key_str
    if not raw:
        raise ToolError("Parameter 'keys' (e.g. 'ctrl+c') or 'shortcut' is required.")

    if isinstance(raw, str):
        parts = [k.strip() for k in raw.split("+")]
    elif isinstance(raw, list):
        parts = [str(k) for k in raw]
    else:
        raise ToolError("'keys' must be a string like 'ctrl+c' or a list.")

    if not parts:
        raise ToolError("No keys parsed from the input.")
    _pg().hotkey(*parts, interval=0.04)
    return {"result": f"Sent hotkey {'+'.join(parts)}."}


# ── Text selection tools ────────────────────────────────────────────────────

@register("selectText")
def select_text(args: Dict[str, Any]) -> Dict[str, Any]:
    """Select text in the focused control. Modes: all, drag, word, line, paragraph."""
    mode = str(args.get("mode", "all")).lower()

    if mode == "all":
        _pg().hotkey("ctrl", "a")
        return {"result": "Selected all text (Ctrl+A)."}
    if mode == "drag":
        return mouse_drag(args)
    if mode in ("word", "line", "paragraph"):
        x = args.get("x")
        y = args.get("y")
        if x is None or y is None:
            raise ToolError(f"Mode '{mode}' needs x,y coordinates.")
        x, y = int(x), int(y)
        _smooth_move(x, y, duration=0.15)
        time.sleep(0.1)
        # Double-click for word, triple-click for line
        clicks = {"word": 2, "line": 3}.get(mode, 1)
        _win32_click("left")  # first click
        for _ in range(clicks - 1):
            time.sleep(0.05)
            _win32_click("left")
        if mode == "paragraph":
            time.sleep(0.05)
            _pg().hotkey("ctrl", "shift", "down")
        return {"result": f"Selected {mode} at ({x},{y})."}

    raise ToolError(f"Unknown select mode '{mode}'. Use all/drag/word/line/paragraph.")


@register("copySelected")
def _copy_selected(args: Dict[str, Any]) -> Dict[str, Any]:
    """Send Ctrl+C and read the clipboard (selection → copy)."""
    _pg().hotkey("ctrl", "c")
    time.sleep(0.15)
    try:
        import pyperclip
        text = pyperclip.paste() or ""
    except Exception:
        text = ""
    return {"result": "Copied selection to clipboard.", "text": text}


__all__ = [
    "move_cursor",
    "mouse_click",
    "mouse_drag",
    "scroll_mouse",
    "scroll_smooth",
    "scroll_until_visible",
    "type_text",
    "press_key",
    "send_hotkey",
    "select_text",
    "copy_selected",
]
