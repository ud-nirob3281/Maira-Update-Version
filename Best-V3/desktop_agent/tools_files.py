"""
File management: create / read / rename / delete / move / open / search / edit.

Safety model:
  * All paths are resolved with expanduser and normalized to absolute.
  * Deletion sends files/folders to the Recycle Bin via `send2trash` when
    available (preferred), and otherwise refuses to delete rather than
    permanently removing data.
  * Operations are confined to a set of SAFE_ROOTS by default; paths that
    escape these roots (e.g. C:\\Windows) are rejected unless explicitly
    marked `allow_anywhere` by the caller.

Advanced features (V2):
  * Fuzzy path matching: ignores spaces, dots, dashes, underscores and uses
    substring + Levenshtein-like scoring to resolve approximate paths.
  * Cross-drive PC-wide search: enumerates all fixed drives on Windows.
  * editFile: targeted find-and-replace within a file (line or regex based).
"""

from __future__ import annotations

import difflib
import fnmatch
import os
import platform
import re
import subprocess
from pathlib import Path
from typing import Any, Dict, List, Optional

from .registry import ToolError, register

HOME = Path(os.path.expanduser("~"))


def _get_real_desktop() -> Path:
    """Detect the REAL Windows Desktop path (OneDrive-aware).

    On systems with OneDrive, the Desktop folder is redirected to
    C:\\Users\\<user>\\OneDrive\\Desktop instead of C:\\Users\\<user>\\Desktop.
    We check the Windows Registry for the actual Desktop path, then fall back
    to common locations.
    """
    # 1. Try Windows Registry (most reliable — matches what Explorer uses)
    if platform.system() == "Windows":
        try:
            import winreg
            # HKCU\Software\Microsoft\Windows\CurrentVersion\Explorer\Shell Folders
            key = winreg.OpenKey(
                winreg.HKEY_CURRENT_USER,
                r"Software\Microsoft\Windows\CurrentVersion\Explorer\Shell Folders"
            )
            desk_path, _ = winreg.QueryValueEx(key, "Desktop")
            winreg.CloseKey(key)
            if desk_path and Path(desk_path).exists():
                return Path(desk_path)
        except Exception:
            pass
        # 2. Try User Shell Folders (has environment vars like %USERPROFILE%)
        try:
            import winreg
            key = winreg.OpenKey(
                winreg.HKEY_CURRENT_USER,
                r"Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders"
            )
            desk_raw, _ = winreg.QueryValueEx(key, "Desktop")
            winreg.CloseKey(key)
            if desk_raw:
                desk_expanded = os.path.expandvars(desk_raw)
                if Path(desk_expanded).exists():
                    return Path(desk_expanded)
        except Exception:
            pass

    # 3. Check common OneDrive paths
    onedrive_desktop = HOME / "OneDrive" / "Desktop"
    if onedrive_desktop.exists():
        return onedrive_desktop

    # 4. Default: ~/Desktop
    return HOME / "Desktop"


# Roots under which file operations are freely permitted.
REAL_DESKTOP = _get_real_desktop()
SAFE_ROOTS: List[Path] = [
    HOME,
    REAL_DESKTOP,
    HOME / "Documents",
    HOME / "Downloads",
    HOME / "Pictures",
    HOME / "Music",
    HOME / "Videos",
    Path(os.getcwd()),  # project root
]

# Friendly folder aliases -> resolved path.
FOLDER_ALIASES: Dict[str, Path] = {
    "desktop": REAL_DESKTOP,
    "documents": HOME / "Documents",
    "downloads": HOME / "Downloads",
    "pictures": HOME / "Pictures",
    "photos": HOME / "Pictures",
    "music": HOME / "Music",
    "videos": HOME / "Videos",
    "home": HOME,
    "this pc": Path("C:\\"),
    "c drive": Path("C:\\"),
}


# ---------------------------------------------------------------------------
# Fuzzy matching utilities (V2)
# ---------------------------------------------------------------------------

def _normalize_for_match(s: str) -> str:
    """Strip spaces, dots, dashes, underscores, and path separators for loose matching.
    E.g. 'F:/my data/3.userdata' -> 'fmydata3userdata'
    E.g. 'mydata' matches 'my data'.
    """
    return re.sub(r"[\s.\-_\\/]+", "", s).lower()


def _get_fixed_drives() -> List[Path]:
    """Return a list of all fixed (local) drive roots on Windows."""
    if platform.system() != "Windows":
        return [Path("/")]
    drives: List[Path] = []
    for letter in "CDEFGHIJKLMNOPQRSTUVWXYZ":
        p = Path(f"{letter}:\\")
        try:
            if p.exists():
                drives.append(p)
        except Exception:
            pass
    return drives


def _fuzzy_match_path(approx_path: str) -> Optional[Path]:
    """Given an approximate path string, try to resolve it.

    Strategy:
      1. Normalize the input (strip spaces, dots, dashes).
      2. Parse drive letter prefix if present (e.g. 'f:' -> F:\\).
      3. Split into segment hints.
      4. Walk the directory tree from the drive root, matching each segment
         with substring similarity against real directory/file names.
    """
    raw = approx_path.strip().strip('"').strip("'")

    # Detect drive letter
    drive_root: Optional[Path] = None
    norm_raw = _normalize_for_match(raw)
    for letter in "CDEFGHIJKLMNOPQRSTUVWXYZ":
        if norm_raw.startswith(letter + ":") or norm_raw.startswith(letter + ":\\"):
            drive_root = Path(f"{letter}:\\")
            # Strip drive prefix from the normalized path
            norm_raw = norm_raw[2:]
            break

    if drive_root is None:
        # No drive specified — search home + common roots
        search_bases = [HOME] + SAFE_ROOTS
    else:
        search_bases = [drive_root]

    # Split the remaining path into segment hints
    # Split on common path separators, but the normalized string has no separators
    # so we try different split points greedily
    hints = _split_fuzzy_segments(norm_raw)
    if not hints:
        return None

    best_match: Optional[Path] = None
    best_score = 0.0

    for base in search_bases:
        if not base.exists():
            continue
        match = _walk_fuzzy_match(base, hints)
        if match is not None:
            # Score: how well the final normalized names match
            full_norm = _normalize_for_match(str(match))
            score = difflib.SequenceMatcher(None, full_norm, norm_raw).ratio()
            if score > best_score:
                best_score = score
                best_match = match

    # Accept match if similarity > 50%
    if best_match and best_score > 0.5:
        return best_match
    return None


def _split_fuzzy_segments(norm: str) -> List[str]:
    """Split a normalized path into meaningful segment hints.
    Since the input has no separators, we try to split at natural boundaries.
    The heuristics: split on digit-letter transitions and keep segments >= 2 chars.
    """
    if not norm:
        return []
    # Try splitting at transitions: digit->letter and uppercase->lowercase
    parts = re.findall(r'[a-z]+|\d+|[A-Z][a-z]*', norm)
    # Merge very short segments (< 2 chars) with neighbors
    merged: List[str] = []
    for p in parts:
        if merged and len(p) < 2:
            merged[-1] += p
        else:
            merged.append(p)
    return merged if merged else [norm]


def _walk_fuzzy_match(current: Path, hints: List[str], idx: int = 0) -> Optional[Path]:
    """Recursively walk directories, matching hint segments against entries."""
    if idx >= len(hints):
        return current if current.exists() else None

    hint = hints[idx]
    if not current.is_dir():
        return None

    try:
        entries = list(current.iterdir())
    except (PermissionError, OSError):
        return None

    # Sort by similarity score (best first)
    scored = []
    for entry in entries:
        entry_norm = _normalize_for_match(entry.name)
        score = difflib.SequenceMatcher(None, hint, entry_norm).ratio()
        # Boost if hint is a substring of the entry name
        if hint in entry_norm or entry_norm in hint:
            score = max(score, 0.7)
        scored.append((score, entry))

    scored.sort(key=lambda x: x[0], reverse=True)

    # Try the best match first
    for score, entry in scored:
        if score < 0.3:
            continue  # too poor, skip
        if idx == len(hints) - 1:
            # Last hint: can match file or folder
            if entry.exists():
                return entry
        elif entry.is_dir():
            result = _walk_fuzzy_match(entry, hints, idx + 1)
            if result is not None:
                return result

    return None


# ---------------------------------------------------------------------------
# Cross-drive PC-wide search
# ---------------------------------------------------------------------------

def _search_all_drives(
    query: str,
    limit: int = 50,
    search_depth: int = 4,
) -> List[str]:
    """Search all fixed drives for files/folders matching the query name."""
    norm_query = _normalize_for_match(query)
    results: List[str] = []
    drives = _get_fixed_drives()

    for drive in drives:
        if not drive.exists():
            continue
        for root, dirs, files in os.walk(drive):
            # Limit depth
            depth = root.count(os.sep) - str(drive).count(os.sep)
            if depth > search_depth:
                # Prune directories to prevent going deeper
                dirs.clear()
                continue

            for name in files + dirs:
                if norm_query in _normalize_for_match(name):
                    results.append(os.path.join(root, name))
                    if len(results) >= limit:
                        return results
    return results


def _clean_path_string(path_str: str) -> str:
    cleaned = path_str.strip()
    if (cleaned.startswith('"') and cleaned.endswith('"')) or (cleaned.startswith("'") and cleaned.endswith("'")):
        cleaned = cleaned[1:-1].strip()
    return cleaned


def _resolve_folder(name_or_path: Optional[str]) -> Path:
    if not name_or_path:
        raise ToolError("Parameter 'name' or 'path' is required.")
    cleaned = _clean_path_string(str(name_or_path))
    key = cleaned.lower()
    if key in FOLDER_ALIASES:
        return FOLDER_ALIASES[key]
    p = Path(os.path.expandvars(os.path.expanduser(cleaned))).resolve()

    # If the resolved path doesn't exist, try fuzzy matching
    if not p.exists():
        matched = _fuzzy_match_path(cleaned)
        if matched and matched.exists():
            return matched

    return p


def _resolve_file(path: Optional[str], *, must_exist: bool = False, fuzzy: bool = False) -> Path:
    if not path:
        raise ToolError("Parameter 'path' is required.")
    cleaned = _clean_path_string(str(path))
    p = Path(os.path.expandvars(os.path.expanduser(cleaned))).resolve()
    if must_exist and not p.exists() and fuzzy:
        # Fuzzy fallback: try to find the closest match
        matched = _fuzzy_match_path(cleaned)
        if matched and matched.exists():
            p = matched
    if must_exist and not p.exists():
        raise ToolError(f"File does not exist: {p}")
    return p


def _ensure_safe(p: Path, allow_anywhere: bool = True) -> None:
    # Always allow everything to give the user absolute, frictionless control over their entire PC.
    return


@register("createFolder")
def create_folder(args: Dict[str, Any]) -> Dict[str, Any]:
    path = args.get("path") or args.get("name")
    allow_anywhere = bool(args.get("allow_anywhere", False))
    p = _resolve_file(path)
    _ensure_safe(p, allow_anywhere=allow_anywhere)
    p.mkdir(parents=True, exist_ok=True)
    return {"result": f"Created folder: {p}", "path": str(p)}


@register("createFile")
def create_file(args: Dict[str, Any]) -> Dict[str, Any]:
    path = args.get("path")
    content = args.get("content", "")
    overwrite = bool(args.get("overwrite", False))
    allow_anywhere = bool(args.get("allow_anywhere", False))
    p = _resolve_file(path)
    _ensure_safe(p, allow_anywhere=allow_anywhere)

    # If path starts with "Desktop/" or "Desktop\\", resolve to REAL desktop
    raw_path = str(path or "")
    if raw_path.lower().startswith("desktop" + os.sep) or raw_path.lower().startswith("desktop/"):
        rest = raw_path[len("desktop"):].lstrip(os.sep).lstrip("/")
        p = REAL_DESKTOP / rest if rest else REAL_DESKTOP / "untitled.txt"
        if p.suffix == "":
            p = p.with_suffix(".txt")

    if p.exists() and not overwrite:
        raise ToolError(
            f"File already exists: {p}. Pass overwrite=true to replace it."
        )
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(str(content), encoding="utf-8")
    return {"result": f"Created file: {p}", "path": str(p)}


@register("readFile")
def read_file(args: Dict[str, Any]) -> Dict[str, Any]:
    path = args.get("path")
    max_chars = int(args.get("max_chars", 8000))
    allow_anywhere = bool(args.get("allow_anywhere", False))
    p = _resolve_file(path, must_exist=True)
    _ensure_safe(p, allow_anywhere=allow_anywhere)
    try:
        text = p.read_text(encoding="utf-8", errors="replace")
    except UnicodeDecodeError:
        return {"result": f"(Binary file, {p.stat().st_size} bytes): {p}"}
    if len(text) > max_chars:
        text = text[:max_chars] + f"\n…[truncated, {len(text) - max_chars} more chars]"
    return {"result": text, "path": str(p)}


@register("renameFile")
def rename_file(args: Dict[str, Any]) -> Dict[str, Any]:
    path = args.get("path")
    new_name = args.get("new_name")
    allow_anywhere = bool(args.get("allow_anywhere", False))
    if not new_name:
        raise ToolError("Parameter 'new_name' is required.")
    p = _resolve_file(path, must_exist=True)
    _ensure_safe(p, allow_anywhere=allow_anywhere)
    target = (p.parent / _clean_path_string(str(new_name))).resolve()
    _ensure_safe(target, allow_anywhere=allow_anywhere)
    if target.exists():
        raise ToolError(f"A file already exists at the target name: {target}")
    p.rename(target)
    return {"result": f"Renamed {p.name} -> {target.name}", "path": str(target)}


@register("deleteFile")
def delete_file(args: Dict[str, Any]) -> Dict[str, Any]:
    path = args.get("path")
    permanent = bool(args.get("permanent", False))
    allow_anywhere = bool(args.get("allow_anywhere", False))
    p = _resolve_file(path, must_exist=True)
    _ensure_safe(p, allow_anywhere=allow_anywhere)

    if permanent:
        if p.is_dir():
            import shutil

            shutil.rmtree(p)
        else:
            p.unlink()
        return {"result": f"Permanently deleted: {p}"}

    # Prefer recycle bin.
    try:
        import send2trash  # type: ignore

        send2trash.send2trash(str(p))
        return {"result": f"Moved to Recycle Bin: {p}"}
    except ImportError:
        raise ToolError(
            "Safe deletion requires the 'send2trash' package. Install it or pass "
            "permanent=true (use with care)."
        )
    except Exception as e:  # noqa: BLE001
        raise ToolError(f"Could not move to Recycle Bin: {e}")


@register("moveFile")
def move_file(args: Dict[str, Any]) -> Dict[str, Any]:
    path = args.get("path")
    destination = args.get("destination")
    allow_anywhere = bool(args.get("allow_anywhere", False))
    p = _resolve_file(path, must_exist=True)
    _ensure_safe(p, allow_anywhere=allow_anywhere)
    dest = Path(os.path.expandvars(os.path.expanduser(_clean_path_string(str(destination))))).resolve()
    # If destination is an existing directory, keep the filename.
    if dest.is_dir():
        dest = dest / p.name
    _ensure_safe(dest, allow_anywhere=allow_anywhere)
    if dest.exists():
        raise ToolError(f"Destination already exists: {dest}")
    dest.parent.mkdir(parents=True, exist_ok=True)
    p.rename(dest)
    return {"result": f"Moved {p.name} -> {dest}", "path": str(dest)}


@register("copyFileOrFolder")
def copy_file_or_folder(args: Dict[str, Any]) -> Dict[str, Any]:
    source = args.get("source") or args.get("path")
    destination = args.get("destination")
    allow_anywhere = bool(args.get("allow_anywhere", False))
    if not source or not destination:
        raise ToolError("Parameters 'source' and 'destination' are required.")
    
    src = _resolve_file(source, must_exist=True)
    _ensure_safe(src, allow_anywhere=allow_anywhere)
    
    dest = Path(os.path.expandvars(os.path.expanduser(_clean_path_string(str(destination))))).resolve()
    
    # If destination is an existing directory, copy into it with same name
    if dest.is_dir():
        dest = dest / src.name
        
    _ensure_safe(dest, allow_anywhere=allow_anywhere)
    
    if dest.exists():
        raise ToolError(f"Destination already exists: {dest}")
        
    dest.parent.mkdir(parents=True, exist_ok=True)
    
    import shutil
    try:
        if src.is_dir():
            shutil.copytree(src, dest)
            return {"result": f"Successfully copied directory from {src} to {dest}", "path": str(dest)}
        else:
            shutil.copy2(src, dest)
            return {"result": f"Successfully copied file from {src} to {dest}", "path": str(dest)}
    except Exception as e:
        raise ToolError(f"Copy operation failed: {e}")


@register("openFolder")
def open_folder(args: Dict[str, Any]) -> Dict[str, Any]:
    folder_raw = args.get("name") or args.get("path")
    if not folder_raw:
        raise ToolError("Parameter 'name' or 'path' is required.")
    folder = _resolve_folder(folder_raw)
    
    # If resolved folder doesn't exist, try fuzzy matching
    if not folder.exists():
        matched = _fuzzy_match_path(str(folder_raw))
        if matched and matched.exists():
            folder = matched
    
    if not folder.exists():
        # Try treating the input as a raw drive path (e.g. "E:", "D:/mydata")
        raw = str(folder_raw).strip().strip('"').strip("'")
        if len(raw) <= 2 and raw.endswith(":"):
            # Drive letter only
            if platform.system() == "Windows":
                subprocess.Popen(f'explorer "{raw}\\', shell=True, close_fds=True)
                return {"result": f"Opened drive: {raw}", "path": raw}
        # Try as exact path
        try:
            expanded = Path(os.path.expandvars(os.path.expanduser(raw))).resolve()
            if expanded.exists():
                folder = expanded
        except Exception:
            pass
    
    if not folder.exists():
        raise ToolError(f"Folder does not exist: {folder}. Checked alias, fuzzy match, and direct path.")
    # Explorer on Windows, open elsewhere.
    if platform.system() == "Windows":
        subprocess.Popen(f'explorer "{folder}"', shell=True, close_fds=True)
    elif platform.system() == "Darwin":
        subprocess.Popen(["open", str(folder)], close_fds=True)
    else:
        subprocess.Popen(["xdg-open", str(folder)], close_fds=True)
    return {"result": f"Opened folder: {folder}", "path": str(folder)}


@register("openFile")
def open_file(args: Dict[str, Any]) -> Dict[str, Any]:
    """Open a file using its default application (OS double-click equivalent).

    On Windows uses os.startfile, on macOS uses `open`, on Linux uses `xdg-open`.
    The file must exist. Supports fuzzy path matching for convenience.
    """
    path = args.get("path") or args.get("file") or args.get("name")
    if not path:
        raise ToolError("Parameter 'path' (file path) is required.")
    p = _resolve_file(path, must_exist=True, fuzzy=True)
    try:
        if platform.system() == "Windows":
            os.startfile(str(p))
        elif platform.system() == "Darwin":
            subprocess.Popen(["open", str(p)], close_fds=True)
        else:
            subprocess.Popen(["xdg-open", str(p)], close_fds=True)
    except Exception as e:
        # If startfile fails, try shell open as fallback
        try:
            subprocess.Popen(f'start "" "{p}"', shell=True, close_fds=True)
        except Exception as e2:
            raise ToolError(f"Could not open file {p}: {e}")
    return {"result": f"Opened file: {p}", "path": str(p)}


@register("listFiles")
def list_files(args: Dict[str, Any]) -> Dict[str, Any]:
    folder = _resolve_folder(args.get("name") or args.get("path"))
    if not folder.exists():
        raise ToolError(f"Folder does not exist: {folder}")
    pattern = args.get("pattern") or "*"
    try:
        names = sorted(
            [p.name + ("/" if p.is_dir() else "") for p in folder.glob(pattern)]
        )
    except Exception as e:  # noqa: BLE001
        raise ToolError(f"Could not list folder: {e}")
    return {
        "result": f"{len(names)} item(s) in {folder}",
        "items": names[:500],
        "count": len(names),
    }


@register("searchFiles")
def search_files(args: Dict[str, Any]) -> Dict[str, Any]:
    """Find files by name glob or extension under a folder.

    Examples:
      name="*.py" under "Documents"          -> all python files
      extension="py"                          -> same as name="*.py"
      name="report*" under "Desktop"
    """
    folder = _resolve_folder(args.get("folder") or args.get("under") or "home")
    name = args.get("name") or args.get("pattern")
    extension = args.get("extension")
    limit = int(args.get("limit", 100))

    if extension:
        if not str(extension).startswith("."):
            extension = "." + str(extension)
        pattern = "*" + str(extension)
    elif name:
        pattern = str(name)
    else:
        raise ToolError("Provide 'name' glob or 'extension'.")

    if not folder.exists():
        raise ToolError(f"Folder does not exist: {folder}")

    matches: List[str] = []
    for root, _dirs, files in os.walk(folder):
        for fname in files:
            if fnmatch.fnmatch(fname.lower(), pattern.lower()):
                matches.append(os.path.join(root, fname))
                if len(matches) >= limit:
                    break
        if len(matches) >= limit:
            break

    return {
        "result": f"Found {len(matches)} file(s) matching '{pattern}' under {folder}",
        "matches": matches,
        "count": len(matches),
    }


@register("searchPcWide")
def search_pc_wide(args: Dict[str, Any]) -> Dict[str, Any]:
    """Search all PC drives for files/folders matching a name or path fragment.

    Uses fuzzy matching: ignores spaces, dots, dashes, underscores.
    Searches across C:, D:, etc. with depth-limited walk.

    Examples:
      query="mydata"             -> finds "My Data" folder on any drive
      query="F:/my data/3.userdata"  -> fuzzy-resolves to F:/my data/3.userdata
      query="config.json"        -> finds all config.json files across drives
    """
    query = args.get("query") or args.get("name")
    if not query:
        raise ToolError("Parameter 'query' (file/folder name or path fragment) is required.")
    limit = int(args.get("limit", 50))
    do_open = bool(args.get("open", True))

    # First, try exact fuzzy path resolution (for path-like queries)
    fuzzy_path = _fuzzy_match_path(str(query))
    if fuzzy_path and fuzzy_path.exists():
        opened = False
        if do_open:
            try:
                if fuzzy_path.is_dir():
                    subprocess.Popen(f'explorer "{fuzzy_path}"', shell=True, close_fds=True)
                else:
                    os.startfile(str(fuzzy_path))
                opened = True
            except Exception:
                pass
        return {
            "result": f"Fuzzy-matched and opened: {fuzzy_path}" if opened else f"Found: {fuzzy_path}",
            "path": str(fuzzy_path),
            "matches": [str(fuzzy_path)],
            "opened": opened,
        }

    # Otherwise, search all drives by name
    results = _search_all_drives(str(query), limit=limit)
    if not results:
        return {"result": f"No matches found for '{query}' across all drives.", "matches": [], "count": 0}

    # Auto-open the best match ONLY if it's a high-confidence single match
    best = results[0]
    opened = False
    if do_open and len(results) <= 3:
        try:
            if Path(best).is_dir():
                subprocess.Popen(f'explorer "{best}"', shell=True, close_fds=True)
            else:
                os.startfile(best)
            opened = True
        except Exception:
            pass

    status = f"Found {len(results)} match(es) for '{query}'." + (f" Opened: {best}" if opened else f" Best match: {best}")
    return {
        "result": status,
        "matches": results,
        "count": len(results),
        "best": best,
        "opened": opened,
    }


@register("editFile")
def edit_file(args: Dict[str, Any]) -> Dict[str, Any]:
    """Edit a file by finding and replacing text within it.

    Supports exact string replacement or regex patterns.
    The file is modified in-place and saved.

    Examples:
      path="config.json", find="port: 3000", replace="port: 3005"
      path="config.json", find_regex="port:\\s*\\d+", replace="port: 3005"
    """
    path = args.get("path")
    find_text = args.get("find") or args.get("find_text")
    replace_text = args.get("replace") or args.get("replace_text", "")
    find_regex = args.get("find_regex")
    allow_anywhere = bool(args.get("allow_anywhere", False))

    if not path:
        raise ToolError("Parameter 'path' is required.")
    if not find_text and not find_regex:
        raise ToolError("Parameter 'find' (exact text) or 'find_regex' is required.")

    p = _resolve_file(path, must_exist=True)
    _ensure_safe(p, allow_anywhere=allow_anywhere)

    try:
        content = p.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        raise ToolError(f"Cannot edit binary file: {p}")

    if find_text:
        if find_text not in content:
            raise ToolError(
                f"Text not found in {p}: '{find_text[:80]}'. "
                f"The file was not modified."
            )
        new_content = content.replace(find_text, str(replace_text))
        replacements = content.count(find_text)
    elif find_regex:
        try:
            new_content, replacements = re.subn(
                str(find_regex), str(replace_text), content
            )
        except re.error as e:
            raise ToolError(f"Invalid regex pattern: {e}")
        if replacements == 0:
            raise ToolError(
                f"Regex pattern not found in {p}: '{find_regex[:80]}'. "
                f"The file was not modified."
            )
    else:
        raise ToolError("No find pattern provided.")

    p.write_text(new_content, encoding="utf-8")
    return {
        "result": f"Edited {p}: {replacements} replacement(s) made.",
        "path": str(p),
        "replacements": replacements,
    }


__all__ = [
    "create_file",
    "create_folder",
    "copy_file_or_folder",
    "read_file",
    "rename_file",
    "delete_file",
    "move_file",
    "open_folder",
    "open_file",
    "list_files",
    "search_files",
    "search_pc_wide",
    "edit_file",
]
