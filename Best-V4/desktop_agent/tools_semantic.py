"""
Semantic File Search — find files from a natural-language description.

Unlike `searchFiles` (exact glob) and `searchPcWide` (fuzzy path fragment),
this tool understands *intent*: "React project খুলে দাও", "গতকাল যেই PDF edit
করেছিলাম", "Web development folder-এর React file".

Approach (no heavy ML model — fast & dependency-free):
  1. Tokenize the query, strip English + Bangla stopwords, keep keywords and
     detect explicit file-type / project-type hints (react, pdf, python, …).
  2. Walk the safe roots (+ fixed drives when `pc_wide=True`), depth-limited.
  3. Score each candidate file/folder by:
       - filename token overlap with the query (highest weight)
       - extension match against the detected type hints
       - parent-directory name match (e.g. "Web development folder")
       - recency bonus (recently modified files rank higher)
       - fuzzy token similarity (lenient typo tolerance)
  4. Return the top-N ranked matches with scores; optionally open the best one.

This reuses the normalization + fixed-drive helpers from `tools_files` so the
two modules stay consistent. Safety: searches are confined to SAFE_ROOTS unless
`pc_wide` is explicitly requested (which then enumerates fixed drives only).
"""

from __future__ import annotations

import os
import re
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

from .registry import ToolError, register
from .tools_files import (
    HOME,
    SAFE_ROOTS,
    _get_fixed_drives,
    _normalize_for_match,
)


# ── Query understanding ─────────────────────────────────────────────────────

# Common English stopwords to drop from the query before tokenizing.
_EN_STOPWORDS: Set[str] = {
    "the", "a", "an", "of", "for", "to", "and", "or", "in", "on", "at", "is",
    "are", "was", "were", "be", "my", "me", "please", "open", "find", "get",
    "show", "give", "that", "this", "last", "yesterday", "today", "which", "i",
    "want", "need", "have", "had", "do", "does", "file", "files", "folder",
    "dir", "directory", "project", "thing", "stuff", "koro", "koroa", "dao",
    "kholo", "khulo", "khol", "theke", "ekta", "ekta", "amar", "amr",
}

# Bangla stopwords / filler words commonly used in mixed-language commands.
_BN_STOPWORDS: Set[str] = {
    "খুলে", "খোলো", "খোল", "খুল", "দাও", "করো", "কর", "এর", "এরটা", "আমার",
    "আম্মার", "যেই", "যে", "সেই", "টা", "টি", "গুলো", "গুলা", "কে", "থেকে",
    "একটা", "একটি", "প্লিজ", "নাও", "দেখাও", "বের", "করেছিলাম", "করেছিলেন",
    "ছিল", "ছিলাম", "গতকাল", "আজকে", "আজ",
}

# Map detected type hints → expected file extensions. Order matters: the first
# matching hint wins so a query like "react pdf" resolves to React source.
_TYPE_EXTENSIONS: List[Tuple[str, List[str]]] = [
    ("react", [".jsx", ".tsx", ".js", ".ts"]),
    ("next", [".tsx", ".jsx", ".ts", ".js"]),
    ("vue", [".vue"]),
    ("angular", [".ts", ".js"]),
    ("python", [".py"]),
    ("py", [".py"]),
    ("java", [".java"]),
    ("csharp", [".cs"]),
    ("c++", [".cpp", ".cc", ".hpp"]),
    ("cpp", [".cpp", ".cc", ".hpp"]),
    ("javascript", [".js", ".jsx"]),
    ("js", [".js"]),
    ("typescript", [".ts", ".tsx"]),
    ("ts", [".ts"]),
    ("html", [".html", ".htm"]),
    ("css", [".css", ".scss", ".sass"]),
    ("pdf", [".pdf"]),
    ("word", [".doc", ".docx"]),
    ("excel", [".xls", ".xlsx", ".csv"]),
    ("powerpoint", [".ppt", ".pptx"]),
    ("ppt", [".ppt", ".pptx"]),
    ("image", [".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp"]),
    ("photo", [".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp"]),
    ("video", [".mp4", ".mkv", ".avi", ".mov", ".webm"]),
    ("audio", [".mp3", ".wav", ".flac", ".aac", ".ogg"]),
    ("music", [".mp3", ".wav", ".flac", ".aac", ".ogg"]),
    ("json", [".json"]),
    ("config", [".json", ".yaml", ".yml", ".ini", ".env", ".toml"]),
    ("markdown", [".md", ".markdown"]),
    ("text", [".txt"]),
    ("zip", [".zip", ".rar", ".7z", ".tar", ".gz"]),
    ("database", [".db", ".sqlite", ".sql"]),
]


def _tokenize_query(query: str) -> Tuple[Set[str], List[str]]:
    """Return (meaningful_tokens, type_hints) extracted from a NL query.

    Splits on non-alphanumeric (incl. Bangla unicode), lowercases, drops
    stopwords, and keeps anything >= 2 chars. Type hints are the keys of
    `_TYPE_EXTENSIONS` that appear in the raw query.
    """
    raw_lower = query.lower()
    # Words: runs of ascii letters/digits OR Bangla letters.
    words = re.findall(r"[a-z0-9]+|[\u0980-\u09FF]+", raw_lower)

    tokens: Set[str] = set()
    for w in words:
        if len(w) < 2:
            continue
        if w in _EN_STOPWORDS or w in _BN_STOPWORDS:
            continue
        tokens.add(w)

    # Detect explicit type hints (substring match against the query).
    type_hints: List[str] = []
    for hint, _exts in _TYPE_EXTENSIONS:
        if hint in raw_lower and hint not in type_hints:
            type_hints.append(hint)

    return tokens, type_hints


def _extensions_for_hints(type_hints: List[str]) -> Set[str]:
    """Resolve a set of expected extensions from detected type hints."""
    exts: Set[str] = set()
    for hint in type_hints:
        for h, e in _TYPE_EXTENSIONS:
            if h == hint:
                exts.update(e)
                break
    return exts


# ── Candidate scoring ────────────────────────────────────────────────────────

def _score_candidate(
    path: Path,
    query_tokens: Set[str],
    type_exts: Set[str],
    folder_tokens: Set[str],
    now: float,
) -> float:
    """Score a single candidate path against the parsed query (0..~100)."""
    name = path.name
    name_norm = _normalize_for_match(name)
    # Split the filename into scoring tokens (camelCase aware).
    name_parts = set(re.findall(r"[a-z0-9]+", name.lower()))

    score = 0.0

    # 1. Direct token overlap with the filename (highest weight).
    if query_tokens:
        hit = len(query_tokens & name_parts)
        if hit:
            score += 35.0 * hit
        else:
            # Fuzzy: token-substring containment in the normalized name.
            fuzzy_hits = sum(
                1 for t in query_tokens if len(t) >= 3 and t in name_norm
            )
            score += 14.0 * fuzzy_hits

    # 2. Extension / type hint match.
    if type_exts:
        if path.suffix.lower() in type_exts:
            score += 25.0
    elif path.suffix == "":
        pass  # folders get scored via parent-path matching below

    # 3. Parent-directory / folder intent match (e.g. "Web development folder").
    if folder_tokens:
        try:
            parents = {p.lower() for p in path.parts[:-1]}
            parent_norm = _normalize_for_match("/".join(path.parts[:-1]))
            parent_hits = sum(1 for t in folder_tokens if t in parent_norm)
            score += 12.0 * parent_hits
        except Exception:
            pass

    # 4. Recency bonus — files touched in the last day get a boost, decaying
    #    over a week. Useful for "গতকাল যেই file edit করেছিলাম".
    try:
        mtime = path.stat().st_mtime
        age_days = max(0.0, (now - mtime) / 86400.0)
        if age_days < 1:
            score += 10.0
        elif age_days < 7:
            score += 5.0 * (1 - age_days / 7)
    except Exception:
        pass

    return score


# ── Search driver ────────────────────────────────────────────────────────────

# Skip these directory names to keep the walk fast and avoid junk.
_SKIP_DIRS: Set[str] = {
    "node_modules", ".git", ".svn", "__pycache__", ".venv", "venv", "env",
    ".idea", ".vscode", "dist", "build", ".next", ".cache", "site-packages",
    "AppData", "$Recycle.Bin", "System Volume Information", "Windows",
    "Program Files", "Program Files (x86)",
}


def _walk_for_candidates(roots: List[Path], max_depth: int, max_results: int) -> List[Path]:
    """Collect candidate files/folders under `roots`, depth-limited."""
    candidates: List[Path] = []
    for root in roots:
        if not root.exists():
            continue
        # os.walk with manual depth tracking.
        stack: List[Tuple[Path, int]] = [(root, 0)]
        while stack:
            current, depth = stack.pop()
            try:
                with os.scandir(current) as it:
                    for entry in it:
                        try:
                            name = entry.name
                            if name in _SKIP_DIRS:
                                continue
                            p = Path(entry.path)
                            candidates.append(p)
                            if len(candidates) >= max_results * 8:
                                return candidates
                            if entry.is_dir() and depth < max_depth:
                                stack.append((p, depth + 1))
                        except Exception:
                            continue
            except (PermissionError, OSError):
                continue
    return candidates


def _semantic_search(query: str, *, limit: int, max_depth: int, pc_wide: bool) -> List[Dict[str, Any]]:
    """Core search → list of {'path','name','score'} sorted by score desc."""
    tokens, type_hints = _tokenize_query(query)
    type_exts = _extensions_for_hints(type_hints)

    # Folder intent: tokens that look like a containing-folder name. We treat
    # every token as a potential folder hint — the parent-path scorer handles it.
    folder_tokens = set(tokens)

    # Choose search roots.
    roots = [HOME] + SAFE_ROOTS
    if pc_wide:
        for d in _get_fixed_drives():
            if d not in roots:
                roots.append(d)

    now = time.time()
    candidates = _walk_for_candidates(roots, max_depth=max_depth, max_results=limit)

    scored: List[Dict[str, Any]] = []
    for p in candidates:
        try:
            s = _score_candidate(p, tokens, type_exts, folder_tokens, now)
        except Exception:
            continue
        if s > 0:
            scored.append({"path": str(p), "name": p.name, "score": round(s, 1)})

    scored.sort(key=lambda d: d["score"], reverse=True)
    return scored[:limit]


# ── Registered tool ─────────────────────────────────────────────────────────

@register("semanticSearchFiles")
def semantic_search_files(args: Dict[str, Any]) -> Dict[str, Any]:
    """Find files/folders from a natural-language description.

    Understands intent + file-type hints + recency, so the user does not need
    to know the exact name.

    Examples:
      query="React project"              -> top react project folders/files
      query="গতকাল যেই PDF edit করেছিলাম"  -> recently-edited PDF files
      query="Web development React file" -> react source under web folders
      query="yesterday's PowerPoint"     -> recent .pptx files

    Options:
      pc_wide   (bool)  search all fixed drives (default False — safe roots)
      open      (bool)  open the best match (default True)
      limit     (int)   max results (default 8)
      max_depth (int)   walk depth (default 6)
    """
    query = args.get("query") or args.get("text") or args.get("q")
    if not query:
        raise ToolError("Parameter 'query' (natural-language description) is required.")
    limit = int(args.get("limit", 8))
    max_depth = int(args.get("max_depth", 6))
    pc_wide = bool(args.get("pc_wide", False))
    do_open = bool(args.get("open", True))

    matches = _semantic_search(
        str(query), limit=limit, max_depth=max_depth, pc_wide=pc_wide
    )
    if not matches:
        return {
            "result": f"No files matched '{query}'. Try broadening the search or enabling pc_wide.",
            "matches": [],
            "count": 0,
        }

    best = matches[0]
    opened = False
    if do_open:
        try:
            p = Path(best["path"])
            if p.is_dir():
                os.startfile(str(p))  # opens folder in Explorer
            else:
                os.startfile(str(p))  # opens with default app
            opened = True
        except Exception:
            pass

    summary = (
        f"Best match for '{query}': {best['name']} (score {best['score']}). "
        f"{len(matches)} result(s) found"
        + (f"; opened the best match." if opened else ".")
    )
    return {
        "result": summary,
        "matches": matches,
        "count": len(matches),
        "best": best["path"],
        "opened": opened,
    }


__all__ = ["semantic_search_files"]
