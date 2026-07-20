"""
Hybrid Vision Engine + Smart Click Engine.

Click accuracy is paramount. Instead of guessing coordinates, we use a cascade
of methods from highest to lowest confidence:

  1. UI Automation (Windows Accessibility tree) — exact element rectangles,
     works even with display scaling; the gold standard on Windows.
  2. Tesseract OCR (preprocessed, OpenCV-enhanced) — fast, accurate text labels.
  3. EasyOCR fallback (PyTorch) — slower but better on stylized/noisy text.
  4. Coordinate click — last resort, requires an explicit (x, y).

OCR preprocessing pipeline: grayscale → contrast → sharpen → denoise → (OpenCV
adaptive threshold when available). Languages: English, Bangla (ben), Hindi (hin).
Confidence scoring with rapidfuzz fuzzy matching so "Visual Studlo" still
matches "Visual Studio".

Both Tesseract and EasyOCR are optional; the agent degrades gracefully if
either (or both) are missing — UI Automation still works, and a clear status
message tells the user what to install.
"""

from __future__ import annotations

import os
import re
from typing import Any, Dict, List, Optional, Tuple

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


# ── Tesseract path detection ────────────────────────────────────────────────

def _find_tesseract() -> Optional[str]:
    """Return the tesseract executable path, or None if not installed."""
    from .tools_screenshot import _find_tesseract_exe
    return _find_tesseract_exe()


def _tesseract_available() -> bool:
    return _find_tesseract() is not None


# ── Screen capture ──────────────────────────────────────────────────────────

def _capture_screen():
    """Capture the full virtual screen as a PIL Image (RGB) using unified PIL capture."""
    from .tools_screenshot import capture_screen_unified
    return capture_screen_unified()


# ── Image preprocessing pipeline ────────────────────────────────────────────

def _preprocess(img):
    """Run the OCR preprocessing pipeline. Returns a PIL Image (L mode).

    Pipeline: grayscale → contrast → sharpen → denoise → (OpenCV adaptive
    threshold when cv2 is available; falls back to PIL-only pipeline).
    """
    from PIL import ImageFilter, ImageEnhance
    import numpy as np

    # Grayscale
    gray = img.convert("L")
    arr = np.array(gray)

    # Contrast enhancement (CLAHE-like stretch to full range)
    arr = np.clip(arr.astype(np.int16) * 1.6, 0, 255).astype(np.uint8)

    # Try OpenCV adaptive threshold (better on uneven lighting / shadows)
    try:
        import cv2
        blurred = cv2.GaussianBlur(arr, (3, 3), 0)
        adaptive = cv2.adaptiveThreshold(
            blurred, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
            cv2.THRESH_BINARY, 41, 10,
        )
        # Sharpen + denoise on the thresholded image
        kernel = np.array([[-1, -1, -1], [-1, 9, -1], [-1, -1, -1]])
        sharpened = cv2.filter2D(adaptive, -1, kernel)
        denoised = cv2.medianBlur(sharpened, 3)
        return Image.fromarray(denoised)
    except ImportError:
        pass  # cv2 not available — use PIL pipeline below

    # PIL-only fallback (still very good)
    gray = Image.fromarray(arr)
    gray = ImageEnhance.Contrast(gray).enhance(1.6)
    gray = gray.filter(ImageFilter.UnsharpMask(radius=2, percent=130, threshold=3))
    gray = gray.filter(ImageFilter.MedianFilter(size=3))
    return gray


# ── OCR with bounding boxes ─────────────────────────────────────────────────

def _ocr_with_boxes(img, lang: str = "eng") -> List[Dict[str, Any]]:
    """Run Tesseract, return word-level results with bounding boxes + confidence."""
    tesseract_path = _find_tesseract()
    if tesseract_path is None:
        raise ToolError(
            "Tesseract OCR is not installed. The user needs to install it:\n"
            "1. Download from https://github.com/UB-Mannheim/tesseract/wiki\n"
            "2. Install to C:\\Program Files\\Tesseract-OCR\\\n"
            "3. During install, select the 'Additional language data (download)' "
            "and pick: English, Bangla, Hindi.\n"
            "Until then, OCR-based clicking (clickOnText) will not work. "
            "Ask the user to install it, or use precise coordinates instead."
        )

    import pytesseract

    pytesseract.pytesseract.tesseract_cmd = tesseract_path

    # Map UI lang code → Tesseract lang code
    tess_lang = {"english": "eng", "bangla": "ben", "hindi": "hin", "auto": "eng+ben+hin"}.get(
        lang.lower(), "eng"
    )

    try:
        processed = _preprocess(img)
    except Exception:
        processed = img  # fall back to raw if preprocessing fails

    try:
        data = pytesseract.image_to_data(processed, lang=tess_lang, output_type=pytesseract.Output.DICT)
    except Exception as e:
        # Lang pack missing → retry with English only
        if "Failed to load language" in str(e) or "tessdata" in str(e).lower():
            data = pytesseract.image_to_data(processed, lang="eng", output_type=pytesseract.Output.DICT)
        else:
            raise ToolError(f"OCR failed: {e}") from e

    results: List[Dict[str, Any]] = []
    for i in range(len(data["text"])):
        text = data["text"][i].strip()
        conf = int(data["conf"][i])
        if text and conf > 25:
            results.append({
                "text": text,
                "left": int(data["left"][i]),
                "top": int(data["top"][i]),
                "width": int(data["width"][i]),
                "height": int(data["height"][i]),
                "conf": conf,
            })
    return results


# ── EasyOCR fallback tier ─────────────────────────────────────────────────

def _easyocr_available() -> bool:
    """Check if EasyOCR (and its PyTorch dependency) can be imported."""
    try:
        import easyocr  # noqa: F401
        return True
    except ImportError:
        return False


_easyocr_reader_cache = None


def _get_easyocr_reader():
    """Return a cached EasyOCR reader (lazy-init, GPU if available)."""
    global _easyocr_reader_cache
    if _easyocr_reader_cache is not None:
        return _easyocr_reader_cache
    try:
        import easyocr
        _easyocr_reader_cache = easyocr.Reader(
            ["en", "bn", "hi"],
            gpu=True,        # use CUDA if available, else CPU
            verbose=False,
            quantized=True,  # smaller model, faster on CPU
        )
        return _easyocr_reader_cache
    except Exception:
        return None


def _ocr_easyocr(img, lang: str = "eng") -> List[Dict[str, Any]]:
    """Run EasyOCR, return word-level results in the same format as _ocr_with_boxes.

    Falls back gracefully if EasyOCR is not installed.
    """
    reader = _get_easyocr_reader()
    if reader is None:
        return []

    # EasyOCR lang mapping: english→en, bangla→bn+en, hindi→hi+en, auto→all
    lang_map = {
        "english": ["en"], "bangla": ["bn", "en"],
        "hindi": ["hi", "en"], "auto": ["en", "bn", "hi"],
    }
    langs = lang_map.get(lang.lower(), ["en"])

    try:
        import numpy as np
        arr = np.array(img)
        # EasyOCR returns (bbox, text, confidence) per detection
        raw_results = reader.readtext(arr, detail=1, paragraph=False)
    except Exception:
        return []

    results: List[Dict[str, Any]] = []
    for (bbox, text, conf) in raw_results:
        text = text.strip()
        if not text or conf < 0.3:
            continue
        # bbox = [[x1,y1],[x2,y2],[x3,y3],[x4,y4]]
        xs = [p[0] for p in bbox]
        ys = [p[1] for p in bbox]
        left, top = int(min(xs)), int(min(ys))
        right, bottom = int(max(xs)), int(max(ys))
        results.append({
            "text": text,
            "left": left,
            "top": top,
            "width": right - left,
            "height": bottom - top,
            "conf": int(conf * 100),  # normalize to 0-100 like Tesseract
        })
    return results


# ── Hybrid OCR cascade: Tesseract → EasyOCR ────────────────────────────────

def _ocr_best(img, lang: str = "eng", min_results: int = 3) -> List[Dict[str, Any]]:
    """Best-effort OCR: Tesseract first, then EasyOCR fallback.

    Returns the Tesseract results if they contain enough confident matches,
    otherwise appends/falls back to EasyOCR results. This gives us the speed
    of Tesseract for normal text and the resilience of EasyOCR for stylized
    or low-contrast text.
    """
    # 1. Try Tesseract (fast, accurate for clean text)
    tess_results: List[Dict[str, Any]] = []
    try:
        tess_results = _ocr_with_boxes(img, lang=lang)
    except ToolError:
        pass  # Tesseract missing — continue to EasyOCR

    # If Tesseract gave enough results, use them directly.
    if len(tess_results) >= min_results:
        return tess_results

    # 2. Try EasyOCR fallback (slower, better on noisy/stylized text)
    easy_results = _ocr_easyocr(img, lang=lang)
    if not easy_results:
        return tess_results  # return whatever Tesseract had (may be empty)

    # Merge: deduplicate overlapping boxes (keep higher confidence).
    merged = list(tess_results)
    for er in easy_results:
        overlap = False
        for mr in merged:
            # Simple center-distance check for dedup.
            cx_e = er["left"] + er["width"] / 2
            cy_e = er["top"] + er["height"] / 2
            cx_m = mr["left"] + mr["width"] / 2
            cy_m = mr["top"] + mr["height"] / 2
            if abs(cx_e - cx_m) < 30 and abs(cy_e - cy_m) < 20:
                overlap = True
                # Keep the higher-confidence one.
                if er["conf"] > mr["conf"]:
                    merged.remove(mr)
                    merged.append(er)
                break
        if not overlap:
            merged.append(er)

    return merged


# ── Fuzzy text matching ─────────────────────────────────────────────────────

def _normalize(s: str) -> str:
    """Lowercase, strip non-alphanumeric (for fuzzy substring match)."""
    return re.sub(r"[^a-z0-9\u0980-\u09FF]", "", s.lower())


def _fuzzy_score(a: str, b: str) -> float:
    """Return a 0..1 similarity score between two normalized strings.

    Uses rapidfuzz if available (fast Levenshtein), else difflib.
    """
    na, nb = _normalize(a), _normalize(b)
    if not na or not nb:
        return 0.0
    try:
        from rapidfuzz import fuzz
        return max(
            fuzz.ratio(na, nb) / 100.0,
            fuzz.partial_ratio(na, nb) / 100.0,
        )
    except ImportError:
        import difflib
        return max(
            difflib.SequenceMatcher(None, na, nb).ratio(),
            difflib.SequenceMatcher(None, na, nb).get_matching_blocks() and
            min(len(na), len(nb)) / max(len(na), len(nb), 1) * (difflib.SequenceMatcher(None, na, nb).ratio()),
        )


def _find_best_match(words: List[Dict[str, Any]], target: str, threshold: float = 0.70) -> Optional[Tuple[Dict[str, Any], float]]:
    """Find the best matching word/phrase on screen for the target text.

    Returns (match, score) or None. Considers single words AND adjacent phrases.
    """
    norm_target = _normalize(target)
    if not norm_target:
        return None

    best: Optional[Tuple[Dict[str, Any], float]] = None

    # 1. Multi-word phrases (merge up to 5 adjacent words)
    for i in range(len(words)):
        for span in range(2, 6):
            if i + span > len(words):
                break
            phrase_words = [words[j] for j in range(i, i + span)]
            phrase_text = " ".join(w["text"] for w in phrase_words)
            score = _fuzzy_score(phrase_text, target)
            # Require words to be horizontally adjacent (same line)
            xs = [w["left"] for w in phrase_words]
            if max(xs) - min(xs) > 1500:  # not on the same line
                continue
            if score >= threshold and (best is None or score > best[1]):
                xs2 = [w["left"] for w in phrase_words]
                ys2 = [w["top"] for w in phrase_words]
                xe = [w["left"] + w["width"] for w in phrase_words]
                ye = [w["top"] + w["height"] for w in phrase_words]
                merged = {
                    "text": phrase_text,
                    "left": min(xs2),
                    "top": min(ys2),
                    "width": max(xe) - min(xs2),
                    "height": max(ye) - min(ys2),
                    "conf": min(w["conf"] for w in phrase_words),
                }
                best = (merged, score)
        # 2. Single word
        score = _fuzzy_score(words[i]["text"], target)
        if score >= threshold and (best is None or score > best[1]):
            best = (dict(words[i]), score)

    return best


# ── Smart click cascade: UI Automation → OCR → coordinates ─────────────────

def _try_uiautomation_click(target: str, button: str, double: bool) -> Optional[Dict[str, Any]]:
    """Try the Windows Accessibility tree to find and click an element by name.

    Returns a result dict on success, or None if UI Automation is unavailable
    or the element wasn't found.
    """
    try:
        import uiautomation as ua
    except ImportError:
        return None

    target_lower = target.lower()
    # Search the foreground window + desktop for a matching control
    try:
        root = ua.GetForegroundWindow() or ua.GetRootControl()
        found = None
        # Depth-limited walk — avoid hanging on huge trees
        for ctrl, _depth in _walk_uia(root, max_depth=6):
            try:
                name = (ctrl.Name or "").strip()
                if name and target_lower in name.lower():
                    found = ctrl
                    break
            except Exception:
                continue
        if found is None:
            return None
        rect = found.BoundingRectangle
        if not rect:
            return None
        cx = (rect.left + rect.right) // 2
        cy = (rect.top + rect.bottom) // 2
        # Click via pyautogui (consistent with the rest of the system)
        import pyautogui, time
        pyautogui.FAILSAFE = False
        pyautogui.moveTo(cx, cy, duration=0.2, tween=pyautogui.easeOutQuad)
        time.sleep(0.08)
        clicks = 2 if double else 1
        pyautogui.click(clicks=clicks, button=button, interval=0.08)
        return {"result": f"Clicked '{target}' via UI Automation at ({cx},{cy}).", "x": cx, "y": cy, "method": "uiautomation"}
    except Exception:
        return None


def _walk_uia(ctrl, max_depth=6):
    """Yield (control, depth) up to max_depth."""
    stack = [(ctrl, 0)]
    while stack:
        c, d = stack.pop()
        yield c, d
        if d < max_depth:
            try:
                children = c.GetChildren() or []
                for ch in children:
                    stack.append((ch, d + 1))
            except Exception:
                continue


def _active_window_bbox() -> Optional[Tuple[int, int, int, int]]:
    """Return (left, top, right, bottom) of the foreground window, or None."""
    try:
        import win32gui
        hwnd = win32gui.GetForegroundWindow()
        if not hwnd:
            return None
        class_name = win32gui.GetClassName(hwnd)
        if class_name in ("Progman", "Shell_TrayWnd"):
            return None
        rect = win32gui.GetWindowRect(hwnd)  # (l, t, r, b)
        left, top, right, bottom = rect
        if right - left > 10 and bottom - top > 10:
            return left, top, right, bottom
    except Exception:
        pass
    return None


def _ocr_click(target: str, button: str, double: bool, lang: str) -> Optional[Dict[str, Any]]:
    """Try OCR-based click (hybrid Tesseract + EasyOCR). Returns result dict or None."""
    try:
        img = _capture_screen()
    except ToolError:
        raise  # surface the "Tesseract not installed" message

    match_info = None
    bbox = _active_window_bbox()
    offset_x, offset_y = 0, 0

    # 1. First, try foreground active window crop (reduces noise)
    if bbox:
        left, top, right, bottom = bbox
        cl = max(0, min(img.width, left))
        ct = max(0, min(img.height, top))
        cr = max(cl, min(img.width, right))
        cb = max(ct, min(img.height, bottom))

        if cr - cl > 10 and cb - ct > 10:
            try:
                cropped = img.crop((cl, ct, cr, cb))
                words = _ocr_best(cropped, lang=lang)
                match_info = _find_best_match(words, target)
                if match_info:
                    offset_x, offset_y = cl, ct
            except Exception:
                pass

    # 2. Fallback: try full screen OCR if no match found in foreground window
    if match_info is None:
        try:
            words = _ocr_best(img, lang=lang)
            match_info = _find_best_match(words, target)
            offset_x, offset_y = 0, 0
        except ToolError:
            raise

    if match_info is None:
        return None

    match, score = match_info
    
    # Calculate accurate center coordinate
    cx = offset_x + match["left"] + match["width"] // 2
    cy = offset_y + match["top"] + match["height"] // 2

    # Click using the high-accuracy DPI-aware _click_with_retry engine
    from .tools_input import _click_with_retry
    clicks = 2 if double else 1
    _click_with_retry(cx, cy, button, clicks, 0.08)

    # Confidence কম হলে ৫-১০ pixel jitter দিয়ে retry করে
    ocr_conf = match.get("conf", 100)
    if score < 0.85 or ocr_conf < 70:
        import time, random
        for _ in range(2):
            time.sleep(0.12)
            jx = cx + random.choice([-8, -5, 5, 8])
            jy = cy + random.choice([-8, -5, 5, 8])
            _click_with_retry(jx, jy, button, clicks, 0.08)

    return {
        "result": f"Clicked '{match['text']}' (fuzzy score {score:.0%}, OCR conf {ocr_conf}%) at ({cx},{cy}) via OCR.",
        "x": cx, "y": cy, "matched_text": match["text"], "method": "ocr", "confidence": round(score, 2),
    }


# ── Registered tools ────────────────────────────────────────────────────────

@register("screenResolution")
def screen_resolution(args: Dict[str, Any]) -> Dict[str, Any]:
    """Return the virtual-screen size in physical pixels (multi-monitor aware)."""
    try:
        import pyautogui
        w, h = pyautogui.size()
    except Exception as e:
        raise ToolError(f"Could not read screen size: {e}") from e
    # Also report scaling factor via ctypes if available
    scaling = 1.0
    try:
        import ctypes
        hdc = ctypes.windll.user32.GetDC(0)
        LOGPIXELSX = 88
        dpi = ctypes.windll.gdi32.GetDeviceCaps(hdc, LOGPIXELSX)
        ctypes.windll.user32.ReleaseDC(0, hdc)
        scaling = round(dpi / 96.0, 2)
    except Exception:
        pass
    return {"result": f"Screen is {w}x{h} physical pixels (scaling {scaling:.0%}).", "width": w, "height": h, "scaling": scaling}


@register("clickOnText")
def click_on_text(args: Dict[str, Any]) -> Dict[str, Any]:
    """Smart click engine: find a visible element by text and click its center.

    Cascade: UI Automation (accessibility tree) → OCR hybrid (Tesseract +
    EasyOCR fallback, fuzzy match) → retry with EasyOCR-only → fail with a
    clear message. Never clicks on low-confidence guesses.
    """
    target = args.get("text") or args.get("target") or args.get("label")
    button = str(args.get("button", "left")).lower()
    double = bool(args.get("double", False))
    lang = str(args.get("lang", "eng"))

    if not target:
        raise ToolError("Parameter 'text' (the visible label to click) is required.")

    # 1. UI Automation (highest confidence)
    res = _try_uiautomation_click(str(target), button, double)
    if res:
        return res

    # 2. OCR hybrid (Tesseract → EasyOCR fallback, fuzzy match)
    res = _ocr_click(str(target), button, double, lang)
    if res:
        return res

    # 3. Retry with EasyOCR directly (may catch text Tesseract misses)
    if _easyocr_available():
        try:
            import time
            time.sleep(0.3)  # brief pause before re-capture (screen may change)
            img = _capture_screen()
            easy_words = _ocr_easyocr(img, lang=lang)
            if easy_words:
                match_info = _find_best_match(easy_words, str(target))
                if match_info:
                    match, score = match_info
                    cx = match["left"] + match["width"] // 2
                    cy = match["top"] + match["height"] // 2
                    import pyautogui
                    pyautogui.FAILSAFE = False
                    pyautogui.moveTo(cx, cy, duration=0.2, tween=pyautogui.easeOutQuad)
                    time.sleep(0.08)
                    clicks = 2 if double else 1
                    pyautogui.click(clicks=clicks, button=button, interval=0.08)
                    return {
                        "result": f"Clicked '{match['text']}' (EasyOCR, score {score:.0%}) at ({cx},{cy}).",
                        "x": cx, "y": cy, "matched_text": match["text"],
                        "method": "easyocr", "confidence": round(score, 2),
                    }
        except Exception:
            pass

    raise ToolError(
        f"Could not find '{target}' on the screen. Tried UI Automation, Tesseract OCR, "
        f"and EasyOCR. The element may be off-screen, obscured, or confidence was too low. "
        f"Try scrolling first, or use exact coordinates."
    )


@register("findOnScreen")
def find_on_screen(args: Dict[str, Any]) -> Dict[str, Any]:
    """Find where a visible text/label is on screen WITHOUT clicking."""
    target = args.get("text") or args.get("target") or args.get("label")
    lang = str(args.get("lang", "eng"))
    if not target:
        raise ToolError("Parameter 'text' is required.")

    # Try UI Automation first
    try:
        import uiautomation as ua
        target_lower = str(target).lower()
        root = ua.GetForegroundWindow() or ua.GetRootControl()
        for ctrl, _ in _walk_uia(root, max_depth=6):
            try:
                name = (ctrl.Name or "").strip()
                if name and target_lower in name.lower():
                    rect = ctrl.BoundingRectangle
                    if rect:
                        return {
                            "result": f"Found '{target}' via UI Automation.",
                            "found": True,
                            "x": (rect.left + rect.right) // 2,
                            "y": (rect.top + rect.bottom) // 2,
                            "method": "uiautomation",
                        }
            except Exception:
                continue
    except ImportError:
        pass

    # Fall back to hybrid OCR
    img = _capture_screen()
    words = _ocr_best(img, lang=lang)
    match_info = _find_best_match(words, str(target))
    if match_info is None:
        return {"result": f"'{target}' not found on screen.", "found": False}
    match, score = match_info
    cx = match["left"] + match["width"] // 2
    cy = match["top"] + match["height"] // 2
    return {
        "result": f"Found '{match['text']}' (score {score:.0%}) at ({cx},{cy}).",
        "found": True, "x": cx, "y": cy, "matched_text": match["text"],
        "box": {"left": match["left"], "top": match["top"], "width": match["width"], "height": match["height"]},
    }


@register("ocrStatus")
def ocr_status(args: Dict[str, Any]) -> Dict[str, Any]:
    """Report which OCR engines are installed (Tesseract, EasyOCR, OpenCV)."""
    tess_path = _find_tesseract()
    easy = _easyocr_available()
    try:
        import cv2
        cv2_ok = True
    except ImportError:
        cv2_ok = False

    engines = []
    if tess_path:
        engines.append(f"Tesseract ({tess_path})")
    if easy:
        engines.append("EasyOCR (PyTorch)")
    if cv2_ok:
        engines.append("OpenCV")

    if engines:
        return {
            "result": f"OCR engines available: {', '.join(engines)}.",
            "installed": True,
            "engines": {"tesseract": bool(tess_path), "easyocr": easy, "opencv": cv2_ok},
            "tesseract_path": tess_path,
        }
    return {
        "result": (
            "No OCR engines are installed. OCR-based clicking (clickOnText) will not work. "
            "Install at least one: Tesseract (recommended): download from "
            "https://github.com/UB-Mannheim/tesseract/wiki — or EasyOCR: pip install easyocr. "
            "OpenCV (pip install opencv-python) improves preprocessing quality."
        ),
        "installed": False,
        "engines": {"tesseract": False, "easyocr": False, "opencv": False},
    }


__all__ = ["screen_resolution", "click_on_text", "find_on_screen", "ocr_status"]
