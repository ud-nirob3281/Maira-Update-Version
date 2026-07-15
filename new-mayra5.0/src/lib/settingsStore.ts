/**
 * MYRAA Settings Store — persistent user preferences (V2).
 *
 * Establishes the persistence pattern for MYRAA: settings are mirrored to
 * localStorage (instant local read) AND synced to the backend (settings.json)
 * so auto-start / wake-word preferences survive across browsers and the
 * Python desktop agent can read them too.
 *
 * Pattern follows the existing codebase conventions: plain state + ref mirrors.
 * No Context/Zustand — this is deliberately lightweight to match audio.ts/memoryTypes.ts.
 */

export interface MyraaSettings {
  /** Launch MYRAA (backends + browser tab) silently on Windows login. */
  autoStart: boolean;
  /** Master toggle for UI animations. */
  animations: boolean;
  /** Change assistant name dynamically. */
  assistantName: string;
  /** Voice tone selection: "Soft and Gentle" (lead), "Bright and Clear", etc.
   * Must match a key in server.ts VOICE_MAP and a `value` in SettingsPanel.tsx. */
  voiceTone: string;

  // Permissions Manager Toggles
  fileSystemAccess: boolean;
  screenShareAccess: boolean;
  microphoneAccess: boolean;
  cameraAccess: boolean;
  systemCommandsAccess: boolean;

  // Chat preferences (V3)
  chatLanguage?: "auto" | "english" | "bengali" | "hindi";
  saveChatHistory?: boolean;
  chatNotifications?: boolean;
}

export const DEFAULT_SETTINGS: MyraaSettings = {
  autoStart: false,
  animations: true,
  assistantName: "Mayra",
  voiceTone: "Soft and Gentle",
  fileSystemAccess: true,
  screenShareAccess: true,
  microphoneAccess: true,
  cameraAccess: true,
  systemCommandsAccess: true,
};

const STORAGE_KEY = "myraa.settings.v2";

/** Settings keys that the browser should never persist (security). */
const NEVER_PERSIST: ReadonlySet<keyof MyraaSettings> = new Set([]);

/** Valid voice labels in the current catalog (kept in sync with server.ts).
 * A persisted `voiceTone` from an older release is migrated to the new default
 * so the picker never shows a stale/missing selection after an upgrade. */
const VALID_VOICE_TONES: ReadonlySet<string> = new Set([
  "Soft and Gentle",
  "Bright and Clear",
  "Sweet and Youthful",
  "Gentle and Soothing",
  "Elegant Female",
  "Warm Companion",
  "Friendly Girl",
  "Calm Assistant",
  "Natural Young Woman",
  "Expressive Female",
  "Emotional Storyteller",
  "Professional Female",
  "Playful Friend",
  "Confident Woman",
]);

/**
 * Load settings from localStorage, merged over defaults so new keys always
 * have a sane value even when an older payload is present.
 */
export function loadSettings(): MyraaSettings {
  if (typeof window === "undefined") return { ...DEFAULT_SETTINGS };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<MyraaSettings>;
    const merged = { ...DEFAULT_SETTINGS, ...parsed };
    // Migrate any legacy voice label that no longer exists in the catalog.
    if (merged.voiceTone && !VALID_VOICE_TONES.has(merged.voiceTone)) {
      merged.voiceTone = DEFAULT_SETTINGS.voiceTone;
    }
    return merged;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * Persist a full or partial settings update to localStorage.
 * Returns the fully merged settings object.
 */
export function saveSettings(patch: Partial<MyraaSettings>): MyraaSettings {
  const current = loadSettings();
  const next: MyraaSettings = { ...current, ...patch };
  if (typeof window !== "undefined") {
    try {
      // Strip any sensitive keys before writing to localStorage.
      const safe: Record<string, unknown> = {};
      (Object.keys(next) as (keyof MyraaSettings)[]).forEach((k) => {
        if (!NEVER_PERSIST.has(k)) safe[k] = next[k];
      });
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(safe));
    } catch {
      /* localStorage may be unavailable (private mode) — fail silently. */
    }
  }
  // Best-effort sync to backend so the Python agent can read auto-start state.
  void syncSettingsToBackend(next).catch(() => {});
  return next;
}

/** Push settings to the backend (server.ts persists to settings.json). */
async function syncSettingsToBackend(settings: MyraaSettings): Promise<void> {
  try {
    await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    });
  } catch {
    /* Backend may be briefly unavailable during boot — non-fatal. */
  }
}
