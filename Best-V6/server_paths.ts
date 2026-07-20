/**
 * MYRAA — path & secret resolution.
 *
 * Separates read-only *code/asset* locations (shipped with the app) from the
 * writable *data* location (per-user, survives reinstalls). In development both
 * collapse to the project root, so existing behaviour is unchanged. When the
 * packaged Electron app launches the backend it sets MYRAA_DATA_DIR to a
 * writable folder under %APPDATA%\MYRAA, because the install directory
 * (Program Files) is read-only.
 *
 * The Gemini API key is NOT shipped with the app. Each user supplies their own
 * on first run; it is stored here in the per-user data dir (never returned to
 * the frontend).
 */

import fs from "fs";
import path from "path";

/** Writable per-user data directory. Falls back to cwd in development. */
export const DATA_DIR: string = process.env.MYRAA_DATA_DIR || process.cwd();

try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
} catch {
  /* already exists / best-effort */
}

/** Absolute path to a file inside the writable data directory. */
export function dataFile(name: string): string {
  return path.join(DATA_DIR, name);
}

// ---------------------------------------------------------------------------
// Gemini API key store (secrets.json in the writable data dir).
// ---------------------------------------------------------------------------
const SECRETS_FILE = dataFile("secrets.json");

interface Secrets {
  geminiApiKey?: string;
}

function readSecrets(): Secrets {
  try {
    if (fs.existsSync(SECRETS_FILE)) {
      return JSON.parse(fs.readFileSync(SECRETS_FILE, "utf-8")) as Secrets;
    }
  } catch {
    /* corrupt — treat as empty */
  }
  return {};
}

/** Persist a user-supplied key to the per-user secrets file. */
export function setGeminiApiKey(key: string): void {
  const trimmed = (key || "").trim();
  if (!trimmed) throw new Error("API key must not be empty.");

  try {
    const dataSecrets = readSecrets();
    dataSecrets.geminiApiKey = trimmed;
    fs.writeFileSync(SECRETS_FILE, JSON.stringify(dataSecrets, null, 2), "utf-8");
    try {
      fs.chmodSync(SECRETS_FILE, 0o600); // owner-only where supported
    } catch {}
  } catch (err: any) {
    console.error("[Secrets] Error writing to secrets file:", err?.message || err);
  }
}

// Auto-migrate environment GEMINI_API_KEY to secrets.json on startup if missing.
try {
  const envKey = process.env.GEMINI_API_KEY?.trim();
  if (envKey) {
    const currentKey = getGeminiApiKey();
    if (!currentKey) {
      setGeminiApiKey(envKey);
      console.log("[Secrets Migration] Successfully migrated environment GEMINI_API_KEY to secrets.json");
    }
  }
} catch (err: any) {
  console.error("[Secrets Migration] Error migrating key:", err?.message || err);
}

/**
 * Resolve the active Gemini API key.
 * Strictly reads from secrets.json under the writable data directory.
 */
export function getGeminiApiKey(): string | undefined {
  const dataKey = readSecrets().geminiApiKey?.trim();
  if (dataKey) return dataKey;

  const envKey = process.env.GEMINI_API_KEY?.trim();
  if (envKey) return envKey;

  return undefined;
}

/** Whether any usable key is configured (without revealing it). */
export function hasGeminiApiKey(): boolean {
  return Boolean(getGeminiApiKey());
}

/** Remove the stored key (used by "reset"/sign-out flows). */
export function clearGeminiApiKey(): void {
  try {
    const dataSecrets = readSecrets();
    delete dataSecrets.geminiApiKey;
    fs.writeFileSync(SECRETS_FILE, JSON.stringify(dataSecrets, null, 2), "utf-8");
  } catch {}
}
