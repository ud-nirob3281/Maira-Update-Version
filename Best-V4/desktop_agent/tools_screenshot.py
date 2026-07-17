"""
Screenshot & screen-reading: capture, save, OCR, and read on-screen text.

  takeScreenshot    -> capture full screen, return metadata (+ small base64)
  saveScreenshot    -> capture & write to a file under the Screenshots folder
  analyzeScreenshot-> capture, run OCR (pytesseract), return extracted text
  readScreen        -> OCR the active window region + name the active window

OCR requires the Tesseract OCR engine + the pytesseract wrapper. If either is
missing, the OCR tools return a graceful 'unavailable' message instead of
crashing; non-OCR capture still works.
"""

from __future__ import annotations

import base64
import io
import os
import time
from pathlib import Path
from typing import Any, Dict, Optional

from .registry import ToolError, register

try:
    import ctypes
    # Ensure DPI awareness is active
    ctypes.windll.shcore.SetProcessDpiAwareness(2)
except Exception:
    try:
        ctypes.windll.user32.SetProcessDPIAware()
    except Exception:
        pass

SCREENSHOTS_DIR = Path(os.path.expanduser("~")) / "Pictures" / "MyraaScreenshots"


def capture_screen_unified() -> "Any":
    """Unified screen capture using PIL ImageGrab with all_screens=False (to capture only visible screen of current monitor) and cursor drawing."""
    try:
        from PIL import ImageGrab, ImageDraw
        try:
            # Explicitly capture only the user's primary/active monitor (all_screens=False)
            # to prevent grabbing extra multi-monitor areas or scrollable extensions.
            img = ImageGrab.grab(all_screens=False)
        except Exception:
            img = ImageGrab.grab()
        
        # Enforce strict cropping on Windows to match exactly the primary monitor size (visible screen area)
        try:
            import ctypes
            width = ctypes.windll.user32.GetSystemMetrics(0)  # SM_CXSCREEN
            height = ctypes.windll.user32.GetSystemMetrics(1)  # SM_CYSCREEN
            if width > 0 and height > 0 and (img.width > width or img.height > height):
                img = img.crop((0, 0, width, height))
        except Exception:
            pass
        
        # Draw current mouse cursor on the captured image
        try:
            import ctypes
            class POINT(ctypes.Structure):
                _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]
            pt = POINT()
            ctypes.windll.user32.GetCursorPos(ctypes.byref(pt))
            cx, cy = pt.x, pt.y
            
            # Since we captured the primary monitor (top-left is always 0,0),
            # physical cursor coordinates correspond directly to image pixels.
            ix = cx
            iy = cy
            
            if 0 <= ix < img.width and 0 <= iy < img.height:
                draw = ImageDraw.Draw(img)
                # Classic arrow cursor shape polygon
                arrow = [
                    (ix, iy),
                    (ix, iy + 15),
                    (ix + 4, iy + 11),
                    (ix + 9, iy + 16),
                    (ix + 11, iy + 14),
                    (ix + 6, iy + 9),
                    (ix + 11, iy + 9)
                ]
                draw.polygon(arrow, fill="white", outline="black")
        except Exception:
            pass
            
        return img
    except Exception as e:
        raise ToolError(f"Screen capture failed: {e}")


def _capture() -> "Any":
    """Capture the full virtual screen as a PIL Image."""
    return capture_screen_unified()


def _capture_region(bbox):
    try:
        from PIL import ImageGrab

        return ImageGrab.grab(bbox=bbox, all_screens=False)
    except Exception as e:  # noqa: BLE001
        raise ToolError(f"Region capture failed: {e}")


def _active_window_bbox():
    """Return (left, top, right, bottom) of the foreground window, or None."""
    try:
        import win32gui

        hwnd = win32gui.GetForegroundWindow()
        if not hwnd:
            return None
        rect = win32gui.GetWindowRect(hwnd)  # (l, t, r, b)
        return rect
    except Exception:
        return None


def _active_window_title() -> str:
    try:
        import win32gui

        hwnd = win32gui.GetForegroundWindow()
        return win32gui.GetWindowText(hwnd) if hwnd else ""
    except Exception:
        return ""


def _image_to_b64(img, fmt="PNG", quality=70) -> str:
    buf = io.BytesIO()
    if fmt.upper() == "JPEG":
        img.convert("RGB").save(buf, format="JPEG", quality=quality)
    else:
        img.save(buf, format=fmt)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def _image_size_kb(img) -> int:
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return len(buf.getvalue()) // 1024


def _run_ocr(img) -> str:
    """Run OCR on an image with robust error handling and preprocessing.

    Pipeline:
      1. Verify Tesseract engine is available
      2. Preprocess image (grayscale, contrast, sharpen)
      3. Run OCR with language fallback (eng → eng+ben+hin)
      4. Return extracted text

    Raises ToolError with diagnostic info on failure.
    """
    import logging
    log = logging.getLogger("myraa.agent.ocr")

    try:
        import pytesseract
    except ImportError:
        raise ToolError(
            "OCR unavailable: the 'pytesseract' package is not installed. "
            "Install with: pip install pytesseract"
        )

    # Locate Tesseract binary
    exe = os.environ.get("TESSERACT_PATH") or _find_tesseract_exe()
    if exe:
        pytesseract.pytesseract.tesseract_cmd = exe
        log.debug("Tesseract engine found at: %s", exe)
    else:
        log.warning("Tesseract executable not found in any known location.")
        raise ToolError(
            "OCR unavailable: Tesseract OCR engine is not installed. "
            "Please install Tesseract from https://github.com/UB-Mannheim/tesseract/wiki "
            "or set the TESSERACT_PATH environment variable."
        )

    # Preprocess image for better OCR accuracy
    try:
        from PIL import ImageFilter, ImageEnhance
        gray = img.convert("L")
        # Boost contrast + sharpen for clearer text
        gray = ImageEnhance.Contrast(gray).enhance(1.5)
        gray = gray.filter(ImageFilter.UnsharpMask(radius=2, percent=120, threshold=3))
        gray = gray.filter(ImageFilter.MedianFilter(size=3))
        processed = gray
    except Exception as e:
        log.debug("OCR preprocessing skipped (%s), using raw image.", e)
        processed = img

    # Run OCR with language fallback
    langs_to_try = ["eng", "eng+ben+hin"]
    last_err = None
    for lang in langs_to_try:
        try:
            text = pytesseract.image_to_string(processed, lang=lang, config="--psm 3 --oem 3")
            if text and text.strip():
                log.debug("OCR succeeded (lang=%s, %d chars extracted).", lang, len(text))
                return text
        except Exception as e:
            last_err = e
            log.debug("OCR with lang='%s' failed: %s", lang, e)
            continue

    raise ToolError(
        f"OCR failed to extract any text (tried languages: {langs_to_try}). "
        f"Last error: {last_err}. "
        f"Check: 1) Tesseract path is correct, 2) Language data files exist in tessdata/."
    )


def _configure_tesseract_env(exe_path: str) -> None:
    """Configures environment variables for Tesseract, setting TESSDATA_PREFIX and prepending PATH."""
    parent_dir = os.path.dirname(exe_path)
    if parent_dir and parent_dir not in os.environ.get("PATH", ""):
        os.environ["PATH"] = parent_dir + os.pathsep + os.environ.get("PATH", "")
    
    # Configure TESSDATA_PREFIX pointing to the actual 'tessdata' folder
    tessdata_dir = os.path.join(parent_dir, "tessdata")
    if os.path.isdir(tessdata_dir):
        # ALWAYS overwrite to bypass stale/broken system-wide environment variables
        os.environ["TESSDATA_PREFIX"] = tessdata_dir


def _find_tesseract_exe() -> Optional[str]:
    """Find Tesseract OCR executable with comprehensive candidate paths.

    Search order:
      1. Environment variable TESSERACT_PATH (user can override)
      2. Search via system PATH (shutil.which)
      3. New custom path (D:\\APP\\Tesseract)
      4. Standard installation paths
    Also configures TESSDATA_PREFIX and PATH environment variables.
    """
    import shutil
    
    # 1. Environment variable
    env_path = os.environ.get("TESSERACT_PATH")
    if env_path and os.path.isfile(env_path):
        _configure_tesseract_env(env_path)
        return env_path

    # 2. System PATH
    which_path = shutil.which("tesseract") or shutil.which("tesseract.exe")
    if which_path and os.path.isfile(which_path):
        _configure_tesseract_env(which_path)
        return which_path

    # 3. Candidates (completely excluding the old New Trasarect location)
    candidates = [
        r"D:\APP\Tesseract\tesseract.exe",
        r"D:\APP\Tesseract\tesseract",
        r"C:\Program Files\Tesseract-OCR\tesseract.exe",
        r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe",
        os.path.join(os.environ.get("LOCALAPPDATA", ""), "Tesseract-OCR", "tesseract.exe"),
        os.path.join(os.environ.get("APPDATA", ""), "Tesseract-OCR", "tesseract.exe"),
    ]
    for c in candidates:
        if os.path.isfile(c):
            _configure_tesseract_env(c)
            return c
    return None


@register("ocrHealthCheck")
def ocr_health_check(args: Dict[str, Any] = None) -> Dict[str, Any]:
    """Perform a comprehensive health check of Tesseract OCR on startup."""
    import logging
    log_obj = logging.getLogger("myraa.ocr")
    
    exe = os.environ.get("TESSERACT_PATH") or _find_tesseract_exe()
    if not exe:
        return {
            "status": "error",
            "message": "Tesseract executable not found. Please install Tesseract under D:\\APP\\Tesseract\\ or C:\\Program Files\\Tesseract-OCR\\."
        }
        
    parent_dir = os.path.dirname(exe)
    tessdata_dir = os.path.join(parent_dir, "tessdata")
    
    detected_langs = []
    missing_langs = []
    tessdata_exists = os.path.isdir(tessdata_dir)
    
    if tessdata_exists:
        try:
            files = os.listdir(tessdata_dir)
            for lang in ["eng", "ben", "hin"]:
                if f"{lang}.traineddata" in files:
                    detected_langs.append(lang)
                else:
                    missing_langs.append(lang)
        except Exception as e:
            log_obj.warning("Failed to list files in tessdata directory: %s", e)
                
    # Overwrite the environment TESSDATA_PREFIX to point to the valid tessdata directory
    if tessdata_exists:
        os.environ["TESSDATA_PREFIX"] = tessdata_dir
        
    status = "ok" if ("eng" in detected_langs) else "degraded"
    if not tessdata_exists:
        status = "error"
        
    res = {
        "status": status,
        "tesseract_path": exe,
        "tessdata_path": tessdata_dir if tessdata_exists else None,
        "tessdata_exists": tessdata_exists,
        "detected_languages": detected_langs,
        "missing_languages": missing_langs,
        "tessdata_prefix_env": os.environ.get("TESSDATA_PREFIX"),
    }
    
    log_obj.info("OCR Health Check - Status: %s. Binary: %s. Languages: %s", status, exe, detected_langs)
    return res


@register("desktopOcrHealthCheck")
def desktop_ocr_health_check(args: Dict[str, Any]) -> Dict[str, Any]:
    """Perform a comprehensive health check of Tesseract OCR on startup."""
    return ocr_health_check(args)


def _trim_ocr(text: str, max_chars: int = 1500) -> str:
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    out = "\n".join(lines)
    if len(out) > max_chars:
        out = out[:max_chars] + "…"
    return out


@register("takeScreenshot")
def take_screenshot(args: Dict[str, Any]) -> Dict[str, Any]:
    # Cache disabled to prevent old screenshot/stuck issues and ensure raw, live, real-time screen visualization.
    img = _capture()
    include_image = bool(args.get("include_image", False))
    result: Dict[str, Any] = {
        "result": f"Captured screen ({img.width}x{img.height}).",
        "width": img.width,
        "height": img.height,
    }
    
    # Return cursor position in physical screen coordinates
    try:
        import ctypes
        class POINT(ctypes.Structure):
            _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]
        pt = POINT()
        ctypes.windll.user32.GetCursorPos(ctypes.byref(pt))
        result["cursor_position"] = {"x": int(pt.x), "y": int(pt.y)}
        result["result"] += f" Cursor is at ({pt.x}, {pt.y})."
    except Exception:
        pass

    if include_image:
        # Downscale + JPEG to keep payload small for the WS bridge.
        max_dim = int(args.get("max_dim", 1280))
        if max(img.size) > max_dim:
            ratio = max_dim / max(img.size)
            img_small = img.resize(
                (max(1, int(img.width * ratio)), max(1, int(img.height * ratio)))
            )
        else:
            img_small = img
        result["image_base64"] = _image_to_b64(img_small, fmt="JPEG", quality=60)
        result["image_mime"] = "image/jpeg"

    return result


@register("saveScreenshot")
def save_screenshot(args: Dict[str, Any]) -> Dict[str, Any]:
    img = _capture()
    SCREENSHOTS_DIR.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    name = args.get("name")
    fname = f"{name}-{stamp}.png" if name else f"screenshot-{stamp}.png"
    out_path = SCREENSHOTS_DIR / fname
    img.save(out_path, format="PNG")
    return {"result": f"Saved screenshot to {out_path}.", "path": str(out_path)}


@register("analyzeScreenshot")
def analyze_screenshot(args: Dict[str, Any]) -> Dict[str, Any]:
    # Cache disabled to prevent old screenshot/stuck issues and ensure raw, live, real-time screen vision.
    img = _capture()
    try:
        text = _run_ocr(img)
    except ToolError as e:
        return {"result": f"Screenshot captured, but OCR unavailable: {e.message}"}

    result = {
        "result": "Screenshot analyzed via OCR.",
        "text": _trim_ocr(text, int(args.get("max_chars", 1500))),
    }
    return result


@register("readScreen")
def read_screen(args: Dict[str, Any]) -> Dict[str, Any]:
    """OCR the active window and report its title + visible text."""
    # Cache disabled to prevent old screenshot/stuck issues and ensure raw, live, real-time screen vision.
    title = _active_window_title()
    bbox = _active_window_bbox()
    if bbox:
        try:
            img = _capture_region(bbox)
        except ToolError:
            img = _capture()
    else:
        img = _capture()
    try:
        text = _run_ocr(img)
        visible = _trim_ocr(text, int(args.get("max_chars", 1500))) or "(no readable text)"
    except ToolError as e:
        return {
            "result": f"Active window: {title or 'unknown'}. OCR unavailable: {e.message}",
            "active_window": title,
        }

    result = {
        "result": f"Active window '{title or 'unknown'}' contains readable text.",
        "active_window": title,
        "text": visible,
    }
    return result


__all__ = [
    "take_screenshot",
    "save_screenshot",
    "analyze_screenshot",
    "read_screen",
]
