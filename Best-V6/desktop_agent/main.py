"""
MYRAA Desktop Control Agent — FastAPI entrypoint.

Thin dispatcher: every request is routed to a handler registered in the
central registry (`registry.TOOLS`). The handler modules
(`tools_pc`, `tools_browser`, `tools_files`, …) populate that registry via
their `@register(...)` decorators when `registry.load_all()` runs below.

Responsiveness (the historical "sleep/off" bug): no blocking work happens on
the asyncio event loop here. Pure-Python sync handlers are dispatched by
FastAPI's anyio threadpool, and the Playwright handlers in `tools_browser`
marshal onto a dedicated background event loop (see `_get_loop` there). This
keeps `/health` and every `/execute` responsive even while a heavy tool
(selenium-free browser launch, recursive file search, OCR) is in flight.

Contract with the Node bridge (server.ts `callDesktopAgent`):
  Request:  POST /execute  { "tool": "<name>", "args": { ... } }
  Response: 200  { "ok": true,  "result": <handler return value> }
            200  { "ok": false, "error": "<message>" }   (ToolError or unknown tool)
  Health:   GET  /health  -> { "ok": true, "tool_count": <N> }
"""

from __future__ import annotations

import logging
import os
from typing import Any, Dict

# ── DPI AWARENESS — MUST run BEFORE any GUI library import ───────────────────
# This is the ROOT FIX for every "mouse clicks at the wrong coordinate" bug.
# Windows display scaling (125%/150%/175%/200%) maps logical pixels to physical
# pixels differently. Without this call, pyautogui / Win32 APIs return logical
# coordinates that don't match the physical screen, so clicks land in the wrong
# place. We request PER_MONITOR_V2 awareness so every tool sees raw physical
# coordinates consistently. This must happen exactly ONCE, before pyautogui,
# mss, uiautomation, or any other GUI library is imported anywhere in the process.
try:
    import ctypes

    # PER_MONITOR_AWARE_V2 (2) — best available on Windows 10 1703+
    ctypes.windll.shcore.SetProcessDpiAwareness(2)
except Exception:
    try:
        ctypes.windll.user32.SetProcessDPIAware()
    except Exception:
        pass

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from .registry import TOOLS, ToolError, load_all

log = logging.getLogger("myraa.agent")
app = FastAPI(title="MYRAA Desktop Agent", version="1.0.0")

# Eagerly populate the registry. Each tool module is imported defensively
# inside load_all(), so one missing optional dependency can never make the
# whole agent unstartable — only that one tool becomes unavailable.
try:
    load_all()
    log.info("Loaded %d desktop tools: %s", len(TOOLS), ", ".join(sorted(TOOLS)))
except Exception:
    # A catastrophic import failure should still let the agent boot so /health
    # works and server.ts can report a meaningful error per-tool.
    log.exception("One or more tool modules failed to import; partial registry active.")


class ExecuteRequest(BaseModel):
    """Mirror of the payload server.ts posts at `callDesktopAgent`."""

    tool: str
    args: Dict[str, Any] = {}


def _dispatch(tool: str, args: Dict[str, Any]) -> Dict[str, Any]:
    """Run a registered tool and normalize the result for the Node bridge.

    Returns one of:
      {"ok": True,  "result": <handler return value>}
      {"ok": False, "error":  "<user-facing message>"}
    """
    handler = TOOLS.get(tool)
    if handler is None:
        log.warning("Unknown tool requested: %s", tool)
        return {
            "ok": False,
            "error": (
                f"Unknown tool '{tool}'. No handler is registered for it. "
                f"Available tools: {len(TOOLS)}."
            ),
        }
    
    # Snapshot cache invalidation for any state-modifying tool
    non_invalidating_tools = {
        "takeScreenshot",
        "saveScreenshot",
        "analyzeScreenshot",
        "readScreen",
        "desktopBrowserSnapshot",
        "browserSnapshot",
        "ocrHealthCheck",
        "desktopOcrHealthCheck",
        "systemInfo",
        "gpuInfo",
        "temperatureInfo",
        "getClipboard",
        "browserSessionStatus",
        "desktopBrowserSessionStatus",
        "getAutoStartStatus",
        "getMonitorInfo",
        "getActiveWindowInfo",
    }
    if tool not in non_invalidating_tools:
        try:
            from .tools_snapshot_manager import SNAPSHOT_CACHE
            SNAPSHOT_CACHE.invalidate()
        except Exception as ex:
            log.warning("Failed to invalidate SNAPSHOT_CACHE in _dispatch: %s", ex)

    try:
        result = handler(args)
        return {"ok": True, "result": result}
    except ToolError as e:
        log.info("ToolError in '%s': %s", tool, e.message)
        return {"ok": False, "error": e.message}
    except Exception as e:  # noqa: BLE001 - last-resort guard so one tool can't crash the agent
        log.exception("Unhandled error while running tool '%s'", tool)
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


@app.post("/execute")
def execute(req: ExecuteRequest) -> JSONResponse:
    # Pure sync handler dispatch + a dict lookup; the handler itself is what may
    # block, and FastAPI runs sync routes in a worker thread, so the event loop
    # (and therefore /health and other /execute calls) stays responsive.
    payload = _dispatch(req.tool, dict(req.args))
    return JSONResponse(payload)


@app.get("/health")
async def health() -> Dict[str, Any]:
    """Liveness + readiness probe used by server.ts before routing tools.

    `ok` mirrors the per-tool response shape so server.ts only needs one
    success-check; `tool_count` is a quick signal that load_all() succeeded.
    """
    return {"ok": True, "status": "running", "tool_count": len(TOOLS)}


@app.get("/")
async def root() -> Dict[str, Any]:
    return {"service": "MYRAA Desktop Agent", "tools": sorted(TOOLS.keys())}


# Allow `python -m desktop_agent.main` for parity, though run_agent.py is the
# real entrypoint used by the packaged app.
if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8765)
