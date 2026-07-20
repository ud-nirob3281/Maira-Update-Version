import React, { useEffect, useRef, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Settings as SettingsIcon,
  Brain,
  MessageSquare,
  Mic,
  MicOff,
  Monitor,
  MonitorOff,
} from 'lucide-react';
import {
  MyraaCoreVisualizer,
  type MyraaEmotion,
} from './components/MyraaCoreVisualizer';
import { ChatPanel, type ChatMessage } from './components/ChatPanel';
import { SettingsPanel } from './components/SettingsPanel';
import { MemoryDashboard } from './components/MemoryDashboard';
import { MyraaAudioSession, type LiveState } from './lib/audio';
import {
  loadSettings,
  saveSettings,
  type MyraaSettings,
} from './lib/settingsStore';
import type { Memory, MemoryCategory } from './lib/memoryTypes';

const TASK_DISPLAY_NAMES: Record<string, string> = {
  openApplication: "Launching Application",
  closeApplication: "Closing Application",
  openWebsite: "Opening Website",
  searchWeb: "Searching the Web",
  searchYouTube: "Searching YouTube",
  searchGoogle: "Searching Google",
  searchGitHub: "Searching GitHub",
  createFile: "Creating File",
  readFile: "Reading File",
  editFile: "Editing File",
  deleteFile: "Deleting File",
  takeScreenshot: "Taking Screenshot",
  analyzeScreenshot: "Analyzing Screen",
  readScreen: "Reading Screen Content",
  desktopBrowserOpen: "Opening Automated Browser",
  desktopBrowserSnapshot: "Scanning Page Elements",
  desktopBrowserClick: "Clicking Page Element",
  desktopBrowserType: "Typing into Field",
  desktopBrowserSearch: "Searching Web Page",
  desktopBrowserClose: "Closing Browser",
  clickOnText: "Finding and Clicking Text",
  findOnScreen: "Searching Screen",
  runPythonScript: "Running Python Script",
};

function App() {
  const [runningTask, setRunningTask] = useState<string | null>(null);
  // ── Settings & persistence ──────────────────────────────────────────────
  const [settings, setSettings] = useState<MyraaSettings>(loadSettings());
  const [showSettings, setShowSettings] = useState(false);
  const [showMemory, setShowMemory] = useState(false);
  const [showChat, setShowChat] = useState(false); // toggleable chat

  const handleSettingsChange = useCallback((patch: Partial<MyraaSettings>) => {
    setSettings(prev => saveSettings({ ...prev, ...patch }));
  }, []);

  // ── Audio session & live state ──────────────────────────────────────────
  const audioRef = useRef<MyraaAudioSession | null>(null);
  const [liveState, setLiveState] = useState<LiveState>('disconnected');
  const [emotion, setEmotion] = useState<MyraaEmotion>('idle');
  const [error, setError] = useState<string | null>(null);

  // ── Chat ─────────────────────────────────────────────────────────────────
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  // Whether a model response is currently streaming in (drives the typing UI).
  const [isChatStreaming, setIsChatStreaming] = useState(false);
  // Tracks the id of the model bubble currently receiving streamed chunks so
  // consecutive transcription chunks accumulate into ONE bubble (the model's
  // response arrives in pieces over the WS bridge). Resets on turn-complete.
  const streamingBubbleIdRef = useRef<string | null>(null);

  // ── Memories ─────────────────────────────────────────────────────────────
  const [memories, setMemories] = useState<Memory[]>([]);

  // ── Screen Share ─────────────────────────────────────────────────────────
  const [isSharingScreen, setIsSharingScreen] = useState(false);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const screenIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const screenCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // Load memories on mount
  useEffect(() => {
    fetch('/api/memories')
      .then(r => r.json())
      .then(data => {
        if (Array.isArray(data)) setMemories(data);
      })
      .catch(() => {});
  }, []);

  // Character state: talking while speaking, thinking during automation
  const [isThinking, setIsThinking] = useState(false);
  const characterState: 'idle' | 'thinking' | 'talking' =
    liveState === 'speaking' ? 'talking' : isThinking ? 'thinking' : 'idle';

  // ── Connect / disconnect audio session ─────────────────────────────────
  const connect = useCallback(() => {
    if (audioRef.current) return;
    const session = new MyraaAudioSession({
      onStateChange: s => setLiveState(s),
      onTranscription: (role, text) => {
        // ── Streaming-aware chat accumulation ──
        // The model's response arrives as many small `transcription` chunks
        // (server.ts forwards each modelTurn text piece). Without accumulation
        // each chunk would become its own chat bubble. Instead:
        //  • USER text → always a new bubble.
        //  • MODEL text → append to the current streaming bubble (creating one
        //    if a user turn just started), so the whole reply is one bubble.
        if (role === 'user') {
          streamingBubbleIdRef.current = null;
          setIsChatStreaming(true); // a new user turn → expect a model reply
          setChatMessages(prev => [
            ...prev,
            {
              id: Math.random().toString(36).slice(2),
              role,
              text,
              timestamp: new Date().toISOString(),
            },
          ]);
        } else {
          setIsChatStreaming(true);
          setChatMessages(prev => {
            const id = streamingBubbleIdRef.current;
            if (id) {
              // Append to the in-flight model bubble.
              return prev.map(m =>
                m.id === id ? { ...m, text: m.text + text } : m
              );
            }
            // Start a new model bubble for this turn.
            const newId = Math.random().toString(36).slice(2);
            streamingBubbleIdRef.current = newId;
            return [
              ...prev,
              { id: newId, role: 'model', text, timestamp: new Date().toISOString() },
            ];
          });
        }
        // Auto-open chat panel when a new message arrives
        setShowChat(true);
      },
      onToolCall: (name, args, cb) => {
        cb({ result: 'ok' });
      },
      onError: e => setError(e),
      onMemorySync: mems => setMemories(mems),
      onEmotionChange: emo => setEmotion(emo as MyraaEmotion),
    });
    // Desktop automation events (tool start/complete/fail) are processed
    // silently: they drive the "thinking" character state, but we deliberately
    // do NOT surface any floating console / debug HUD to the user (P3). All
    // detail remains in the developer console only.
    session.onBrowserAutomationEvent = event => {
      if (event.status === 'started') {
        setIsThinking(true);
        setRunningTask(event.name);
      } else if (event.status === 'completed' || event.status === 'failed' || event.status === 'cancelled') {
        setIsThinking(false);
        setRunningTask(null);
      }
      // Dev-console trace only — never user-visible.
      console.debug('[Myraa automation]', event.name, event.status, event.result ?? event.error ?? '');
    };
    // When the model finishes a turn, stop the typing indicator so the last
    // bubble's streaming caret disappears.
    session.onTurnComplete = () => {
      setIsChatStreaming(false);
      streamingBubbleIdRef.current = null;
    };
    audioRef.current = session;
    session.connect({
      voiceTone: settings.voiceTone,
      assistantName: settings.assistantName,
      fileSystemAccess: settings.fileSystemAccess,
      screenShareAccess: settings.screenShareAccess,
      microphoneAccess: settings.microphoneAccess,
      cameraAccess: settings.cameraAccess,
      systemCommandsAccess: settings.systemCommandsAccess,
    });
  }, [settings]);

  const disconnect = useCallback(() => {
    audioRef.current?.disconnect();
    audioRef.current = null;
    setLiveState('disconnected');
  }, []);

  useEffect(() => () => audioRef.current?.disconnect(), []);

  // ── Chat send (text input) ──────────────────────────────────────────────
  // The bubble is added by onTranscription when the server echoes the user
  // turn back; here we only push the text to the Live session. This keeps the
  // voice path and the text path synchronized (both flow through the same WS).
  const handleSendChat = (text: string) => {
    const t = text.trim();
    if (!t) return;
    audioRef.current?.sendTextMessage(t);
  };

  // ── Memory handlers ─────────────────────────────────────────────────────
  const handleAddMemory = async (category: MemoryCategory, text: string) => {
    const res = await fetch('/api/memories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category, text }),
    });
    if (res.ok) {
      const newMem = await res.json();
      setMemories(prev => [...prev, newMem]);
    }
  };

  const handleDeleteMemory = async (id: string) => {
    await fetch(`/api/memories/${id}`, { method: 'DELETE' });
    setMemories(prev => prev.filter(m => m.id !== id));
  };

  // ── Screen Share toggle ─────────────────────────────────────────────────
  // Captures the user's screen via getDisplayMedia, samples frames to a canvas,
  // encodes as JPEG base64, and pushes to the audio session so Mayra can "see".
  //
  // In Electron, getDisplayMedia requires the desktopCapturer permission
  // which is configured in main.cjs. As a fallback, we try using Electron's
  // desktopCapturer via IPC to pick a source first, then pass its id to
  // getDisplayMedia (the { desktopId } option) so the picker is bypassed.
  const toggleScreenShare = useCallback(async () => {
    // STOP path
    if (isSharingScreen) {
      if (screenIntervalRef.current) {
        clearInterval(screenIntervalRef.current);
        screenIntervalRef.current = null;
      }
      screenStreamRef.current?.getTracks().forEach(t => t.stop());
      screenStreamRef.current = null;
      setIsSharingScreen(false);
      return;
    }

    // START path — requires an active audio session
    if (!audioRef.current) {
      setError('Connect to Mayra first to share your screen.');
      return;
    }
    if (!settings.screenShareAccess) {
      setError('Screen sharing is disabled in Settings → Permissions.');
      return;
    }

    let stream: MediaStream | null = null;

    // Strategy 1: Use Electron desktopCapturer IPC to get source ID, then pass to getDisplayMedia
    // This avoids the picker dialog and is the most reliable Electron approach.
    try {
      const electronSources = await (window as any).myraaDesktop?.getSources?.({ types: ['screen'] });
      
      if (electronSources && electronSources.length > 0) {
        const screenSource = electronSources.find((s: any) =>
          s.name.toLowerCase().includes('screen') || s.name.toLowerCase().includes('display')
        ) || electronSources[0];
        
        // @ts-ignore — desktopId is Electron-specific extension to getDisplayMedia
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: 1, desktopId: screenSource.id } as any,
          audio: false,
        });
      }
    } catch (e1: any) {
      console.warn('[ScreenShare] Electron desktopCapturer strategy failed:', e1?.message);
    }

    // Strategy 2: Direct getDisplayMedia (shows picker or uses setDisplayMediaRequestHandler)
    if (!stream) {
      try {
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: 1 } as any,
          audio: false,
        });
      } catch (e2: any) {
        console.warn('[ScreenShare] All getDisplayMedia strategies failed:', e2?.message);
        setError('Screen sharing is not supported. Try updating Electron or use Chrome.');
        return;
      }
    }

    try {
      screenStreamRef.current = stream;
      const video = document.createElement('video');
      video.srcObject = stream;
      video.muted = true;
      await video.play();

      if (!screenCanvasRef.current) {
        screenCanvasRef.current = document.createElement('canvas');
      }
      const canvas = screenCanvasRef.current;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas 2D context unavailable');

      // Sample a frame every ~1s and send to Gemini via the WS bridge.
      screenIntervalRef.current = setInterval(() => {
        if (!video.videoWidth) return;
        // Downscale to keep payload small (~640px wide)
        const scale = Math.min(1, 640 / video.videoWidth);
        canvas.width = video.videoWidth * scale;
        canvas.height = video.videoHeight * scale;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.5);
        // strip the "data:image/jpeg;base64," prefix
        audioRef.current?.sendVideoFrame(dataUrl.split(',')[1]);
      }, 1000);

      // If the user stops sharing from the browser's native bar, clean up.
      stream.getVideoTracks()[0].addEventListener('ended', () => {
        if (screenIntervalRef.current) clearInterval(screenIntervalRef.current);
        screenIntervalRef.current = null;
        screenStreamRef.current = null;
        setIsSharingScreen(false);
      });

      setIsSharingScreen(true);
    } catch (e: any) {
      setError(e?.message || 'Could not start screen sharing.');
    }
  }, [isSharingScreen, settings.screenShareAccess]);

  const isConnected = liveState !== 'disconnected';
  const themeColor = 'charcoal';

  return (
    <div className="relative w-full h-screen overflow-hidden bg-black text-white font-sans">
      {/* Fixed Background Image (original layout) */}
      <div className="absolute inset-0 z-0">
        <video
          src="assets/Background.mp4"
          autoPlay // ← camelCase
          loop
          muted
          playsInline // ← মোবাইলের জন্য যোগ করুন
          className="w-full h-full object-cover"
        />
        <div className="absolute inset-0 bg-gradient-to-b from-transparent to-black/80" />
      </div>

      {/* Floating Particles (original layout) */}
      <div className="absolute inset-0 z-10 pointer-events-none overflow-hidden">
        {[...Array(30)].map((_, i) => (
          <div
            key={i}
            className="absolute rounded-full bg-blue-400/30 animate-float"
            style={{
              width: `${Math.random() * 8 + 4}px`,
              height: `${Math.random() * 8 + 4}px`,
              left: `${Math.random() * 100}%`,
              top: `${Math.random() * 100}%`,
              animationDuration: `${Math.random() * 15 + 10}s`,
              animationDelay: `${Math.random() * 5}s`,
            }}
          />
        ))}
      </div>

      {/* Top-right control buttons */}
      <div className="absolute top-4 right-4 z-30 flex items-center gap-2">
        {/* Connect / Disconnect */}
        {!isConnected ? (
          <button
            onClick={connect}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-gradient-to-r from-indigo-500 to-cyan-500 hover:brightness-110 text-xs font-semibold tracking-wide transition cursor-pointer"
          >
            <Mic size={14} />
            <span className="hidden sm:inline">Connect</span>
          </button>
        ) : (
          <button
            onClick={disconnect}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-rose-500/30 bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 text-xs font-semibold transition cursor-pointer"
          >
            <MicOff size={14} />
            <span className="hidden sm:inline">Disconnect</span>
          </button>
        )}
        {/* Screen Share toggle */}
        <button
          onClick={toggleScreenShare}
          disabled={!isConnected}
          className={`flex items-center gap-1.5 px-3 py-2 rounded-xl border text-xs font-semibold transition cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed ${
            isSharingScreen
              ? 'border-cyan-400/50 bg-cyan-500/20 text-cyan-200 animate-pulse'
              : 'border-white/10 bg-white/5 hover:bg-white/10 text-slate-300 hover:text-white'
          }`}
          title={
            isSharingScreen
              ? 'Stop sharing screen'
              : 'Share your screen with Mayra'
          }
        >
          {isSharingScreen ? <MonitorOff size={14} /> : <Monitor size={14} />}
          <span className="hidden sm:inline">
            {isSharingScreen ? 'STOP SHARE' : 'SHARE'}
          </span>
        </button>
        {/* Memory */}
        <button
          onClick={() => setShowMemory(true)}
          className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 text-xs font-mono tracking-wider text-slate-300 hover:text-white transition cursor-pointer"
          title="Memory Core"
        >
          <Brain size={14} />
          <span className="hidden sm:inline">MEMORY</span>
        </button>
        {/* Chat toggle */}
        <button
          onClick={() => setShowChat(!showChat)}
          className={`flex items-center gap-1.5 px-3 py-2 rounded-xl border text-xs font-mono tracking-wider transition cursor-pointer ${
            showChat
              ? 'border-cyan-400/40 bg-cyan-500/10 text-cyan-300'
              : 'border-white/10 bg-white/5 hover:bg-white/10 text-slate-300 hover:text-white'
          }`}
          title="Chat"
        >
          <MessageSquare size={14} />
          <span className="hidden sm:inline">CHAT</span>
        </button>
        {/* Settings */}
        <button
          onClick={() => setShowSettings(true)}
          className="p-2 rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 text-slate-300 hover:text-white transition cursor-pointer"
          title="Settings"
        >
          <SettingsIcon size={16} />
        </button>
      </div>

      {/* Connection status badge (top-left) */}
      <div className="absolute top-4 left-4 z-30 flex items-center gap-2">
        <span
          className={`w-2 h-2 rounded-full ${isConnected ? 'bg-emerald-400 animate-pulse' : 'bg-slate-600'}`}
        />
        <span className="text-[9px] font-mono uppercase tracking-widest text-slate-400">
          {liveState}
        </span>
        {error && (
          <span
            className="text-[9px] font-mono text-rose-400 ml-2 max-w-[200px] truncate"
            title={error}
          >
            ⚠ {error}
          </span>
        )}
      </div>

      {/* Active Task Floating Pill */}
      <AnimatePresence>
        {runningTask && (
          <motion.div
            initial={{ opacity: 0, y: -20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -20, scale: 0.95 }}
            className="absolute top-4 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 px-4 py-2 rounded-full border border-red-500/30 bg-black/60 backdrop-blur-md shadow-[0_0_20px_rgba(239,68,68,0.2)] text-xs font-medium text-white select-none"
          >
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500"></span>
            </span>
            <span className="text-slate-300">Myraa is:</span>
            <span className="font-semibold text-rose-400">
              {TASK_DISPLAY_NAMES[runningTask] || runningTask}
            </span>
            <button
              onClick={() => audioRef.current?.cancelActiveTask()}
              className="ml-2 flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-red-500/20 hover:bg-red-500 hover:text-white border border-red-500/30 hover:border-transparent text-red-400 transition-all cursor-pointer text-[10px] uppercase font-bold tracking-wider"
            >
              Cancel
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Main Character Area (original centered layout) */}
      <div className="relative z-20 flex flex-col items-center justify-center h-full px-4 pt-10">
        <motion.div
          initial={{ scale: 0.95, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          className="max-w-5xl w-full flex justify-center drop-shadow-2xl"
        >
          <div
            className="relative w-full max-w-2xl aspect-video rounded-[2rem] border-2 border-white/10 overflow-hidden shadow-[0_0_60px_-10px_rgba(99,102,241,0.4)] bg-gradient-to-b from-indigo-950/30 to-black/40 backdrop-blur-sm"
            style={{ boxShadow: "0 0 80px -20px rgba(99,102,241,0.5), inset 0 0 40px rgba(0,0,0,0.3)" }}
          >
            <MyraaCoreVisualizer
              state={liveState}
              themeColor={themeColor}
              activeEmotion={emotion}
              characterState={characterState}
            />
          </div>
        </motion.div>

        {/* Toggleable Chat Interface (Glassmorphism — original style) */}
        <AnimatePresence>
          {showChat && (
            <ChatPanel
              messages={chatMessages}
              assistantName={settings.assistantName || 'Mayra'}
              isStreaming={isChatStreaming}
              onSend={handleSendChat}
              onClear={() => setChatMessages([])}
              onClose={() => setShowChat(false)}
            />
          )}
        </AnimatePresence>
      </div>

      {/* ── Overlays ── */}
      <SettingsPanel
        isOpen={showSettings}
        onClose={() => setShowSettings(false)}
        settings={settings}
        onChange={handleSettingsChange}
        themeColor={themeColor}
      />

      <MemoryDashboard
        isOpen={showMemory}
        onClose={() => setShowMemory(false)}
        memories={memories}
        onAddMemory={handleAddMemory}
        onDeleteMemory={handleDeleteMemory}
        themeColor={themeColor}
      />
    </div>
  );
}

export default App;
