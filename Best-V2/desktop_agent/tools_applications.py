"""
Application control: launch and close Windows applications.

Launch strategy is layered for robustness:
  1. Try a known executable / shell verb (fastest, most reliable).
  2. Search common install directories for a matching .exe (dynamic fallback).
  3. Fall back to `start <name>` which lets Windows resolve via App Paths / registry.

Closing uses taskkill on the matching process image name, with a graceful
grace period so apps can save work.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from .registry import ToolError, register

# Canonical app key -> (launch_command, kind)
#   kind == "exe"   : launch_command is the executable name (resolved via PATH/App Paths)
#   kind == "shell" : launch_command is a shell builtin verb run with cmd /c
#   kind == "uwp"   : launch_command is an apps-family activation string
APP_COMMANDS: Dict[str, Dict[str, str]] = {
    "notepad": {"exe": "notepad.exe", "image": "notepad.exe", "label": "Notepad"},
    "chrome": {"exe": "chrome.exe", "image": "chrome.exe", "label": "Google Chrome"},
    "edge": {"exe": "msedge.exe", "image": "msedge.exe", "label": "Microsoft Edge"},
    "vscode": {"exe": "code.cmd", "image": "Code.exe", "label": "Visual Studio Code"},
    "calculator": {"shell": "calc", "image": "CalculatorApp.exe", "label": "Calculator"},
    "calc": {"shell": "calc", "image": "CalculatorApp.exe", "label": "Calculator"},
    "file explorer": {"shell": "explorer", "image": "explorer.exe", "label": "File Explorer"},
    "explorer": {"shell": "explorer", "image": "explorer.exe", "label": "File Explorer"},
    "task manager": {"shell": "taskmgr", "image": "Taskmgr.exe", "label": "Task Manager"},
    "taskmanager": {"shell": "taskmgr", "image": "Taskmgr.exe", "label": "Task Manager"},
    "settings": {"uwp": "ms-settings:", "image": "SystemSettings.exe", "label": "Settings"},
    "command prompt": {"exe": "cmd.exe", "image": "cmd.exe", "label": "Command Prompt"},
    "cmd": {"exe": "cmd.exe", "image": "cmd.exe", "label": "Command Prompt"},
    "powershell": {"exe": "powershell.exe", "image": "powershell.exe", "label": "PowerShell"},
    "wordpad": {"shell": "write", "image": "wordpad.exe", "label": "WordPad"},
    "paint": {"shell": "mspaint", "image": "mspaint.exe", "label": "Paint"},
    "snipping tool": {"uwp": "ms-screenclip:", "image": "ScreenClippingHost.exe", "label": "Snipping Tool"},
    "spotify": {"exe": "Spotify.exe", "image": "Spotify.exe", "label": "Spotify"},
    "discord": {"exe": "Discord.exe", "image": "Discord.exe", "label": "Discord"},
    "telegram": {"exe": "Telegram.exe", "image": "Telegram.exe", "label": "Telegram"},
    "whatsapp": {"exe": "WhatsApp.exe", "image": "WhatsApp.exe", "label": "WhatsApp"},
    "firefox": {"exe": "firefox.exe", "image": "firefox.exe", "label": "Mozilla Firefox"},
    "brave": {"exe": "brave.exe", "image": "brave.exe", "label": "Brave Browser"},
    "vlc": {"exe": "vlc.exe", "image": "vlc.exe", "label": "VLC Media Player"},
    "steam": {"exe": "steam.exe", "image": "steam.exe", "label": "Steam"},
    "obs": {"exe": "obs64.exe", "image": "obs64.exe", "label": "OBS Studio"},
    "notion": {"exe": "Notion.exe", "image": "Notion.exe", "label": "Notion"},
    "figma": {"exe": "Figma.exe", "image": "Figma.exe", "label": "Figma"},
    "slack": {"exe": "slack.exe", "image": "slack.exe", "label": "Slack"},
    "zoom": {"exe": "Zoom.exe", "image": "Zoom.exe", "label": "Zoom"},
    "teams": {"exe": "ms-teams.exe", "image": "ms-teams.exe", "label": "Microsoft Teams"},
}


def _normalize(name: str) -> str:
    """Strip spaces, dots, dashes, underscores for loose matching."""
    return re.sub(r"[\s.\-_]+", "", name).lower()


def _fuzzy_find_app(name: str) -> Optional[Dict[str, str]]:
    """Search the hardcoded dict with fuzzy name matching (substring + normalized)."""
    norm = _normalize(name)
    # Exact normalized match
    for key, spec in APP_COMMANDS.items():
        if _normalize(key) == norm:
            return spec
    # Substring match (name is contained in key or vice-versa)
    for key, spec in APP_COMMANDS.items():
        if norm in _normalize(key) or _normalize(key) in norm:
            return spec
    return None


def _search_install_dirs(name: str) -> Optional[Path]:
    """Search common install directories for an exe matching the name."""
    norm = _normalize(name)
    search_roots: List[Path] = []
    for env_var in ("PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA", "APPDATA"):
        p = os.environ.get(env_var)
        if p:
            search_roots.append(Path(p))
    search_roots.append(Path.home() / "AppData" / "Local" / "Programs")
    search_roots.append(Path.home() / "Desktop")

    for root in search_roots:
        if not root.exists():
            continue
        # Shallow scan first (top-level, faster)
        for item in root.iterdir():
            if item.suffix.lower() == ".exe" and norm in _normalize(item.stem):
                return item
        # One level deep for organized directories
        try:
            for sub in root.iterdir():
                if sub.is_dir():
                    try:
                        for item in sub.iterdir():
                            if item.suffix.lower() == ".exe" and norm in _normalize(item.stem):
                                return item
                    except (PermissionError, OSError):
                        continue
        except (PermissionError, OSError):
            continue
    return None


def _resolve_app(key: str) -> Dict[str, str]:
    norm = (key or "").strip().lower()

    # 1. Exact key match
    if norm in APP_COMMANDS:
        return APP_COMMANDS[norm]

    # 2. Known aliases
    aliases = {
        "code": "vscode",
        "visual studio code": "vscode",
        "vs code": "vscode",
        "google chrome": "chrome",
        "microsoft edge": "edge",
        "settings app": "settings",
        "windows explorer": "file explorer",
        "terminal": "powershell",
        "word": "wordpad",
    }
    if norm in aliases and aliases[norm] in APP_COMMANDS:
        return APP_COMMANDS[aliases[norm]]

    # 3. Fuzzy match within hardcoded dict
    fuzzy = _fuzzy_find_app(key)
    if fuzzy:
        return fuzzy

    # 4. Search install directories for matching exe
    found = _search_install_dirs(key)
    if found:
        return {
            "exe": str(found),
            "image": found.name,
            "label": found.stem,
            "dynamic": "true",
        }

    # 5. Last resort: let Windows try to resolve via start command
    return {
        "shell": key,
        "image": f"{key}.exe",
        "label": key,
        "fallback": "true",
    }


def _launch(spec: Dict[str, str]) -> str:
    """Launch an app. Returns the display label.

    Uses `os.startfile` for absolute exe paths (most reliable on Windows), and
    `cmd /c start` for bare exe names / shell verbs. Never uses DETACHED_PROCESS
    for GUI apps — that flag can prevent the window from appearing.
    """
    label = spec.get("label", "application")
    try:
        if "exe" in spec:
            exe = spec["exe"]
            # Absolute path that exists on disk → startfile is the most reliable
            if Path(exe).exists():
                os.startfile(str(exe))
            # Bare exe name (e.g. "chrome.exe") → let cmd resolve via PATH/App Paths
            else:
                subprocess.Popen(
                    f'start "" "{exe}"',
                    shell=True,
                    close_fds=True,
                    creationflags=getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0),
                )
        elif "shell" in spec:
            subprocess.Popen(
                f'start "" {spec["shell"]}',
                shell=True,
                close_fds=True,
                creationflags=getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0),
            )
        elif "uwp" in spec:
            subprocess.Popen(
                f'start "" {spec["uwp"]}',
                shell=True,
                close_fds=True,
                creationflags=getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0),
            )
        else:
            raise ToolError(f"App spec for {label} is incomplete.")
    except Exception as e:  # noqa: BLE001
        raise ToolError(f"Could not launch {label}: {e}") from e
    return label


@register("openApplication")
def open_application(args: Dict[str, Any]) -> Dict[str, Any]:
    name = args.get("name") or args.get("application")
    if not name:
        raise ToolError("Parameter 'name' (application name) is required.")
    spec = _resolve_app(str(name))
    label = _launch(spec)
    fallback_note = " (found via system search)" if spec.get("fallback") else ""
    return {"result": f"{label} opened.{fallback_note}"}


@register("closeApplication")
def close_application(args: Dict[str, Any]) -> Dict[str, Any]:
    """Close a running application by name.

    Uses multiple strategies because process names don't always match the
    friendly app name:
      1. Try the known image name from APP_COMMANDS
      2. Try window-title-based close (WM_CLOSE on the matching window)
      3. Try taskkill with wildcard matching
      4. Try WMIC to find processes by name pattern
      5. Verify the process was actually killed
    """
    name = args.get("name") or args.get("application")
    force = bool(args.get("force", False))
    if not name:
        raise ToolError("Parameter 'name' (application name) is required.")
    spec = _resolve_app(str(name))
    label = spec.get("label", str(name))
    image = spec.get("image", f"{name}.exe")
    force_flag = " /F" if force else ""

    # Strategy 1: Window-title-based close (most reliable for GUI apps)
    try:
        import win32gui
        hwnd = _find_window_by_title(str(name))
        if hwnd:
            try:
                import win32con
                win32gui.PostMessage(hwnd, win32con.WM_CLOSE, 0, 0)
                time.sleep(0.5)
                # Check if the window is still there
                if not win32gui.IsWindow(hwnd) or not win32gui.IsWindowVisible(hwnd):
                    return {"result": f"Closed {label}.", "closed": True}
            except Exception:
                pass
    except Exception:
        pass

    # Strategy 2: taskkill by image name
    candidates = [image]
    base = image.replace(".exe", "").replace(".EXE", "")
    if base and base not in candidates:
        candidates.append(base)
    uwp_hosts = ["ApplicationFrameHost.exe", "WinStore.App.exe", "SearchApp.exe", "ShellExperienceHost.exe"]
    if spec.get("uwp"):
        candidates.extend(uwp_hosts)

    killed_any = False
    for proc_name in candidates:
        try:
            result = subprocess.run(
                f'taskkill /IM "{proc_name}"{force_flag}',
                shell=True,
                capture_output=True,
                text=True,
                timeout=10,
            )
            if result.returncode == 0 and "SUCCESS" in (result.stdout or "").upper():
                killed_any = True
        except Exception:
            continue

    # Strategy 3: WMIC wildcard search
    if not killed_any:
        try:
            wmic_result = subprocess.run(
                f'wmic process where "name like \\"%{base}%\\" call terminate',
                shell=True,
                capture_output=True,
                text=True,
                timeout=10,
            )
            if wmic_result.returncode == 0 and "ReturnValue = 0" in (wmic_result.stdout or ""):
                killed_any = True
        except Exception:
            pass

    # Verify
    time.sleep(0.3)
    still_running = False
    try:
        check = subprocess.run(
            f'tasklist /FI "IMAGENAME eq {image}" /NH',
            shell=True,
            capture_output=True,
            text=True,
            timeout=5,
        )
        output = (check.stdout or "").strip()
        if image.lower() in output.lower() and "no tasks" not in output.lower():
            still_running = True
    except Exception:
        pass

    if still_running and not killed_any:
        # Force kill as last resort
        try:
            subprocess.run(f'taskkill /IM "{image}" /F /T', shell=True, capture_output=True, timeout=10)
            time.sleep(0.2)
        except Exception:
            pass
        try:
            check2 = subprocess.run(
                f'tasklist /FI "IMAGENAME eq {image}" /NH',
                shell=True, capture_output=True, text=True, timeout=5,
            )
            if image.lower() in (check2.stdout or "").lower() and "no tasks" not in (check2.stdout or "").lower():
                return {"result": f"Could not fully close {label}. The process may require admin privileges or a different name.", "closed": False}
        except Exception:
            pass

    return {"result": f"Closed {label}.", "closed": True}


def _find_window_by_title(query: str):
    """Find a window by title substring. Returns hwnd or None."""
    try:
        import win32gui
        matches = []
        query_lower = query.lower()
        def cb(hwnd, _):
            if win32gui.IsWindowVisible(hwnd):
                title = win32gui.GetWindowText(hwnd)
                if title and query_lower in title.lower():
                    matches.append(hwnd)
            return True
        win32gui.EnumWindows(cb, None)
        return matches[0] if matches else None
    except Exception:
        return None


__all__ = ["open_application", "close_application", "APP_COMMANDS"]
