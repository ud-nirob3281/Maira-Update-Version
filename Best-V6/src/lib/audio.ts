/**
 * Audio handling utility for Myraa Live API Voice stream.
 * Handles:
 * - 16kHz layout sampling for microphone stream.
 * - Raw Little Endian Int16 PCM translation.
 * - 24kHz layout output sampling for model voice playback.
 * - Gapless double-buffer queue scheduler.
 * - Interrupt signal immediate stop.
 * - Input & Output AnalyserNodes for real-time waveform visuals.
 */

export type LiveState = "disconnected" | "connecting" | "listening" | "speaking";

// PCM Conversion Helper: converts Float32Array [-1.0, 1.0] to signed Int16 Raw PCM Little Endian
function floatTo16BitPCM(input: Float32Array): ArrayBuffer {
  const buffer = new ArrayBuffer(input.length * 2);
  const view = new DataView(buffer);
  let offset = 0;
  for (let i = 0; i < input.length; i++, offset += 2) {
    let s = Math.max(-1, Math.min(1, input[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
  return buffer;
}

// Float conversion helper: converts signed Int16 array buffer to Float32Array [-1.0, 1.0]
function pcm16ToFloats(uint8Array: Uint8Array): Float32Array {
  const int16 = new Int16Array(
    uint8Array.buffer,
    uint8Array.byteOffset,
    uint8Array.byteLength / 2
  );
  const floats = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    floats[i] = int16[i] / 32768.0;
  }
  return floats;
}

// Convert ArrayBuffer to Base64 String
function base64ArrayBuffer(arrayBuffer: ArrayBuffer): string {
  let binary = '';
  const bytes = new Uint8Array(arrayBuffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
}

// Convert Base64 string to Uint8Array
function base64ToUint8Array(base64: string): Uint8Array {
  const binaryString = window.atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

function getCloseCodeExplanation(code: number): string {
  switch (code) {
    case 1000: return "Normal Closure (The connection successfully completed).";
    case 1001: return "Going Away (The server is going down or browser navigated away).";
    case 1002: return "Protocol Error (The endpoint is terminating because of a protocol error).";
    case 1003: return "Unsupported Data (The endpoint received a type of data it cannot accept).";
    case 1005: return "No Status Rcv (The connection was closed without a status code).";
    case 1006: return "Abnormal Closure (Connection closed abnormally, e.g., server crashed, websocket bridge failed, or network down).";
    case 1007: return "Invalid Frame Payload (The endpoint received data that was not consistent with the type of message).";
    case 1008: return "Policy Violation (The endpoint received a message that violates its policy).";
    case 1009: return "Message Too Big (The endpoint cannot process the message because it is too large).";
    case 1011: return "Internal Error (The server encountered an unexpected condition that prevented it from fulfilling the request).";
    case 1015: return "TLS Handshake (Failure to perform a TLS handshake).";
    default: return `Unknown Close Code (${code}).`;
  }
}

export class MyraaAudioSession {
  private ws: WebSocket | null = null;
  
  // Audios contexts (separate to match exact required sample rates)
  private inputAudioCtx: AudioContext | null = null;
  private outputAudioCtx: AudioContext | null = null;
  
  // Audio sources & processors
  private micStream: MediaStream | null = null;
  private micSourceNode: MediaStreamAudioSourceNode | null = null;
  private micProcessorNode: ScriptProcessorNode | null = null;
  
  // Visualisers
  public inputAnalyser: AnalyserNode | null = null;
  public outputAnalyser: AnalyserNode | null = null;
  private outputGainNode: GainNode | null = null;
  
  // Buffering / Playback details
  private nextStartTime = 0;
  private activeSources: AudioBufferSourceNode[] = [];
  
  // State Callbacks
  private onStateChange: (state: LiveState) => void;
  private onTranscription: (role: "user" | "model", text: string) => void;
  private onToolCall: (name: string, args: any, callback: (result: any) => void) => void;
  private onError: (error: string) => void;
  private onMemorySync?: (memories: any[]) => void;
  public onBrowserAutomationEvent?: (event: any) => void;
  public onEmotionChange?: (emotion: string) => void;
  // Fired when the model finishes its turn — lets the UI drop the typing
  // indicator / streaming caret on the last chat bubble.
  public onTurnComplete?: () => void;
  
  private currentState: LiveState = "disconnected";
  private isActivated = false;
  private heartbeatInterval: any = null;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 8;
  public sessionId: string | null = null;

  constructor(handlers: {
    onStateChange: (state: LiveState) => void;
    onTranscription: (role: "user" | "model", text: string) => void;
    onToolCall: (name: string, args: any, callback: (result: any) => void) => void;
    onError: (error: string) => void;
    onMemorySync?: (memories: any[]) => void;
    onEmotionChange?: (emotion: string) => void;
  }) {
    this.onStateChange = handlers.onStateChange;
    this.onTranscription = handlers.onTranscription;
    this.onToolCall = handlers.onToolCall;
    this.onError = handlers.onError;
    this.onMemorySync = handlers.onMemorySync;
    this.onEmotionChange = handlers.onEmotionChange;
  }

  private setState(state: LiveState) {
    this.currentState = state;
    this.onStateChange(state);
  }

  public getState(): LiveState {
    return this.currentState;
  }

  /**
   * Pushes a compressed JPEG base64 screenshot frame directly to the live WebSocket server.
   */
  public sendVideoFrame(base64Data: string) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.currentState !== "disconnected") {
      this.ws.send(JSON.stringify({ type: "video", video: base64Data }));
    }
  }

  /**
   * Send a text message to Mayra via the live WebSocket bridge (chat mode).
   * The server forwards it to the Gemini Live session as client content.
   */
  public sendTextMessage(text: string) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.currentState !== "disconnected") {
      this.ws.send(JSON.stringify({ type: "text", text }));
    }
  }

  /**
   * Cancel any active background or running task.
   */
  public cancelActiveTask() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "cancelTask" }));
    }
  }

  // Requests microphone and creates connections
  public async connect(options?: {
    voiceTone?: string;
    assistantName?: string;
    fileSystemAccess?: boolean;
    screenShareAccess?: boolean;
    microphoneAccess?: boolean;
    cameraAccess?: boolean;
    systemCommandsAccess?: boolean;
  }) {
    if (this.isActivated) return;
    this.isActivated = true;
    this.reconnectAttempts = 0; // reset on fresh connect
    this.setState("connecting");
    this.lastConnectOptions = options; // save for auto-reconnect
    console.log("Connecting..."); // Requirement: "Connecting..."

    try {
      // 1. Establish custom WebSocket server bridge
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const params = new URLSearchParams();
      if (options) {
        if (options.voiceTone) params.append("voiceTone", options.voiceTone);
        if (options.assistantName) params.append("assistantName", options.assistantName);
        if (options.fileSystemAccess !== undefined) params.append("fileSystemAccess", String(options.fileSystemAccess));
        if (options.screenShareAccess !== undefined) params.append("screenShareAccess", String(options.screenShareAccess));
        if (options.microphoneAccess !== undefined) params.append("microphoneAccess", String(options.microphoneAccess));
        if (options.cameraAccess !== undefined) params.append("cameraAccess", String(options.cameraAccess));
        if (options.systemCommandsAccess !== undefined) params.append("systemCommandsAccess", String(options.systemCommandsAccess));
      }
      if (this.sessionId) {
        params.append("sessionId", this.sessionId);
      }
      const queryStr = params.toString() ? `?${params.toString()}` : "";
      this.ws = new WebSocket(`${protocol}//${window.location.host}/live${queryStr}`);
      this.ws.binaryType = "blob";

      this.ws.onopen = async () => {
        console.log("Connected"); // Requirement: "Connected"
        console.log("[Myraa] Connected to server side WS bridge");
        
        // Start client-to-server heartbeat ping
        if (this.heartbeatInterval) {
          clearInterval(this.heartbeatInterval);
        }
        this.heartbeatInterval = setInterval(() => {
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            try {
              this.ws.send(JSON.stringify({ type: "ping" }));
            } catch (e) {}
          }
        }, 15000); // 15 seconds heartbeat

        try {
          // Guard against early user disconnect during connection setup
          if (!this.isActivated) return;

          // Safe, cross-browser AudioContext initialization
          const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
          if (!AudioContextClass) {
            throw new Error("Holographic audio link unsupported: Web Audio API missing in browser.");
          }

          this.inputAudioCtx = new AudioContextClass({ sampleRate: 16000 });
          this.outputAudioCtx = new AudioContextClass({ sampleRate: 24000 });

          // Ensure Audio Contexts are active and resumed to bypass browser security blocks
          if (this.inputAudioCtx.state === "suspended") {
            await this.inputAudioCtx.resume().catch(() => {});
          }
          if (this.outputAudioCtx.state === "suspended") {
            await this.outputAudioCtx.resume().catch(() => {});
          }
          
          // Setup custom output Analyser & Volume Gains
          this.outputGainNode = this.outputAudioCtx.createGain();
          this.outputAnalyser = this.outputAudioCtx.createAnalyser();
          this.outputAnalyser.fftSize = 256;
          this.outputAnalyser.smoothingTimeConstant = 0.8;
          
          this.outputGainNode.connect(this.outputAnalyser);
          this.outputAnalyser.connect(this.outputAudioCtx.destination);
          
          // Obtain User Microphone layout
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
            }
          });

          // Safeguard: Check if we disconnected while waiting for user to grant mic permissions
          if (!this.isActivated || !this.inputAudioCtx || !this.outputAudioCtx) {
            stream.getTracks().forEach((track) => {
              try {
                track.stop();
              } catch (e) {}
            });
            return;
          }

          this.micStream = stream;

          // Setup custom input Analyser
          this.inputAnalyser = this.inputAudioCtx.createAnalyser();
          this.inputAnalyser.fftSize = 256;
          
          this.micSourceNode = this.inputAudioCtx.createMediaStreamSource(this.micStream);
          this.micSourceNode.connect(this.inputAnalyser);

          // Stream input PCM 16-bit to WS
          this.micProcessorNode = this.inputAudioCtx.createScriptProcessor(2048, 1, 1);
          this.micSourceNode.connect(this.micProcessorNode);
          this.micProcessorNode.connect(this.inputAudioCtx.destination);

          this.micProcessorNode.onaudioprocess = (e) => {
            if (this.currentState === "disconnected" || this.currentState === "connecting") return;
            
            const channelData = e.inputBuffer.getChannelData(0);
            
            // Convert to base64 Int16 Little Endian PCM
            const pcmBuffer = floatTo16BitPCM(channelData);
            const base64 = base64ArrayBuffer(pcmBuffer);
            
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
              this.ws.send(JSON.stringify({ audio: base64 }));
            }
          };

          // Sound setups are fully functional
          this.setState("listening");

        } catch (audioError: any) {
          console.error("Audio Context or Microphone Initialization Failed:", audioError);
          this.onError(`Permission error: ${audioError.message || "Microphone required for holographic Live link."}`);
          this.disconnect();
        }
      };

      this.ws.onmessage = async (event) => {
        try {
          const data = JSON.parse(event.data);
          
          if (data.type === "pong") {
            // Heartbeat acknowledged
            return;
          }
          if (data.type === "ping") {
            try {
              if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({ type: "pong" }));
              }
            } catch (e) {}
            return;
          }

          // Root Error Handler message
          if (data.type === "error") {
            // Don't immediately disconnect on error — many errors are transient
            // (Gemini rate limit, network blip). Show the error to the user but
            // keep the connection alive for auto-reconnect to work.
            this.onError(data.error);
            console.warn("[Myraa] Server error (not disconnecting):", data.error);
            return;
          }

          // Handle server-side states
          if (data.type === "status") {
            console.log("[Myraa WS Status]:", data.status);
            if (data.status === "authenticating") {
              console.log("Authenticating..."); // Requirement: "Authenticating..."
            } else if (data.status === "authenticated") {
              console.log("Authenticated"); // Requirement: "Authenticated"
              if (data.sessionId) {
                this.sessionId = data.sessionId;
              }
            } else if (data.status === "creating_session") {
              console.log("Creating session..."); // Requirement: "Creating session..."
            } else if (data.status === "session_ready") {
              console.log("Session Ready"); // Requirement: "Session Ready"
            } else if (data.status === "connecting_gemini") {
              // Wait for Gemini Live connection
            } else if (data.status === "connected") {
              this.setState("listening");
            } else if (data.status === "session_closed") {
              // Gemini session closed (idle timeout / server restart).
              // Do NOT fully disconnect — auto-reconnect so the user stays
              // connected until they explicitly hit Disconnect.
              console.log("[Myraa] Session closed by server — auto-reconnecting…");
              this.setState("connecting");
              this.reconnect();
            }
            return;
          }

          // Handle audio payload (24kHzPCM model response)
          if (data.type === "audio" && data.audio) {
            console.log("Receiving Audio"); // Requirement: "Receiving Audio"
            this.playAudioPCMChunk(data.audio);
          }

          // Handle interruption signal (e.g. user talked over Myraa)
          if (data.type === "interrupted") {
            this.handleInterruption();
          }

          // Turn complete
          if (data.type === "turnComplete") {
            // Notify the UI that the model finished its reply (drop typing caret).
            if (this.onTurnComplete) {
              try { this.onTurnComplete(); } catch {}
            }
            // Once Myraa completes speaking, change visual state back to listening
            setTimeout(() => {
              if (this.activeSources.length === 0 && this.currentState === "speaking") {
                this.setState("listening");
              }
            }, 100);
          }

          // Handle live captions transcription
          if (data.type === "transcription") {
            if (data.role === "model") {
              console.log("Receiving Text"); // Requirement: "Receiving Text"
            }
            this.onTranscription(data.role, data.text);
          }

          // Handle memory synchronization
          if (data.type === "memory_sync" && data.memories) {
            if (this.onMemorySync) {
              this.onMemorySync(data.memories);
            }
          }

          // Handle browser automation events
          if (data.type === "browserAutomationEvent") {
            if (this.onBrowserAutomationEvent) {
              this.onBrowserAutomationEvent(data);
            }
          }

          // Handle emotion detection from server-side classifier
          if (data.type === "emotion" && data.emotion) {
            if (this.onEmotionChange) {
              this.onEmotionChange(data.emotion);
            }
          }

          // Handle Tool Calling
          if (data.type === "toolCall") {
            const { callId, name, args } = data;
            this.onToolCall(name, args, (result) => {
              // Send back execution result to server bridge
              if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({
                  type: "toolResponse",
                  id: callId,
                  name: name,
                  output: result
                }));
              }
            });
          }

        } catch (parseError) {
          console.error("Error reading server packet:", parseError);
        }
      };

      this.ws.onerror = (wsError) => {
        console.error("WebSocket transport error:", wsError);
        // Don't disconnect on error — let onclose handle reconnect logic
      };

      this.ws.onclose = (event) => {
        const code = event.code;
        const reason = event.reason || "No reason provided";
        console.log(`[Myraa WS] Closed: code=${code} reason=${reason}`);

        // 1000 = normal close (server intentional). Auto-reconnect unless user
        // explicitly disconnected (isActivated will be false then).
        if (this.isActivated) {
          console.log("[Myraa WS] Auto-reconnecting in 1.5s…");
          this.setState("connecting");
          this.reconnect();
        } else {
          this.disconnect();
        }
      };

    } catch (e: any) {
      console.error("Connection establish sequence failed:", e);
      this.onError(e.message || "Failed to initialize active channel.");
      this.disconnect();
    }
  }

  // Interruption triggers: stops all active audio players immediately
  private handleInterruption() {
    console.log("[Audio] Interruption signal received; flushing play logs.");
    
    // Stop all playing nodes
    this.activeSources.forEach((source) => {
      try {
        source.stop();
      } catch (err) {
        // Already finished or stopped
      }
    });
    this.activeSources = [];
    this.nextStartTime = 0;
    
    // Set state back to user listening
    this.setState("listening");
  }

  // Direct raw PCM chunk scheduled playback at 24kHz
  private playAudioPCMChunk(base64Audio: string) {
    if (!this.outputAudioCtx || !this.outputGainNode) return;

    try {
      this.setState("speaking");
      const uint8Array = base64ToUint8Array(base64Audio);
      const floats = pcm16ToFloats(uint8Array);

      // Create AudioBuffer of 24000Hz (the exact playback sample rate of Gemini outputs)
      const buffer = this.outputAudioCtx.createBuffer(1, floats.length, 24000);
      buffer.getChannelData(0).set(floats);

      // Create Buffer source
      const source = this.outputAudioCtx.createBufferSource();
      source.buffer = buffer;

      // Connect source to gain which is routed to analyser & speakers
      source.connect(this.outputGainNode);

      const currentTime = this.outputAudioCtx.currentTime;
      
      // Gapless scheduler sync
      if (this.nextStartTime < currentTime) {
        // Start fresh: 30ms ahead to bridge schedule timing
        this.nextStartTime = currentTime + 0.03;
      }

      source.start(this.nextStartTime);
      this.nextStartTime += buffer.duration;

      // Keep reference to handle real-time interruptions
      source.onended = () => {
        const index = this.activeSources.indexOf(source);
        if (index > -1) {
          this.activeSources.splice(index, 1);
        }
        
        // If there are no more active play nodes, revert state back to listening
        if (this.activeSources.length === 0 && this.currentState === "speaking") {
          this.setState("listening");
        }
      };

      this.activeSources.push(source);

    } catch (playbackError) {
      console.error("PCM Chunk buffering/playback failed:", playbackError);
    }
  }

  // Store last connect options for auto-reconnect
  private lastConnectOptions: Parameters<MyraaAudioSession["connect"]>[0] | undefined;

  /**
   * Auto-reconnect after a server-side session close.
   * Cleans up the old WS + audio nodes but keeps isActivated flagged true
   * via a fresh connect(), so the mic stream is re-acquired seamlessly.
   */
  private reconnect() {
    this.reconnectAttempts++;
    if (this.reconnectAttempts > this.maxReconnectAttempts) {
      console.error("[Myraa] Max reconnect attempts reached. Giving up.");
      this.onError("Connection lost after multiple attempts. Please click Connect to try again.");
      this.disconnect();
      return;
    }
    // Exponential backoff: 1.5s, 3s, 6s, 12s... capped at 30s
    const delay = Math.min(1500 * Math.pow(2, this.reconnectAttempts - 1), 30000);
    console.log(`[Myraa] Reconnect attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delay}ms…`);
    this.cleanupResources();
    setTimeout(() => {
      if (this.currentState === "disconnected") return;
      try {
        this.isActivated = false;
        this.connect(this.lastConnectOptions);
      } catch (e) {
        console.error("[Myraa] Reconnect failed:", e);
        this.setState("disconnected");
      }
    }, delay);
  }

  /**
   * Release mic stream, audio contexts, and WS socket WITHOUT flipping
   * isActivated — used by reconnect() to reuse the same session options.
   */
  private cleanupResources() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.ws) {
      try { this.ws.onopen = null; this.ws.onmessage = null; this.ws.onerror = null; this.ws.onclose = null; } catch {}
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
    if (this.micStream) {
      this.micStream.getTracks().forEach((track) => { try { track.stop(); } catch {} });
      this.micStream = null;
    }
    if (this.micProcessorNode) { try { this.micProcessorNode.disconnect(); } catch {} this.micProcessorNode = null; }
    if (this.micSourceNode) { try { this.micSourceNode.disconnect(); } catch {} this.micSourceNode = null; }
    if (this.inputAudioCtx) { try { this.inputAudioCtx.close(); } catch {} this.inputAudioCtx = null; }
    if (this.outputAudioCtx) { try { this.outputAudioCtx.close(); } catch {} this.outputAudioCtx = null; }
    this.activeSources = [];
    this.nextStartTime = 0;
    this.inputAnalyser = null;
    this.outputAnalyser = null;
    this.outputGainNode = null;
  }

  // Fully cleanup and release microphones & connection sockets
  public disconnect() {
    this.isActivated = false;
    this.setState("disconnected");
    this.sessionId = null;

    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    // Close WS socket
    if (this.ws) {
      try {
        this.ws.close();
      } catch (e) {}
      this.ws = null;
    }

    // Stop and release user microphone streams
    if (this.micStream) {
      this.micStream.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch (e) {}
      });
      this.micStream = null;
    }

    // Disconnect routing nodes
    if (this.micProcessorNode) {
      try {
        this.micProcessorNode.disconnect();
      } catch (e) {}
      this.micProcessorNode = null;
    }

    if (this.micSourceNode) {
      try {
        this.micSourceNode.disconnect();
      } catch (e) {}
      this.micSourceNode = null;
    }

    // Close Audio contexts
    if (this.inputAudioCtx) {
      try {
        this.inputAudioCtx.close();
      } catch (e) {}
      this.inputAudioCtx = null;
    }

    if (this.outputAudioCtx) {
      try {
        this.outputAudioCtx.close();
      } catch (e) {}
      this.outputAudioCtx = null;
    }

    this.activeSources = [];
    this.nextStartTime = 0;
    this.inputAnalyser = null;
    this.outputAnalyser = null;
    this.outputGainNode = null;
  }
}
