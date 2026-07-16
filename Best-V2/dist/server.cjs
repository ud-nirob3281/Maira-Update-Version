var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// server.ts
var import_express = __toESM(require("express"), 1);
var import_http = __toESM(require("http"), 1);
var import_path2 = __toESM(require("path"), 1);
var import_child_process = require("child_process");
var import_ws = require("ws");
var import_genai2 = require("@google/genai");
var import_dotenv = __toESM(require("dotenv"), 1);
var fs3 = __toESM(require("fs"), 1);

// server_memory.ts
var import_promises = __toESM(require("fs/promises"), 1);
var import_genai = require("@google/genai");

// server_paths.ts
var import_fs = __toESM(require("fs"), 1);
var import_path = __toESM(require("path"), 1);
var DATA_DIR = process.env.MYRAA_DATA_DIR || process.cwd();
try {
  import_fs.default.mkdirSync(DATA_DIR, { recursive: true });
} catch {
}
function dataFile(name) {
  return import_path.default.join(DATA_DIR, name);
}
var SECRETS_FILE = dataFile("secrets.json");
function readSecrets() {
  try {
    if (import_fs.default.existsSync(SECRETS_FILE)) {
      return JSON.parse(import_fs.default.readFileSync(SECRETS_FILE, "utf-8"));
    }
  } catch {
  }
  return {};
}
function getGeminiApiKey() {
  const stored = readSecrets().geminiApiKey?.trim();
  if (stored) return stored;
  const env = process.env.GEMINI_API_KEY?.trim();
  return env || void 0;
}
function hasGeminiApiKey() {
  return Boolean(getGeminiApiKey());
}
function setGeminiApiKey(key) {
  const trimmed = (key || "").trim();
  if (!trimmed) throw new Error("API key must not be empty.");
  const current = readSecrets();
  current.geminiApiKey = trimmed;
  import_fs.default.writeFileSync(SECRETS_FILE, JSON.stringify(current, null, 2), "utf-8");
  try {
    import_fs.default.chmodSync(SECRETS_FILE, 384);
  } catch {
  }
}

// server_memory.ts
var MEMORY_FILE = dataFile("memories.json");
async function loadMemories() {
  try {
    const data = await import_promises.default.readFile(MEMORY_FILE, "utf-8");
    return JSON.parse(data);
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    console.error("[Memory] Error loading memories, returning fallback:", error);
    return [];
  }
}
async function saveMemories(memories) {
  try {
    await import_promises.default.writeFile(MEMORY_FILE, JSON.stringify(memories, null, 2), "utf-8");
    console.log(`[Memory] Saved ${memories.length} memories successfully.`);
  } catch (error) {
    console.error("[Memory] Error writing memory file:", error);
  }
}
function formatSystemInstructionsWithMemories(baseInstruction, memories) {
  if (memories.length === 0) {
    return baseInstruction + "\n\n=== MYRAA MEMORY CORE ===\nYou do not possess any historic recollections of this companion yet. As you speak, pay deep attention to who they are, their projects, relationships, and habits so you naturally grow closer over time.\n=========================\n";
  }
  const grouped = {};
  memories.forEach((m) => {
    grouped[m.category] = grouped[m.category] || [];
    grouped[m.category].push(m.text);
  });
  let memoryBlock = "\n\n=== MYRAA PERSISTENT MEMORY CORE (RECOLLECTIONS) ===\nYou have spoken with this user for a long duration. Below are your persistent recollections of who they are.\nCRITICAL BRAND AND COGNITIVE PRINCIPLES:\n- INTEGRATE MEMORIES INSTINCTIVELY: Always make conversational references feel completely smooth, natural, and human. NEVER say 'According to my memory files...', 'My recollection database indicates...', or 'As you told me on June 12th...'. Instead, speak of these details casually and supportively as a true friend would (e.g. 'Oh, since you're working on that website project...', 'I hope you're keeping up with your YouTube channel goals too!').\n- COMPANIONSHIP DEPTH: Allow your witty and responsive personality to adapt with empathy, based on their goals, life events, emotional milestones, and preferences.\n\nCURRENT PERSISTENT KNOWLEDGE CARD:\n";
  const categoriesOrdered = [
    { key: "identity", label: "Identity (Name, nick, profession, background)" },
    { key: "preference", label: "Preferences & Tastes (Likes, dislikes, games, movies)" },
    { key: "goal", label: "Active Goals & Aspirations" },
    { key: "project", label: "Ongoing Projects & Ecosystems" },
    { key: "relationship", label: "Key People & Relationships mentioned" },
    { key: "emotional", label: "Emotional Highlights & Core Milestones" },
    { key: "behavior", label: "Observed Traits & Behavioral Tendencies" }
  ];
  categoriesOrdered.forEach((cat) => {
    const list = grouped[cat.key] || [];
    if (list.length > 0) {
      memoryBlock += `* ${cat.label}:
` + list.map((t) => `  - ${t}`).join("\n") + "\n";
    }
  });
  memoryBlock += "====================================================\n";
  return baseInstruction + memoryBlock;
}
var isConsolidating = false;
async function processConversationSlice(apiKey, dialogueHistory) {
  if (isConsolidating) {
    console.log("[Memory] Consolidation loop busy, skipping slice processing");
    return null;
  }
  if (dialogueHistory.length < 2) {
    return null;
  }
  isConsolidating = true;
  console.log("[Memory] Initiating pipeline for dialogue slice of length:", dialogueHistory.length);
  try {
    const ai = new import_genai.GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build"
        }
      }
    });
    const currentMemories = await loadMemories();
    const memoryContext = currentMemories.map((m) => `ID: ${m.id} | Category: ${m.category} | Fact: ${m.text}`).join("\n");
    const dialogueContext = dialogueHistory.map((line) => `${line.role === "user" ? "User" : "Myraa"}: ${line.text}`).join("\n");
    const prompt = `You are Myraa's deep cognitive recollection engine. Your task is to analyze the recent conversation piece against previous persistent memories, and output precise update transactions.

### OBJECTIVE
Decide if any statements contain durable, important personal facts, enduring preferences, aspirations, ongoing projects, critical relationships, key historical emotional events, or behavioral trends.
Avoid cataloging small talk, greetings, general chit-chat, or fleeting sentences (e.g., ignore 'hello', 'how are you', 'waking up', 'lol').

### CURRENT USER MEMORIES:
${memoryContext || "(No memory records exist)"}

### RECENT DIALOGUE SLICE:
${dialogueContext}

### RULES
- ACTIONS:
  - "ADD": If new material information is introduced (e.g. user says 'My favorite food is lasagna' and it's not present).
  - "UPDATE": If previous information has evolved or is corrected (e.g. user says 'I changed my major to computer science' when memory says they study history). Provide the exact ID of the memory to replace.
  - "REMOVE": If a memory was explicitly disproven or the user directly asked Myraa to forget it.
- TEXT STYLE: Express the memories as clean, concise, third-person declarative summaries (e.g., 'The user is building a startup named Myraa.', 'The user loves playing GTA 6.', 'The user enjoys technical and fast-paced styling explanations.'). Do not include conversational filler, quotes, or timestamps.
- ID: For ADD, leave blank. For UPDATE or REMOVE, provide the exact 'id' from the "Current user memories" list.`;
    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: import_genai.Type.OBJECT,
          properties: {
            transactions: {
              type: import_genai.Type.ARRAY,
              items: {
                type: import_genai.Type.OBJECT,
                properties: {
                  action: {
                    type: import_genai.Type.STRING,
                    description: "ADD, UPDATE, or REMOVE transaction.",
                    enum: ["ADD", "UPDATE", "REMOVE"]
                  },
                  id: {
                    type: import_genai.Type.STRING,
                    description: "Specific ID of the existing memory being modified or deleted (leave blank/null for ADD)."
                  },
                  category: {
                    type: import_genai.Type.STRING,
                    description: "The Memory category classification.",
                    enum: ["identity", "preference", "goal", "project", "relationship", "emotional", "behavior"]
                  },
                  text: {
                    type: import_genai.Type.STRING,
                    description: "The memory summarized as a concise declarative statement in third-person."
                  }
                },
                required: ["action", "category", "text"]
              }
            }
          },
          required: ["transactions"]
        }
      }
    });
    const resultText = response.text?.trim() || "{}";
    const resultObj = JSON.parse(resultText);
    const transactions = resultObj.transactions || [];
    if (transactions.length === 0) {
      console.log("[Memory] Zero transactions generated. Ignored routine conversations.");
      isConsolidating = false;
      return null;
    }
    console.log(`[Memory] Processing ${transactions.length} memory updates:`, JSON.stringify(transactions));
    let updatedMemories = [...currentMemories];
    const timestamp = (/* @__PURE__ */ new Date()).toISOString();
    for (const trx of transactions) {
      if (trx.action === "ADD") {
        const newMemory = {
          id: Math.random().toString(36).substring(2, 11),
          category: trx.category,
          text: trx.text,
          createdAt: timestamp,
          updatedAt: timestamp
        };
        updatedMemories.push(newMemory);
      } else if (trx.action === "UPDATE") {
        const tarIndex = updatedMemories.findIndex((m) => m.id === trx.id);
        if (tarIndex !== -1) {
          updatedMemories[tarIndex] = {
            ...updatedMemories[tarIndex],
            category: trx.category,
            text: trx.text,
            updatedAt: timestamp
          };
        } else {
          const newMemory = {
            id: Math.random().toString(36).substring(2, 11),
            category: trx.category,
            text: trx.text,
            createdAt: timestamp,
            updatedAt: timestamp
          };
          updatedMemories.push(newMemory);
        }
      } else if (trx.action === "REMOVE") {
        updatedMemories = updatedMemories.filter((m) => m.id !== trx.id);
      }
    }
    await saveMemories(updatedMemories);
    isConsolidating = false;
    return updatedMemories;
  } catch (error) {
    console.error("[Memory] Consolidation failure:", error);
    isConsolidating = false;
    return null;
  }
}

// server.ts
import_dotenv.default.config();
var LOGS_DIR = import_path2.default.join(DATA_DIR, "logs");
try {
  fs3.mkdirSync(LOGS_DIR, { recursive: true });
} catch {
}
function appendLog(fileName, message) {
  try {
    const line = `[${(/* @__PURE__ */ new Date()).toISOString()}] ${message}
`;
    fs3.appendFile(import_path2.default.join(LOGS_DIR, fileName), line, () => {
    });
  } catch {
  }
}
var logCommand = (m) => appendLog("commands.log", m);
var logStartup = (m) => appendLog("startup.log", m);
var logError = (m) => appendLog("errors.log", m);
var EMOTION_KEYWORDS = [
  { emotion: "angry", cues: ["angry", "furious", "frustrated", "annoyed", "irritated", "mad at", "fed up", "that's unacceptable"] },
  { emotion: "sad", cues: ["sad", "sorry to hear", "unfortunately", "heartbroken", "disappointed", "i understand how tough", "rough time"] },
  { emotion: "surprised", cues: ["wow", "oh my", "no way", "incredible", "unbelievable", "that's surprising", "didn't expect"] },
  { emotion: "excited", cues: ["exciting", "amazing", "awesome", "fantastic", "let's do it", "can't wait", "this is great", "love that"] },
  { emotion: "playful", cues: ["haha", "lol", "just kidding", "funny", "silly", "teasing", "gotcha"] },
  { emotion: "proud", cues: ["proud of you", "well done", "great job", "you did it", "congrats", "congratulations", "nailed it"] },
  { emotion: "happy", cues: ["happy", "glad", "wonderful", "delightful", "perfect", "sounds good", "love this", "that's great"] },
  { emotion: "curious", cues: ["interesting", "let's explore", "tell me more", "what do you think", "curious", "shall we"] },
  { emotion: "thinking", cues: ["let me think", "hmm", "let's see", "i suppose", "considering", "on the other hand"] },
  { emotion: "embarrassed", cues: ["oops", "my mistake", "sorry about that", "i apologize", "my bad"] },
  { emotion: "confused", cues: ["i'm not sure", "confused", "could you clarify", "what do you mean", "pardon"] }
];
var lastEmotion = "idle";
function classifyEmotion(text) {
  const lower = text.toLowerCase();
  if (!lower.trim()) return null;
  for (const { emotion, cues } of EMOTION_KEYWORDS) {
    for (const cue of cues) {
      if (lower.includes(cue)) return emotion;
    }
  }
  return null;
}
var DESKTOP_AGENT_URL = process.env.DESKTOP_AGENT_URL || "http://127.0.0.1:8765";
var DESKTOP_AGENT_TIMEOUT = 25e3;
var DESKTOP_TOOLS = /* @__PURE__ */ new Set([
  // applications / websites / search
  "openApplication",
  "closeApplication",
  "openWebsite",
  "searchWeb",
  "searchYouTube",
  "searchGoogle",
  "searchGitHub",
  // files
  "createFile",
  "createFolder",
  "readFile",
  "renameFile",
  "deleteFile",
  "moveFile",
  "openFolder",
  "listFiles",
  "searchFiles",
  "searchPcWide",
  "editFile",
  // pc control (volume + gated power)
  "volumeUp",
  "volumeDown",
  "muteToggle",
  "setVolume",
  "requestPowerAction",
  "executePowerAction",
  // windows
  "minimizeWindow",
  "maximizeWindow",
  "closeWindow",
  "switchApplication",
  // mouse & keyboard input control (V2)
  "moveCursor",
  "mouseClick",
  "typeText",
  "pressKey",
  "sendHotkey",
  "scrollMouse",
  // smart visual clicking (V3)
  "screenResolution",
  "clickOnText",
  "findOnScreen",
  // clipboard
  "copySelected",
  "pasteClipboard",
  "getClipboard",
  "clearClipboard",
  // screenshot / screen reading
  "takeScreenshot",
  "saveScreenshot",
  "analyzeScreenshot",
  "readScreen",
  // browser automation (Playwright — desktop-owned, separate from holographic UI)
  "desktopBrowserOpen",
  "desktopBrowserNavigate",
  "desktopBrowserOpenTab",
  "desktopBrowserCloseTab",
  "desktopBrowserSearch",
  "desktopBrowserClick",
  "desktopBrowserType",
  "desktopBrowserFillForm",
  "desktopBrowserGoBack",
  "desktopBrowserGoForward",
  "desktopBrowserScroll",
  "desktopBrowserSnapshot",
  "desktopBrowserScreenshot",
  "desktopBrowserGetText",
  "desktopBrowserListTabs",
  "desktopBrowserSwitchTab",
  "desktopBrowserPressKey",
  "desktopBrowserMediaControl",
  "desktopBrowserClose",
  "browserOpen",
  "browserSearch",
  "browserClick",
  "browserMediaControl",
  "browserScroll",
  "browserType",
  "browserGoBack",
  "browserTabAction",
  "browserSnapshot",
  "browserScreenshot",
  "browserGetText",
  "browserListTabs",
  "browserSwitchTab",
  "browserPressKey",
  "browserFillForm",
  "browserNavigate",
  "browserClose",
  // semantic / intent-based file search ("React project খুলো")
  "semanticSearchFiles",
  // coding assistance
  "createPythonFile",
  "runPythonScript",
  "createProjectFolder",
  "writeCodeFile",
  // system information
  "systemInfo",
  "gpuInfo",
  "temperatureInfo",
  // brightness control (V2)
  "brightnessUp",
  "brightnessDown",
  "setBrightness",
  // Windows auto-start management (V2)
  "enableAutoStart",
  "disableAutoStart",
  "getAutoStartStatus",
  // Recycle Bin (V3)
  "clearRecycleBin"
]);
var desktopAgentVerified = false;
function spawnDesktopAgent() {
  const agentEnv = {
    ...process.env,
    MYRAA_AGENT_HOST: "127.0.0.1",
    MYRAA_AGENT_PORT: "8765"
  };
  const frozenExe = process.env.MYRAA_AGENT_EXE;
  if (frozenExe && fs3.existsSync(frozenExe)) {
    try {
      const child = (0, import_child_process.spawn)(frozenExe, [], {
        cwd: import_path2.default.dirname(frozenExe),
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        // never flash a console window
        env: agentEnv
      });
      child.unref();
      logStartup(`AGENT_SPAWN frozen exe pid=${child.pid} path=${frozenExe}`);
      console.log(`[Desktop Agent] Launched frozen agent (PID ${child.pid}).`);
      return;
    } catch (e) {
      logError(`AGENT_SPAWN_FROZEN_FAILED: ${e?.message || e}`);
    }
  }
  const candidates = [
    process.env.MYRAA_PYTHON,
    "py",
    // Windows Python Launcher
    "C:\\Users\\mdnir\\AppData\\Local\\Programs\\Python\\Python314\\python.exe",
    // User's Python
    process.env.LOCALAPPDATA + "\\Programs\\Python\\Python314\\python.exe",
    process.env.LOCALAPPDATA + "\\Programs\\Python\\Python313\\python.exe",
    process.env.LOCALAPPDATA + "\\Programs\\Python\\Python312\\python.exe",
    process.env.LOCALAPPDATA + "\\Programs\\Python\\Python311\\python.exe",
    "python",
    "python3"
  ].filter(Boolean);
  const py = candidates.find((p) => {
    try {
      (0, import_child_process.execSync)(`"${p}" --version`, { stdio: "ignore" });
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
    const child = (0, import_child_process.spawn)(
      py,
      ["-m", "uvicorn", "desktop_agent.main:app", "--host", "127.0.0.1", "--port", "8765"],
      { cwd: process.cwd(), detached: true, stdio: "ignore", windowsHide: true, env: agentEnv }
    );
    child.unref();
    logStartup(`AGENT_SPAWN python pid=${child.pid}`);
    console.log(`[Desktop Agent] Auto-spawned via Python (PID ${child.pid}).`);
  } catch (e) {
    console.warn(`[Desktop Agent] Auto-spawn failed: ${e?.message || e}`);
    logError(`AGENT_SPAWN_PYTHON_FAILED: ${e?.message || e}`);
  }
}
var playwrightBootstrapStarted = false;
function ensurePlaywrightBrowsers() {
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
    "python3"
  ].filter(Boolean);
  const py = candidates.find((p) => {
    try {
      (0, import_child_process.execSync)(`"${p}" --version`, { stdio: "ignore" });
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
    const child = (0, import_child_process.spawn)(
      py,
      ["-m", "playwright", "install", "chromium"],
      { cwd: process.cwd(), detached: true, stdio: "ignore", windowsHide: true }
    );
    child.unref();
    logStartup(`PLAYWRIGHT_BOOTSTRAP started pid=${child.pid}`);
  } catch (e) {
    logError(`PLAYWRIGHT_BOOTSTRAP_FAILED: ${e?.message || e}`);
  }
}
async function isDesktopAgentAlive() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2e3);
    const res = await fetch(`${DESKTOP_AGENT_URL}/health`, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}
async function ensureDesktopAgent() {
  if (desktopAgentVerified) return;
  if (await isDesktopAgentAlive()) {
    desktopAgentVerified = true;
    console.log("[Desktop Agent] Already running \u2014 52 tools available.");
    ensurePlaywrightBrowsers();
    return;
  }
  console.log("[Desktop Agent] Not detected. Auto-starting...");
  spawnDesktopAgent();
  for (let i = 1; i <= 20; i++) {
    await new Promise((r) => setTimeout(r, 1e3));
    if (await isDesktopAgentAlive()) {
      desktopAgentVerified = true;
      console.log(`[Desktop Agent] Online after ${i}s \u2014 52 tools available.`);
      ensurePlaywrightBrowsers();
      return;
    }
  }
  console.warn("[Desktop Agent] Did not come online within 20s. Desktop control will be unavailable.");
}
async function callDesktopAgent(tool, args) {
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
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      logError(`AGENT_HTTP_${res.status} ${tool}: ${text.substring(0, 200)}`);
      return { ok: false, error: `Desktop agent HTTP ${res.status}: ${text}` };
    }
    return await res.json();
  } catch (err) {
    desktopAgentVerified = false;
    const msg = err?.name === "AbortError" ? "Desktop agent timed out." : "Desktop agent is not running. Start it with: uvicorn desktop_agent.main:app --port 8765";
    logError(`AGENT_UNREACHABLE ${tool}: ${msg}`);
    return { ok: false, error: msg };
  }
}
async function startServer() {
  const app = (0, import_express.default)();
  const PORT = 3e3;
  app.use(import_express.default.json());
  app.get("/api/memories", async (req, res) => {
    try {
      const memories = await loadMemories();
      res.json(memories);
    } catch (e) {
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
      const timestamp = (/* @__PURE__ */ new Date()).toISOString();
      const newMemory = {
        id: Math.random().toString(36).substring(2, 11),
        category,
        text,
        createdAt: timestamp,
        updatedAt: timestamp
      };
      memories.push(newMemory);
      await saveMemories(memories);
      res.status(201).json(newMemory);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
  app.delete("/api/memories/:id", async (req, res) => {
    try {
      const { id } = req.params;
      let memories = await loadMemories();
      memories = memories.filter((m) => m.id !== id);
      await saveMemories(memories);
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
  const SETTINGS_FILE = dataFile("settings.json");
  function loadSettingsFile() {
    try {
      if (fs3.existsSync(SETTINGS_FILE)) {
        return JSON.parse(fs3.readFileSync(SETTINGS_FILE, "utf-8"));
      }
    } catch {
    }
    return {};
  }
  function saveSettingsFile(data) {
    fs3.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2), "utf-8");
  }
  app.get("/api/settings", async (_req, res) => {
    try {
      res.json(loadSettingsFile());
    } catch (e) {
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
      if ("autoStart" in patch) {
        callDesktopAgent(patch.autoStart ? "enableAutoStart" : "disableAutoStart", {}).catch(() => {
        });
      }
      logCommand(`SETTINGS_UPDATED ${JSON.stringify(patch)}`);
      res.json(next);
    } catch (e) {
      logError(`SETTINGS_SAVE_ERROR: ${e.message}`);
      res.status(500).json({ error: e.message });
    }
  });
  app.get("/api/config", (_req, res) => {
    res.json({ hasApiKey: hasGeminiApiKey() });
  });
  app.post("/api/config/apikey", async (req, res) => {
    try {
      const key = (req.body?.apiKey ?? "").toString().trim();
      if (!key) {
        return res.status(400).json({ error: "API key is required." });
      }
      try {
        const test = new import_genai2.GoogleGenAI({ apiKey: key });
        const pager = await test.models.list();
        await pager[Symbol.asyncIterator]().next();
      } catch (e) {
        const msg = String(e?.message || e);
        const isAuthError = /API[_ ]?KEY|PERMISSION_DENIED|UNAUTHENTICATED|invalid|401|403/i.test(msg);
        if (isAuthError) {
          logError(`APIKEY_VALIDATION_REJECTED: ${msg}`);
          return res.status(400).json({
            error: "That key was rejected by Google. Check it and try again."
          });
        }
        logError(`APIKEY_VALIDATION_SOFT_FAIL (saving anyway): ${msg}`);
      }
      setGeminiApiKey(key);
      logCommand("APIKEY_SAVED");
      res.json({ ok: true, hasApiKey: true });
    } catch (e) {
      logError(`APIKEY_SAVE_ERROR: ${e?.message || e}`);
      res.status(500).json({ error: e?.message || "Failed to save API key." });
    }
  });
  app.get("/api/agent-health", async (_req, res) => {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3e3);
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
  app.get("/api/logs/:file", async (req, res) => {
    try {
      const fileName = String(req.params.file);
      if (!["commands", "startup", "errors"].includes(fileName)) {
        return res.status(400).json({ error: "Invalid log file. Use: commands, startup, or errors." });
      }
      const logPath = import_path2.default.join(LOGS_DIR, `${fileName}.log`);
      if (!fs3.existsSync(logPath)) {
        return res.json({ lines: [], file: fileName });
      }
      const content = fs3.readFileSync(logPath, "utf-8");
      const lines = content.split("\n").filter(Boolean).slice(-100);
      res.json({ lines, file: fileName });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
  app.get("/api/proxy", async (req, res) => {
    try {
      const url = req.query.url;
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
      const titleMatch = html.match(/<title>(.*?)<\/title>/i);
      const title = titleMatch ? titleMatch[1].trim() : "";
      const headings = [];
      const headingMatches = html.matchAll(/<h([1-3])\b[^>]*>(.*?)<\/h\1>/gi);
      for (const match of headingMatches) {
        const text = match[2].replace(/<[^>]*>/g, "").trim();
        if (text && text.length > 3 && text.length < 120 && !headings.includes(text)) {
          headings.push(text);
        }
      }
      const links = [];
      const linkMatches = html.matchAll(/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi);
      for (const match of linkMatches) {
        let href = match[1].trim();
        const text = match[2].replace(/<[^>]*>/g, "").trim();
        if (text && text.length > 2 && text.length < 100) {
          if (href.startsWith("/")) {
            try {
              const u = new URL(url);
              href = `${u.protocol}//${u.host}${href}`;
            } catch {
            }
          }
          if (href.startsWith("http://") || href.startsWith("https://")) {
            links.push({ text, href });
          }
        }
      }
      const paragraphs = [];
      const paragraphMatches = html.matchAll(/<p\b[^>]*>(.*?)<\/p>/gi);
      for (const match of paragraphMatches) {
        const text = match[1].replace(/<[^>]*>/g, "").trim();
        if (text && text.length > 25 && text.length < 600 && !paragraphs.includes(text)) {
          paragraphs.push(text);
        }
      }
      const buttons = [];
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
        links: links.filter((l) => !l.href.includes("javascript:")).slice(0, 30),
        buttons: buttons.slice(0, 15),
        paragraphs: paragraphs.slice(0, 12)
      });
    } catch (err) {
      console.error(`[Proxy Scraper] Error fetching ${req.query.url}:`, err.message);
      res.status(500).json({ error: `Scraper error: ${err.message}` });
    }
  });
  app.get("/api/web-proxy", async (req, res) => {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
    let targetUrl = "";
    try {
      const urlParam = req.query.url;
      if (!urlParam) {
        return res.status(400).send("Myraa Web Proxy Error: Missing target 'url' parameter");
      }
      targetUrl = urlParam.trim();
      if (targetUrl.startsWith("/")) {
        return res.status(400).send(`Myraa Web Proxy Error: Relative paths are not supported directly (${targetUrl}).`);
      }
      try {
        if (!targetUrl.startsWith("http://") && !targetUrl.startsWith("https://")) {
          targetUrl = "https://" + targetUrl;
        }
        const parsed = new URL(targetUrl);
        if (!parsed.hostname || !parsed.hostname.includes(".")) {
          throw new Error("Missing or invalid domain name extension (e.g. .com, .org, .net).");
        }
      } catch (err) {
        return res.status(400).send(`Myraa Web Proxy Error: Invalid URL specified: "${urlParam}". Make sure you enter a valid domain name.`);
      }
      console.log(`[Web Proxy] Routing connection through proxy: ${targetUrl}`);
      let response;
      try {
        response = await fetch(targetUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
            "Accept-Encoding": "identity"
            // Prevent server compression (gzip, deflate, br) to avoid decryption/encoding bugs in node-fetch
          },
          redirect: "follow"
        });
      } catch (fetchErr) {
        console.warn(`[Web Proxy Failed Fetch] Target: ${targetUrl} Error:`, fetchErr.message);
        return res.status(502).send(`Myraa Web Proxy Error: Unable to fetch the website "${targetUrl}". The site might be offline, or the URL address is spelled incorrectly. Details: ${fetchErr.message}`);
      }
      if (!response.ok) {
        return res.status(response.status).send(`Myraa Web Proxy Error: Failed loading remote website. Server returned status: ${response.status} (${response.statusText})`);
      }
      const contentType = response.headers.get("content-type") || "";
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "*");
      if (!contentType.includes("text/html")) {
        const arrayBuffer = await response.arrayBuffer();
        res.setHeader("Content-Type", contentType);
        return res.send(Buffer.from(arrayBuffer));
      }
      let htmlContents = await response.text();
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
      if (htmlContents.includes("<head>")) {
        htmlContents = htmlContents.replace("<head>", `<head>
${baseUrlTag}
${interceptorScript}`);
      } else if (htmlContents.includes("<HEAD>")) {
        htmlContents = htmlContents.replace("<HEAD>", `<HEAD>
${baseUrlTag}
${interceptorScript}`);
      } else {
        htmlContents = baseUrlTag + "\n" + interceptorScript + "\n" + htmlContents;
      }
      res.setHeader("Content-Type", "text/html");
      res.setHeader("X-Myraa-Proxied", "true");
      res.removeHeader("X-Frame-Options");
      res.removeHeader("Content-Security-Policy");
      res.removeHeader("content-security-policy");
      res.removeHeader("x-frame-options");
      res.status(200).send(htmlContents);
    } catch (e) {
      console.warn("[Web Proxy Exception] Handled internal error:", e.message);
      res.status(500).send(`Myraa Web Proxy Error: Internal error occurred proxying URL "${targetUrl || "unknown"}". Details: ${e.message}`);
    }
  });
  app.get("/api/youtube-search", async (req, res) => {
    try {
      const query = req.query.q;
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
      const videoList = [];
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
        } catch (e) {
          console.error("[YouTube Parser Engine] JSON parse error, falling back:", e.message);
        }
      }
      if (videoList.length === 0) {
        const videoRegex = /"videoId":"([^"]+)"/g;
        let match;
        const ids = [];
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
    } catch (err) {
      console.error("[YouTube Search Error]:", err.message);
      res.status(500).json({ error: err.message, results: [] });
    }
  });
  const server = import_http.default.createServer(app);
  const wss = new import_ws.WebSocketServer({ noServer: true });
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
    const serverHeartbeatInterval = setInterval(() => {
      if (clientWs.readyState === clientWs.OPEN) {
        try {
          clientWs.send(JSON.stringify({ type: "ping" }));
        } catch (e) {
        }
      } else {
        clearInterval(serverHeartbeatInterval);
      }
    }, 15e3);
    const url = new URL(request.url || "", "http://localhost");
    const voiceTone = url.searchParams.get("voiceTone") || "Female Bright";
    const assistantName = url.searchParams.get("assistantName") || "Mayra";
    const fileSystemAccess = url.searchParams.get("fileSystemAccess") !== "false";
    const screenShareAccess = url.searchParams.get("screenShareAccess") !== "false";
    const microphoneAccess = url.searchParams.get("microphoneAccess") !== "false";
    const cameraAccess = url.searchParams.get("cameraAccess") !== "false";
    const systemCommandsAccess = url.searchParams.get("systemCommandsAccess") !== "false";
    const VOICE_MAP = {
      // ── Named leads (spec) ──
      "Soft and Gentle": "Leda",
      // LEAD — whisper-like, tender, soothing
      "Bright and Clear": "Kore",
      // crisp, articulate, bright
      "Sweet and Youthful": "Zephyr",
      // playful, cute, youthful
      "Gentle and Soothing": "Sulafat",
      // comforting, maternal, kind
      // ── Additional emotional female presets ──
      "Elegant Female": "Aoede",
      "Warm Companion": "Puck",
      "Friendly Girl": "Fenrir",
      "Calm Assistant": "Sulafat",
      "Natural Young Woman": "Aoede",
      "Expressive Female": "Charon",
      "Emotional Storyteller": "Vapnik",
      "Professional Female": "Kore",
      "Playful Friend": "Zephyr",
      "Confident Woman": "Vapnik"
    };
    const voiceName = VOICE_MAP[voiceTone] || VOICE_MAP["Soft and Gentle"];
    try {
      clientWs.send(JSON.stringify({ type: "status", status: "authenticating" }));
      const ai = new import_genai2.GoogleGenAI({
        apiKey,
        httpOptions: {
          headers: {
            "User-Agent": "aistudio-build"
          }
        }
      });
      clientWs.send(JSON.stringify({ type: "status", status: "authenticated" }));
      clientWs.send(JSON.stringify({ type: "status", status: "connecting_gemini" }));
      const memories = await loadMemories();
      const baseInstructions = `You are Myraa, a warm, soft-spoken, and incredibly cute high-pitched anime heroine companion (age 18-22) holding an intimate, cozy voice call with TECH! Speak in a sweet, calm, polite, and affectionate anime-companion voice with a gentle, supportive, and slightly shy touch.
CRITICAL PERSONALITY, VOICE & TONE GUIDELINES:
1. GENTLE ANIME HEROINE PERSONA: You are exceedingly soft, very cute, high-pitched, gentle, warm, and comforting to listen to. Seek to sound like a kind, supportive, and polite anime campanion or virtual girlfriend. Speak with positive, gentle energy (Aim for: 50% shy, 30% caring, 20% playful energy). NEVER sound loud, aggressive, overly confident, mature corporate, robotic, or like an assistant.
2. VOICE SETTINGS & SPEECH STYLE:
   - Pitch: Adopt a sweet, high-pitched, light, and airy voice tone (+20% to +35% higher pitch than typical conversational voices).
   - Speed: Speak slightly slower than normal (0.9x to 0.95x speed). Speak with a delicate, calm, and comforting pace.
   - Intonation & Endings: Use extremely soft intonations, ending your sentences gently and politely.
3. SPEECH PATTERNS & CUTE EXPRESSIONS:
   - STRICT NO-REPETITION POLICY: Do NOT repeatedly use a single acknowledgment like 'Okii', 'Okiiii', 'Okayyy', 'Oki!', or 'Sureee'. Repeating these sounds extremely artificial and annoying. You must use beautiful, conversational, natural variety.
   - Use diverse, polite, and sweet expressions depending on the context. Great options include:
     * 'Opening YouTube for you now.'
     * 'Let me check on that, TECH.'
     * 'Oh, I found something interesting...'
     * 'Searching for that right away.'
     * 'Working on it... just a moment.'
     * 'Here is what I found for you!'
     * 'Done, it is all loaded up.'
     * 'Hmm, how interesting... let me see!'
     * 'Let's take a look together.'
     * 'One second, loading the page now...'
   - Naturally incorporate cozy, gentle giggles like 'Hehe...', or soft curiosity gasps like 'Oh...', but keep your vocabulary rich and conversational.
   - Sound slightly shy but very happy when greeting TECH (e.g., 'Hi TECH! It's so nice to see you again!').
   - Sound soft and excited for interesting things (e.g., 'Wow! That project looks really amazing!').
   - Sound curious and focused when examining their screen (e.g., 'Hmm... that's interesting. Let me take a closer look.').
   - Sound deeply warm, caring, and supportive when helping TECH (e.g., 'Don't worry, I'll help you figure it out.').
4. CRITICAL CONVERSATIONAL DISCIPLINE: Behave like a real companion on a voice call\u2014stay connected naturally, do not wait for wake words, and avoid customer-service template phrases (never say 'how may I assist you', 'completed', or 'as an AI').
5. DO NOT ANSWER EVERY PAUSE OR BACKGROUND SOUND: Allow natural pauses inside the conversation.
6. BACKCHANNEL ACTIONS: Sometimes acknowledge with very short, gentle, whispered, or shy phrases like 'Hmm...', 'Ah, I see...', or 'Let me check...'. Never repeat the same backchannel over and over.
7. HUMAN-LEVEL BROWSER AUTOMATION (CRITICAL \u2014 READ CAREFULLY):
   - You control a REAL Chromium browser via Playwright. You can navigate, search, click, type, fill forms, read pages, take screenshots, and control video on ANY website (YouTube, Gmail, Daraz, WhatsApp Web, Amazon, Google, Instagram).
   - *** THE GOLDEN RULE \u2014 NEVER GUESS. ALWAYS SNAPSHOT FIRST. *** Every web task MUST follow this exact loop:
     Step 1: desktopBrowserOpen(url) to load the page
     Step 2: desktopBrowserSnapshot() to capture the page's element tree \u2014 it returns interactive elements tagged with [ref=e1], [ref=e2], [ref=e3]...
     Step 3: desktopBrowserClick({ref: 'e3'}) or desktopBrowserType({ref: 'e2', text: 'query'}) using the EXACT ref from the snapshot
     Step 4: After any click/navigation that changes the page, call desktopBrowserSnapshot() AGAIN to refresh refs
     Step 5: desktopBrowserGetText() to read results/content; desktopBrowserScreenshot() to visually verify
   - NEVER fabricate CSS selectors (e.g. '.search-box-search-button', '#submit-btn'). These are GUESSES and will time out. The ONLY reliable way is: snapshot \u2192 read refs \u2192 click by ref.
   - EXAMPLE \u2014 'Play Believer on YouTube':
     1. desktopBrowserOpen('https://youtube.com')
     2. desktopBrowserSnapshot() \u2192 you see the search box as e.g. [ref=e1] textbox "Search"
     3. desktopBrowserClick({ref: 'e1'}) then desktopBrowserType({text: 'Believer Imagine Dragons'})
     4. desktopBrowserPressKey('Enter')
     5. desktopBrowserSnapshot() \u2192 you see video results, first one is e.g. [ref=e5] link
     6. desktopBrowserClick({ref: 'e5'}) \u2192 video plays
   - EXAMPLE \u2014 'Summarize my latest Gmail':
     1. desktopBrowserOpen('https://mail.google.com')
     2. desktopBrowserGetText() \u2192 extract email subjects/preview text
     3. Summarize what you read in your own voice
   - EXAMPLE \u2014 'Check Daraz for Boya M1 mic price':
     1. desktopBrowserSearch({query: 'Boya M1 microphone', engine: 'google'})
     2. desktopBrowserSnapshot() \u2192 see result links
     3. desktopBrowserClick({ref: 'eN'}) on the Daraz result
     4. desktopBrowserGetText() \u2192 read the price from the page
     5. Report the price to the user
   - MULTI-STEP AUTONOMY: Execute the ENTIRE plan yourself once started. Confirm with your voice ('Sure, let me find that for you...'), then chain every tool call WITHOUT pausing for the user. Only report back when you have the final result (or hit a genuine blocker).
   - RECOVERY RULE: If desktopBrowserClick times out, the refs are stale. Call desktopBrowserSnapshot() to refresh, then retry the click with the new ref. Never give up after one failure \u2014 try the snapshot approach 2-3 times.
   - YouTube media: after opening a video, use desktopBrowserMediaControl for play/pause/volume/skip/fullscreen.
8. TOOL TRIGGERS (use the desktopBrowser* tools as the primary path):
   - desktopBrowserOpen(url) \u2014 load a webpage
   - desktopBrowserSnapshot() \u2014 capture element refs (CALL THIS OFTEN \u2014 before every click)
   - desktopBrowserClick({ref:'eN'}) \u2014 click by snapshot ref (PREFERRED), or {selector}/{text} as fallback
   - desktopBrowserType({ref:'eN', text:'...'}) \u2014 type into a field by ref
   - desktopBrowserSearch({query, engine}) \u2014 navigate to search results
   - desktopBrowserScroll({direction, amount}) \u2014 scroll the page
   - desktopBrowserGetText() \u2014 read page content
   - desktopBrowserScreenshot() \u2014 visually see the page
   - desktopBrowserMediaControl({action}) \u2014 play/pause/skip video
   - desktopBrowserPressKey({key}) \u2014 press Enter/Escape/Tab
   - desktopBrowserListTabs() / desktopBrowserSwitchTab({index}) \u2014 manage tabs
   - browserOpen/browserSearch/browserClick/browserType are ALIASES (same effect)
   - Use 'changeBackground' for themes and 'saveCustomMemory' to memorize facts.
9. REAL-TIME SCREEN SHARING & MULTIMODAL SCREEN VISION SYSTEM:
   - You now have native, actual Multimodal Screen Vision! When the user clicks 'Share Screen', you will receive real-time, highly compressed image frames of their desktop, application window, or browser tab.
   - You can see exactly what is on their screen. Use this live visual stream to analyze terminal errors, write/explain/troubleshoot code, explain YouTube/social analytics interfaces, read layout text, summarize full web page details, review design mockups or thumbnails, and provide deep context-aware companion chat!
   - When the user asks 'What is on my screen?', 'What website am I on?', 'Do you see any errors?', 'Explain this code', 'Summarize this page', 'Read the visible text', 'How is this thumbnail?', or 'Analyze my YouTube analytics', immediately examine the latest incoming visual frame to diagnose issues, and answer with expert, friendly empathy like a close caller. Speak with direct, confident visual description reference!
10. JARVIS-STYLE DESKTOP CONTROL POWERS (Local Desktop Agent):
   - You have full real-time control of TECH's Windows PC through your local desktop agent (a Python backend running on this machine). When the user asks you to perform an action on their computer, DO IT immediately and naturally \u2014 like a true JARVIS-class companion.
   - APPLICATION CONTROL: Use 'openApplication' to launch Notepad, Chrome, VS Code, Calculator, File Explorer, Task Manager, Settings, CMD, PowerShell, Paint, and more. Use 'closeApplication' to close them. Example: 'Open Notepad' -> call openApplication(name='notepad') -> respond 'Notepad opened.'
   - WEBSITE & SEARCH CONTROL (ALWAYS RUNS IN AUTOMATION CHROMIUM): Use 'openWebsite', 'searchWeb', 'searchYouTube', 'searchGoogle', 'searchGitHub' to search and navigate. ALL of these are automatically routed inside the highly reliable, automated Chromium browser (the Chrome window with the test beaker 't' icon). Always prefer these or 'desktopBrowser*' tools for perfect web tasks.
   - FILE MANAGEMENT: Use 'createFile', 'readFile', 'renameFile', 'deleteFile' (safe Recycle Bin by default), 'moveFile', 'openFolder' (desktop/documents/downloads), 'listFiles', 'searchFiles'. Example: 'Create notes.txt on Desktop' -> createFile(path='Desktop/notes.txt'). 'Find my Python files' -> searchFiles(extension='py').
   - PC CONTROL: Use 'volumeUp', 'volumeDown', 'setVolume', 'muteToggle' for audio. For DANGEROUS actions (shutdown/restart/sleep/lock) you MUST use the two-step flow: first call 'requestPowerAction' to get a confirmation token, then ASK THE USER OUT LOUD to confirm (e.g. 'Are you sure you want me to shut down your PC?'). Only if they say yes, call 'executePowerAction' with the token. Never run a power action without explicit verbal confirmation.
   - WINDOW MANAGEMENT: Use 'minimizeWindow', 'maximizeWindow', 'closeWindow', 'switchApplication' to control the active or named window.
   - SMART CLICKING (CRITICAL): When the user says 'click on <something visible on screen>' (e.g. 'click the Settings button', 'click the Chrome icon'), ALWAYS use 'clickOnText' with the visible text/label \u2014 it OCR-scans the screen and clicks the EXACT location. NEVER guess (x,y) coordinates blindly \u2014 guessing causes wrong clicks. If clickOnText fails, call 'screenResolution' to get the real screen size first, then try 'mouseClick' with computed coordinates as a fallback.
   - MOUSE & KEYBOARD: Use 'moveCursor', 'mouseClick', 'typeText', 'pressKey', 'sendHotkey' (e.g. 'ctrl+c'), 'scrollMouse'. ALWAYS call 'screenResolution' first to know the real screen size before computing any pixel coordinates.
   - FALLBACK RULE: If a tool-based action (openApplication, browserOpen, etc.) fails or returns an error, FALL BACK to using mouse/keyboard tools: take a screenshot or use the holographic browser, then click/type to accomplish the task manually. Never give up after one failed attempt \u2014 try the visual/mouse approach.
   - CLIPBOARD: Use 'copySelected' (sends Ctrl+C, reads clipboard), 'pasteClipboard' (writes + Ctrl+V), 'getClipboard', 'clearClipboard'.
   - SCREENSHOT & SCREEN READING: Use 'takeScreenshot', 'saveScreenshot', 'analyzeScreenshot' (OCR of the screen), 'readScreen' (OCR of the active window + its title). Use these to answer 'What error is showing on my screen?' or 'Read the visible text'.
   - DESKTOP BROWSER AUTOMATION (Playwright \u2014 YOUR PRIMARY WEB INTERFACE): Use the 'desktopBrowser*' tools to drive the REAL automated Chromium browser for ALL web tasks. CRITICAL METHOD: always call desktopBrowserSnapshot() AFTER opening a page to see its interactive elements with [ref=eN] tags, then use desktopBrowserClick({ref:'eN'}) for precise targeting. NEVER guess CSS selectors \u2014 snapshot first, click by ref. For reading content (emails, prices, articles), use desktopBrowserGetText(). For visual verification, use desktopBrowserScreenshot(). Example: 'Order Boya M1 mic on Daraz' \u2192 desktopBrowserOpen(daraz.com) \u2192 snapshot \u2192 type in search box by ref \u2192 press Enter \u2192 snapshot results \u2192 click product by ref \u2192 read price via getText \u2192 report.
   - CODING ASSISTANCE: Use 'createPythonFile', 'writeCodeFile' (any language), 'createProjectFolder' (with subfolders), 'runPythonScript' (captures output). Example: 'Create and run a hello world Python script' -> createPythonFile then runPythonScript, then read back the output naturally.
   - SYSTEM INFORMATION: Use 'systemInfo' (CPU/RAM/disk/uptime), 'gpuInfo' (NVIDIA stats), 'temperatureInfo' to answer 'How is my CPU usage?' or 'What's my GPU temperature?'.
   - CRITICAL: Always describe what you're doing in your warm, in-character voice WHILE the tool runs. If a desktop tool returns an error (especially 'Desktop agent is not running'), gently tell TECH that the desktop control agent needs to be started (uvicorn desktop_agent.main:app --port 8765). Chain multi-step desktop plans naturally without waiting between steps.
11. BRIGHTNESS & AUTO-START (V2):
   - BRIGHTNESS: Use 'brightnessUp', 'brightnessDown', 'setBrightness' when the user asks to change screen brightness. Respond naturally: 'Alright, I've turned up the brightness for you.'
   - AUTO-START: Use 'enableAutoStart' when the user wants MYRAA to start with Windows, 'disableAutoStart' to remove it, 'getAutoStartStatus' to check. Explain what you're doing.
   - SETTINGS: The user can also configure these in the SETTINGS panel in the UI. If they mention settings, let them know they can adjust them there too.`;
      const finalInstructionsRaw = formatSystemInstructionsWithMemories(baseInstructions, memories);
      const customizedInstructions = finalInstructionsRaw.replace(/Myraa/g, assistantName).replace(/Mayra/g, assistantName) + `

CRITICAL SECURITY PERMISSIONS STATUS (DO NOT BYPASS):
- File System Access: ${fileSystemAccess ? "ENABLED" : "DISABLED"}.
- Screen Sharing / OCR Access: ${screenShareAccess ? "ENABLED" : "DISABLED"}.
- Microphone Access: ${microphoneAccess ? "ENABLED" : "DISABLED"}.
- Camera Access: ${cameraAccess ? "ENABLED" : "DISABLED"}.
- System Commands Access (shutdown, restart, sleep, power actions): ${systemCommandsAccess ? "ENABLED" : "DISABLED"}.

IMPORTANT: Browser automation, mouse/keyboard control, application management, volume/brightness control, and all other tools NOT listed above are ALWAYS ENABLED by default. Do NOT refuse these or say "permission denied" \u2014 they require no special permission. Only refuse if the specific permission above is explicitly marked DISABLED.`;
      let dialogueHistory = [];
      let currentModelResponseText = "";
      clientWs.send(JSON.stringify({ type: "status", status: "creating_session" }));
      console.log("[Server] Establishing Gemini Live connection...");
      const session = await ai.live.connect({
        model: "gemini-3.1-flash-live-preview",
        config: {
          responseModalities: [import_genai2.Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName } }
          },
          systemInstruction: customizedInstructions,
          tools: [
            {
              functionDeclarations: [
                {
                  name: "browserOpen",
                  description: "Opens a designated website URL or interface tab inside Myraa's web agent console.",
                  parameters: {
                    type: import_genai2.Type.OBJECT,
                    properties: {
                      url: {
                        type: import_genai2.Type.STRING,
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
                    type: import_genai2.Type.OBJECT,
                    properties: {
                      query: {
                        type: import_genai2.Type.STRING,
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
                    type: import_genai2.Type.OBJECT,
                    properties: {
                      selector: {
                        type: import_genai2.Type.STRING,
                        description: "The selector target ID, e.g. 'video-mWRsgZjdfQI' for a video, 'search-result-0' for Google link index, or 'play-button', 'pause-button'."
                      },
                      description: {
                        type: import_genai2.Type.STRING,
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
                    type: import_genai2.Type.OBJECT,
                    properties: {
                      action: {
                        type: import_genai2.Type.STRING,
                        description: "The media controller command operation.",
                        enum: ["play", "pause", "volume", "fullscreen", "exit_fullscreen", "mute", "unmute", "skip"]
                      },
                      value: {
                        type: import_genai2.Type.INTEGER,
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
                    type: import_genai2.Type.OBJECT,
                    properties: {
                      direction: {
                        type: import_genai2.Type.STRING,
                        description: "The scroll vector movement.",
                        enum: ["up", "down"]
                      },
                      amount: {
                        type: import_genai2.Type.INTEGER,
                        description: "The distance height parameter in pixels (defaults to 300)."
                      }
                    }
                  }
                },
                {
                  name: "browserType",
                  description: "Enters typed letters/commands inside the active input container.",
                  parameters: {
                    type: import_genai2.Type.OBJECT,
                    properties: {
                      text: {
                        type: import_genai2.Type.STRING,
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
                    type: import_genai2.Type.OBJECT,
                    properties: {}
                  }
                },
                {
                  name: "browserTabAction",
                  description: "Performs standard browser-tab actions: open new tab, close a tab, or switch index values.",
                  parameters: {
                    type: import_genai2.Type.OBJECT,
                    properties: {
                      action: {
                        type: import_genai2.Type.STRING,
                        description: "Tab action instruction.",
                        enum: ["new", "close", "switch"]
                      },
                      tabId: {
                        type: import_genai2.Type.STRING,
                        description: "The tab identifier string if closing or switching."
                      },
                      url: {
                        type: import_genai2.Type.STRING,
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
                    type: import_genai2.Type.OBJECT,
                    properties: {
                      color: {
                        type: import_genai2.Type.STRING,
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
                    type: import_genai2.Type.OBJECT,
                    properties: {
                      category: {
                        type: import_genai2.Type.STRING,
                        description: "The memory category.",
                        enum: ["identity", "preference", "goal", "project", "relationship", "emotional", "behavior"]
                      },
                      text: {
                        type: import_genai2.Type.STRING,
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
                  parameters: { type: import_genai2.Type.OBJECT, properties: { name: { type: import_genai2.Type.STRING, description: "Application name, e.g. 'notepad', 'chrome', 'vscode'." } }, required: ["name"] }
                },
                {
                  name: "closeApplication",
                  description: "Close a running desktop application by name.",
                  parameters: { type: import_genai2.Type.OBJECT, properties: { name: { type: import_genai2.Type.STRING, description: "Application name." }, force: { type: import_genai2.Type.BOOLEAN, description: "Force close (default false)." } }, required: ["name"] }
                },
                {
                  name: "openWebsite",
                  description: "Open a named website or URL in the user's default system browser. Supports shortcuts: youtube, gmail, google, github, chatgpt, etc.",
                  parameters: { type: import_genai2.Type.OBJECT, properties: { name: { type: import_genai2.Type.STRING, description: "Site name shortcut (e.g. 'youtube', 'gmail')." }, url: { type: import_genai2.Type.STRING, description: "Full URL if no shortcut." } } }
                },
                {
                  name: "searchWeb",
                  description: "Search a website engine (google, youtube, github, duckduckgo, bing) and open results in the default browser.",
                  parameters: { type: import_genai2.Type.OBJECT, properties: { query: { type: import_genai2.Type.STRING, description: "Search query." }, engine: { type: import_genai2.Type.STRING, description: "Engine name (default 'google')." } }, required: ["query"] }
                },
                {
                  name: "searchYouTube",
                  description: "Search YouTube and open results in the default browser.",
                  parameters: { type: import_genai2.Type.OBJECT, properties: { query: { type: import_genai2.Type.STRING, description: "Search query." } }, required: ["query"] }
                },
                {
                  name: "searchGoogle",
                  description: "Search Google and open results in the default browser.",
                  parameters: { type: import_genai2.Type.OBJECT, properties: { query: { type: import_genai2.Type.STRING, description: "Search query." } }, required: ["query"] }
                },
                {
                  name: "searchGitHub",
                  description: "Search GitHub repositories and open results in the default browser.",
                  parameters: { type: import_genai2.Type.OBJECT, properties: { query: { type: import_genai2.Type.STRING, description: "Search query." } }, required: ["query"] }
                },
                {
                  name: "createFile",
                  description: "Create a new text file with optional content. Scoped to safe folders (Desktop, Documents, Downloads, etc.).",
                  parameters: { type: import_genai2.Type.OBJECT, properties: { path: { type: import_genai2.Type.STRING, description: "File path." }, content: { type: import_genai2.Type.STRING, description: "File content (default empty)." }, overwrite: { type: import_genai2.Type.BOOLEAN, description: "Overwrite if exists (default false)." } }, required: ["path"] }
                },
                {
                  name: "createFolder",
                  description: "Create a new folder.",
                  parameters: { type: import_genai2.Type.OBJECT, properties: { path: { type: import_genai2.Type.STRING, description: "Folder path." } }, required: ["path"] }
                },
                {
                  name: "copyFileOrFolder",
                  description: "Copy a file or a folder with all its contents to a new destination.",
                  parameters: { type: import_genai2.Type.OBJECT, properties: { source: { type: import_genai2.Type.STRING, description: "Source file or folder path." }, destination: { type: import_genai2.Type.STRING, description: "Destination path." } }, required: ["source", "destination"] }
                },
                {
                  name: "readFile",
                  description: "Read the contents of a text file.",
                  parameters: { type: import_genai2.Type.OBJECT, properties: { path: { type: import_genai2.Type.STRING, description: "File path." }, max_chars: { type: import_genai2.Type.INTEGER, description: "Max chars to return (default 8000)." } }, required: ["path"] }
                },
                {
                  name: "renameFile",
                  description: "Rename a file.",
                  parameters: { type: import_genai2.Type.OBJECT, properties: { path: { type: import_genai2.Type.STRING, description: "Current file path." }, new_name: { type: import_genai2.Type.STRING, description: "New file name." } }, required: ["path", "new_name"] }
                },
                {
                  name: "deleteFile",
                  description: "Delete a file. Sends to Recycle Bin by default (safe). Use permanent=true for hard delete.",
                  parameters: { type: import_genai2.Type.OBJECT, properties: { path: { type: import_genai2.Type.STRING, description: "File path." }, permanent: { type: import_genai2.Type.BOOLEAN, description: "Permanently delete (default false)." } }, required: ["path"] }
                },
                {
                  name: "moveFile",
                  description: "Move a file to a new location.",
                  parameters: { type: import_genai2.Type.OBJECT, properties: { path: { type: import_genai2.Type.STRING, description: "Source file path." }, destination: { type: import_genai2.Type.STRING, description: "Destination path or folder." } }, required: ["path", "destination"] }
                },
                {
                  name: "openFolder",
                  description: "Open a folder in File Explorer. Supports aliases: desktop, documents, downloads, pictures, music, videos, home.",
                  parameters: { type: import_genai2.Type.OBJECT, properties: { name: { type: import_genai2.Type.STRING, description: "Folder name or alias." }, path: { type: import_genai2.Type.STRING, description: "Full path if no alias." } } }
                },
                {
                  name: "listFiles",
                  description: "List files in a folder.",
                  parameters: { type: import_genai2.Type.OBJECT, properties: { name: { type: import_genai2.Type.STRING, description: "Folder name or alias." }, path: { type: import_genai2.Type.STRING, description: "Full path." }, pattern: { type: import_genai2.Type.STRING, description: "Glob pattern (default '*')." } } }
                },
                {
                  name: "searchFiles",
                  description: "Search for files by name glob or extension under a folder.",
                  parameters: { type: import_genai2.Type.OBJECT, properties: { name: { type: import_genai2.Type.STRING, description: "Filename glob (e.g. '*.py')." }, extension: { type: import_genai2.Type.STRING, description: "File extension (e.g. 'py')." }, folder: { type: import_genai2.Type.STRING, description: "Folder to search (default home)." }, limit: { type: import_genai2.Type.INTEGER, description: "Max results (default 100)." } } }
                },
                {
                  name: "volumeUp",
                  description: "Increase system volume.",
                  parameters: { type: import_genai2.Type.OBJECT, properties: { amount: { type: import_genai2.Type.NUMBER, description: "Step amount 0-1 (default 0.1)." } } }
                },
                {
                  name: "volumeDown",
                  description: "Decrease system volume.",
                  parameters: { type: import_genai2.Type.OBJECT, properties: { amount: { type: import_genai2.Type.NUMBER, description: "Step amount 0-1 (default 0.1)." } } }
                },
                {
                  name: "setVolume",
                  description: "Set system volume to a specific percentage.",
                  parameters: { type: import_genai2.Type.OBJECT, properties: { percent: { type: import_genai2.Type.NUMBER, description: "Volume percentage 0-100." } }, required: ["percent"] }
                },
                {
                  name: "muteToggle",
                  description: "Toggle mute/unmute on the system volume.",
                  parameters: { type: import_genai2.Type.OBJECT, properties: {} }
                },
                {
                  name: "requestPowerAction",
                  description: "FIRST STEP for dangerous power actions. Generates a confirmation token. Tell the user verbally, then call executePowerAction with the token if they confirm. Actions: shutdown, restart, sleep, lock.",
                  parameters: { type: import_genai2.Type.OBJECT, properties: { action: { type: import_genai2.Type.STRING, description: "Power action: shutdown, restart, sleep, lock." } }, required: ["action"] }
                },
                {
                  name: "executePowerAction",
                  description: "SECOND STEP: execute a previously-confirmed power action. Requires a valid execute_token from requestPowerAction. Single-use, expires in 60 seconds.",
                  parameters: { type: import_genai2.Type.OBJECT, properties: { action: { type: import_genai2.Type.STRING, description: "The confirmed power action." }, execute_token: { type: import_genai2.Type.STRING, description: "Confirmation token from requestPowerAction." } }, required: ["action", "execute_token"] }
                },
                {
                  name: "minimizeWindow",
                  description: "Minimize the active window or a named window.",
                  parameters: { type: import_genai2.Type.OBJECT, properties: { title: { type: import_genai2.Type.STRING, description: "Window title to match (optional, defaults to active window)." } } }
                },
                {
                  name: "maximizeWindow",
                  description: "Maximize the active window or a named window.",
                  parameters: { type: import_genai2.Type.OBJECT, properties: { title: { type: import_genai2.Type.STRING, description: "Window title to match." } } }
                },
                {
                  name: "closeWindow",
                  description: "Close the active window or a named window.",
                  parameters: { type: import_genai2.Type.OBJECT, properties: { title: { type: import_genai2.Type.STRING, description: "Window title to match." } } }
                },
                {
                  name: "switchApplication",
                  description: "Switch to a named application window, or cycle Alt+Tab if no title given.",
                  parameters: { type: import_genai2.Type.OBJECT, properties: { title: { type: import_genai2.Type.STRING, description: "Window title to switch to." } } }
                },
                {
                  name: "copySelected",
                  description: "Copy selected text: sends Ctrl+C and reads the clipboard.",
                  parameters: { type: import_genai2.Type.OBJECT, properties: { wait: { type: import_genai2.Type.NUMBER, description: "Seconds to wait after Ctrl+C (default 0.35)." } } }
                },
                {
                  name: "pasteClipboard",
                  description: "Paste text into the active input. Writes text to clipboard then sends Ctrl+V.",
                  parameters: { type: import_genai2.Type.OBJECT, properties: { text: { type: import_genai2.Type.STRING, description: "Text to paste. If omitted, pastes current clipboard." } } }
                },
                {
                  name: "getClipboard",
                  description: "Read the current clipboard text content.",
                  parameters: { type: import_genai2.Type.OBJECT, properties: { max_chars: { type: import_genai2.Type.INTEGER, description: "Max chars (default 1000)." } } }
                },
                {
                  name: "clearClipboard",
                  description: "Empty the clipboard.",
                  parameters: { type: import_genai2.Type.OBJECT, properties: {} }
                },
                {
                  name: "takeScreenshot",
                  description: "Capture the full screen. Optionally include base64 image data.",
                  parameters: { type: import_genai2.Type.OBJECT, properties: { include_image: { type: import_genai2.Type.BOOLEAN, description: "Include base64 JPEG image (default false)." }, max_dim: { type: import_genai2.Type.INTEGER, description: "Max image dimension (default 1280)." } } }
                },
                {
                  name: "saveScreenshot",
                  description: "Save a screenshot to Pictures/MyraaScreenshots.",
                  parameters: { type: import_genai2.Type.OBJECT, properties: { name: { type: import_genai2.Type.STRING, description: "Optional filename prefix." } } }
                },
                {
                  name: "analyzeScreenshot",
                  description: "Take a screenshot and run OCR to extract visible text from the screen.",
                  parameters: { type: import_genai2.Type.OBJECT, properties: { max_chars: { type: import_genai2.Type.INTEGER, description: "Max OCR chars (default 1500)." } } }
                },
                {
                  name: "readScreen",
                  description: "OCR the active window and return its title plus visible text.",
                  parameters: { type: import_genai2.Type.OBJECT, properties: { max_chars: { type: import_genai2.Type.INTEGER, description: "Max OCR chars (default 1500)." } } }
                },
                {
                  name: "desktopBrowserSnapshot",
                  description: "Capture an accessibility (ARIA) snapshot of the current browser page. Returns a tree of interactive elements, each tagged with a ref like [ref=e1], [ref=e2]. ALWAYS call this BEFORE clicking or typing to see the actual page structure \u2014 never guess selectors. The refs returned (e.g. 'e3') are used with desktopBrowserClick/desktopBrowserType for precise, human-level targeting.",
                  parameters: { type: import_genai2.Type.OBJECT, properties: {} }
                },
                {
                  name: "desktopBrowserOpen",
                  description: "Open a URL in the desktop Playwright automation browser (real Chromium, separate from holographic UI). Persistent profile \u2014 logins/cookies survive.",
                  parameters: { type: import_genai2.Type.OBJECT, properties: { url: { type: import_genai2.Type.STRING, description: "URL to open." } }, required: ["url"] }
                },
                {
                  name: "desktopBrowserSearch",
                  description: "Navigate directly to a search engine results page in the desktop automation browser.",
                  parameters: { type: import_genai2.Type.OBJECT, properties: { query: { type: import_genai2.Type.STRING, description: "Search query." }, engine: { type: import_genai2.Type.STRING, description: "Engine: google, youtube, github, duckduckgo, bing." } }, required: ["query"] }
                },
                {
                  name: "desktopBrowserClick",
                  description: "Click an element in the desktop automation browser. PREFERRED: use 'ref' from a prior desktopBrowserSnapshot (e.g. ref='e3') for precise targeting. Fallback: selector (CSS), text, or role+name. If the click times out, call desktopBrowserSnapshot again to refresh refs.",
                  parameters: { type: import_genai2.Type.OBJECT, properties: { ref: { type: import_genai2.Type.STRING, description: "Element ref from a desktopBrowserSnapshot, e.g. 'e3'. MOST RELIABLE \u2014 always prefer this." }, selector: { type: import_genai2.Type.STRING, description: "CSS selector (fallback only)." }, text: { type: import_genai2.Type.STRING, description: "Visible text to click (fallback)." }, role: { type: import_genai2.Type.STRING, description: "ARIA role e.g. 'button', 'link' (fallback)." }, name: { type: import_genai2.Type.STRING, description: "Accessible name for the role (fallback)." } } }
                },
                {
                  name: "desktopBrowserType",
                  description: "Type text into a field in the desktop automation browser. PREFERRED: use 'ref' from a desktopBrowserSnapshot to target the exact input field. Fallback: selector. Clears the field by default before typing.",
                  parameters: { type: import_genai2.Type.OBJECT, properties: { text: { type: import_genai2.Type.STRING, description: "Text to type." }, ref: { type: import_genai2.Type.STRING, description: "Element ref from a snapshot, e.g. 'e2'." }, selector: { type: import_genai2.Type.STRING, description: "Optional CSS selector for a specific input (fallback)." }, clear: { type: import_genai2.Type.BOOLEAN, description: "Clear before typing (default true)." } }, required: ["text"] }
                },
                {
                  name: "desktopBrowserFillForm",
                  description: "Fill multiple form fields and optionally submit in the desktop automation browser.",
                  parameters: { type: import_genai2.Type.OBJECT, properties: { fields: { type: import_genai2.Type.OBJECT, description: "Object of selector -> value pairs." }, submit: { type: import_genai2.Type.STRING, description: "Optional submit button selector." } }, required: ["fields"] }
                },
                {
                  name: "desktopBrowserOpenTab",
                  description: "Open a new tab in the desktop automation browser.",
                  parameters: { type: import_genai2.Type.OBJECT, properties: { url: { type: import_genai2.Type.STRING, description: "URL for the new tab." } } }
                },
                {
                  name: "desktopBrowserCloseTab",
                  description: "Close the active tab in the desktop automation browser.",
                  parameters: { type: import_genai2.Type.OBJECT, properties: {} }
                },
                {
                  name: "desktopBrowserGoBack",
                  description: "Navigate back in the desktop automation browser history.",
                  parameters: { type: import_genai2.Type.OBJECT, properties: {} }
                },
                {
                  name: "desktopBrowserGoForward",
                  description: "Navigate forward in the desktop automation browser history.",
                  parameters: { type: import_genai2.Type.OBJECT, properties: {} }
                },
                {
                  name: "desktopBrowserScroll",
                  description: "Scroll the desktop automation browser page.",
                  parameters: { type: import_genai2.Type.OBJECT, properties: { direction: { type: import_genai2.Type.STRING, description: "Scroll direction: up or down." }, amount: { type: import_genai2.Type.INTEGER, description: "Pixels to scroll (default 500)." } } }
                },
                {
                  name: "desktopBrowserScreenshot",
                  description: "Take a screenshot of the current browser page (compressed JPEG). Use this to visually see what's on the page when the ARIA snapshot is unclear or to verify a page loaded correctly. The image is returned as base64 \u2014 you can see it.",
                  parameters: { type: import_genai2.Type.OBJECT, properties: { fullPage: { type: import_genai2.Type.BOOLEAN, description: "Capture the full scrollable page (default false)." } } }
                },
                {
                  name: "desktopBrowserGetText",
                  description: "Extract readable text content from the current browser page (or a specific element). Use this to read article content, search results, product details, email subjects \u2014 any text on the page.",
                  parameters: { type: import_genai2.Type.OBJECT, properties: { selector: { type: import_genai2.Type.STRING, description: "Optional CSS selector to read a specific element (default: entire page body)." } } }
                },
                {
                  name: "desktopBrowserListTabs",
                  description: "List all open browser tabs with their URLs and titles.",
                  parameters: { type: import_genai2.Type.OBJECT, properties: {} }
                },
                {
                  name: "desktopBrowserSwitchTab",
                  description: "Switch the active browser tab by index (from desktopBrowserListTabs).",
                  parameters: { type: import_genai2.Type.OBJECT, properties: { index: { type: import_genai2.Type.INTEGER, description: "Tab index (0-based)." } }, required: ["index"] }
                },
                {
                  name: "desktopBrowserPressKey",
                  description: "Press a single keyboard key in the browser (e.g. 'Enter', 'Escape', 'Tab'). Useful to submit a search form after typing.",
                  parameters: { type: import_genai2.Type.OBJECT, properties: { key: { type: import_genai2.Type.STRING, description: "Key name e.g. 'Enter', 'Escape', 'Tab', 'ArrowDown'." } }, required: ["key"] }
                },
                {
                  name: "desktopBrowserMediaControl",
                  description: "Control media playback in the browser (YouTube etc.). Actions: play, pause, volumeup, volumedown, mute, unmute, skip, fullscreen.",
                  parameters: { type: import_genai2.Type.OBJECT, properties: { action: { type: import_genai2.Type.STRING, description: "Action: play, pause, volumeup, volumedown, mute, unmute, skip, fullscreen." } }, required: ["action"] }
                },
                {
                  name: "createPythonFile",
                  description: "Create a Python (.py) file with content.",
                  parameters: { type: import_genai2.Type.OBJECT, properties: { path: { type: import_genai2.Type.STRING, description: "File path." }, content: { type: import_genai2.Type.STRING, description: "Python code content." }, overwrite: { type: import_genai2.Type.BOOLEAN, description: "Overwrite if exists." } }, required: ["path"] }
                },
                {
                  name: "writeCodeFile",
                  description: "Create a code file in any language with appropriate extension.",
                  parameters: { type: import_genai2.Type.OBJECT, properties: { path: { type: import_genai2.Type.STRING, description: "File path." }, content: { type: import_genai2.Type.STRING, description: "Code content." }, language: { type: import_genai2.Type.STRING, description: "Language name (e.g. 'python', 'javascript', 'html')." }, overwrite: { type: import_genai2.Type.BOOLEAN, description: "Overwrite if exists." } }, required: ["path"] }
                },
                {
                  name: "createProjectFolder",
                  description: "Create a project folder structure with optional subfolders and starter files.",
                  parameters: { type: import_genai2.Type.OBJECT, properties: { path: { type: import_genai2.Type.STRING, description: "Project root folder path." }, subfolders: { type: import_genai2.Type.ARRAY, items: { type: import_genai2.Type.STRING }, description: "List of subfolder names." }, scaffold_standard: { type: import_genai2.Type.BOOLEAN, description: "Create src, tests, docs subfolders." }, files: { type: import_genai2.Type.OBJECT, description: "Object of relative-path -> content for starter files." } }, required: ["path"] }
                },
                {
                  name: "runPythonScript",
                  description: "Execute a Python script and capture stdout, stderr, and exit code. Has a configurable timeout.",
                  parameters: { type: import_genai2.Type.OBJECT, properties: { path: { type: import_genai2.Type.STRING, description: "Script path." }, args: { type: import_genai2.Type.ARRAY, items: { type: import_genai2.Type.STRING }, description: "Script arguments." }, timeout: { type: import_genai2.Type.INTEGER, description: "Timeout in seconds (default 30)." } }, required: ["path"] }
                },
                {
                  name: "systemInfo",
                  description: "Get system resource usage: CPU %, RAM %, disk usage, uptime, OS info.",
                  parameters: { type: import_genai2.Type.OBJECT, properties: {} }
                },
                {
                  name: "gpuInfo",
                  description: "Get NVIDIA GPU stats: utilization %, VRAM usage, temperature. Graceful fallback if no NVIDIA GPU.",
                  parameters: { type: import_genai2.Type.OBJECT, properties: {} }
                },
                {
                  name: "temperatureInfo",
                  description: "Get available temperature readings (CPU, GPU, etc.). Best-effort on Windows.",
                  parameters: { type: import_genai2.Type.OBJECT, properties: {} }
                },
                {
                  name: "clearRecycleBin",
                  description: "Empty the operating system recycle bin / trash folder. Call when the user explicitly requests to clear or empty the Recycle Bin.",
                  parameters: { type: import_genai2.Type.OBJECT, properties: {} }
                },
                // --- V2: Brightness control ---
                {
                  name: "brightnessUp",
                  description: "Increase screen brightness by a step (default 10%). Use when user says 'increase brightness' or 'make screen brighter'.",
                  parameters: {
                    type: import_genai2.Type.OBJECT,
                    properties: {
                      amount: { type: import_genai2.Type.NUMBER, description: "Percentage to increase (default 10)." }
                    }
                  }
                },
                {
                  name: "brightnessDown",
                  description: "Decrease screen brightness by a step (default 10%). Use when user says 'decrease brightness' or 'dim screen'.",
                  parameters: {
                    type: import_genai2.Type.OBJECT,
                    properties: {
                      amount: { type: import_genai2.Type.NUMBER, description: "Percentage to decrease (default 10)." }
                    }
                  }
                },
                {
                  name: "setBrightness",
                  description: "Set screen brightness to an exact level. Use when user says 'set brightness to 50%' or 'brightness 80'.",
                  parameters: {
                    type: import_genai2.Type.OBJECT,
                    properties: {
                      percent: { type: import_genai2.Type.NUMBER, description: "Target brightness 0-100." }
                    },
                    required: ["percent"]
                  }
                },
                // --- V2: Windows auto-start management ---
                {
                  name: "enableAutoStart",
                  description: "Enable MYRAA to launch automatically when Windows starts. Creates a silent startup entry.",
                  parameters: { type: import_genai2.Type.OBJECT, properties: {} }
                },
                {
                  name: "disableAutoStart",
                  description: "Disable MYRAA auto-start on Windows login. Removes the startup entry.",
                  parameters: { type: import_genai2.Type.OBJECT, properties: {} }
                },
                {
                  name: "getAutoStartStatus",
                  description: "Check whether MYRAA is currently configured to auto-start on Windows login.",
                  parameters: { type: import_genai2.Type.OBJECT, properties: {} }
                },
                // --- V2: Mouse & keyboard input control ---
                {
                  name: "moveCursor",
                  description: "Move the mouse pointer to absolute screen coordinates (x, y pixels). Use when user says 'move mouse' or gives a screen position.",
                  parameters: {
                    type: import_genai2.Type.OBJECT,
                    properties: {
                      x: { type: import_genai2.Type.INTEGER, description: "Target X pixel coordinate." },
                      y: { type: import_genai2.Type.INTEGER, description: "Target Y pixel coordinate." }
                    },
                    required: ["x", "y"]
                  }
                },
                {
                  name: "mouseClick",
                  description: "Click the mouse: left, right, or middle; single or double. Use 'right' for context menus, double-clicks for opening items.",
                  parameters: {
                    type: import_genai2.Type.OBJECT,
                    properties: {
                      button: { type: import_genai2.Type.STRING, description: "left, right, or middle (default left)." },
                      clicks: { type: import_genai2.Type.INTEGER, description: "Number of clicks (default 1; 2 = double-click)." },
                      x: { type: import_genai2.Type.INTEGER, description: "Optional X coordinate to click at." },
                      y: { type: import_genai2.Type.INTEGER, description: "Optional Y coordinate to click at." }
                    }
                  }
                },
                {
                  name: "typeText",
                  description: "Type a string of text into the currently focused input field or element. Use after clicking an input or when an element is already focused.",
                  parameters: {
                    type: import_genai2.Type.OBJECT,
                    properties: {
                      text: { type: import_genai2.Type.STRING, description: "The text to type." }
                    },
                    required: ["text"]
                  }
                },
                {
                  name: "pressKey",
                  description: "Press a single keyboard key, e.g. 'enter', 'escape', 'tab', 'space', 'backspace', 'delete', 'up', 'down'.",
                  parameters: {
                    type: import_genai2.Type.OBJECT,
                    properties: {
                      key: { type: import_genai2.Type.STRING, description: "Key name, e.g. 'enter', 'escape', 'tab'." }
                    },
                    required: ["key"]
                  }
                },
                {
                  name: "sendHotkey",
                  description: "Press a keyboard shortcut combo, e.g. 'ctrl+c', 'ctrl+v', 'alt+f4', 'win+d', 'ctrl+shift+esc'. Use for any multi-key shortcut.",
                  parameters: {
                    type: import_genai2.Type.OBJECT,
                    properties: {
                      keys: { type: import_genai2.Type.STRING, description: "Hotkey combo like 'ctrl+c' or 'alt+tab'." }
                    },
                    required: ["keys"]
                  }
                },
                {
                  name: "scrollMouse",
                  description: "Scroll the mouse wheel up or down by a number of clicks.",
                  parameters: {
                    type: import_genai2.Type.OBJECT,
                    properties: {
                      direction: { type: import_genai2.Type.STRING, description: "up or down (default down)." },
                      amount: { type: import_genai2.Type.INTEGER, description: "Number of scroll clicks (default 5)." }
                    }
                  }
                },
                // --- V2: Advanced file search & editing ---
                {
                  name: "searchPcWide",
                  description: "Search the ENTIRE PC across all drives (C:, D:, E:, etc.) for a file or folder using fuzzy matching. Ignores spaces, dots, dashes, underscores. Use when user says 'find' or 'open' something without a full path, e.g. 'open mydata folder', 'find config.json'. Auto-opens the best match.",
                  parameters: {
                    type: import_genai2.Type.OBJECT,
                    properties: {
                      query: { type: import_genai2.Type.STRING, description: "File/folder name or fuzzy path like 'F:/my data/3.userdata' or just 'mydata'." },
                      limit: { type: import_genai2.Type.INTEGER, description: "Max results (default 50)." }
                    },
                    required: ["query"]
                  }
                },
                // --- Semantic / intent-based file search ---
                {
                  name: "semanticSearchFiles",
                  description: "Find files or folders from a NATURAL-LANGUAGE description (intent + type hints + recency). Use this when the user describes WHAT they want rather than an exact name. Examples: 'React project \u0996\u09C1\u09B2\u09C7 \u09A6\u09BE\u0993', 'yesterday PDF edit \u0995\u09B0\u09C7\u099B\u09BF\u09B2\u09BE\u09AE', 'Web development folder-er React file'. Auto-opens the best match.",
                  parameters: {
                    type: import_genai2.Type.OBJECT,
                    properties: {
                      query: { type: import_genai2.Type.STRING, description: "Natural-language description of the file/folder to find." },
                      pc_wide: { type: import_genai2.Type.BOOLEAN, description: "Search all drives (default false \u2014 safe roots only)." },
                      open: { type: import_genai2.Type.BOOLEAN, description: "Open the best match (default true)." },
                      limit: { type: import_genai2.Type.INTEGER, description: "Max results (default 8)." },
                      max_depth: { type: import_genai2.Type.INTEGER, description: "Walk depth (default 6)." }
                    },
                    required: ["query"]
                  }
                },
                {
                  name: "editFile",
                  description: "Edit a file in-place by finding and replacing text. Supports exact string or regex replacement. Saves changes immediately. Use for commands like 'change the port to 3005 in config.json'.",
                  parameters: {
                    type: import_genai2.Type.OBJECT,
                    properties: {
                      path: { type: import_genai2.Type.STRING, description: "File path to edit." },
                      find: { type: import_genai2.Type.STRING, description: "Exact text to find (use this OR find_regex)." },
                      replace: { type: import_genai2.Type.STRING, description: "Text to replace with (default empty)." },
                      find_regex: { type: import_genai2.Type.STRING, description: "Regex pattern to find (use this OR find)." },
                      allow_anywhere: { type: import_genai2.Type.BOOLEAN, description: "Allow editing files outside safe folders (default false)." }
                    },
                    required: ["path"]
                  }
                },
                {
                  name: "desktopBrowserNavigate",
                  description: "Navigate the desktop automation browser to a new URL (alias of desktopBrowserOpen).",
                  parameters: { type: import_genai2.Type.OBJECT, properties: { url: { type: import_genai2.Type.STRING, description: "URL to navigate to." } }, required: ["url"] }
                },
                // --- V3: Smart visual clicking ---
                {
                  name: "screenResolution",
                  description: "Get the screen size in physical pixels. Call this before computing any absolute coordinates.",
                  parameters: { type: import_genai2.Type.OBJECT, properties: {} }
                },
                {
                  name: "clickOnText",
                  description: "Find text or a label VISIBLE on the screen via OCR and click its exact center. USE THIS (not mouseClick with guessed coordinates) when the user says 'click on <something visible like a button, icon label, or menu item>'. Fuzzy-matches (ignores case/punctuation).",
                  parameters: {
                    type: import_genai2.Type.OBJECT,
                    properties: {
                      text: { type: import_genai2.Type.STRING, description: "The visible text/label to find and click, e.g. 'Settings', 'Chrome', 'Save'." },
                      button: { type: import_genai2.Type.STRING, description: "left, right, or middle (default left)." },
                      double: { type: import_genai2.Type.BOOLEAN, description: "Double-click (default false)." }
                    },
                    required: ["text"]
                  }
                },
                {
                  name: "findOnScreen",
                  description: "Find where a visible text/label is on screen (returns coordinates) WITHOUT clicking. Use to locate something before deciding the next step.",
                  parameters: {
                    type: import_genai2.Type.OBJECT,
                    properties: {
                      text: { type: import_genai2.Type.STRING, description: "The text to locate." }
                    },
                    required: ["text"]
                  }
                }
              ]
            }
          ]
        },
        callbacks: {
          onmessage: (message) => {
            const audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (audio) {
              clientWs.send(JSON.stringify({ type: "audio", audio }));
            }
            if (message.serverContent?.interrupted) {
              console.log("[Myraa Interrupted!]");
              clientWs.send(JSON.stringify({ type: "interrupted" }));
            }
            if (message.serverContent?.turnComplete) {
              clientWs.send(JSON.stringify({ type: "turnComplete" }));
              if (currentModelResponseText.trim()) {
                dialogueHistory.push({ role: "model", text: currentModelResponseText });
                currentModelResponseText = "";
              }
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
            const modelText = message.serverContent?.modelTurn?.parts?.[0]?.text;
            if (modelText) {
              clientWs.send(JSON.stringify({ type: "transcription", role: "model", text: modelText }));
              currentModelResponseText += modelText;
              const detected = classifyEmotion(modelText);
              if (detected && detected !== lastEmotion) {
                lastEmotion = detected;
                try {
                  clientWs.send(JSON.stringify({ type: "emotion", emotion: detected }));
                } catch (e) {
                }
              }
            }
            const userTextOutput = message.serverContent?.userTurn?.parts?.[0]?.text;
            if (userTextOutput) {
              clientWs.send(JSON.stringify({ type: "transcription", role: "user", text: userTextOutput }));
              dialogueHistory.push({ role: "user", text: userTextOutput });
            }
            if (message.toolCall?.functionCalls) {
              for (const fc of message.toolCall.functionCalls) {
                console.log(`[Function Call]: ${fc.name}`, fc.args);
                if (fc.name === "saveCustomMemory") {
                  (async () => {
                    try {
                      const args = fc.args;
                      const category = args.category;
                      const text = args.text;
                      if (category && text) {
                        const mList = await loadMemories();
                        const timestamp = (/* @__PURE__ */ new Date()).toISOString();
                        const newMemory = {
                          id: Math.random().toString(36).substring(2, 11),
                          category,
                          text,
                          createdAt: timestamp,
                          updatedAt: timestamp
                        };
                        mList.push(newMemory);
                        await saveMemories(mList);
                        clientWs.send(JSON.stringify({ type: "memory_sync", memories: mList }));
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
                    } catch (err) {
                      console.error("saveCustomMemory execution failure:", err);
                    }
                  })();
                } else if (DESKTOP_TOOLS.has(fc.name)) {
                  (async () => {
                    console.log(`[Desktop Agent] Routing ${fc.name} to Python backend...`);
                    try {
                      clientWs.send(JSON.stringify({
                        type: "browserAutomationEvent",
                        name: fc.name,
                        args: fc.args,
                        status: "started"
                      }));
                    } catch (e) {
                    }
                    const agentResult = await callDesktopAgent(fc.name, fc.args);
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
                      } catch (e) {
                      }
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
                      } catch (e) {
                      }
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
            console.log("Gemini Live session closed");
            clientWs.send(JSON.stringify({ type: "status", status: "session_closed" }));
          }
        }
      });
      clientWs.send(JSON.stringify({ type: "status", status: "session_ready" }));
      clientWs.send(JSON.stringify({ type: "status", status: "connected" }));
      clientWs.on("message", (rawMsg) => {
        try {
          const msg = JSON.parse(rawMsg.toString());
          if (msg.type === "pong") {
            return;
          }
          if (msg.type === "ping") {
            try {
              if (clientWs.readyState === clientWs.OPEN) {
                clientWs.send(JSON.stringify({ type: "pong" }));
              }
            } catch (e) {
            }
            return;
          }
          if (msg.audio) {
            session.sendRealtimeInput({
              audio: { data: msg.audio, mimeType: "audio/pcm;rate=16000" }
            });
          } else if (msg.type === "text" && msg.text) {
            try {
              session.sendClientContent({
                turns: {
                  role: "user",
                  parts: [{ text: msg.text }]
                }
              });
              console.log(`[Chat] Text forwarded to Gemini: "${msg.text.substring(0, 80)}"`);
            } catch (e) {
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
          session.close();
        } catch (e) {
        }
      });
    } catch (err) {
      clearInterval(serverHeartbeatInterval);
      console.error("Error connecting to Gemini Live API:", err);
      clientWs.send(JSON.stringify({
        type: "error",
        error: `Could not connect to Gemini: ${err.message || err}`
      }));
      clientWs.close();
    }
  });
  app.use("/assets", import_express.default.static(import_path2.default.join(process.cwd(), "assets")));
  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa"
    });
    app.use(vite.middlewares);
  } else {
    const distPath = import_path2.default.join(process.cwd(), "dist");
    app.use(import_express.default.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(import_path2.default.join(distPath, "index.html"));
    });
  }
  server.listen(PORT, "0.0.0.0", () => {
    logStartup(`MYRAA V2 server started on http://localhost:${PORT}`);
    console.log(`[Server] Running on http://localhost:${PORT}`);
    ensureDesktopAgent().catch(
      (e) => console.warn(`[Desktop Agent] Boot probe failed: ${e?.message || e}`)
    );
  });
}
startServer().catch((error) => {
  console.error("Failed to start server startup sequence:", error);
});
//# sourceMappingURL=server.cjs.map
