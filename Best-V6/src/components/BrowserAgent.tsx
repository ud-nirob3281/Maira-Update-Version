import React, { useEffect, useRef } from "react";
import { 
  X, 
  ExternalLink, 
  Cpu, 
  CheckCircle, 
  AlertCircle, 
  Terminal, 
  Trash2,
  Globe, 
  Play,
  Monitor,
  Sparkles,
  Command
} from "lucide-react";
import { motion } from "motion/react";

interface LogItem {
  id: string;
  timestamp: string;
  text: string;
  type: "info" | "success" | "error" | "action";
}

interface BrowserAgentProps {
  url: string | null;
  logs: LogItem[];
  onClearLogs: () => void;
  onClose: () => void;
}

export const BrowserAgent: React.FC<BrowserAgentProps> = ({
  url,
  logs,
  onClearLogs,
  onClose
}) => {
  const terminalEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll logs to bottom when new logs stream in
  useEffect(() => {
    terminalEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  // Extract a clean domain name for display
  const getCleanDomain = (urlStr: string | null): string => {
    if (!urlStr || urlStr === "about:blank") return "Playwright Core Launcher";
    try {
      const parsed = new URL(urlStr);
      return parsed.hostname;
    } catch {
      return urlStr;
    }
  };

  const isExecuting = logs.length > 0 && logs[logs.length - 1].type === "action";

  return (
    <div
      id="myraa-playwright-automation-hud"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-xl animate-fade-in text-left select-none"
    >
      <div className="relative w-full max-w-4xl h-[75vh] flex flex-col rounded-3xl border border-purple-500/20 bg-slate-900/90 shadow-[0_0_80px_rgba(147,51,234,0.3)] overflow-hidden">
        
        {/* Ambient background styling */}
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(168,85,247,0.15),transparent_60%)] pointer-events-none" />
        <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.003)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.003)_1px,transparent_1px)] bg-[size:16px_16px] pointer-events-none opacity-20" />

        {/* 1. HUD HEADER */}
        <div className="relative z-10 px-6 py-4 border-b border-white/5 bg-slate-950/40 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="relative flex items-center justify-center w-10 h-10 rounded-xl bg-purple-500/10 border border-purple-500/30 text-purple-400">
              <Cpu size={20} className={isExecuting ? "animate-pulse" : ""} />
              {isExecuting && (
                <span className="absolute -top-1 -right-1 flex h-3 w-3">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-3 w-3 bg-cyan-500"></span>
                </span>
              )}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-mono text-[10px] font-extrabold uppercase tracking-[0.2em] text-purple-400">
                  Automation Subsystem
                </span>
                <span className="px-2 py-0.5 rounded-full bg-purple-500/10 border border-purple-500/20 text-[9px] font-mono text-purple-300">
                  Playwright v1.49+
                </span>
              </div>
              <h1 className="text-base font-bold text-slate-100 flex items-center gap-1.5 font-sans">
                Myraa Browser Engine
                <Sparkles size={14} className="text-yellow-400" />
              </h1>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={onClearLogs}
              className="p-2 rounded-xl bg-white/5 hover:bg-white/10 text-slate-400 hover:text-white border border-white/5 transition-all text-xs flex items-center gap-1.5 cursor-pointer"
              title="Clear Console History"
            >
              <Trash2 size={13} />
              <span className="hidden sm:inline font-mono text-[10px]">Clear Log</span>
            </button>
            <button
              onClick={onClose}
              className="p-2 rounded-xl bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 hover:text-rose-100 border border-rose-500/20 transition-all text-xs flex items-center gap-1 cursor-pointer"
            >
              <X size={15} />
              <span className="hidden sm:inline font-mono text-[10px]">Close HUD</span>
            </button>
          </div>
        </div>

        {/* 2. ACTIVE SITE BANNER */}
        <div className="relative z-10 px-6 py-4 bg-slate-950/30 border-b border-white/5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 font-mono">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-slate-800 border border-white/5 flex items-center justify-center text-slate-400">
              <Globe size={15} className={isExecuting ? "animate-spin text-purple-400" : "text-slate-400"} />
            </div>
            <div>
              <span className="text-[10px] text-slate-500 uppercase font-bold tracking-wider">Active Domain Instance</span>
              <div className="text-xs text-purple-300 font-bold truncate max-w-md">
                {getCleanDomain(url)}
              </div>
            </div>
          </div>

          {url && url !== "about:blank" && (
            <a
              href={url}
              target="_blank"
              rel="noreferrer noopener"
              className="self-start sm:self-auto flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-slate-300 hover:text-white border border-white/5 text-[11px] transition-all cursor-pointer"
            >
              <ExternalLink size={12} />
              <span>Launch Separate Web Window</span>
            </a>
          )}
        </div>

        {/* 3. CONSOLE LOG ENGINE */}
        <div className="flex-1 flex flex-col min-h-0 bg-slate-950/65 relative p-6">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-1.5 font-mono text-[10px] text-slate-400 uppercase font-bold tracking-wider">
              <Terminal size={12} className="text-slate-500" />
              <span>Real-Time Operation Log</span>
            </div>
            <div className="flex items-center gap-1.5 font-mono text-[9px]">
              <span className={`w-1.5 h-1.5 rounded-full ${isExecuting ? "bg-cyan-400 animate-pulse" : "bg-green-400"}`} />
              <span className="text-slate-500">{isExecuting ? "Executing Plan" : "Idle & Monitoring"}</span>
            </div>
          </div>

          <div 
            className="flex-1 overflow-y-auto font-mono text-xs p-4 rounded-xl border border-white/5 bg-slate-950/90 text-slate-300 space-y-2.5 shadow-inner"
            style={{ contentVisibility: "auto" }}
          >
            {logs.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-center text-slate-600 space-y-1.5 py-12">
                <Command size={24} className="text-slate-700 animate-pulse" />
                <div className="text-xs font-semibold">Console history is clean.</div>
                <div className="text-[10px] max-w-xs text-slate-700 leading-relaxed">
                  Ask Myraa to open a website, search for a video, play media, or automate actions to trigger Playwright control commands.
                </div>
              </div>
            ) : (
              logs.map((log) => {
                const isAction = log.type === "action";
                const isSuccess = log.type === "success";
                const isError = log.type === "error";

                return (
                  <motion.div
                    key={log.id}
                    initial={{ opacity: 0, x: -5 }}
                    animate={{ opacity: 1, x: 0 }}
                    className="flex items-start gap-2.5 border-b border-white/[0.02] pb-1.5 leading-relaxed"
                  >
                    <span className="text-[10px] text-slate-600 select-none pt-0.5 shrink-0">
                      {log.timestamp}
                    </span>
                    <div className="flex items-start gap-1.5 min-w-0">
                      {isAction && (
                        <span className="shrink-0 inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-cyan-500/10 border border-cyan-500/20 text-[9px] font-extrabold uppercase text-cyan-400">
                          <Play size={8} /> Active
                        </span>
                      )}
                      {isSuccess && (
                        <span className="shrink-0 inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/20 text-[9px] font-extrabold uppercase text-emerald-400">
                          <CheckCircle size={8} /> Success
                        </span>
                      )}
                      {isError && (
                        <span className="shrink-0 inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-rose-500/10 border border-rose-500/20 text-[9px] font-extrabold uppercase text-rose-400">
                          <AlertCircle size={8} /> Failed
                        </span>
                      )}
                      {!isAction && !isSuccess && !isError && (
                        <span className="shrink-0 inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-slate-800 border border-white/5 text-[9px] font-extrabold uppercase text-slate-400">
                          Info
                        </span>
                      )}
                      <span className="text-slate-300 break-words font-medium">
                        {log.text}
                      </span>
                    </div>
                  </motion.div>
                );
              })
            )}
            <div ref={terminalEndRef} />
          </div>
        </div>

        {/* Footer / Tip */}
        <div className="px-6 py-3.5 bg-slate-950/50 border-t border-white/5 flex items-center justify-between text-[10px] text-slate-500 font-mono">
          <div className="flex items-center gap-1.5">
            <Monitor size={12} className="text-slate-600" />
            <span>The browser is running headed on your system. You can view or interact with it directly.</span>
          </div>
          <span className="hidden md:inline text-purple-500/70 font-semibold uppercase tracking-wider">Myraa Active Link</span>
        </div>

      </div>
    </div>
  );
};
