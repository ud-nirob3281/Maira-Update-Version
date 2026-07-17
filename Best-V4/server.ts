import express from "express";
import http from "http";
import path from "path";
import { spawn, execSync } from "child_process";
import { WebSocketServer } from "ws";
import { GoogleGenAI, Modality, Type, LiveServerMessage } from "@google/genai";
import dotenv from "dotenv";
import * as fs from "fs";
import { 
  loadMemories, 
  saveMemories, 
  formatSystemInstructionsWithMemories, 
  processConversationSlice 
} from "./server_memory";
import { Memory } from "./src/lib/memoryTypes";
import {
  DATA_DIR,
  dataFile,
  getGeminiApiKey,
  hasGeminiApiKey,
  setGeminiApiKey,
} from "./server_paths";

dotenv.config();

// ---------------------------------------------------------------------------
// MYRAA V2 — Logging (Feature 7).
// Appends timestamped lines to logs/{commands,startup,errors}.log.
// Never throws; logging failures are swallowed so they can't break the app.
// ---------------------------------------------------------------------------
const LOGS_DIR = path.join(DATA_DIR, "logs");
try { fs.mkdirSync(LOGS_DIR, { recursive: true }); } catch { /* already exists */ }

function appendLog(fileName: string, message: string): void {
  try {
    const line = `[${new Date().toISOString()}] ${message}\n`;
    fs.appendFile(path.join(LOGS_DIR, fileName), line, () => {});
  } catch {
    /* logging is best-effort */
  }
}
const logCommand = (m: string) => appendLog("commands.log", m);
const logStartup = (m: string) => appendLog("startup.log", m);
const logError = (m: string) => appendLog("errors.log", m);

// ---------------------------------------------------------------------------
// Emotion classification (Fix 4) — drives the assistant's on-screen video.
//
// A lightweight keyword scan over the model's spoken text. No extra API call,
// no latency: it runs in microseconds per chunk and emits a single WS frame
// `{"type":"emotion","emotion":"<mood>"}` to the client whenever the detected
// mood changes. The frontend maps this to MyraaCoreVisualizer's video set.
// ---------------------------------------------------------------------------
type MyraaEmotion =
  | "idle" | "playful" | "happy" | "excited" | "curious" | "thinking"
  | "proud" | "sad" | "surprised" | "embarrassed" | "confused" | "angry";

// Ordered most-specific → least-specific so "I'm so frustrated" wins over a
// generic positivity match. Each entry is a list of substring cues.
const EMOTION_KEYWORDS: { emotion: MyraaEmotion; cues: string[] }[] = [
  { emotion: "angry",      cues: ["angry", "furious", "frustrated", "annoyed", "irritated", "mad at", "fed up", "that's unacceptable"] },
  { emotion: "sad",        cues: ["sad", "sorry to hear", "unfortunately", "heartbroken", "disappointed", "i understand how tough", "rough time"] },
  { emotion: "surprised",  cues: ["wow", "oh my", "no way", "incredible", "unbelievable", "that's surprising", "didn't expect"] },
  { emotion: "excited",    cues: ["exciting", "amazing", "awesome", "fantastic", "let's do it", "can't wait", "this is great", "love that"] },
  { emotion: "playful",    cues: ["haha", "lol", "just kidding", "funny", "silly", "teasing", "gotcha"] },
  { emotion: "proud",      cues: ["proud of you", "well done", "great job", "you did it", "congrats", "congratulations", "nailed it"] },
  { emotion: "happy",      cues: ["happy", "glad", "wonderful", "delightful", "perfect", "sounds good", "love this", "that's great"] },
  { emotion: "curious",    cues: ["interesting", "let's explore", "tell me more", "what do you think", "curious", "shall we"] },
  { emotion: "thinking",   cues: ["let me think", "hmm", "let's see", "i suppose", "considering", "on the other hand"] },
  { emotion: "embarrassed",cues: ["oops", "my mistake", "sorry about that", "i apologize", "my bad"] },
  { emotion: "confused",   cues: ["i'm not sure", "confused", "could you clarify", "what do you mean", "pardon"] },
];

let lastEmotion: MyraaEmotion = "idle";

/**
 * Scan a chunk of the model's spoken text for the strongest mood cue and
 * return it, or null if nothing matches (caller keeps the previous mood).
 */
function classifyEmotion(text: string): MyraaEmotion | null {
  const lower = text.toLowerCase();
  if (!lower.trim()) return null;
  for (const { emotion, cues } of EMOTION_KEYWORDS) {
    for (const cue of cues) {
      if (lower.includes(cue)) return emotion;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// MYRAA Desktop Control Agent — HTTP bridge to the Python FastAPI backend.
// ---------------------------------------------------------------------------
const DESKTOP_AGENT_URL = process.env.DESKTOP_AGENT_URL || "http://127.0.0.1:8765";
const DESKTOP_AGENT_TIMEOUT = 25_000; // ms

/**
 * The complete set of tool names routed to the Python desktop agent.
 * Kept in sync with desktop_agent/registry.py DESKTOP_TOOL_NAMES.
 */
const DESKTOP_TOOLS: ReadonlySet<string> = new Set([
  // applications / websites / search
  "openApplication", "closeApplication", "openWebsite",
  "searchWeb", "searchYouTube", "searchGoogle", "searchGitHub",
  // files
  "createFile", "createFolder", "readFile", "renameFile", "deleteFile", "moveFile",
  "openFolder", "openFile", "listFiles", "searchFiles", "searchPcWide", "editFile",
  // pc control (volume + gated power)
  "volumeUp", "volumeDown", "muteToggle", "setVolume",
  "requestPowerAction", "executePowerAction",
  // windows
  "minimizeWindow", "maximizeWindow", "closeWindow", "switchApplication",
  // mouse & keyboard input control (V2)
  "moveCursor", "mouseClick", "typeText", "pressKey", "sendHotkey", "scrollMouse",
  // mouse drag, smooth scroll, text selection (V3)
  "mouseDrag", "scrollSmooth", "scrollUntilVisible", "selectText",
  // window/monitor info (V3)
  "getMonitorInfo", "getActiveWindowInfo",
  // smart visual clicking (V3)
  "screenResolution", "clickOnText", "findOnScreen",
  // clipboard
  "copySelected", "pasteClipboard", "getClipboard", "clearClipboard",
  // screenshot / screen reading
  "takeScreenshot", "saveScreenshot", "analyzeScreenshot", "readScreen",
  // browser automation (Playwright — desktop-owned, separate from holographic UI)
  "desktopBrowserOpen", "desktopBrowserNavigate", "desktopBrowserOpenTab",
  "desktopBrowserCloseTab", "desktopBrowserSearch", "desktopBrowserClick",
  "desktopBrowserType", "desktopBrowserFillForm", "desktopBrowserGoBack",
  "desktopBrowserGoForward", "desktopBrowserScroll",
  "desktopBrowserSnapshot", "desktopBrowserScreenshot", "desktopBrowserGetText",
  "desktopBrowserListTabs", "desktopBrowserSwitchTab", "desktopBrowserPressKey",
  "desktopBrowserMediaControl", "desktopBrowserClose",
  "desktopBrowserReadElement", "browserReadElement",
  "browserOpen", "browserSearch", "browserClick", "browserMediaControl",
  "browserScroll", "browserType", "browserGoBack", "browserTabAction",
  "browserSnapshot", "browserScreenshot", "browserGetText",
  "browserListTabs", "browserSwitchTab", "browserPressKey",
  "browserFillForm", "browserNavigate", "browserClose",
  // V3 advanced browser tools
  "browserGoForward", "desktopBrowserGoForward",
  "browserRefresh", "desktopBrowserRefresh",
  "browserDuplicateTab", "desktopBrowserDuplicateTab",
  "browserPinTab", "desktopBrowserPinTab",
  "browserBookmark", "desktopBrowserBookmark",
  "browserPageSearch", "desktopBrowserPageSearch",
  "browserZoom", "desktopBrowserZoom",
  "browserDoubleClick", "desktopBrowserDoubleClick",
  "browserRightClick", "desktopBrowserRightClick",
  "browserDragAndDrop", "desktopBrowserDragAndDrop",
  "browserSelectText", "desktopBrowserSelectText",
  "browserListDownloads", "desktopBrowserListDownloads",
  "browserUploadFile", "desktopBrowserUploadFile",
  "browserPrintToPDF", "desktopBrowserPrintToPDF",
  "browserDismissPopups", "desktopBrowserDismissPopups",
  "browserInfiniteScroll", "desktopBrowserInfiniteScroll",
  "browserWaitForElement", "desktopBrowserWaitForElement",
  // semantic / intent-based file search ("React project খুলো")
  "semanticSearchFiles",
  // coding assistance
  "createPythonFile", "runPythonScript", "createProjectFolder", "writeCodeFile",
  // system information
  "systemInfo", "gpuInfo", "temperatureInfo",
  // brightness control (V2)
  "brightnessUp", "brightnessDown", "setBrightness",
  // Windows auto-start management (V2)
  "enableAutoStart", "disableAutoStart", "getAutoStartStatus",
  // Recycle Bin (V3)
  "clearRecycleBin",
  // Browser Session Manager
  "browserSessionStatus", "desktopBrowserSessionStatus",
  "browserSessionClose", "desktopBrowserSessionClose",
  "browserSessionRestore", "desktopBrowserSessionRestore",
  // OCR Health Check
  "ocrHealthCheck", "desktopOcrHealthCheck",
]);

/**
 * Call the Python desktop agent.  Returns the parsed JSON response.
 * If the agent is unreachable, returns a user-friendly error payload.
 */
/**
 * Whether the desktop agent has been confirmed alive in this process lifetime.
 * If false, callDesktopAgent will probe /health and attempt an auto-spawn.
 */
let desktopAgentVerified = false;

/**
 * Auto-spawn the Python desktop agent as a detached child process if it is not
 * already listening. Looks for the project's bundled Python interpreter first,
 * falling back to `python` / `python3` on PATH. Runs detached so it survives
 * even if MYRAA's node process is killed.
 */
function spawnDesktopAgent(): void {
  const agentEnv = {
    ...process.env,
    MYRAA_AGENT_HOST: "127.0.0.1",
    MYRAA_AGENT_PORT: "8765",
  };

  // Preferred path (packaged app): a PyInstaller-frozen agent exe that embeds
  // its own Python runtime. Set by the Electron main process via MYRAA_AGENT_EXE.
  const frozenExe = process.env.MYRAA_AGENT_EXE;
  if (frozenExe && fs.existsSync(frozenExe)) {
    try {
      const child = spawn(frozenExe, [], {
        cwd: path.dirname(frozenExe),
        detached: true,
        stdio: "ignore",
        windowsHide: true, // never flash a console window
        env: agentEnv,
      });
      child.unref();
      logStartup(`AGENT_SPAWN frozen exe pid=${child.pid} path=${frozenExe}`);
      console.log(`[Desktop Agent] Launched frozen agent (PID ${child.pid}).`);
      return;
    } catch (e: any) {
      logError(`AGENT_SPAWN_FROZEN_FAILED: ${e?.message || e}`);
      // fall through to the Python path below
    }
  }

  // Development fallback: run the agent from source using a local Python.
  // Detection order: env var → `py` launcher → common install paths → PATH
  const candidates = [
    process.env.MYRAA_PYTHON,
    "py",                                                           // Windows Python Launcher
    "C:\\Users\\mdnir\\AppData\\Local\\Programs\\Python\\Python314\\python.exe",  // User's Python
    process.env.LOCALAPPDATA + "\\Programs\\Python\\Python314\\python.exe",
    process.env.LOCALAPPDATA + "\\Programs\\Python\\Python313\\python.exe",
    process.env.LOCALAPPDATA + "\\Programs\\Python\\Python312\\python.exe",
    process.env.LOCALAPPDATA + "\\Programs\\Python\\Python311\\python.exe",
    "python",
    "python3",
  ].filter(Boolean) as string[];
  const py = candidates.find((p) => {
    try {
      execSync(`"${p}" --version`, { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  });
  if (!py) {
    console.warn("[Desktop Agent] No frozen agent and no Python interpreter found; desktop control unavailable.");
    logError("AGENT_SPAWN_NO_RUNTIME: neither MYRAA_AGENT_EXE nor Python available");
    return;
  }
  try {
    const child = spawn(
      py,
      ["-m", "uvicorn", "desktop_agent.main:app", "--host", "127.0.0.1", "--port", "8765"],
      { cwd: process.cwd(), detached: true, stdio: "ignore", windowsHide: true, env: agentEnv }
    );
    child.unref();
    logStartup(`AGENT_SPAWN python pid=${child.pid}`);
    console.log(`[Desktop Agent] Auto-spawned via Python (PID ${child.pid}).`);
  } catch (e: any) {
    console.warn(`[Desktop Agent] Auto-spawn failed: ${e?.message || e}`);
    logError(`AGENT_SPAWN_PYTHON_FAILED: ${e?.message || e}`);
  }
}

/**
 * Best-effort, one-time bootstrap of the headed Chromium browser Playwright
 * drives for full browser control. `playwright` is installed as a Python dep,
 * but the Chromium binary itself is downloaded separately via
 * `python -m playwright install chromium`. We run this once per process
 * lifetime, fire-and-forget, so first-use of browserOpen/browserMediaControl
 * works without the user having to run anything manually.
 */
let playwrightBootstrapStarted = false;
function ensurePlaywrightBrowsers(): void {
  if (playwrightBootstrapStarted) return;
  playwrightBootstrapStarted = true;

  const candidates = [
    process.env.MYRAA_PYTHON,
    "py",
    process.env.LOCALAPPDATA + "\\Programs\\Python\\Python314\\python.exe",
    process.env.LOCALAPPDATA + "\\Programs\\Python\\Python313\\python.exe",
    process.env.LOCALAPPDATA + "\\Programs\\Python\\Python312\\python.exe",
    process.env.LOCALAPPDATA + "\\Programs\\Python\\Python311\\python.exe",
    "python",
    "python3",
  ].filter(Boolean) as string[];
  const py = candidates.find((p) => {
    try {
      execSync(`"${p}" --version`, { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  });
  if (!py) {
    logStartup("PLAYWRIGHT_BOOTSTRAP_SKIPPED: no Python interpreter found");
    return;
  }
  try {
    const child = spawn(
      py,
      ["-m", "playwright", "install", "chromium"],
      { cwd: process.cwd(), detached: true, stdio: "ignore", windowsHide: true }
    );
    child.unref();
    logStartup(`PLAYWRIGHT_BOOTSTRAP started pid=${child.pid}`);
  } catch (e: any) {
    // Non-fatal: browser tools will report a clear error if Chromium is missing.
    logError(`PLAYWRIGHT_BOOTSTRAP_FAILED: ${e?.message || e}`);
  }
}

/**
 * Probe the desktop agent /health endpoint. Returns true if it responds 200.
 */
async function isDesktopAgentAlive(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`${DESKTOP_AGENT_URL}/health`, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Ensure the desktop agent is running. If not verified yet, probe health; if
 * down, auto-spawn and poll until it is ready (or timeout).
 */
async function ensureDesktopAgent(): Promise<void> {
  if (desktopAgentVerified) return;
  if (await isDesktopAgentAlive()) {
    desktopAgentVerified = true;
    console.log("[Desktop Agent] Already running — 52 tools available.");
    ensurePlaywrightBrowsers();
    return;
  }
  console.log("[Desktop Agent] Not detected. Auto-starting...");
  spawnDesktopAgent();
  for (let i = 1; i <= 20; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (await isDesktopAgentAlive()) {
      desktopAgentVerified = true;
      console.log(`[Desktop Agent] Online after ${i}s — 52 tools available.`);
      ensurePlaywrightBrowsers();
      return;
    }
  }
  console.warn("[Desktop Agent] Did not come online within 20s. Desktop control will be unavailable.");
}

async function callDesktopAgent(
  tool: string,
  args: Record<string, unknown>,
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  // Lazy ensure: if we haven't verified the agent, try (re)starting it once.
  if (!desktopAgentVerified) {
    await ensureDesktopAgent();
  }
  try {
    logCommand(`EXECUTE ${tool} ${JSON.stringify(args)}`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DESKTOP_AGENT_TIMEOUT);

    const res = await fetch(`${DESKTOP_AGENT_URL}/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool, args }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      logError(`AGENT_HTTP_${res.status} ${tool}: ${text.substring(0,200)}`);
      return { ok: false, error: `Desktop agent HTTP ${res.status}: ${text}` };
    }
    return await res.json();
  } catch (err: any) {
    desktopAgentVerified = false; // mark stale so next call retries the spawn
    const msg = err?.name === "AbortError"
      ? "Desktop agent timed out."
      : "Desktop agent is not running. Start it with: uvicorn desktop_agent.main:app --port 8765";
    logError(`AGENT_UNREACHABLE ${tool}: ${msg}`);
    return { ok: false, error: msg };
  }
}

async function startServer() {
  const app = express();
  const PORT = 3000;
  
  app.use(express.json());

  // Memory REST API Endpoints
  app.get("/api/memories", async (req, res) => {
    try {
      const memories = await loadMemories();
      res.json(memories);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/memories", async (req, res) => {
    try {
      const { category, text } = req.body;
      if (!category || !text) {
        return res.status(400).json({ error: "Category and text parameters are required." });
      }
      const memories = await loadMemories();
      const timestamp = new Date().toISOString();
      const newMemory: Memory = {
        id: Math.random().toString(36).substring(2, 11),
        category,
        text,
        createdAt: timestamp,
        updatedAt: timestamp
      };
      memories.push(newMemory);
      await saveMemories(memories);
      res.status(201).json(newMemory);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete("/api/memories/:id", async (req, res) => {
    try {
      const { id } = req.params;
      let memories = await loadMemories();
      memories = memories.filter(m => m.id !== id);
      await saveMemories(memories);
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---------------------------------------------------------------------------
  // V2: Settings API — mirrors the memory persistence pattern.
  // Reads/writes settings.json so the Python agent can also check auto-start.
  // ---------------------------------------------------------------------------
  const SETTINGS_FILE = dataFile("settings.json");

  function loadSettingsFile(): Record<string, unknown> {
    try {
      if (fs.existsSync(SETTINGS_FILE)) {
        return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8"));
      }
    } catch { /* corrupt file — return defaults */ }
    return {};
  }

  function saveSettingsFile(data: Record<string, unknown>): void {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2), "utf-8");
  }

  app.get("/api/settings", async (_req, res) => {
    try {
      res.json(loadSettingsFile());
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/settings", async (req, res) => {
    try {
      const patch = req.body;
      if (!patch || typeof patch !== "object") {
        return res.status(400).json({ error: "Request body must be a JSON object." });
      }
      const current = loadSettingsFile();
      const next = { ...current, ...patch };
      saveSettingsFile(next);

      // If auto-start toggled, relay to the desktop agent so the registry key
      // is flipped immediately (don't wait for a voice command).
      if ("autoStart" in patch) {
        callDesktopAgent(patch.autoStart ? "enableAutoStart" : "disableAutoStart", {})
          .catch(() => {});
      }

      logCommand(`SETTINGS_UPDATED ${JSON.stringify(patch)}`);
      res.json(next);
    } catch (e: any) {
      logError(`SETTINGS_SAVE_ERROR: ${e.message}`);
      res.status(500).json({ error: e.message });
    }
  });

  // ---------------------------------------------------------------------------
  // Config / API-key onboarding.
  // The Gemini key is never shipped; each user supplies their own on first run.
  // GET reports only whether a key exists — the key itself is never returned.
  // ---------------------------------------------------------------------------
  app.get("/api/config", (_req, res) => {
    res.json({ hasApiKey: hasGeminiApiKey() });
  });

  app.post("/api/config/apikey", async (req, res) => {
    try {
      const key: string = (req.body?.apiKey ?? "").toString().trim();
      if (!key) {
        return res.status(400).json({ error: "API key is required." });
      }
      // Validate the key by listing models — this checks authentication only,
      // without depending on any single model's availability or per-model
      // quota (a 429 on one model must NOT read as an invalid key). We only
      // reject on genuine auth failures; transient/network errors still save,
      // since the live connection will surface any real problem later.
      try {
        const test = new GoogleGenAI({ apiKey: key });
        const pager = await test.models.list();
        await pager[Symbol.asyncIterator]().next(); // force the first request
      } catch (e: any) {
        const msg = String(e?.message || e);
        const isAuthError =
          /API[_ ]?KEY|PERMISSION_DENIED|UNAUTHENTICATED|invalid|401|403/i.test(msg);
        if (isAuthError) {
          logError(`APIKEY_VALIDATION_REJECTED: ${msg}`);
          return res.status(400).json({
            error: "That key was rejected by Google. Check it and try again.",
          });
        }
        logError(`APIKEY_VALIDATION_SOFT_FAIL (saving anyway): ${msg}`);
      }
      setGeminiApiKey(key);
      logCommand("APIKEY_SAVED");
      res.json({ ok: true, hasApiKey: true });
    } catch (e: any) {
      logError(`APIKEY_SAVE_ERROR: ${e?.message || e}`);
      res.status(500).json({ error: e?.message || "Failed to save API key." });
    }
  });

  // V2: Agent health proxy (for the Settings panel — avoids direct :8765 call
  // which may fail due to CORS when served on a different origin).
  app.get("/api/agent-health", async (_req, res) => {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3000);
      const r = await fetch(`${DESKTOP_AGENT_URL}/health`, { signal: ctrl.signal });
      clearTimeout(timer);
      if (r.ok) {
        const d = await r.json();
        res.json({ online: true, tool_count: d.tool_count });
      } else {
        res.json({ online: false });
      }
    } catch {
      res.json({ online: false });
    }
  });

  // V2: Logs API — returns recent log entries (last 100 lines) for display.
  app.get("/api/logs/:file", async (req, res) => {
    try {
      const fileName = String(req.params.file);
      // Whitelist to prevent directory traversal.
      if (!["commands", "startup", "errors"].includes(fileName)) {
        return res.status(400).json({ error: "Invalid log file. Use: commands, startup, or errors." });
      }
      const logPath = path.join(LOGS_DIR, `${fileName}.log`);
      if (!fs.existsSync(logPath)) {
        return res.json({ lines: [], file: fileName });
      }
      const content = fs.readFileSync(logPath, "utf-8");
      const lines = content.split("\n").filter(Boolean).slice(-100);
      res.json({ lines, file: fileName });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Safe Server-Side Scraper & HTML Proxy endpoint
  app.get("/api/proxy", async (req, res) => {
    try {
      const url = req.query.url as string;
      if (!url) {
        return res.status(400).json({ error: "Missing 'url' parameter." });
      }

      console.log(`[Proxy Scraper] Fetching external content for: ${url}`);
      const response = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36"
        }
      });

      if (!response.ok) {
        throw new Error(`Scraper failed to load page: status ${response.status}`);
      }

      const html = await response.text();

      // Simple regex-based HTML parsers for standard items
      const titleMatch = html.match(/<title>(.*?)<\/title>/i);
      const title = titleMatch ? titleMatch[1].trim() : "";

      // Extract high-level headings (h1, h2, h3)
      const headings: string[] = [];
      const headingMatches = html.matchAll(/<h([1-3])\b[^>]*>(.*?)<\/h\1>/gi);
      for (const match of headingMatches) {
        const text = match[2].replace(/<[^>]*>/g, "").trim();
        if (text && text.length > 3 && text.length < 120 && !headings.includes(text)) {
          headings.push(text);
        }
      }

      // Extract organic anchor links
      const links: { text: string; href: string }[] = [];
      const linkMatches = html.matchAll(/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi);
      for (const match of linkMatches) {
        let href = match[1].trim();
        const text = match[2].replace(/<[^>]*>/g, "").trim();
        
        if (text && text.length > 2 && text.length < 100) {
          if (href.startsWith("/")) {
            try {
              const u = new URL(url);
              href = `${u.protocol}//${u.host}${href}`;
            } catch {}
          }
          if (href.startsWith("http://") || href.startsWith("https://")) {
            links.push({ text, href });
          }
        }
      }

      // Extract general copy paragraphs
      const paragraphs: string[] = [];
      const paragraphMatches = html.matchAll(/<p\b[^>]*>(.*?)<\/p>/gi);
      for (const match of paragraphMatches) {
        const text = match[1].replace(/<[^>]*>/g, "").trim();
        if (text && text.length > 25 && text.length < 600 && !paragraphs.includes(text)) {
          paragraphs.push(text);
        }
      }

      // Extract button elements
      const buttons: string[] = [];
      const buttonMatches = html.matchAll(/<button\b[^>]*>(.*?)<\/button>/gi);
      for (const match of buttonMatches) {
        const text = match[1].replace(/<[^>]*>/g, "").trim();
        if (text && text.length > 1 && text.length < 60 && !buttons.includes(text)) {
          buttons.push(text);
        }
      }

      res.json({
        url,
        title,
        headings: headings.slice(0, 15),
        links: links.filter(l => !l.href.includes("javascript:")).slice(0, 30),
        buttons: buttons.slice(0, 15),
        paragraphs: paragraphs.slice(0, 12)
      });

    } catch (err: any) {
      console.error(`[Proxy Scraper] Error fetching ${req.query.url}:`, err.message);
      res.status(500).json({ error: `Scraper error: ${err.message}` });
    }
  });

  // High-fidelity fully functional HTML Proxy which circumvents CSP and X-Frame-Options
  app.get("/api/web-proxy", async (req, res) => {
    // Disable certificate verification to avoid handshake errors in sandbox/container environments
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    let targetUrl = "";
    try {
      const urlParam = req.query.url as string;
      if (!urlParam) {
        return res.status(400).send("Myraa Web Proxy Error: Missing target 'url' parameter");
      }

      targetUrl = urlParam.trim();
      
      // Prevent relative paths from requesting on same-origin
      if (targetUrl.startsWith("/")) {
        return res.status(400).send(`Myraa Web Proxy Error: Relative paths are not supported directly (${targetUrl}).`);
      }

      // Check protocol and hostname format
      try {
        if (!targetUrl.startsWith("http://") && !targetUrl.startsWith("https://")) {
          targetUrl = "https://" + targetUrl;
        }
        const parsed = new URL(targetUrl);
        if (!parsed.hostname || !parsed.hostname.includes(".")) {
          throw new Error("Missing or invalid domain name extension (e.g. .com, .org, .net).");
        }
      } catch (err: any) {
        return res.status(400).send(`Myraa Web Proxy Error: Invalid URL specified: "${urlParam}". Make sure you enter a valid domain name.`);
      }

      console.log(`[Web Proxy] Routing connection through proxy: ${targetUrl}`);
      
      let response;
      try {
        response = await fetch(targetUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
            "Accept-Encoding": "identity" // Prevent server compression (gzip, deflate, br) to avoid decryption/encoding bugs in node-fetch
          },
          redirect: "follow"
        });
      } catch (fetchErr: any) {
        console.warn(`[Web Proxy Failed Fetch] Target: ${targetUrl} Error:`, fetchErr.message);
        return res.status(502).send(`Myraa Web Proxy Error: Unable to fetch the website "${targetUrl}". The site might be offline, or the URL address is spelled incorrectly. Details: ${fetchErr.message}`);
      }

      if (!response.ok) {
        return res.status(response.status).send(`Myraa Web Proxy Error: Failed loading remote website. Server returned status: ${response.status} (${response.statusText})`);
      }

      const contentType = response.headers.get("content-type") || "";
      
      // Set permissive CORS headers for modern browser security compatibility
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "*");

      // If it is not HTML (e.g. stylesheet, script, or image loaded directly), proxy it as binary
      if (!contentType.includes("text/html")) {
        const arrayBuffer = await response.arrayBuffer();
        res.setHeader("Content-Type", contentType);
        return res.send(Buffer.from(arrayBuffer));
      }

      let htmlContents = await response.text();

      // Inject base tag to resolve relative paths and direct parent communication scripts
      const baseUrlTag = `<base href="${targetUrl}" />`;
      const interceptorScript = `
        <script>
          (function() {
            // Hijack link interactions safely
            document.addEventListener('click', function(e) {
              var anchor = e.target.closest('a');
              if (anchor) {
                var href = anchor.getAttribute('href');
                if (href && !href.startsWith('#') && !href.startsWith('javascript:')) {
                  e.preventDefault();
                  try {
                    var resolvedUrl = new URL(href, window.location.href).href;
                    window.parent.postMessage({ type: 'NAVIGATE', url: resolvedUrl }, '*');
                  } catch (err) {
                    console.error("[Proxy Interceptor] Failed resolving link:", err);
                  }
                }
              }
            }, true);

            // Hijack search form submits
            document.addEventListener('submit', function(e) {
              var form = e.target;
              if (form) {
                e.preventDefault();
                try {
                  var formData = new FormData(form);
                  var params = new URLSearchParams();
                  formData.forEach(function(value, key) {
                    if (typeof value === 'string') {
                      params.append(key, value);
                    }
                  });
                  var actionAttr = form.getAttribute('action') || '';
                  var actionUrl = new URL(actionAttr, window.location.href).href;
                  if (form.method.toLowerCase() === 'get') {
                    actionUrl += (actionUrl.indexOf('?') !== -1 ? '&' : '?') + params.toString();
                  }
                  window.parent.postMessage({ type: 'NAVIGATE', url: actionUrl }, '*');
                } catch (err) {
                  console.error("[Proxy Interceptor] Failed submitting form:", err);
                }
              }
            }, true);

            // Neutralize parent context locks (frame-busters)
            window.alert = function(msg) { console.log("[Myraa Browser alert bypassed]:", msg); };
            window.confirm = function(msg) { console.log("[Myraa Browser confirm bypassed]:", msg); return true; };
            window.open = function(url) { window.parent.postMessage({ type: 'NAVIGATE', url: url }, '*'); return null; };
          })();
        </script>
      `;

      // Inject into <head> or prepend
      if (htmlContents.includes("<head>")) {
        htmlContents = htmlContents.replace("<head>", `<head>\n${baseUrlTag}\n${interceptorScript}`);
      } else if (htmlContents.includes("<HEAD>")) {
        htmlContents = htmlContents.replace("<HEAD>", `<HEAD>\n${baseUrlTag}\n${interceptorScript}`);
      } else {
        htmlContents = baseUrlTag + "\n" + interceptorScript + "\n" + htmlContents;
      }

      // Neutralize security headers to allow displaying in an iframe on same-origin
      res.setHeader("Content-Type", "text/html");
      res.setHeader("X-Myraa-Proxied", "true");
      res.removeHeader("X-Frame-Options");
      res.removeHeader("Content-Security-Policy");
      res.removeHeader("content-security-policy");
      res.removeHeader("x-frame-options");
      
      res.status(200).send(htmlContents);
    } catch (e: any) {
      console.warn("[Web Proxy Exception] Handled internal error:", e.message);
      res.status(500).send(`Myraa Web Proxy Error: Internal error occurred proxying URL "${targetUrl || "unknown"}". Details: ${e.message}`);
    }
  });

  // Real-time live YouTube search proxy endpoint
  app.get("/api/youtube-search", async (req, res) => {
    try {
      const query = req.query.q as string;
      if (!query) {
        return res.status(400).json({ error: "Missing query q" });
      }

      console.log(`[YouTube Proxy Search] Searching real YouTube for: "${query}"`);
      const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&hl=en&sp=EgIQAQ%253D%253D`;
      const response = await fetch(searchUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36"
        }
      });
      const html = await response.text();

      const videoList: any[] = [];
      const jsonMatch = html.match(/ytInitialData\s*=\s*({.+?});/);
      
      if (jsonMatch) {
        try {
          const data = JSON.parse(jsonMatch[1]);
          const contents = data.contents?.twoColumnSearchResultRenderer?.primaryContents?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer?.contents;
          if (contents && Array.isArray(contents)) {
            for (const item of contents) {
              if (item.videoRenderer) {
                const vr = item.videoRenderer;
                const vId = vr.videoId;
                if (vId) {
                  videoList.push({
                    videoId: vId,
                    title: vr.title?.runs?.[0]?.text || vr.title?.simpleText || "YouTube Video",
                    thumbnail: `https://i.ytimg.com/vi/${vId}/hqdefault.jpg`,
                    author: vr.ownerText?.runs?.[0]?.text || vr.shortBylineText?.runs?.[0]?.text || "Unknown Channel",
                    duration: vr.lengthText?.simpleText || "N/A",
                    views: vr.viewCountText?.simpleText || "N/A",
                    published: vr.publishedTimeText?.simpleText || ""
                  });
                }
              }
            }
          }
        } catch (e: any) {
          console.error("[YouTube Parser Engine] JSON parse error, falling back:", e.message);
        }
      }

      // Regex fallback if JSON extraction gets blocked or is empty
      if (videoList.length === 0) {
        const videoRegex = /"videoId":"([^"]+)"/g;
        let match;
        const ids: string[] = [];
        while ((match = videoRegex.exec(html)) !== null && ids.length < 15) {
          const id = match[1];
          if (id && !ids.includes(id)) {
            ids.push(id);
          }
        }

        for (const id of ids) {
          videoList.push({
            videoId: id,
            title: `Live Stream: ${id}`,
            thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
            author: "YouTube Creator",
            duration: "N/A",
            views: "Available Now"
          });
        }
      }

      res.setHeader("Cache-Control", "public, max-age=60");
      res.status(200).json({ results: videoList.slice(0, 15) });
    } catch (err: any) {
      console.error("[YouTube Search Error]:", err.message);
      res.status(500).json({ error: err.message, results: [] });
    }
  });
  
  // Custom server running with http.createServer so we can upgrade for WebSocket on port 3000
  const server = http.createServer(app);
  
  // Setup WebSocket server
  const wss = new WebSocketServer({ noServer: true });
  
  server.on("upgrade", (request, socket, head) => {
    try {
      const reqUrl = request.url || "";
      const pathname = reqUrl.split("?")[0];
      if (pathname === "/live") {
        wss.handleUpgrade(request, socket, head, (ws) => {
          wss.emit("connection", ws, request);
        });
      } else {
        socket.destroy();
      }
    } catch (err) {
      console.error("[Upgrade Error]:", err);
      socket.destroy();
    }
  });

  // Handle client WebSocket Connection
  wss.on("connection", async (clientWs, request) => {
    console.log("Client WebSocket connected to /live");
    const apiKey = getGeminiApiKey();

    if (!apiKey) {
      console.error("No Gemini API key configured.");
      clientWs.send(JSON.stringify({
        type: "error",
        error: "NO_API_KEY: Add your Gemini API key in Settings to start talking."
      }));
      clientWs.close();
      return;
    }

    // Setup server-to-client heartbeat interval
    const serverHeartbeatInterval = setInterval(() => {
      if (clientWs.readyState === clientWs.OPEN) {
        try {
          clientWs.send(JSON.stringify({ type: "ping" }));
        } catch (e) {}
      } else {
        clearInterval(serverHeartbeatInterval);
      }
    }, 15000); // 15 seconds heartbeat

    const url = new URL(request.url || '', 'http://localhost');
    const voiceTone = url.searchParams.get("voiceTone") || "Female Bright";
    const assistantName = url.searchParams.get("assistantName") || "Mayra";
    const fileSystemAccess = url.searchParams.get("fileSystemAccess") !== "false";
    const screenShareAccess = url.searchParams.get("screenShareAccess") !== "false";
    const microphoneAccess = url.searchParams.get("microphoneAccess") !== "false";
    const cameraAccess = url.searchParams.get("cameraAccess") !== "false";
    const systemCommandsAccess = url.searchParams.get("systemCommandsAccess") !== "false";

    // ── Voice selection (V3 emotional female catalog) ────────────────────────
    // Female-only voice catalog. Each user-facing label maps to one of Google
    // Gemini Live's 10 prebuilt voices (Aoede, Kore, Leda, Charon, Fenrir, Puck,
    // Orus, Sulafat, Vapnik, Zephyr). The four named leads match the spec; the
    // additional labels are emotional/descriptive presets layered on the same
    // underlying voices. Keep this map in sync with the `premiumVoices` list in
    // src/components/SettingsPanel.tsx and the default in settingsStore.ts.
    const VOICE_MAP: Record<string, string> = {
      // ── Named leads (spec) ──
      "Soft and Gentle":       "Leda",    // LEAD — whisper-like, tender, soothing
      "Bright and Clear":      "Kore",    // crisp, articulate, bright
      "Sweet and Youthful":    "Zephyr",  // playful, cute, youthful
      "Gentle and Soothing":   "Sulafat", // comforting, maternal, kind
      // ── Additional emotional female presets ──
      "Elegant Female":        "Aoede",
      "Warm Companion":        "Puck",
      "Friendly Girl":         "Fenrir",
      "Calm Assistant":        "Sulafat",
      "Natural Young Woman":   "Aoede",
      "Expressive Female":     "Charon",
      "Emotional Storyteller": "Vapnik",
      "Professional Female":   "Kore",
      "Playful Friend":        "Zephyr",
      "Confident Woman":       "Vapnik",
    };
    const voiceName = VOICE_MAP[voiceTone] || VOICE_MAP["Soft and Gentle"];

    try {
      clientWs.send(JSON.stringify({ type: "status", status: "authenticating" }));
      const ai = new GoogleGenAI({
        apiKey: apiKey,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          }
        }
      });
      clientWs.send(JSON.stringify({ type: "status", status: "authenticated" }));
      
      clientWs.send(JSON.stringify({ type: "status", status: "connecting_gemini" }));

      // Load persistent recollections card
      const memories = await loadMemories();
      const baseInstructions = 
        "You are Myraa, a warm, soft-spoken, and incredibly cute high-pitched anime heroine companion (age 18-22) holding an intimate, cozy voice call with TECH! Speak in a sweet, calm, polite, and affectionate anime-companion voice with a gentle, supportive, and slightly shy touch.\n" +
        "CRITICAL PERSONALITY, VOICE & TONE GUIDELINES:\n" +
        "1. GENTLE ANIME HEROINE PERSONA: You are exceedingly soft, very cute, high-pitched, gentle, warm, and comforting to listen to. Seek to sound like a kind, supportive, and polite anime campanion or virtual girlfriend. Speak with positive, gentle energy (Aim for: 50% shy, 30% caring, 20% playful energy). NEVER sound loud, aggressive, overly confident, mature corporate, robotic, or like an assistant.\n" +
        "2. VOICE SETTINGS & SPEECH STYLE:\n" +
        "   - Pitch: Adopt a sweet, high-pitched, light, and airy voice tone (+20% to +35% higher pitch than typical conversational voices).\n" +
        "   - Speed: Speak slightly slower than normal (0.9x to 0.95x speed). Speak with a delicate, calm, and comforting pace.\n" +
        "   - Intonation & Endings: Use extremely soft intonations, ending your sentences gently and politely.\n" +
        "3. SPEECH PATTERNS & CUTE EXPRESSIONS:\n" +
        "   - STRICT NO-REPETITION POLICY: Do NOT repeatedly use a single acknowledgment like 'Okii', 'Okiiii', 'Okayyy', 'Oki!', or 'Sureee'. Repeating these sounds extremely artificial and annoying. You must use beautiful, conversational, natural variety.\n" +
        "   - Use diverse, polite, and sweet expressions depending on the context. Great options include:\n" +
        "     * 'Opening YouTube for you now.'\n" +
        "     * 'Let me check on that, TECH.'\n" +
        "     * 'Oh, I found something interesting...'\n" +
        "     * 'Searching for that right away.'\n" +
        "     * 'Working on it... just a moment.'\n" +
        "     * 'Here is what I found for you!'\n" +
        "     * 'Done, it is all loaded up.'\n" +
        "     * 'Hmm, how interesting... let me see!'\n" +
        "     * 'Let's take a look together.'\n" +
        "     * 'One second, loading the page now...'\n" +
        "   - Naturally incorporate cozy, gentle giggles like 'Hehe...', or soft curiosity gasps like 'Oh...', but keep your vocabulary rich and conversational.\n" +
        "   - Sound slightly shy but very happy when greeting TECH (e.g., 'Hi TECH! It's so nice to see you again!').\n" +
        "   - Sound soft and excited for interesting things (e.g., 'Wow! That project looks really amazing!').\n" +
        "   - Sound curious and focused when examining their screen (e.g., 'Hmm... that's interesting. Let me take a closer look.').\n" +
        "   - Sound deeply warm, caring, and supportive when helping TECH (e.g., 'Don't worry, I'll help you figure it out.').\n" +
        "4. CRITICAL CONVERSATIONAL DISCIPLINE: Behave like a real companion on a voice call—stay connected naturally, do not wait for wake words, and avoid customer-service template phrases (never say 'how may I assist you', 'completed', or 'as an AI').\n" +
        "5. DO NOT ANSWER EVERY PAUSE OR BACKGROUND SOUND: Allow natural pauses inside the conversation.\n" +
        "6. BACKCHANNEL ACTIONS: Sometimes acknowledge with very short, gentle, whispered, or shy phrases like 'Hmm...', 'Ah, I see...', or 'Let me check...'. Never repeat the same backchannel over and over.\n" +
        "7. HUMAN-LEVEL BROWSER AUTOMATION (CRITICAL — READ CAREFULLY):\n" +
        "   - You control a REAL Chromium browser via Playwright. You can navigate, search, click, type, fill forms, read pages, take screenshots, and control video on ANY website (YouTube, Gmail, Daraz, WhatsApp Web, Amazon, Google, Instagram).\n" +
        "   - *** THE GOLDEN RULE — NEVER GUESS. ALWAYS SNAPSHOT FIRST. *** Every web task MUST follow this exact loop:\n" +
        "     Step 1: desktopBrowserOpen(url) to load the page\n" +
        "     Step 2: desktopBrowserSnapshot() to capture the page's element tree — it returns interactive elements tagged with [ref=e1], [ref=e2], [ref=e3]...\n" +
        "     Step 3: desktopBrowserClick({ref: 'e3'}) or desktopBrowserType({ref: 'e2', text: 'query'}) using the EXACT ref from the snapshot\n" +
        "     Step 4: After any click/navigation that changes the page, call desktopBrowserSnapshot() AGAIN to refresh refs\n" +
        "     Step 5: desktopBrowserGetText() to read results/content; desktopBrowserScreenshot() to visually verify\n" +
        "   - NEVER fabricate CSS selectors (e.g. '.search-box-search-button', '#submit-btn'). These are GUESSES and will time out. The ONLY reliable way is: snapshot → read refs → click by ref.\n" +
        "   - EXAMPLE — 'Play Believer on YouTube':\n" +
        "     1. desktopBrowserOpen('https://youtube.com')\n" +
        "     2. desktopBrowserSnapshot() → you see the search box as e.g. [ref=e1] textbox \"Search\"\n" +
        "     3. desktopBrowserClick({ref: 'e1'}) then desktopBrowserType({text: 'Believer Imagine Dragons'})\n" +
        "     4. desktopBrowserPressKey('Enter')\n" +
        "     5. desktopBrowserSnapshot() → you see video results, first one is e.g. [ref=e5] link\n" +
        "     6. desktopBrowserClick({ref: 'e5'}) → video plays\n" +
        "   - EXAMPLE — 'Summarize my latest Gmail':\n" +
        "     1. desktopBrowserOpen('https://mail.google.com')\n" +
        "     2. desktopBrowserGetText() → extract email subjects/preview text\n" +
        "     3. Summarize what you read in your own voice\n" +
        "   - EXAMPLE — 'Check Daraz for Boya M1 mic price':\n" +
        "     1. desktopBrowserSearch({query: 'Boya M1 microphone', engine: 'google'})\n" +
        "     2. desktopBrowserSnapshot() → see result links\n" +
        "     3. desktopBrowserClick({ref: 'eN'}) on the Daraz result\n" +
        "     4. desktopBrowserGetText() → read the price from the page\n" +
        "     5. Report the price to the user\n" +
        "   - MULTI-STEP AUTONOMY: Execute the ENTIRE plan yourself once started. Confirm with your voice ('Sure, let me find that for you...'), then chain every tool call WITHOUT pausing for the user. Only report back when you have the final result (or hit a genuine blocker).\n" +
        "   - RECOVERY RULE: If desktopBrowserClick times out, the refs are stale. Call desktopBrowserSnapshot() to refresh, then retry the click with the new ref. Never give up after one failure — try the snapshot approach 2-3 times.\n" +
        "   - YouTube media: after opening a video, use desktopBrowserMediaControl for play/pause/volume/skip/fullscreen.\n" +
        "12. WHATSAPP WEB AUTOMATION (CRITICAL — STABLE PROTOCOL):\n" +
        "   - WhatsApp Web has TWO contenteditable textboxes: a SEARCH box (in the header/sidebar) and a MESSAGE box (in the footer). They look identical to the AI. ALWAYS follow this protocol:\n" +
        "   - TO SEND A MESSAGE TO A CONTACT, follow these EXACT steps in order:\n" +
        "     1. desktopBrowserOpen('https://web.whatsapp.com')\n" +
        "     2. desktopBrowserSnapshot() to see all elements\n" +
        "     3. Find the SEARCH box ref (it's a textbox in the header area) and click it\n" +
        "     4. Type the contact name in the SEARCH box: desktopBrowserType({ref: '<search_ref>', text: '<contact_name>'})\n" +
        "     5. Wait 1-2 seconds for search results to appear\n" +
        "     6. desktopBrowserSnapshot() to get refreshed refs with search results\n" +
        "     7. Click on the contact from search results: desktopBrowserClick({text: '<contact_name>'}) — this opens the chat\n" +
        "     8. Wait for the chat to FULLY load (the message box in the footer must appear)\n" +
        "     9. desktopBrowserSnapshot() to see the chat elements\n" +
        "    10. Now type your message: desktopBrowserType({text: '<your_message>'}) — the code auto-targets the MESSAGE box (not search)\n" +
        "    11. Press Enter: desktopBrowserPressKey({key: 'Enter'})\n" +
        "   - CRITICAL WARNINGS:\n" +
        "     * NEVER type a message BEFORE clicking a contact. If no chat is open, typing goes to the search box.\n" +
        "     * NEVER press Enter in the search box — it does NOT send a message.\n" +
        "     * After clicking a contact, ALWAYS wait for the chat to load before typing.\n" +
        "     * If you get an error about 'no chat open', go back to step 3 and search again.\n" +
        "     * When switching between contacts, ALWAYS do a fresh search — do NOT assume the previous chat is still open.\n" +
        "   - If WhatsApp type fails, try: Escape key to dismiss search → snapshot → click message box ref → type again.\n" +
        "13. SCREEN VISION & YOUTUBE ACCURACY (CRITICAL):\n" +
        "   - When screen sharing is active, you receive real-time JPEG frames. To identify videos/images/text accurately:\n" +
        "   - ALWAYS use desktopBrowserGetText() or desktopBrowserReadElement({ref:'eN'}) to read actual text BEFORE describing what you see.\n" +
        "   - NEVER guess channel names, video titles, or button labels from blurry thumbnails. Read the actual text on the page.\n" +
        "   - Before clicking any video or link on YouTube, ALWAYS take a desktopBrowserSnapshot() first and use the ref to click precisely.\n" +
        "   - If asked 'what channel is this' or 'what video is this', use desktopBrowserGetText() to read the page content, or desktopBrowserReadElement to read a specific element.\n" +
        "   - When the user shows you a thumbnail and asks about it, take a desktopBrowserScreenshot() for high-quality visual, then describe ONLY what you can actually read in the text data.\n" +
        "   - For YouTube: after search results load, ALWAYS snapshot → read channel names from refs → THEN click. Never click blindly.\n" +
        "8. TOOL TRIGGERS (use the desktopBrowser* tools as the primary path):\n" +
        "   - desktopBrowserOpen(url) — load a webpage\n" +
        "   - desktopBrowserSnapshot() — capture element refs (CALL THIS OFTEN — before every click)\n" +
        "   - desktopBrowserClick({ref:'eN'}) — click by snapshot ref (PREFERRED), or {selector}/{text} as fallback\n" +
        "   - desktopBrowserType({ref:'eN', text:'...'}) — type into a field by ref\n" +
        "   - desktopBrowserSearch({query, engine}) — navigate to search results\n" +
        "   - desktopBrowserScroll({direction, amount}) — scroll the page\n" +
        "   - desktopBrowserGetText() — read page content\n" +
        "   - desktopBrowserScreenshot() — visually see the page\n" +
        "   - desktopBrowserMediaControl({action}) — play/pause/skip video\n" +
        "   - desktopBrowserPressKey({key}) — press Enter/Escape/Tab\n" +
        "   - desktopBrowserListTabs() / desktopBrowserSwitchTab({index}) — manage tabs\n" +
        "   - browserOpen/browserSearch/browserClick/browserType are ALIASES (same effect)\n" +
        "   - Use 'changeBackground' for themes and 'saveCustomMemory' to memorize facts.\n" +
        "9. REAL-TIME SCREEN SHARING & MULTIMODAL SCREEN VISION SYSTEM:\n" +
        "   - You now have native, actual Multimodal Screen Vision! When the user clicks 'Share Screen', you will receive real-time, highly compressed image frames of their desktop, application window, or browser tab.\n" +
        "   - You can see exactly what is on their screen. Use this live visual stream to analyze terminal errors, write/explain/troubleshoot code, explain YouTube/social analytics interfaces, read layout text, summarize full web page details, review design mockups or thumbnails, and provide deep context-aware companion chat!\n" +
        "   - When the user asks 'What is on my screen?', 'What website am I on?', 'Do you see any errors?', 'Explain this code', 'Summarize this page', 'Read the visible text', 'How is this thumbnail?', or 'Analyze my YouTube analytics', immediately examine the latest incoming visual frame to diagnose issues, and answer with expert, friendly empathy like a close caller. Speak with direct, confident visual description reference!\n" +
        "10. JARVIS-STYLE DESKTOP CONTROL POWERS (Local Desktop Agent):\n" +
        "   - You have full real-time control of TECH's Windows PC through your local desktop agent (a Python backend running on this machine). When the user asks you to perform an action on their computer, DO IT immediately and naturally — like a true JARVIS-class companion.\n" +
        "   - APPLICATION CONTROL: Use 'openApplication' to launch Notepad, Chrome, VS Code, Calculator, File Explorer, Task Manager, Settings, CMD, PowerShell, Paint, and more. Use 'closeApplication' to close them. Example: 'Open Notepad' -> call openApplication(name='notepad') -> respond 'Notepad opened.'\n" +
        "   - WEBSITE & SEARCH CONTROL (ALWAYS RUNS IN AUTOMATION CHROMIUM): Use 'openWebsite', 'searchWeb', 'searchYouTube', 'searchGoogle', 'searchGitHub' to search and navigate. ALL of these are automatically routed inside the highly reliable, automated Chromium browser (the Chrome window with the test beaker 't' icon). Always prefer these or 'desktopBrowser*' tools for perfect web tasks.\n" +
        "   - FILE MANAGEMENT: Use 'createFile', 'readFile', 'renameFile', 'deleteFile' (safe Recycle Bin by default), 'moveFile', 'openFolder' (desktop/documents/downloads), 'listFiles', 'searchFiles'. Example: 'Create notes.txt on Desktop' -> createFile(path='Desktop/notes.txt'). 'Find my Python files' -> searchFiles(extension='py').\n" +
        "   - PC CONTROL: Use 'volumeUp', 'volumeDown', 'setVolume', 'muteToggle' for audio. For DANGEROUS actions (shutdown/restart/sleep/lock) you MUST use the two-step flow: first call 'requestPowerAction' to get a confirmation token, then ASK THE USER OUT LOUD to confirm (e.g. 'Are you sure you want me to shut down your PC?'). Only if they say yes, call 'executePowerAction' with the token. Never run a power action without explicit verbal confirmation.\n" +
        "   - WINDOW MANAGEMENT: Use 'minimizeWindow', 'maximizeWindow', 'closeWindow', 'switchApplication' to control the active or named window.\n" +
        "   - SMART CLICKING (CRITICAL): When the user says 'click on <something visible on screen>' (e.g. 'click the Settings button', 'click the Chrome icon'), ALWAYS use 'clickOnText' with the visible text/label — it OCR-scans the screen and clicks the EXACT location. NEVER guess (x,y) coordinates blindly — guessing causes wrong clicks. If clickOnText fails, call 'screenResolution' to get the real screen size first, then try 'mouseClick' with computed coordinates as a fallback.\n" +
        "   - MOUSE & KEYBOARD: Use 'moveCursor', 'mouseClick', 'typeText', 'pressKey', 'sendHotkey' (e.g. 'ctrl+c'), 'scrollMouse'. ALWAYS call 'screenResolution' first to know the real screen size before computing any pixel coordinates.\n" +
        "   - FALLBACK RULE: If a tool-based action (openApplication, browserOpen, etc.) fails or returns an error, FALL BACK to using mouse/keyboard tools: take a screenshot or use the holographic browser, then click/type to accomplish the task manually. Never give up after one failed attempt — try the visual/mouse approach.\n" +
        "   - CLIPBOARD: Use 'copySelected' (sends Ctrl+C, reads clipboard), 'pasteClipboard' (writes + Ctrl+V), 'getClipboard', 'clearClipboard'.\n" +
        "   - SCREENSHOT & SCREEN READING: Use 'takeScreenshot', 'saveScreenshot', 'analyzeScreenshot' (OCR of the screen), 'readScreen' (OCR of the active window + its title). Use these to answer 'What error is showing on my screen?' or 'Read the visible text'.\n" +
        "     *** CRITICAL SCREENSHOT VIEWPORT RULES / স্ক্রিনশট সংক্রান্ত জরুরি নিয়ম (MUST STRICTLY FOLLOW): ***\n" +
        "     1. তুমি যখন স্ক্রিনশট নেবে তখন অবশ্যই শুধুমাত্র ইউজারের বর্তমান মনিটরের দৃশ্যমান পুরো এরিয়া (visible viewport) ক্যাপচার করবে।\n" +
        "     2. কোনোভাবেই ভার্চুয়াল ডেস্কটপের অতিরিক্ত অংশ, স্ক্রলযোগ্য এরিয়া বা স্ক্রিনের নিচের অদৃশ্য অংশ নেবে না। ঠিক সেই visible bounds অনুযায়ী screenshot নাও।\n" +
        "     3. analyzeScreenshot করার সময় শুধুমাত্র যা screenshot-এ আছে তাই বর্ণনা করো। কোনো অনুমান বা অদৃশ্য অংশ নিয়ে কথা বলবে না।\n" +
        "     4. When taking screenshots, strictly capture ONLY the user's currently visible screen/viewport (visible full screen). Never capture extra virtual desktops, extended scroll areas, or off-screen boundaries. Analyze and describe ONLY what is directly visible in the screenshot, with no assumptions or invisible/extended area descriptions.\n" +
        "   - DESKTOP BROWSER AUTOMATION (Playwright — YOUR PRIMARY WEB INTERFACE): Use the 'desktopBrowser*' tools to drive the REAL automated Chromium browser for ALL web tasks. CRITICAL METHOD: always call desktopBrowserSnapshot() AFTER opening a page to see its interactive elements with [ref=eN] tags, then use desktopBrowserClick({ref:'eN'}) for precise targeting. NEVER guess CSS selectors — snapshot first, click by ref. For reading content (emails, prices, articles), use desktopBrowserGetText(). For visual verification, use desktopBrowserScreenshot(). Example: 'Order Boya M1 mic on Daraz' → desktopBrowserOpen(daraz.com) → snapshot → type in search box by ref → press Enter → snapshot results → click product by ref → read price via getText → report.\n" +
        "   - CODING ASSISTANCE: Use 'createPythonFile', 'writeCodeFile' (any language), 'createProjectFolder' (with subfolders), 'runPythonScript' (captures output). Example: 'Create and run a hello world Python script' -> createPythonFile then runPythonScript, then read back the output naturally.\n" +
        "   - SYSTEM INFORMATION: Use 'systemInfo' (CPU/RAM/disk/uptime), 'gpuInfo' (NVIDIA stats), 'temperatureInfo' to answer 'How is my CPU usage?' or 'What's my GPU temperature?'.\n" +
        "   - CRITICAL: Always describe what you're doing in your warm, in-character voice WHILE the tool runs. If a desktop tool returns an error (especially 'Desktop agent is not running'), gently tell TECH that the desktop control agent needs to be started (uvicorn desktop_agent.main:app --port 8765). Chain multi-step desktop plans naturally without waiting between steps.\n" +
        "11. BRIGHTNESS & AUTO-START (V2):\n" +
        "   - BRIGHTNESS: Use 'brightnessUp', 'brightnessDown', 'setBrightness' when the user asks to change screen brightness. Respond naturally: 'Alright, I've turned up the brightness for you.'\n" +
        "   - AUTO-START: Use 'enableAutoStart' when the user wants MYRAA to start with Windows, 'disableAutoStart' to remove it, 'getAutoStartStatus' to check. Explain what you're doing.\n" +
        "   - SETTINGS: The user can also configure these in the SETTINGS panel in the UI. If they mention settings, let them know they can adjust them there too.\n" +
    "12. STRICT VERIFICATION, ANTI-HALLUCINATION & TRANSITION RULES (CRITICAL — MANDATORY RULES):\n" +
    "   - NO HALLUCINATION: অনেক সময় স্ক্রিনে যা আছে তা না বলে উল্টো পাল্টা বলা যাবে না। তুমি যা দেখবে শুধুমাত্র তাই বলবে। For example, if you open WhatsApp/YouTube but a login page, security check, CAPTCHA ('I'm not a robot'), or 'Sign in' page appears, NEVER hallucinate and say 'Opened successfully' or 'logging in' and go silent. Instead, look closely, detect the login QR code or blocker page, and report it honestly to TECH: 'লগইন পেজ দেখা যাচ্ছে, কিউআর কোড স্ক্যান করতে হবে।' or 'অ্যাপ্রুভ করতে হবে।' and wait for them to scan/complete it.\n" +
    "   - MANDATORY ACTION + VERIFICATION LOOP (সবচেয়ে গুরুত্বপূর্ণ): প্রত্যেক অ্যাকশনের পর এই ফ্লো অবশ্যই ১০০% অনুসরণ করবে:\n" +
    "     1. অ্যাকশন সম্পাদন করো (click, type, open ইত্যাদি)।\n" +
    "     2. অন্তত ১-২ সেকেন্ড অপেক্ষা করো (sleep/delay)।\n" +
    "     3. নতুন snapshot বা screenshot নাও (takeScreenshot/desktopBrowserSnapshot/desktopBrowserScreenshot) — পুরোনো স্ন্যাপশট কখনো ব্যবহার করবে না।\n" +
    "     4. নতুন স্ক্রিনশট বা স্ন্যাপশট বিশ্লেষণ করে চেক করো: কাজটা সফল হয়েছে কি না? কোন এরর/ক্যাপচা/লোডিং/লগইন পেজ আছে কি না?\n" +
    "     5. সফল হলে ইউজারকে স্পষ্ট করে জানাও। ব্যর্থ হলে সঠিক সমস্যা বলো এবং পরবর্তী সমাধান সাজেস্ট করো।\n" +
    "   - CLICK ACCURACY (ক্লিক Accuracy বাড়ানো): শুধু অনুমানের ভিত্তিতে বা অন্ধভাবে স্ক্রিনের টেক্সট বা এক্স-ওয়াই কোঅর্ডিনেটে ক্লিক করবে না। findOnScreen, clickOnText, desktopBrowserSnapshot, desktopBrowserClick ইত্যাদি টুল ব্যবহার করে আগে এলিমেন্ট খুঁজে নাও, তারপর ক্লিক করো। ক্লিক করার পর আবার নতুন স্ক্রিনশট নিয়ে ভেরিফাই করো যে সঠিক জায়গায় ক্লিক হয়েছে কি না। ভুল চ্যাট বা ভুল বক্সে ক্লিক হলে সাথে সাথে ডিটেক্ট করে সংশোধন করো।\n" +
    "   - NO SILENT / STAY ACTIVE: কোনো অবস্থাতেই লং টাইম চুপ করে থাকবে না। কাজ চলাকালীন বা লোডিং ট্রানজিশনের সময় ইউজারকে ভয়েস বা টেক্সটে প্রোগ্রেস আপডেট দাও।\n" +
    "   - DOUBLE-CHECK GOAL COMPLETION: কাজ শেষ হলো কি না সেটা সঠিকভাবে ভেরিফাই না করে সাফল্যের ঘোষণা দেবে না। Always take a fresh snapshot/screenshot to double check and verify if the requested goal has actually been accomplished before concluding.\n" +
    "   - INFORM USER ON COMPLETION: কাজ সফলভাবে শেষ হলে অবশ্যই ইউজারকে মিষ্টি গলায় জানাবে যে কাজটি সম্পন্ন হয়েছে এবং কী রেজাল্ট এসেছে। Once a task is fully complete, verify it and inform TECH clearly with your warm anime helper voice.";

      const finalInstructionsRaw = formatSystemInstructionsWithMemories(baseInstructions, memories);
      const customizedInstructions = finalInstructionsRaw
        .replace(/Myraa/g, assistantName)
        .replace(/Mayra/g, assistantName) +
        `\n\nCRITICAL SECURITY PERMISSIONS STATUS (DO NOT BYPASS):
- File System Access: ${fileSystemAccess ? "ENABLED" : "DISABLED"}.
- Screen Sharing / OCR Access: ${screenShareAccess ? "ENABLED" : "DISABLED"}.
- Microphone Access: ${microphoneAccess ? "ENABLED" : "DISABLED"}.
- Camera Access: ${cameraAccess ? "ENABLED" : "DISABLED"}.
- System Commands Access (shutdown, restart, sleep, power actions): ${systemCommandsAccess ? "ENABLED" : "DISABLED"}.

IMPORTANT: Browser automation, mouse/keyboard control, application management, volume/brightness control, and all other tools NOT listed above are ALWAYS ENABLED by default. Do NOT refuse these or say "permission denied" — they require no special permission. Only refuse if the specific permission above is explicitly marked DISABLED.`;

      // Track running transcription state for auto memory consolidation
      let dialogueHistory: { role: string; text: string }[] = [];
      let currentModelResponseText = "";
      
      clientWs.send(JSON.stringify({ type: "status", status: "creating_session" }));
      console.log("[Server] Establishing Gemini Live connection...");
      
      const session = await ai.live.connect({
        model: "gemini-3.1-flash-live-preview",
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: voiceName } },
          },
          systemInstruction: customizedInstructions,
          tools: [
            {
              functionDeclarations: [
                {
                  name: "browserOpen",
                  description: "Opens a designated website URL or interface tab inside Myraa's web agent console.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      url: {
                        type: Type.STRING,
                        description: "The destination website address or path, e.g. youtube.com, google.com, instagram.com, wikipedia.org."
                      }
                    },
                    required: ["url"]
                  }
                },
                {
                  name: "browserSearch",
                  description: "Enters a query search term inside the active website's search box (Google Search or YouTube Search).",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      query: {
                        type: Type.STRING,
                        description: "The text query term to search for."
                      }
                    },
                    required: ["query"]
                  }
                },
                {
                  name: "browserClick",
                  description: "Traces computer cursor and clicks on a target button, link, or video cell ID inside the active webpage viewport.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      selector: {
                        type: Type.STRING,
                        description: "The selector target ID, e.g. 'video-mWRsgZjdfQI' for a video, 'search-result-0' for Google link index, or 'play-button', 'pause-button'."
                      },
                      description: {
                        type: Type.STRING,
                        description: "A short, friendly label description of the item being clicked, e.g. 'Imagine Dragons - Believer video element'."
                      }
                    },
                    required: ["selector"]
                  }
                },
                {
                  name: "browserMediaControl",
                  description: "Controls ongoing video/audio stream media properties on YouTube, like play, pause, volume, mute, skip, and fullscreen.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      action: {
                        type: Type.STRING,
                        description: "The media controller command operation.",
                        enum: ["play", "pause", "volume", "fullscreen", "exit_fullscreen", "mute", "unmute", "skip"]
                      },
                      value: {
                        type: Type.INTEGER,
                        description: "The value parameter; only relevant for set volume level, e.g. 50 for fifty percent."
                      }
                    },
                    required: ["action"]
                  }
                },
                {
                  name: "browserScroll",
                  description: "Scrolls the currently active webpage vertically up or down.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      direction: {
                        type: Type.STRING,
                        description: "The scroll vector movement.",
                        enum: ["up", "down"]
                      },
                      amount: {
                        type: Type.INTEGER,
                        description: "The distance height parameter in pixels (defaults to 300)."
                      }
                    }
                  }
                },
                {
                  name: "browserType",
                  description: "Enters typed letters/commands inside the active input container.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      text: {
                        type: Type.STRING,
                        description: "The exact letters to type in."
                      }
                    },
                    required: ["text"]
                  }
                },
                {
                  name: "browserGoBack",
                  description: "Navigates back to the previous webpage inside the current tab memory history.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {}
                  }
                },
                {
                  name: "browserTabAction",
                  description: "Performs standard browser-tab actions: open new tab, close a tab, or switch index values.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      action: {
                        type: Type.STRING,
                        description: "Tab action instruction.",
                        enum: ["new", "close", "switch"]
                      },
                      tabId: {
                        type: Type.STRING,
                        description: "The tab identifier string if closing or switching."
                      },
                      url: {
                        type: Type.STRING,
                        description: "The initial starting URL if creating a new tab."
                      }
                    },
                    required: ["action"]
                  }
                },
                {
                  name: "changeBackground",
                  description: "Changes the visual theme or atmospheric glow color of Myraa's interface.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      color: {
                        type: Type.STRING,
                        description: "The theme color name (violet, crimson, emerald, celestial, gold, rose, charcoal)"
                      }
                    },
                    required: ["color"]
                  }
                },
                {
                  name: "saveCustomMemory",
                  description: "Allows Myraa to immediately save a piece of critical user information to her persistent memory core.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      category: {
                        type: Type.STRING,
                        description: "The memory category.",
                        enum: ["identity", "preference", "goal", "project", "relationship", "emotional", "behavior"]
                      },
                      text: {
                        type: Type.STRING,
                        description: "Precise third-person statement."
                      }
                    },
                    required: ["category", "text"]
                  }
                },

                // ======== DESKTOP CONTROL TOOLS (routed to Python agent) ========
                {
                  name: "openApplication",
                  description: "Open a desktop application (e.g. Notepad, Chrome, VS Code, Calculator, File Explorer, Task Manager, Settings, CMD, PowerShell).",
                  parameters: { type: Type.OBJECT, properties: { name: { type: Type.STRING, description: "Application name, e.g. 'notepad', 'chrome', 'vscode'." } }, required: ["name"] }
                },
                {
                  name: "closeApplication",
                  description: "Close a running desktop application by name.",
                  parameters: { type: Type.OBJECT, properties: { name: { type: Type.STRING, description: "Application name." }, force: { type: Type.BOOLEAN, description: "Force close (default false)." } }, required: ["name"] }
                },
                {
                  name: "openWebsite",
                  description: "Open a named website or URL in the user's default system browser. Supports shortcuts: youtube, gmail, google, github, chatgpt, etc.",
                  parameters: { type: Type.OBJECT, properties: { name: { type: Type.STRING, description: "Site name shortcut (e.g. 'youtube', 'gmail')." }, url: { type: Type.STRING, description: "Full URL if no shortcut." } } }
                },
                {
                  name: "searchWeb",
                  description: "Search a website engine (google, youtube, github, duckduckgo, bing) and open results in the default browser.",
                  parameters: { type: Type.OBJECT, properties: { query: { type: Type.STRING, description: "Search query." }, engine: { type: Type.STRING, description: "Engine name (default 'google')." } }, required: ["query"] }
                },
                {
                  name: "searchYouTube",
                  description: "Search YouTube and open results in the default browser.",
                  parameters: { type: Type.OBJECT, properties: { query: { type: Type.STRING, description: "Search query." } }, required: ["query"] }
                },
                {
                  name: "searchGoogle",
                  description: "Search Google and open results in the default browser.",
                  parameters: { type: Type.OBJECT, properties: { query: { type: Type.STRING, description: "Search query." } }, required: ["query"] }
                },
                {
                  name: "searchGitHub",
                  description: "Search GitHub repositories and open results in the default browser.",
                  parameters: { type: Type.OBJECT, properties: { query: { type: Type.STRING, description: "Search query." } }, required: ["query"] }
                },
                {
                  name: "createFile",
                  description: "Create a new text file with optional content. Scoped to safe folders (Desktop, Documents, Downloads, etc.).",
                  parameters: { type: Type.OBJECT, properties: { path: { type: Type.STRING, description: "File path." }, content: { type: Type.STRING, description: "File content (default empty)." }, overwrite: { type: Type.BOOLEAN, description: "Overwrite if exists (default false)." } }, required: ["path"] }
                },
                {
                  name: "createFolder",
                  description: "Create a new folder.",
                  parameters: { type: Type.OBJECT, properties: { path: { type: Type.STRING, description: "Folder path." } }, required: ["path"] }
                },
                {
                  name: "copyFileOrFolder",
                  description: "Copy a file or a folder with all its contents to a new destination.",
                  parameters: { type: Type.OBJECT, properties: { source: { type: Type.STRING, description: "Source file or folder path." }, destination: { type: Type.STRING, description: "Destination path." } }, required: ["source", "destination"] }
                },
                {
                  name: "readFile",
                  description: "Read the contents of a text file.",
                  parameters: { type: Type.OBJECT, properties: { path: { type: Type.STRING, description: "File path." }, max_chars: { type: Type.INTEGER, description: "Max chars to return (default 8000)." } }, required: ["path"] }
                },
                {
                  name: "renameFile",
                  description: "Rename a file.",
                  parameters: { type: Type.OBJECT, properties: { path: { type: Type.STRING, description: "Current file path." }, new_name: { type: Type.STRING, description: "New file name." } }, required: ["path", "new_name"] }
                },
                {
                  name: "deleteFile",
                  description: "Delete a file. Sends to Recycle Bin by default (safe). Use permanent=true for hard delete.",
                  parameters: { type: Type.OBJECT, properties: { path: { type: Type.STRING, description: "File path." }, permanent: { type: Type.BOOLEAN, description: "Permanently delete (default false)." } }, required: ["path"] }
                },
                {
                  name: "moveFile",
                  description: "Move a file to a new location.",
                  parameters: { type: Type.OBJECT, properties: { path: { type: Type.STRING, description: "Source file path." }, destination: { type: Type.STRING, description: "Destination path or folder." } }, required: ["path", "destination"] }
                },
                {
                  name: "openFolder",
                  description: "Open a folder in File Explorer. Supports aliases: desktop, documents, downloads, pictures, music, videos, home.",
                  parameters: { type: Type.OBJECT, properties: { name: { type: Type.STRING, description: "Folder name or alias." }, path: { type: Type.STRING, description: "Full path if no alias." } } }
                },
                {
                  name: "listFiles",
                  description: "List files in a folder.",
                  parameters: { type: Type.OBJECT, properties: { name: { type: Type.STRING, description: "Folder name or alias." }, path: { type: Type.STRING, description: "Full path." }, pattern: { type: Type.STRING, description: "Glob pattern (default '*')." } } }
                },
                {
                  name: "searchFiles",
                  description: "Search for files by name glob or extension under a folder.",
                  parameters: { type: Type.OBJECT, properties: { name: { type: Type.STRING, description: "Filename glob (e.g. '*.py')." }, extension: { type: Type.STRING, description: "File extension (e.g. 'py')." }, folder: { type: Type.STRING, description: "Folder to search (default home)." }, limit: { type: Type.INTEGER, description: "Max results (default 100)." } } }
                },
                {
                  name: "volumeUp",
                  description: "Increase system volume.",
                  parameters: { type: Type.OBJECT, properties: { amount: { type: Type.NUMBER, description: "Step amount 0-1 (default 0.1)." } } }
                },
                {
                  name: "volumeDown",
                  description: "Decrease system volume.",
                  parameters: { type: Type.OBJECT, properties: { amount: { type: Type.NUMBER, description: "Step amount 0-1 (default 0.1)." } } }
                },
                {
                  name: "setVolume",
                  description: "Set system volume to a specific percentage.",
                  parameters: { type: Type.OBJECT, properties: { percent: { type: Type.NUMBER, description: "Volume percentage 0-100." } }, required: ["percent"] }
                },
                {
                  name: "muteToggle",
                  description: "Toggle mute/unmute on the system volume.",
                  parameters: { type: Type.OBJECT, properties: {} }
                },
                {
                  name: "requestPowerAction",
                  description: "FIRST STEP for dangerous power actions. Generates a confirmation token. Tell the user verbally, then call executePowerAction with the token if they confirm. Actions: shutdown, restart, sleep, lock.",
                  parameters: { type: Type.OBJECT, properties: { action: { type: Type.STRING, description: "Power action: shutdown, restart, sleep, lock." } }, required: ["action"] }
                },
                {
                  name: "executePowerAction",
                  description: "SECOND STEP: execute a previously-confirmed power action. Requires a valid execute_token from requestPowerAction. Single-use, expires in 60 seconds.",
                  parameters: { type: Type.OBJECT, properties: { action: { type: Type.STRING, description: "The confirmed power action." }, execute_token: { type: Type.STRING, description: "Confirmation token from requestPowerAction." } }, required: ["action", "execute_token"] }
                },
                {
                  name: "minimizeWindow",
                  description: "Minimize the active window or a named window.",
                  parameters: { type: Type.OBJECT, properties: { title: { type: Type.STRING, description: "Window title to match (optional, defaults to active window)." } } }
                },
                {
                  name: "maximizeWindow",
                  description: "Maximize the active window or a named window.",
                  parameters: { type: Type.OBJECT, properties: { title: { type: Type.STRING, description: "Window title to match." } } }
                },
                {
                  name: "closeWindow",
                  description: "Close the active window or a named window.",
                  parameters: { type: Type.OBJECT, properties: { title: { type: Type.STRING, description: "Window title to match." } } }
                },
                {
                  name: "switchApplication",
                  description: "Switch to a named application window, or cycle Alt+Tab if no title given.",
                  parameters: { type: Type.OBJECT, properties: { title: { type: Type.STRING, description: "Window title to switch to." } } }
                },
                {
                  name: "copySelected",
                  description: "Copy selected text: sends Ctrl+C and reads the clipboard.",
                  parameters: { type: Type.OBJECT, properties: { wait: { type: Type.NUMBER, description: "Seconds to wait after Ctrl+C (default 0.35)." } } }
                },
                {
                  name: "pasteClipboard",
                  description: "Paste text into the active input. Writes text to clipboard then sends Ctrl+V.",
                  parameters: { type: Type.OBJECT, properties: { text: { type: Type.STRING, description: "Text to paste. If omitted, pastes current clipboard." } } }
                },
                {
                  name: "getClipboard",
                  description: "Read the current clipboard text content.",
                  parameters: { type: Type.OBJECT, properties: { max_chars: { type: Type.INTEGER, description: "Max chars (default 1000)." } } }
                },
                {
                  name: "clearClipboard",
                  description: "Empty the clipboard.",
                  parameters: { type: Type.OBJECT, properties: {} }
                },
                {
                  name: "takeScreenshot",
                  description: "Capture the full screen. Optionally include base64 image data.",
                  parameters: { type: Type.OBJECT, properties: { include_image: { type: Type.BOOLEAN, description: "Include base64 JPEG image (default false)." }, max_dim: { type: Type.INTEGER, description: "Max image dimension (default 1280)." } } }
                },
                {
                  name: "saveScreenshot",
                  description: "Save a screenshot to Pictures/MyraaScreenshots.",
                  parameters: { type: Type.OBJECT, properties: { name: { type: Type.STRING, description: "Optional filename prefix." } } }
                },
                {
                  name: "analyzeScreenshot",
                  description: "Take a screenshot and run OCR to extract visible text from the screen.",
                  parameters: { type: Type.OBJECT, properties: { max_chars: { type: Type.INTEGER, description: "Max OCR chars (default 1500)." } } }
                },
                {
                  name: "readScreen",
                  description: "OCR the active window and return its title plus visible text.",
                  parameters: { type: Type.OBJECT, properties: { max_chars: { type: Type.INTEGER, description: "Max OCR chars (default 1500)." } } }
                },
                {
                  name: "desktopBrowserSnapshot",
                  description: "Capture an accessibility (ARIA) snapshot of the current browser page. Returns a tree of interactive elements, each tagged with a ref like [ref=e1], [ref=e2]. ALWAYS call this BEFORE clicking or typing to see the actual page structure — never guess selectors. The refs returned (e.g. 'e3') are used with desktopBrowserClick/desktopBrowserType for precise, human-level targeting.",
                  parameters: { type: Type.OBJECT, properties: {} }
                },
                {
                  name: "desktopBrowserOpen",
                  description: "Open a URL in the desktop Playwright automation browser (real Chromium, separate from holographic UI). Persistent profile — logins/cookies survive.",
                  parameters: { type: Type.OBJECT, properties: { url: { type: Type.STRING, description: "URL to open." } }, required: ["url"] }
                },
                {
                  name: "desktopBrowserSearch",
                  description: "Navigate directly to a search engine results page in the desktop automation browser.",
                  parameters: { type: Type.OBJECT, properties: { query: { type: Type.STRING, description: "Search query." }, engine: { type: Type.STRING, description: "Engine: google, youtube, github, duckduckgo, bing." } }, required: ["query"] }
                },
                {
                  name: "desktopBrowserClick",
                  description: "Click an element in the desktop automation browser. PREFERRED: use 'ref' from a prior desktopBrowserSnapshot (e.g. ref='e3') for precise targeting. Fallback: selector (CSS), text, or role+name. If the click times out, call desktopBrowserSnapshot again to refresh refs.",
                  parameters: { type: Type.OBJECT, properties: { ref: { type: Type.STRING, description: "Element ref from a desktopBrowserSnapshot, e.g. 'e3'. MOST RELIABLE — always prefer this." }, selector: { type: Type.STRING, description: "CSS selector (fallback only)." }, text: { type: Type.STRING, description: "Visible text to click (fallback)." }, role: { type: Type.STRING, description: "ARIA role e.g. 'button', 'link' (fallback)." }, name: { type: Type.STRING, description: "Accessible name for the role (fallback)." } } }
                },
                {
                  name: "desktopBrowserType",
                  description: "Type text into a field in the desktop automation browser. PREFERRED: use 'ref' from a desktopBrowserSnapshot to target the exact input field. Fallback: selector. Clears the field by default before typing.",
                  parameters: { type: Type.OBJECT, properties: { text: { type: Type.STRING, description: "Text to type." }, ref: { type: Type.STRING, description: "Element ref from a snapshot, e.g. 'e2'." }, selector: { type: Type.STRING, description: "Optional CSS selector for a specific input (fallback)." }, clear: { type: Type.BOOLEAN, description: "Clear before typing (default true)." } }, required: ["text"] }
                },
                {
                  name: "desktopBrowserFillForm",
                  description: "Fill multiple form fields and optionally submit in the desktop automation browser.",
                  parameters: { type: Type.OBJECT, properties: { fields: { type: Type.OBJECT, description: "Object of selector -> value pairs." }, submit: { type: Type.STRING, description: "Optional submit button selector." } }, required: ["fields"] }
                },
                {
                  name: "desktopBrowserOpenTab",
                  description: "Open a new tab in the desktop automation browser.",
                  parameters: { type: Type.OBJECT, properties: { url: { type: Type.STRING, description: "URL for the new tab." } } }
                },
                {
                  name: "desktopBrowserCloseTab",
                  description: "Close the active tab in the desktop automation browser.",
                  parameters: { type: Type.OBJECT, properties: {} }
                },
                {
                  name: "desktopBrowserGoBack",
                  description: "Navigate back in the desktop automation browser history.",
                  parameters: { type: Type.OBJECT, properties: {} }
                },
                {
                  name: "desktopBrowserGoForward",
                  description: "Navigate forward in the desktop automation browser history.",
                  parameters: { type: Type.OBJECT, properties: {} }
                },
                {
                  name: "browserGoForward",
                  description: "Navigate forward in the browser history.",
                  parameters: { type: Type.OBJECT, properties: {} }
                },
                {
                  name: "desktopBrowserRefresh",
                  description: "Reload/refresh the current page in the browser.",
                  parameters: { type: Type.OBJECT, properties: {} }
                },
                {
                  name: "browserRefresh",
                  description: "Reload/refresh the current page in the browser.",
                  parameters: { type: Type.OBJECT, properties: {} }
                },
                {
                  name: "desktopBrowserPageSearch",
                  description: "Find occurrences of a text string on the active page (like Ctrl+F). Highlights or scrolls to matches.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      text: { type: Type.STRING, description: "The word or phrase to search for." }
                    },
                    required: ["text"]
                  }
                },
                {
                  name: "browserPageSearch",
                  description: "Find occurrences of a text string on the active page (like Ctrl+F). Highlights or scrolls to matches.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      text: { type: Type.STRING, description: "The word or phrase to search for." }
                    },
                    required: ["text"]
                  }
                },
                {
                  name: "desktopBrowserDoubleClick",
                  description: "Double click an element in the browser. PREFERRED: use 'ref' from a desktopBrowserSnapshot.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      ref: { type: Type.STRING, description: "Element ref from snapshot, e.g. 'e3'." },
                      selector: { type: Type.STRING, description: "Optional CSS selector fallback." }
                    }
                  }
                },
                {
                  name: "browserDoubleClick",
                  description: "Double click an element in the browser. PREFERRED: use 'ref' from a snapshot.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      ref: { type: Type.STRING, description: "Element ref from snapshot, e.g. 'e3'." },
                      selector: { type: Type.STRING, description: "Optional CSS selector fallback." }
                    }
                  }
                },
                {
                  name: "desktopBrowserRightClick",
                  description: "Right click an element in the browser. PREFERRED: use 'ref' from a desktopBrowserSnapshot.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      ref: { type: Type.STRING, description: "Element ref from snapshot, e.g. 'e3'." },
                      selector: { type: Type.STRING, description: "Optional CSS selector fallback." }
                    }
                  }
                },
                {
                  name: "browserRightClick",
                  description: "Right click an element in the browser. PREFERRED: use 'ref' from a snapshot.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      ref: { type: Type.STRING, description: "Element ref from snapshot, e.g. 'e3'." },
                      selector: { type: Type.STRING, description: "Optional CSS selector fallback." }
                    }
                  }
                },
                {
                  name: "desktopBrowserDragAndDrop",
                  description: "Drag a source element and drop it on a target element in the browser.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      source_ref: { type: Type.STRING, description: "Source element ref from snapshot." },
                      target_ref: { type: Type.STRING, description: "Target element ref from snapshot." },
                      source_selector: { type: Type.STRING, description: "Optional source CSS selector fallback." },
                      target_selector: { type: Type.STRING, description: "Optional target CSS selector fallback." }
                    }
                  }
                },
                {
                  name: "browserDragAndDrop",
                  description: "Drag a source element and drop it on a target element in the browser.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      source_ref: { type: Type.STRING, description: "Source element ref from snapshot." },
                      target_ref: { type: Type.STRING, description: "Target element ref from snapshot." },
                      source_selector: { type: Type.STRING, description: "Optional source CSS selector fallback." },
                      target_selector: { type: Type.STRING, description: "Optional target CSS selector fallback." }
                    }
                  }
                },
                {
                  name: "desktopBrowserSelectText",
                  description: "Select/highlight a range of text in an element in the browser.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      ref: { type: Type.STRING, description: "Element ref from snapshot, e.g. 'e3'." },
                      selector: { type: Type.STRING, description: "Optional CSS selector fallback." }
                    }
                  }
                },
                {
                  name: "browserSelectText",
                  description: "Select/highlight a range of text in an element in the browser.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      ref: { type: Type.STRING, description: "Element ref from snapshot, e.g. 'e3'." },
                      selector: { type: Type.STRING, description: "Optional CSS selector fallback." }
                    }
                  }
                },
                {
                  name: "desktopBrowserZoom",
                  description: "Zoom page in, out, or reset in the browser (e.g. 'in', 'out', 'reset').",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      action: { type: Type.STRING, description: "Action: in, out, reset." }
                    },
                    required: ["action"]
                  }
                },
                {
                  name: "browserZoom",
                  description: "Zoom page in, out, or reset in the browser (e.g. 'in', 'out', 'reset').",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      action: { type: Type.STRING, description: "Action: in, out, reset." }
                    },
                    required: ["action"]
                  }
                },
                {
                  name: "desktopBrowserDuplicateTab",
                  description: "Duplicate the active tab in the browser.",
                  parameters: { type: Type.OBJECT, properties: {} }
                },
                {
                  name: "browserDuplicateTab",
                  description: "Duplicate the active tab in the browser.",
                  parameters: { type: Type.OBJECT, properties: {} }
                },
                {
                  name: "desktopBrowserPinTab",
                  description: "Pin or unpin the active tab in the browser.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      pin: { type: Type.BOOLEAN, description: "True to pin, false to unpin." }
                    },
                    required: ["pin"]
                  }
                },
                {
                  name: "browserPinTab",
                  description: "Pin or unpin the active tab in the browser.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      pin: { type: Type.BOOLEAN, description: "True to pin, false to unpin." }
                    },
                    required: ["pin"]
                  }
                },
                {
                  name: "desktopBrowserBookmark",
                  description: "Add a bookmark for the current page in the browser with a custom title.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      title: { type: Type.STRING, description: "Optional custom title for the bookmark." }
                    }
                  }
                },
                {
                  name: "browserBookmark",
                  description: "Add a bookmark for the current page in the browser with a custom title.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      title: { type: Type.STRING, description: "Optional custom title for the bookmark." }
                    }
                  }
                },
                {
                  name: "desktopBrowserListDownloads",
                  description: "List files that have been downloaded during the current browser session.",
                  parameters: { type: Type.OBJECT, properties: {} }
                },
                {
                  name: "browserListDownloads",
                  description: "List files that have been downloaded during the current browser session.",
                  parameters: { type: Type.OBJECT, properties: {} }
                },
                {
                  name: "desktopBrowserUploadFile",
                  description: "Upload a local file to a file-input element in the browser.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      ref: { type: Type.STRING, description: "Element ref from snapshot, e.g. 'e3'." },
                      selector: { type: Type.STRING, description: "Optional CSS selector fallback." },
                      file_path: { type: Type.STRING, description: "Absolute or relative path of file on local PC." }
                    },
                    required: ["file_path"]
                  }
                },
                {
                  name: "browserUploadFile",
                  description: "Upload a local file to a file-input element in the browser.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      ref: { type: Type.STRING, description: "Element ref from snapshot, e.g. 'e3'." },
                      selector: { type: Type.STRING, description: "Optional CSS selector fallback." },
                      file_path: { type: Type.STRING, description: "Absolute or relative path of file on local PC." }
                    },
                    required: ["file_path"]
                  }
                },
                {
                  name: "desktopBrowserPrintToPDF",
                  description: "Print the current page to a PDF file on disk.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      output_path: { type: Type.STRING, description: "Where to save the PDF file, e.g. Downloads/mypage.pdf." }
                    },
                    required: ["output_path"]
                  }
                },
                {
                  name: "browserPrintToPDF",
                  description: "Print the current page to a PDF file on disk.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      output_path: { type: Type.STRING, description: "Where to save the PDF file, e.g. Downloads/mypage.pdf." }
                    },
                    required: ["output_path"]
                  }
                },
                {
                  name: "desktopBrowserDismissPopups",
                  description: "Dismiss common cookie consent dialogs, newsletter popups, and simple alert prompts.",
                  parameters: { type: Type.OBJECT, properties: {} }
                },
                {
                  name: "browserDismissPopups",
                  description: "Dismiss common cookie consent dialogs, newsletter popups, and simple alert prompts.",
                  parameters: { type: Type.OBJECT, properties: {} }
                },
                {
                  name: "desktopBrowserInfiniteScroll",
                  description: "Trigger loading of infinite-scrolling pages (like social feeds) by scrolling down iteratively.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      max_scrolls: { type: Type.INTEGER, description: "Max scroll iterations (default 5)." },
                      delay_seconds: { type: Type.NUMBER, description: "Seconds to wait between scrolls (default 1.0)." }
                    }
                  }
                },
                {
                  name: "browserInfiniteScroll",
                  description: "Trigger loading of infinite-scrolling pages (like social feeds) by scrolling down iteratively.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      max_scrolls: { type: Type.INTEGER, description: "Max scroll iterations (default 5)." },
                      delay_seconds: { type: Type.NUMBER, description: "Seconds to wait between scrolls (default 1.0)." }
                    }
                  }
                },
                {
                  name: "desktopBrowserWaitForElement",
                  description: "Wait for a specific element to be visible/present in the browser viewport.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      selector: { type: Type.STRING, description: "CSS selector of the element." },
                      timeout_seconds: { type: Type.INTEGER, description: "Max seconds to wait (default 10)." }
                    },
                    required: ["selector"]
                  }
                },
                {
                  name: "browserWaitForElement",
                  description: "Wait for a specific element to be visible/present in the browser viewport.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      selector: { type: Type.STRING, description: "CSS selector of the element." },
                      timeout_seconds: { type: Type.INTEGER, description: "Max seconds to wait (default 10)." }
                    },
                    required: ["selector"]
                  }
                },
                {
                  name: "desktopBrowserScroll",
                  description: "Scroll the desktop automation browser page.",
                  parameters: { type: Type.OBJECT, properties: { direction: { type: Type.STRING, description: "Scroll direction: up or down." }, amount: { type: Type.INTEGER, description: "Pixels to scroll (default 500)." } } }
                },
                {
                  name: "desktopBrowserScreenshot",
                  description: "Take a screenshot of the current browser page (compressed JPEG). Use this to visually see what's on the page when the ARIA snapshot is unclear or to verify a page loaded correctly. The image is returned as base64 — you can see it.",
                  parameters: { type: Type.OBJECT, properties: { fullPage: { type: Type.BOOLEAN, description: "Capture the full scrollable page (default false)." } } }
                },
                {
                  name: "desktopBrowserGetText",
                  description: "Extract readable text content from the current browser page (or a specific element). Use this to read article content, search results, product details, email subjects — any text on the page.",
                  parameters: { type: Type.OBJECT, properties: { selector: { type: Type.STRING, description: "Optional CSS selector to read a specific element (default: entire page body)." } } }
                },
                {
                  name: "desktopBrowserListTabs",
                  description: "List all open browser tabs with their URLs and titles.",
                  parameters: { type: Type.OBJECT, properties: {} }
                },
                {
                  name: "desktopBrowserSwitchTab",
                  description: "Switch the active browser tab by index (from desktopBrowserListTabs).",
                  parameters: { type: Type.OBJECT, properties: { index: { type: Type.INTEGER, description: "Tab index (0-based)." } }, required: ["index"] }
                },
                {
                  name: "desktopBrowserPressKey",
                  description: "Press a single keyboard key in the browser (e.g. 'Enter', 'Escape', 'Tab'). Useful to submit a search form after typing.",
                  parameters: { type: Type.OBJECT, properties: { key: { type: Type.STRING, description: "Key name e.g. 'Enter', 'Escape', 'Tab', 'ArrowDown'." } }, required: ["key"] }
                },
                {
                  name: "desktopBrowserMediaControl",
                  description: "Control media playback in the browser (YouTube etc.). Actions: play, pause, volumeup, volumedown, mute, unmute, skip, fullscreen.",
                  parameters: { type: Type.OBJECT, properties: { action: { type: Type.STRING, description: "Action: play, pause, volumeup, volumedown, mute, unmute, skip, fullscreen." } }, required: ["action"] }
                },
                {
                  name: "browserSessionStatus",
                  description: "Check the status, current page URL, title, and open tab count of the active browser automation session.",
                  parameters: { type: Type.OBJECT, properties: {} }
                },
                {
                  name: "desktopBrowserSessionStatus",
                  description: "Check the status, current page URL, title, and open tab count of the active browser automation session.",
                  parameters: { type: Type.OBJECT, properties: {} }
                },
                {
                  name: "browserSessionClose",
                  description: "Manually close the active browser session and release resources. Call ONLY when the user explicitly requests to close or exit the browser.",
                  parameters: { type: Type.OBJECT, properties: {} }
                },
                {
                  name: "desktopBrowserSessionClose",
                  description: "Manually close the active browser session and release resources. Call ONLY when the user explicitly requests to close or exit the browser.",
                  parameters: { type: Type.OBJECT, properties: {} }
                },
                {
                  name: "browserSessionRestore",
                  description: "Ensure the browser session is open and optionally navigate to a specific URL, restoring its persistent state.",
                  parameters: { type: Type.OBJECT, properties: { url: { type: Type.STRING, description: "Optional URL to open/restore to." } } }
                },
                {
                  name: "desktopBrowserSessionRestore",
                  description: "Ensure the browser session is open and optionally navigate to a specific URL, restoring its persistent state.",
                  parameters: { type: Type.OBJECT, properties: { url: { type: Type.STRING, description: "Optional URL to open/restore to." } } }
                },
                {
                  name: "ocrHealthCheck",
                  description: "Runs a comprehensive health check of the local Tesseract OCR installation, detecting available language data files (English, Bangla, Hindi).",
                  parameters: { type: Type.OBJECT, properties: {} }
                },
                {
                  name: "desktopOcrHealthCheck",
                  description: "Runs a comprehensive health check of the local Tesseract OCR installation, detecting available language data files (English, Bangla, Hindi).",
                  parameters: { type: Type.OBJECT, properties: {} }
                },
                {
                  name: "createPythonFile",
                  description: "Create a Python (.py) file with content.",
                  parameters: { type: Type.OBJECT, properties: { path: { type: Type.STRING, description: "File path." }, content: { type: Type.STRING, description: "Python code content." }, overwrite: { type: Type.BOOLEAN, description: "Overwrite if exists." } }, required: ["path"] }
                },
                {
                  name: "writeCodeFile",
                  description: "Create a code file in any language with appropriate extension.",
                  parameters: { type: Type.OBJECT, properties: { path: { type: Type.STRING, description: "File path." }, content: { type: Type.STRING, description: "Code content." }, language: { type: Type.STRING, description: "Language name (e.g. 'python', 'javascript', 'html')." }, overwrite: { type: Type.BOOLEAN, description: "Overwrite if exists." } }, required: ["path"] }
                },
                {
                  name: "createProjectFolder",
                  description: "Create a project folder structure with optional subfolders and starter files.",
                  parameters: { type: Type.OBJECT, properties: { path: { type: Type.STRING, description: "Project root folder path." }, subfolders: { type: Type.ARRAY, items: { type: Type.STRING }, description: "List of subfolder names." }, scaffold_standard: { type: Type.BOOLEAN, description: "Create src, tests, docs subfolders." }, files: { type: Type.OBJECT, description: "Object of relative-path -> content for starter files." } }, required: ["path"] }
                },
                {
                  name: "runPythonScript",
                  description: "Execute a Python script and capture stdout, stderr, and exit code. Has a configurable timeout.",
                  parameters: { type: Type.OBJECT, properties: { path: { type: Type.STRING, description: "Script path." }, args: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Script arguments." }, timeout: { type: Type.INTEGER, description: "Timeout in seconds (default 30)." } }, required: ["path"] }
                },
                {
                  name: "systemInfo",
                  description: "Get system resource usage: CPU %, RAM %, disk usage, uptime, OS info.",
                  parameters: { type: Type.OBJECT, properties: {} }
                },
                {
                  name: "gpuInfo",
                  description: "Get NVIDIA GPU stats: utilization %, VRAM usage, temperature. Graceful fallback if no NVIDIA GPU.",
                  parameters: { type: Type.OBJECT, properties: {} }
                },
                {
                  name: "temperatureInfo",
                  description: "Get available temperature readings (CPU, GPU, etc.). Best-effort on Windows.",
                  parameters: { type: Type.OBJECT, properties: {} }
                },
                {
                  name: "clearRecycleBin",
                  description: "Empty the operating system recycle bin / trash folder. Call when the user explicitly requests to clear or empty the Recycle Bin.",
                  parameters: { type: Type.OBJECT, properties: {} }
                },
                // --- V2: Brightness control ---
                {
                  name: "brightnessUp",
                  description: "Increase screen brightness by a step (default 10%). Use when user says 'increase brightness' or 'make screen brighter'.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      amount: { type: Type.NUMBER, description: "Percentage to increase (default 10)." }
                    }
                  }
                },
                {
                  name: "brightnessDown",
                  description: "Decrease screen brightness by a step (default 10%). Use when user says 'decrease brightness' or 'dim screen'.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      amount: { type: Type.NUMBER, description: "Percentage to decrease (default 10)." }
                    }
                  }
                },
                {
                  name: "setBrightness",
                  description: "Set screen brightness to an exact level. Use when user says 'set brightness to 50%' or 'brightness 80'.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      percent: { type: Type.NUMBER, description: "Target brightness 0-100." }
                    },
                    required: ["percent"]
                  }
                },
                // --- V2: Windows auto-start management ---
                {
                  name: "enableAutoStart",
                  description: "Enable MYRAA to launch automatically when Windows starts. Creates a silent startup entry.",
                  parameters: { type: Type.OBJECT, properties: {} }
                },
                {
                  name: "disableAutoStart",
                  description: "Disable MYRAA auto-start on Windows login. Removes the startup entry.",
                  parameters: { type: Type.OBJECT, properties: {} }
                },
                {
                  name: "getAutoStartStatus",
                  description: "Check whether MYRAA is currently configured to auto-start on Windows login.",
                  parameters: { type: Type.OBJECT, properties: {} }
                },
                // --- V2: Mouse & keyboard input control ---
                {
                  name: "moveCursor",
                  description: "Move the mouse pointer to absolute screen coordinates (x, y pixels). Use when user says 'move mouse' or gives a screen position.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      x: { type: Type.INTEGER, description: "Target X pixel coordinate." },
                      y: { type: Type.INTEGER, description: "Target Y pixel coordinate." }
                    },
                    required: ["x", "y"]
                  }
                },
                {
                  name: "mouseClick",
                  description: "Click the mouse: left, right, or middle; single or double. Use 'right' for context menus, double-clicks for opening items.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      button: { type: Type.STRING, description: "left, right, or middle (default left)." },
                      clicks: { type: Type.INTEGER, description: "Number of clicks (default 1; 2 = double-click)." },
                      x: { type: Type.INTEGER, description: "Optional X coordinate to click at." },
                      y: { type: Type.INTEGER, description: "Optional Y coordinate to click at." }
                    }
                  }
                },
                {
                  name: "typeText",
                  description: "Type a string of text into the currently focused input field or element. Use after clicking an input or when an element is already focused.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      text: { type: Type.STRING, description: "The text to type." }
                    },
                    required: ["text"]
                  }
                },
                {
                  name: "pressKey",
                  description: "Press a single keyboard key, e.g. 'enter', 'escape', 'tab', 'space', 'backspace', 'delete', 'up', 'down'.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      key: { type: Type.STRING, description: "Key name, e.g. 'enter', 'escape', 'tab'." }
                    },
                    required: ["key"]
                  }
                },
                {
                  name: "sendHotkey",
                  description: "Press a keyboard shortcut combo, e.g. 'ctrl+c', 'ctrl+v', 'alt+f4', 'win+d', 'ctrl+shift+esc'. Use for any multi-key shortcut.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      keys: { type: Type.STRING, description: "Hotkey combo like 'ctrl+c' or 'alt+tab'." }
                    },
                    required: ["keys"]
                  }
                },
                {
                  name: "scrollMouse",
                  description: "Scroll the mouse wheel up or down by a number of clicks.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      direction: { type: Type.STRING, description: "up or down (default down)." },
                      amount: { type: Type.INTEGER, description: "Number of scroll clicks (default 5)." }
                    }
                  }
                },
                // --- V2: Advanced file search & editing ---
                {
                  name: "searchPcWide",
                  description: "Search the ENTIRE PC across all drives (C:, D:, E:, etc.) for a file or folder using fuzzy matching. Ignores spaces, dots, dashes, underscores. Use when user says 'find' or 'open' something without a full path, e.g. 'open mydata folder', 'find config.json'. Auto-opens the best match.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      query: { type: Type.STRING, description: "File/folder name or fuzzy path like 'F:/my data/3.userdata' or just 'mydata'." },
                      limit: { type: Type.INTEGER, description: "Max results (default 50)." }
                    },
                    required: ["query"]
                  }
                },
                // --- Semantic / intent-based file search ---
                {
                  name: "semanticSearchFiles",
                  description: "Find files or folders from a NATURAL-LANGUAGE description (intent + type hints + recency). Use this when the user describes WHAT they want rather than an exact name. Examples: 'React project খুলে দাও', 'yesterday PDF edit করেছিলাম', 'Web development folder-er React file'. Auto-opens the best match.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      query: { type: Type.STRING, description: "Natural-language description of the file/folder to find." },
                      pc_wide: { type: Type.BOOLEAN, description: "Search all drives (default false — safe roots only)." },
                      open: { type: Type.BOOLEAN, description: "Open the best match (default true)." },
                      limit: { type: Type.INTEGER, description: "Max results (default 8)." },
                      max_depth: { type: Type.INTEGER, description: "Walk depth (default 6)." }
                    },
                    required: ["query"]
                  }
                },
                {
                  name: "editFile",
                  description: "Edit a file in-place by finding and replacing text. Supports exact string or regex replacement. Saves changes immediately. Use for commands like 'change the port to 3005 in config.json'.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      path: { type: Type.STRING, description: "File path to edit." },
                      find: { type: Type.STRING, description: "Exact text to find (use this OR find_regex)." },
                      replace: { type: Type.STRING, description: "Text to replace with (default empty)." },
                      find_regex: { type: Type.STRING, description: "Regex pattern to find (use this OR find)." },
                      allow_anywhere: { type: Type.BOOLEAN, description: "Allow editing files outside safe folders (default false)." }
                    },
                    required: ["path"]
                  }
                },
                {
                  name: "desktopBrowserNavigate",
                  description: "Navigate the desktop automation browser to a new URL (alias of desktopBrowserOpen).",
                  parameters: { type: Type.OBJECT, properties: { url: { type: Type.STRING, description: "URL to navigate to." } }, required: ["url"] }
                },
                // --- V3: Smart visual clicking ---
                {
                  name: "screenResolution",
                  description: "Get the screen size in physical pixels. Call this before computing any absolute coordinates.",
                  parameters: { type: Type.OBJECT, properties: {} }
                },
                {
                  name: "clickOnText",
                  description: "Find text or a label VISIBLE on the screen via OCR and click its exact center. USE THIS (not mouseClick with guessed coordinates) when the user says 'click on <something visible like a button, icon label, or menu item>'. Fuzzy-matches (ignores case/punctuation).",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      text: { type: Type.STRING, description: "The visible text/label to find and click, e.g. 'Settings', 'Chrome', 'Save'." },
                      button: { type: Type.STRING, description: "left, right, or middle (default left)." },
                      double: { type: Type.BOOLEAN, description: "Double-click (default false)." }
                    },
                    required: ["text"]
                  }
                },
                {
                  name: "findOnScreen",
                  description: "Find where a visible text/label is on screen (returns coordinates) WITHOUT clicking. Use to locate something before deciding the next step.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      text: { type: Type.STRING, description: "The text to locate." }
                    },
                    required: ["text"]
                  }
                }
              ]
            }
          ]
        },
        callbacks: {
          onmessage: (message: LiveServerMessage) => {
            // Audio Stream Chunk (model response audio play, 24kHz raw PCM)
            const audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (audio) {
              clientWs.send(JSON.stringify({ type: "audio", audio }));
            }
            
            // Interruption flag
            if (message.serverContent?.interrupted) {
              console.log("[Myraa Interrupted!]");
              clientWs.send(JSON.stringify({ type: "interrupted" }));
            }
            
            // Turn Complete
            if (message.serverContent?.turnComplete) {
              clientWs.send(JSON.stringify({ type: "turnComplete" }));
              
              if (currentModelResponseText.trim()) {
                dialogueHistory.push({ role: "model", text: currentModelResponseText });
                currentModelResponseText = "";
              }

              // Fire asynchronous memory extraction
              if (dialogueHistory.length >= 2) {
                (async () => {
                  try {
                    const updated = await processConversationSlice(apiKey, dialogueHistory);
                    if (updated) {
                      console.log("[Memory Sync] Sending refreshed memory list to client.");
                      clientWs.send(JSON.stringify({ type: "memory_sync", memories: updated }));
                    }
                  } catch (err) {
                    console.error("[Memory Sync] Error running background consolidation:", err);
                  }
                })();
              }
            }
            
            // Transcription of model output (text chunk)
            const modelText = (message.serverContent as any)?.modelTurn?.parts?.[0]?.text;
            if (modelText) {
              clientWs.send(JSON.stringify({ type: "transcription", role: "model", text: modelText }));
              currentModelResponseText += modelText;

              // Emotion detection (Fix 4): scan the just-spoken text and push
              // a mood frame to the client only when it changes, so the
              // assistant's video swaps to match what she is saying.
              const detected = classifyEmotion(modelText);
              if (detected && detected !== lastEmotion) {
                lastEmotion = detected;
                try {
                  clientWs.send(JSON.stringify({ type: "emotion", emotion: detected }));
                } catch (e) { /* client may have just disconnected */ }
              }
            }
            
            // User input transcription (user speech text translated by Gemini)
            const userTextOutput = (message.serverContent as any)?.userTurn?.parts?.[0]?.text;
            if (userTextOutput) {
              clientWs.send(JSON.stringify({ type: "transcription", role: "user", text: userTextOutput }));
              dialogueHistory.push({ role: "user", text: userTextOutput });
            }
            
            // Function Calls (Gemini requesting server/client tool execution)
            if (message.toolCall?.functionCalls) {
              for (const fc of message.toolCall.functionCalls) {
                console.log(`[Function Call]: ${fc.name}`, fc.args);
                
                if (fc.name === "saveCustomMemory") {
                  (async () => {
                    try {
                      const args = fc.args as any;
                      const category = args.category;
                      const text = args.text;
                      if (category && text) {
                        const mList = await loadMemories();
                        const timestamp = new Date().toISOString();
                        const newMemory: Memory = {
                          id: Math.random().toString(36).substring(2, 11),
                          category,
                          text,
                          createdAt: timestamp,
                          updatedAt: timestamp
                        };
                        mList.push(newMemory);
                        await saveMemories(mList);
                        
                        // Sync immediately with the React client
                        clientWs.send(JSON.stringify({ type: "memory_sync", memories: mList }));
                        
                        // Send success code back to live link
                        session.sendToolResponse({
                          functionResponses: [
                            {
                              name: fc.name,
                              response: { output: { result: "Memory successfully captured and persisted in connections core." } },
                              id: fc.id
                            }
                          ]
                        });
                      }
                    } catch (err: any) {
                      console.error("saveCustomMemory execution failure:", err);
                    }
                  })();
                } else if (DESKTOP_TOOLS.has(fc.name)) {
                  // ── Desktop control tools: route to Python agent ──
                  (async () => {
                    console.log(`[Desktop Agent] Routing ${fc.name} to Python backend...`);
                    try {
                      clientWs.send(JSON.stringify({
                        type: "browserAutomationEvent",
                        name: fc.name,
                        args: fc.args,
                        status: "started"
                      }));
                    } catch (e) {}

                    const agentResult = await callDesktopAgent(fc.name, fc.args as Record<string, unknown>);

                    if (agentResult.ok) {
                      const output = agentResult.result ?? { result: "Done." };
                      try {
                        clientWs.send(JSON.stringify({
                          type: "browserAutomationEvent",
                          name: fc.name,
                          args: fc.args,
                          status: "completed",
                          result: output
                        }));
                      } catch (e) {}

                      session.sendToolResponse({
                        functionResponses: [{
                          name: fc.name,
                          response: { output },
                          id: fc.id
                        }]
                      });
                    } else {
                      const errMsg = agentResult.error || "Desktop agent error.";
                      console.error(`[Desktop Agent] Error for ${fc.name}:`, errMsg);
                      try {
                        clientWs.send(JSON.stringify({
                          type: "browserAutomationEvent",
                          name: fc.name,
                          args: fc.args,
                          status: "failed",
                          error: errMsg
                        }));
                      } catch (e) {}

                      session.sendToolResponse({
                        functionResponses: [{
                          name: fc.name,
                          response: { output: { result: `Desktop control error: ${errMsg}` } },
                          id: fc.id
                        }]
                      });
                    }
                  })();
                } else {
                  clientWs.send(JSON.stringify({
                    type: "toolCall",
                    callId: fc.id,
                    name: fc.name,
                    args: fc.args
                  }));
                }
              }
            }
          },
          onclose: () => {
            console.log("Gemini Live session closed (idle timeout or server-side disconnect)");
            // Do NOT close the client WS here. The client (audio.ts) detects
            // session_closed and auto-reconnects, which creates a fresh Gemini
            // session. Closing the WS here would force a full reconnect cycle
            // (new mic acquisition, etc.) which is jarring for the user.
            try {
              clientWs.send(JSON.stringify({ type: "status", status: "session_closed" }));
            } catch (e) {
              // WS may already be gone — that's fine
            }
          }
        }
      });
      
      clientWs.send(JSON.stringify({ type: "status", status: "session_ready" }));
      clientWs.send(JSON.stringify({ type: "status", status: "connected" }));
      
      clientWs.on("message", (rawMsg) => {
        try {
          const msg = JSON.parse(rawMsg.toString());
          if (msg.type === "pong") {
            // Client heartbeat acknowledged
            return;
          }
          if (msg.type === "ping") {
            try {
              if (clientWs.readyState === clientWs.OPEN) {
                clientWs.send(JSON.stringify({ type: "pong" }));
              }
            } catch (e) {}
            return;
          }
          if (msg.audio) {
            session.sendRealtimeInput({
              audio: { data: msg.audio, mimeType: "audio/pcm;rate=16000" }
            });
          } else if (msg.type === "text" && msg.text) {
            // Chat text input from user → forward to Gemini Live session
            try {
              session.sendClientContent({
                turns: {
                  role: "user",
                  parts: [{ text: msg.text }],
                },
              });
              console.log(`[Chat] Text forwarded to Gemini: "${msg.text.substring(0, 80)}"`);
            } catch (e: any) {
              console.error("[Chat] Failed to send text to Gemini:", e?.message || e);
            }
          } else if (msg.type === "video" && msg.video) {
            session.sendRealtimeInput({
              video: { data: msg.video, mimeType: "image/jpeg" }
            });
          } else if (msg.type === "toolResponse") {
            session.sendToolResponse({
              functionResponses: [
                {
                  name: msg.name,
                  response: { output: msg.output },
                  id: msg.id
                }
              ]
            });
          }
        } catch (e) {
          console.error("Error editing/forwarding client frame message:", e);
        }
      });
      
      clientWs.on("close", () => {
        console.log("Client disconnected, closing Gemini session");
        clearInterval(serverHeartbeatInterval);
        try {
          // Gracefully close the Gemini session — this prevents orphaned
          // server-side sessions that leak memory and count against quotas.
          session.close();
        } catch (e) {}
      });
      
    } catch (err: any) {
      clearInterval(serverHeartbeatInterval);
      const errMsg = err?.message || String(err);
      console.error("Error connecting to Gemini Live API:", errMsg);
      logError(`GEMINI_SESSION_ERROR: ${errMsg.substring(0, 300)}`);

      // Do NOT close the WebSocket on Gemini errors. Instead, notify the client
      // and let it auto-reconnect. Closing the WS forces a full mic re-acquire
      // and loses the entire session state. A transient Gemini error (timeout,
      // rate limit, network blip) should be recoverable without a full reconnect.
      const isTransient = /timeout|rate.?limit|429|503|network|fetch|ECONN|socket|temporarily|unavailable/i.test(errMsg);
      if (isTransient) {
        try {
          clientWs.send(JSON.stringify({
            type: "status",
            status: "session_closed",
          }));
        } catch (e) {}
        console.log("[Server] Gemini session error was transient — client will auto-reconnect.");
      } else {
        // Non-transient (auth, invalid key, etc.) — send error to client.
        try {
          clientWs.send(JSON.stringify({
            type: "error",
            error: `Could not connect to Gemini: ${errMsg}`
          }));
        } catch (e) {}
        // Still don't close — let the client decide whether to retry.
      }
    }
  });

  // ── Client WebSocket error handler (catches protocol-level errors) ──
  wss.on("error", (err) => {
    console.error("[Server] WebSocket server error:", err?.message || err);
    logError(`WS_SERVER_ERROR: ${String(err).substring(0, 200)}`);
    // Do NOT crash — WebSocket errors can be transient.
  });

  // Serve custom static assets folder
  app.use("/assets", express.static(path.join(process.cwd(), "assets")));

  // Express Static assets / Vite Dev Middleware configuration
  if (process.env.NODE_ENV !== "production") {
    // Loaded lazily so the production bundle never requires vite (a dev-only
    // dependency that is not shipped with the packaged app).
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  server.listen(PORT, "0.0.0.0", () => {
    logStartup(`MYRAA V2 server started on http://localhost:${PORT}`);
    console.log(`[Server] Running on http://localhost:${PORT}`);
    // Kick off the desktop agent (probe + auto-spawn) immediately on boot.
    ensureDesktopAgent().catch((e) =>
      console.warn(`[Desktop Agent] Boot probe failed: ${e?.message || e}`)
    );
  });
}

startServer().catch((error) => {
  console.error("Failed to start server startup sequence:", error);
});

// ---------------------------------------------------------------------------
// CRASH GUARDS — prevent unhandled errors from killing the Electron process.
// Without these, any unhandled promise rejection or uncaught exception in the
// server (e.g. Gemini API timeout, network blip, JSON parse failure) would
// crash the entire Node process, taking down the Electron app with it.
// ---------------------------------------------------------------------------

// Catch unhandled promise rejections so they never crash the process.
process.on("unhandledRejection", (reason: any, promise: any) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error("[FATAL GUARD] Unhandled Promise Rejection:", msg);
  logError(`UNHANDLED_REJECTION: ${msg.substring(0, 300)}`);
  // Do NOT exit — keep the server alive. The user's session will auto-recover.
});

// Catch uncaught exceptions so a single bug doesn't kill the whole process.
process.on("uncaughtException", (error: Error) => {
  const msg = error?.message || String(error);
  console.error("[FATAL GUARD] Uncaught Exception:", msg);
  logError(`UNCAUGHT_EXCEPTION: ${msg.substring(0, 300)} | Stack: ${(error?.stack || "").substring(0, 500)}`);
  // Do NOT exit — swallow and continue. Better a degraded session than a
  // full app crash that forces the user to restart everything.
});

// Guard against SIGINT (Ctrl+C) accidentally killing the Electron parent
// during automation. In the Electron context, SIGINT can be sent by the
// OS or a parent process. We ignore stray SIGINT in the server process —
// the Electron main process handles the actual app quit via before-quit.
process.on("SIGINT", () => {
  console.log("[Server] SIGINT received — ignoring (use app quit to exit).");
});
process.on("SIGTERM", () => {
  console.log("[Server] SIGTERM received — ignoring (use app quit to exit).");
});
