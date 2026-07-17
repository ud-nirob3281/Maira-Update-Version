import React, { useEffect, useState } from "react";
import {
  Settings,
  X,
  Power,
  Mic,
  Cpu,
  Info,
  Check,
  AlertTriangle,
  Volume2,
  Sparkles,
  Shield,
  User,
  KeyRound,
  Eye,
  EyeOff,
  Loader2,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import {
  MyraaSettings,
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
} from "../lib/settingsStore";

interface SettingsPanelProps {
  isOpen: boolean;
  onClose: () => void;
  /** Current settings */
  settings: MyraaSettings;
  /** Persist a settings patch */
  onChange: (patch: Partial<MyraaSettings>) => void;
  themeColor: string;
}

type SettingsTab = "general" | "voice" | "permissions" | "system" | "chat" | "about";

/** A single toggle row matching the existing "Screen Vision Mode" switch style. */
function ToggleRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="pt-3 pb-3 border-b border-white/5 flex items-center justify-between text-left">
      <div className="flex flex-col">
        <span className="text-[10px] font-bold font-mono text-slate-200">{label}</span>
        <span className="text-[8px] text-slate-400 uppercase font-mono max-w-[240px]">
          {description}
        </span>
      </div>
      <button
        onClick={() => onChange(!checked)}
        className={`w-10 h-5 rounded-full p-0.5 transition-colors duration-200 focus:outline-none cursor-pointer ${
          checked ? "bg-cyan-500" : "bg-white/10"
        }`}
      >
        <div
          className={`bg-white w-4 h-4 rounded-full shadow-md transform duration-200 ease-in-out ${
            checked ? "translate-x-5" : "translate-x-0"
          }`}
        />
      </button>
    </div>
  );
}

export function SettingsPanel({ isOpen, onClose, settings, onChange, themeColor }: SettingsPanelProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>("general");
  const [agentHealth, setAgentHealth] = useState<{
    online: boolean;
    toolCount?: number;
    cpu?: string;
    ram?: string;
  }>({ online: false });

  // Probe desktop agent health (port 8765) via the server-side logs/health proxy.
  useEffect(() => {
    if (!isOpen) return;
    const probe = async () => {
      try {
        const res = await fetch("http://127.0.0.1:8765/health", { cache: "no-store" });
        if (!res.ok) {
          setAgentHealth({ online: false });
          return;
        }
        const data = await res.json();
        setAgentHealth({ online: true, toolCount: data.tool_count });
      } catch {
        try {
          const res2 = await fetch("/api/agent-health", { cache: "no-store" });
          if (res2.ok) {
            const d = await res2.json();
            setAgentHealth({ online: !!d.online, toolCount: d.tool_count });
            return;
          }
        } catch {
          /* ignore */
        }
        setAgentHealth({ online: false });
      }
    };
    probe();
    const id = setInterval(probe, 5000);
    return () => clearInterval(id);
  }, [isOpen]);

  const getThemeBadgeGlow = () => {
    switch (themeColor) {
      case "violet": return "border-purple-500/30 text-purple-400 bg-purple-500/10";
      case "crimson": return "border-rose-500/30 text-rose-400 bg-rose-500/10";
      case "emerald": return "border-emerald-500/30 text-emerald-400 bg-emerald-500/10";
      case "celestial": return "border-sky-500/30 text-sky-400 bg-sky-500/10";
      case "gold": return "border-amber-500/30 text-amber-400 bg-amber-500/10";
      case "rose": return "border-pink-500/30 text-pink-400 bg-pink-500/10";
      case "charcoal":
      default:
        return "border-indigo-500/30 text-indigo-400 bg-indigo-500/10";
    }
  };

  const tabs: { id: SettingsTab; label: string; icon: any }[] = [
    { id: "general", label: "GENERAL", icon: Power },
    { id: "chat", label: "CHAT", icon: Sparkles },
    { id: "voice", label: "VOICE", icon: Mic },
    { id: "permissions", label: "PERMISSIONS", icon: Shield },
    { id: "system", label: "API KEYS", icon: Info },
    { id: "about", label: "ABOUT", icon: Cpu },
  ];

  // Emotional female voice catalog. Each `value` maps to a Gemini Live prebuilt
  // voice via server.ts VOICE_MAP. The four named leads come first; the rest are
  // emotional/descriptive presets. Keep in sync with server.ts + settingsStore.ts.
  const premiumVoices = [
    // ── Named leads (spec) ──
    { value: "Soft and Gentle", label: "Soft and Gentle (Lead)", desc: "Default — whisper-like, tender, soothing" },
    { value: "Bright and Clear", label: "Bright and Clear (Kore)", desc: "Crisp, articulate, bright" },
    { value: "Sweet and Youthful", label: "Sweet and Youthful (Zephyr)", desc: "Playful, cute, endearing" },
    { value: "Gentle and Soothing", label: "Gentle and Soothing (Sulafat)", desc: "Comforting, maternal, kind" },
    // ── Additional premium emotional female voices ──
    { value: "Elegant Female", label: "Elegant Female", desc: "Elegant, refined, graceful" },
    { value: "Warm Companion", label: "Warm Companion", desc: "Warm, companionable, steady" },
    { value: "Friendly Girl", label: "Friendly Girl", desc: "Friendly, sharp, precise" },
    { value: "Calm Assistant", label: "Calm Assistant", desc: "Calm, reassuring, measured" },
    { value: "Natural Young Woman", label: "Natural Young Woman", desc: "Natural, young, smooth" },
    { value: "Expressive Female", label: "Expressive Female", desc: "Dynamic, emotionally rich" },
    { value: "Emotional Storyteller", label: "Emotional Storyteller", desc: "Narrative, expressive, vivid" },
    { value: "Professional Female", label: "Professional Female", desc: "Professional, clear, confident" },
    { value: "Playful Friend", label: "Playful Friend", desc: "Playful, lively, friendly" },
    { value: "Confident Woman", label: "Confident Woman", desc: "Confident, radiant, strong" },
  ];

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop Overlay */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="absolute inset-0 bg-black/60 z-40 backdrop-blur-sm"
          />

          {/* Slide-over Container */}
          <motion.div
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ type: "spring", damping: 25, stiffness: 200 }}
            className="absolute inset-y-0 right-0 w-full max-w-lg bg-[#020206]/95 border-l border-white/15 backdrop-blur-2xl z-50 flex flex-col shadow-[0_0_50px_rgba(0,0,0,0.8)]"
          >
            {/* Header */}
            <div className="p-6 border-b border-white/10 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className={`p-2.5 rounded-xl border ${getThemeBadgeGlow()}`}>
                  <Settings size={22} className="animate-spin [animation-duration:6s]" />
                </div>
                <div>
                  <h3 className="font-display font-medium text-lg tracking-tight text-white flex items-center gap-2">
                    {settings.assistantName || "Mayra"} Configuration
                    <Sparkles size={14} className="text-cyan-400" />
                  </h3>
                  <p className="text-[10px] font-mono uppercase tracking-widest text-slate-400 mt-0.5">
                    System settings &amp; preferences
                  </p>
                </div>
              </div>
              <button
                onClick={onClose}
                className="p-2 rounded-xl border border-white/5 bg-white/5 hover:bg-white/10 text-slate-400 hover:text-white transition cursor-pointer"
              >
                <X size={18} />
              </button>
            </div>

            {/* Tab selector row */}
            <div className="px-6 py-4 border-b border-white/5 flex items-center gap-2 overflow-x-auto">
              {tabs.map((t) => {
                const Icon = t.icon;
                const active = activeTab === t.id;
                return (
                  <button
                    key={t.id}
                    onClick={() => setActiveTab(t.id)}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl border text-xs font-mono tracking-wider transition shrink-0 cursor-pointer ${
                      active
                        ? "border-cyan-400 bg-cyan-400/10 text-cyan-300"
                        : "border-white/5 bg-white/5 text-slate-400 hover:bg-white/10"
                    }`}
                  >
                    <Icon size={12} />
                    <span>{t.label}</span>
                  </button>
                );
              })}
            </div>

            {/* Scrollable content area */}
            <div className="flex-1 overflow-y-auto p-6 space-y-5">
              {/* ---------------- GENERAL ---------------- */}
              {activeTab === "general" && (
                <div className="space-y-4">
                  <div className="text-[10px] font-mono uppercase tracking-widest text-slate-500">
                    Startup &amp; Identity
                  </div>

                  <div className="space-y-1.5">
                    <label className="block text-[10px] font-mono tracking-wider text-slate-300 uppercase">
                      Assistant Name
                    </label>
                    <div className="relative">
                      <input
                        type="text"
                        value={settings.assistantName}
                        onChange={(e) => onChange({ assistantName: e.target.value })}
                        placeholder="Mayra"
                        className="w-full pl-9 pr-3 py-2 rounded-xl border border-white/10 bg-white/5 text-sm text-white font-mono focus:outline-none focus:border-cyan-400/50 transition"
                      />
                      <User className="absolute left-3 top-2.5 text-slate-400" size={14} />
                    </div>
                    <span className="text-[8px] text-slate-500 uppercase font-mono">
                      Change the name of your desktop companion
                    </span>
                  </div>

                  <ToggleRow
                    label="LAUNCH AT STARTUP"
                    description="Start companion silently when system logs in"
                    checked={settings.autoStart}
                    onChange={(v) => {
                      onChange({ autoStart: v });
                      void fetch("/api/settings", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ autoStart: v }),
                      }).catch(() => {});
                    }}
                  />

                  <ToggleRow
                    label="UI ANIMATIONS"
                    description="Enable motion and character visualizer transitions"
                    checked={settings.animations}
                    onChange={(v) => onChange({ animations: v })}
                  />

                  {settings.autoStart && (
                    <div className="mt-2 p-3 rounded-xl border border-emerald-500/20 bg-emerald-500/5 flex items-center gap-2">
                      <Check size={14} className="text-emerald-400 shrink-0" />
                      <span className="text-[10px] font-mono text-emerald-300/80">
                        {settings.assistantName || "Mayra"} will auto-launch on next login.
                      </span>
                    </div>
                  )}
                </div>
              )}

              {/* ---------------- VOICE ---------------- */}
              {activeTab === "voice" && (
                <div className="space-y-4">
                  <div className="text-[10px] font-mono uppercase tracking-widest text-slate-500">
                    Premium Voice Tone Selection — Female Voices Only
                  </div>

                  <div className="space-y-1.5">
                    <label className="block text-[10px] font-mono tracking-wider text-slate-300 uppercase">
                      Voice Tone
                    </label>
                    <div className="space-y-1.5 max-h-[380px] overflow-y-auto pr-1">
                      {premiumVoices.map((voice) => {
                        const active = settings.voiceTone === voice.value;
                        return (
                          <button
                            key={voice.value}
                            onClick={() => onChange({ voiceTone: voice.value })}
                            className={`w-full text-left p-3 rounded-xl border transition cursor-pointer ${
                              active
                                ? "border-cyan-400/40 bg-cyan-500/10"
                                : "border-white/5 bg-white/[0.02] hover:bg-white/5 hover:border-white/10"
                            }`}
                          >
                            <div className="flex items-center gap-2">
                              {active && <Check size={14} className="text-cyan-400 shrink-0" />}
                              <span className={`text-xs font-semibold ${active ? "text-cyan-300" : "text-slate-200"}`}>
                                {voice.label}
                              </span>
                            </div>
                            {voice.desc && (
                              <span className="block text-[9px] font-mono text-slate-400 mt-1 ml-[18px]">
                                {voice.desc}
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                    <span className="text-[8px] text-slate-500 uppercase font-mono">
                      {premiumVoices.length} premium female voices. Transition is seamless and live.
                    </span>
                  </div>

                  <div className="p-3 rounded-xl border border-indigo-500/20 bg-indigo-500/5 flex items-start gap-2.5">
                    <Volume2 size={16} className="text-indigo-400 shrink-0 mt-0.5" />
                    <div>
                      <h4 className="text-[10px] font-bold font-mono text-indigo-300 uppercase">Natural TTS Engine</h4>
                      <p className="text-[9px] text-indigo-400 uppercase font-mono mt-0.5 leading-relaxed">
                        Features state-of-the-art sub-150ms latency voice feedback mapped directly to Gemini prebuilt vocal cords.
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {/* ---------------- PERMISSIONS ---------------- */}
              {activeTab === "permissions" && (
                <div className="space-y-4">
                  <div className="text-[10px] font-mono uppercase tracking-widest text-slate-500">
                    Security &amp; Access Controls
                  </div>

                  <ToggleRow
                    label="FILE SYSTEM ACCESS"
                    description="Allow reading, copying, moving, and pasting local files"
                    checked={settings.fileSystemAccess}
                    onChange={(v) => onChange({ fileSystemAccess: v })}
                  />

                  <ToggleRow
                    label="SCREEN SHARING"
                    description="Allow live screen capture analysis and OCR parsing"
                    checked={settings.screenShareAccess}
                    onChange={(v) => onChange({ screenShareAccess: v })}
                  />

                  <ToggleRow
                    label="MICROPHONE ACCESS"
                    description="Allow live audio capture for continuous listening"
                    checked={settings.microphoneAccess}
                    onChange={(v) => onChange({ microphoneAccess: v })}
                  />

                  <ToggleRow
                    label="CAMERA ACCESS"
                    description="Allow real-time camera video capture support"
                    checked={settings.cameraAccess}
                    onChange={(v) => onChange({ cameraAccess: v })}
                  />

                  <ToggleRow
                    label="SYSTEM COMMANDS"
                    description="Allow power operations (Shutdown, Restart, Sleep)"
                    checked={settings.systemCommandsAccess}
                    onChange={(v) => onChange({ systemCommandsAccess: v })}
                  />
                </div>
              )}

              {/* ---------------- SYSTEM ---------------- */}
              {activeTab === "system" && (
                <div className="space-y-4">
                  <div className="text-[10px] font-mono uppercase tracking-widest text-slate-500">
                    Desktop Control Agent
                  </div>

                  <div
                    className={`p-4 rounded-xl border flex items-center gap-3 ${
                      agentHealth.online
                        ? "border-emerald-500/20 bg-emerald-500/5"
                        : "border-rose-500/20 bg-rose-500/5"
                    }`}
                  >
                    <div
                      className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                        agentHealth.online ? "bg-emerald-400 animate-pulse" : "bg-rose-400"
                      }`}
                    />
                    <div className="flex-1">
                      <div className="text-xs font-mono text-white">
                        {agentHealth.online ? "Agent Online" : "Agent Offline"}
                      </div>
                      <div className="text-[10px] font-mono text-slate-400">
                        {agentHealth.online
                           ? `${agentHealth.toolCount ?? 0} tools registered`
                           : "Start the Python agent on port 8765"}
                      </div>
                    </div>
                    <Cpu size={16} className="text-slate-500" />
                  </div>

                  <div className="p-3 rounded-xl border border-white/5 bg-white/5 space-y-2">
                    <div className="flex items-center gap-2 text-[10px] font-mono text-slate-400 uppercase tracking-wider">
                      <Volume2 size={12} /> Active Capabilities
                    </div>
                    <div className="grid grid-cols-2 gap-1.5 text-[10px] font-mono text-slate-300">
                      <span>✓ App execution</span>
                      <span>✓ Browser proxy</span>
                      <span>✓ System volume</span>
                      <span>✓ Display brightness</span>
                      <span>✓ Power control</span>
                      <span>✓ Copy/Paste/Delete</span>
                      <span>✓ Screenshot OCR</span>
                      <span>✓ Clipboard hook</span>
                    </div>
                  </div>
                </div>
              )}

              {/* ---------------- API KEYS ---------------- */}
              {activeTab === "system" && (
                <div className="space-y-4">
                  <div className="text-[10px] font-mono uppercase tracking-widest text-slate-500">
                    API Keys &amp; LLM Configuration
                  </div>

                  <ApiKeyField
                    label="Google Gemini API Key"
                    description="Primary key — drives Mayra's voice &amp; intelligence"
                    storageKey="gemini"
                    onSave={async (key) => {
                      const res = await fetch("/api/config/apikey", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ apiKey: key }),
                      });
                      if (!res.ok) throw new Error("Failed to save key");
                    }}
                  />

                  <div className="p-3 rounded-xl border border-indigo-500/20 bg-indigo-500/5 flex items-start gap-2.5">
                    <Info size={14} className="text-indigo-400 shrink-0 mt-0.5" />
                    <div>
                      <h4 className="text-[10px] font-bold font-mono text-indigo-300 uppercase">Dynamic Reload</h4>
                      <p className="text-[9px] text-indigo-400 uppercase font-mono mt-0.5 leading-relaxed">
                        Saved keys take effect on the next voice session. No restart needed — reconnect to apply.
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {/* ---------------- CHAT ---------------- */}
              {activeTab === "chat" && (
                <div className="space-y-4">
                  <div className="text-[10px] font-mono uppercase tracking-widest text-slate-500">
                    Chat Preferences
                  </div>

                  <div className="space-y-1.5">
                    <label className="block text-[10px] font-mono tracking-wider text-slate-300 uppercase">
                      Chat Language Preference
                    </label>
                    <select
                      value={settings.chatLanguage || "auto"}
                      onChange={(e) => onChange({ chatLanguage: e.target.value } as any)}
                      className="w-full px-3 py-2 rounded-xl border border-white/10 bg-white/5 text-sm text-white font-mono focus:outline-none focus:border-cyan-400/50 transition cursor-pointer"
                    >
                      <option value="auto" className="bg-slate-950">Auto-detect (recommended)</option>
                      <option value="english" className="bg-slate-950">English only</option>
                      <option value="bengali" className="bg-slate-950">Bengali preferred</option>
                      <option value="hindi" className="bg-slate-950">Hindi preferred</option>
                    </select>
                    <span className="text-[8px] text-slate-500 uppercase font-mono">
                      How {settings.assistantName || "Mayra"} responds in chat
                    </span>
                  </div>

                  <ToggleRow
                    label="SAVE CHAT HISTORY"
                    description="Persist conversations for future reference"
                    checked={settings.saveChatHistory ?? true}
                    onChange={(v) => onChange({ saveChatHistory: v } as any)}
                  />

                  <ToggleRow
                    label="CHAT NOTIFICATIONS"
                    description="Show visual indicators for new AI messages"
                    checked={settings.chatNotifications ?? true}
                    onChange={(v) => onChange({ chatNotifications: v } as any)}
                  />

                  <div className="p-3 rounded-xl border border-cyan-500/20 bg-cyan-500/5 flex items-start gap-2.5">
                    <Sparkles size={14} className="text-cyan-400 shrink-0 mt-0.5" />
                    <div>
                      <h4 className="text-[10px] font-bold font-mono text-cyan-300 uppercase">Text + Voice Chat</h4>
                      <p className="text-[9px] text-cyan-400 uppercase font-mono mt-0.5 leading-relaxed">
                        Chat with Mayra via text or voice. Messages sync with your conversation history and memory core.
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {/* ---------------- ABOUT ---------------- */}
              {activeTab === "about" && (
                <div className="space-y-4">
                  <div className="text-[10px] font-mono uppercase tracking-widest text-slate-500">
                    About {settings.assistantName || "Mayra"}
                  </div>

                  <div className="p-4 rounded-xl border border-white/5 bg-white/5 space-y-3">
                    <div className="flex items-center gap-2">
                      <Info size={14} className="text-cyan-400" />
                      <span className="text-sm font-display text-white">{settings.assistantName || "Mayra"} Desktop Companion</span>
                    </div>
                    <div className="space-y-1.5 text-[10px] font-mono text-slate-400">
                      <div className="flex justify-between">
                        <span>VERSION</span>
                        <span className="text-slate-300">V3.0.0</span>
                      </div>
                      <div className="flex justify-between">
                        <span>ENGINE</span>
                        <span className="text-slate-300">Gemini Live API</span>
                      </div>
                      <div className="flex justify-between">
                        <span>DESKTOP CONTROLLER</span>
                        <span className="text-slate-300">Python FastAPI</span>
                      </div>
                      <div className="flex justify-between">
                        <span>PERMISSIONS</span>
                        <span className="text-slate-300">Sandboxed Toggles</span>
                      </div>
                    </div>
                  </div>

                  <div className="p-3 rounded-xl border border-amber-500/15 bg-amber-500/5 flex items-start gap-2">
                    <AlertTriangle size={12} className="text-amber-400 shrink-0 mt-0.5" />
                    <span className="text-[10px] font-mono text-amber-300/70 leading-relaxed">
                      This desktop companion remains active in the background. Grant the relevant settings/permissions to allow natural language PC actions.
                    </span>
                  </div>
                </div>
              )}
            </div>

            {/* Footer status bar */}
            <div className="px-6 py-3 border-t border-white/5 bg-white/5 flex items-center justify-between">
              <span className="text-[9px] font-mono uppercase tracking-widest text-slate-500">
                Preferences Auto-Saved
              </span>
              <span className="text-[9px] font-mono uppercase tracking-widest text-slate-500">
                {settings.assistantName || "Mayra"} V3
              </span>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

/**
 * API Key field with show/hide toggle and save-to-backend functionality.
 * Calls the provided onSave when the user clicks Save, then shows success/fail.
 */
function ApiKeyField({
  label,
  description,
  storageKey,
  onSave,
}: {
  label: string;
  description: string;
  storageKey: string;
  onSave: (key: string) => Promise<void>;
}) {
  const [value, setValue] = useState("");
  const [show, setShow] = useState(false);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");

  const handleSave = async () => {
    const key = value.trim();
    if (!key) return;
    setStatus("saving");
    try {
      await onSave(key);
      setStatus("saved");
      setValue("");
      setTimeout(() => setStatus("idle"), 2500);
    } catch (e) {
      setStatus("error");
      setTimeout(() => setStatus("idle"), 3000);
    }
  };

  return (
    <div className="space-y-1.5">
      <label className="block text-[10px] font-mono tracking-wider text-slate-300 uppercase">
        {label}
      </label>
      <div className="flex gap-2">
        <div className="relative flex-1">
          <KeyRound className="absolute left-3 top-2.5 text-slate-400" size={14} />
          <input
            type={show ? "text" : "password"}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Paste your API key…"
            spellCheck={false}
            className="w-full pl-9 pr-9 py-2 rounded-xl border border-white/10 bg-white/5 text-sm text-white font-mono focus:outline-none focus:border-cyan-400/50 transition"
          />
          <button
            onClick={() => setShow(!show)}
            className="absolute right-3 top-2.5 text-slate-400 hover:text-white transition"
          >
            {show ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        </div>
        <button
          onClick={handleSave}
          disabled={!value.trim() || status === "saving"}
          className="px-3 py-2 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-xs font-bold uppercase tracking-wider transition disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
        >
          {status === "saving" ? (
            <Loader2 size={14} className="animate-spin" />
          ) : status === "saved" ? (
            <Check size={14} />
          ) : (
            "Save"
          )}
        </button>
      </div>
      <span className="text-[8px] text-slate-500 uppercase font-mono">{description}</span>
      {status === "saved" && (
        <span className="block text-[9px] font-mono text-emerald-400">✓ Key saved successfully</span>
      )}
      {status === "error" && (
        <span className="block text-[9px] font-mono text-rose-400">✗ Failed to save key</span>
      )}
    </div>
  );
}
