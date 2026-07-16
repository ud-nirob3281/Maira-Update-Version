import React, { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Send, Trash2, X, MessageSquare, Copy, Check, ChevronDown } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * ChatPanel — MYRAA's real messaging interface.
 *
 * Extracted from App.tsx (same glassmorphism style, not a redesign). Renders the
 * conversation with Markdown support, syntax-highlighted code blocks, a per-bubble
 * copy button, timestamps, a typing indicator while the model streams, and
 * auto-scroll. Message accumulation (streaming model chunks → one bubble) is done
 * by the parent (App.tsx) in onTranscription; this component only displays the
 * finalized/accumulated message list.
 */

export interface ChatMessage {
  id: string;
  role: "user" | "model";
  text: string;
  timestamp: string;
}

interface ChatPanelProps {
  messages: ChatMessage[];
  assistantName?: string;
  isStreaming: boolean; // true while a model response is in flight
  onSend: (text: string) => void;
  onClear: () => void;
  onClose: () => void;
}

/** Format an ISO timestamp as a short HH:MM clock string. */
function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

/** Tiny self-contained copy-to-clipboard button with feedback. */
const CopyButton: React.FC<{ text: string; label?: string }> = ({ text, label }) => {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async (e) => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1400);
        } catch {
          /* clipboard may be unavailable — ignore */
        }
      }}
      className="flex items-center gap-1 text-[9px] font-mono uppercase tracking-wider text-slate-400 hover:text-cyan-300 transition cursor-pointer"
      title="Copy"
    >
      {copied ? <Check size={11} className="text-emerald-400" /> : <Copy size={11} />}
      {label && <span>{label}</span>}
    </button>
  );
};

/** Styled fenced code block with a language label and copy button. */
const CodeBlock: React.FC<{ language: string; code: string }> = ({ language, code }) => {
  return (
    <div className="my-2 rounded-lg overflow-hidden border border-white/10 bg-black/50">
      <div className="flex items-center justify-between px-3 py-1.5 bg-white/5 border-b border-white/10">
        <span className="text-[9px] font-mono uppercase tracking-wider text-cyan-300/80">
          {language || "code"}
        </span>
        <CopyButton text={code} label="copy" />
      </div>
      <pre className="p-3 overflow-x-auto text-[12px] leading-relaxed font-mono text-slate-200">
        <code>{code}</code>
      </pre>
    </div>
  );
};

export const ChatPanel: React.FC<ChatPanelProps> = ({
  messages,
  assistantName = "Mayra",
  isStreaming,
  onSend,
  onClear,
  onClose,
}) => {
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to the newest message whenever the list grows or streams.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, isStreaming]);

  const handleSend = () => {
    const text = input.trim();
    if (!text) return;
    onSend(text);
    setInput("");
  };

  return (
    <motion.div
      initial={{ y: 50, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      exit={{ y: 50, opacity: 0 }}
      className="w-full max-w-3xl mt-6 p-4 rounded-2xl bg-white/5 backdrop-blur-lg border border-white/10 shadow-2xl"
    >
      <div className="flex items-center justify-between mb-3">
        <span className="text-[10px] font-mono uppercase tracking-widest text-cyan-400 flex items-center gap-1.5">
          <MessageSquare size={12} /> Chat with {assistantName}
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={onClear}
            className="p-1 rounded-lg text-slate-500 hover:text-rose-300 hover:bg-white/10 transition cursor-pointer"
            title="Clear conversation"
          >
            <Trash2 size={14} />
          </button>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-slate-500 hover:text-white hover:bg-white/10 transition cursor-pointer"
            title="Close chat"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      <div
        ref={scrollRef}
        className="h-52 overflow-y-auto mb-4 space-y-3 custom-scrollbar pr-1"
      >
        {messages.length === 0 ? (
          <div className="h-full flex items-center justify-center text-slate-600 text-xs text-center px-4">
            Connect and start talking, or type a message below.
          </div>
        ) : (
          <AnimatePresence initial={false}>
            {messages.map((msg) => {
              const isUser = msg.role === "user";
              // The last model message is "streaming" while the model talks.
              const streaming =
                !isUser && isStreaming && msg.id === messages[messages.length - 1]?.id;
              return (
                <motion.div
                  key={msg.id}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className={`group flex flex-col ${
                    isUser ? "items-end ml-8" : "items-start mr-8"
                  }`}
                >
                  <div
                    className={`relative max-w-full p-3 rounded-lg text-sm leading-relaxed ${
                      isUser
                        ? "bg-blue-500/20 text-right"
                        : "bg-white/10"
                    }`}
                  >
                    {/* Per-bubble copy (hover) */}
                    <div className="absolute -top-2 right-1 opacity-0 group-hover:opacity-100 transition">
                      <span className="inline-flex bg-black/70 rounded px-1 py-0.5">
                        <CopyButton text={msg.text} />
                      </span>
                    </div>
                    {/* Markdown body — user text rendered plain to keep it faithful */}
                    <div className="prose-chat">
                      {isUser ? (
                        <span className="whitespace-pre-wrap break-words">{msg.text}</span>
                      ) : (
                        <ReactMarkdown
                          remarkPlugins={[remarkGfm]}
                          components={{
                            // Inline code vs fenced code block
                            code({ node, className, children, ...props }: any) {
                              const text = String(children ?? "");
                              // react-markdown v9: fenced blocks render <code> inside <pre>
                              const isBlock =
                                /\blanguage-/.test(className || "") || text.includes("\n") || (props as any)?.blockquote !== undefined;
                              if (isBlock) {
                                const lang = /language-(\w+)/.exec(className || "")?.[1] || "";
                                return <CodeBlock language={lang} code={text.replace(/\n$/, "")} />;
                              }
                              return (
                                <code
                                  className="px-1 py-0.5 rounded bg-black/40 text-cyan-200 font-mono text-[12px]"
                                  {...props}
                                >
                                  {children}
                                </code>
                              );
                            },
                            pre: ({ children }: any) => <>{children}</>,
                            a: ({ children, href }: any) => (
                              <a
                                href={href}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-cyan-300 underline hover:text-cyan-200 break-words"
                              >
                                {children}
                              </a>
                            ),
                            ul: ({ children }: any) => (
                              <ul className="list-disc pl-5 my-1 space-y-0.5">{children}</ul>
                            ),
                            ol: ({ children }: any) => (
                              <ol className="list-decimal pl-5 my-1 space-y-0.5">{children}</ol>
                            ),
                            p: ({ children }: any) => <p className="my-1 first:mt-0 last:mb-0">{children}</p>,
                            h1: ({ children }: any) => <h3 className="text-base font-semibold my-1.5">{children}</h3>,
                            h2: ({ children }: any) => <h4 className="text-sm font-semibold my-1.5">{children}</h4>,
                            h3: ({ children }: any) => <h5 className="text-sm font-medium my-1">{children}</h5>,
                            blockquote: ({ children }: any) => (
                              <blockquote className="border-l-2 border-cyan-400/40 pl-3 italic text-slate-300 my-1">
                                {children}
                              </blockquote>
                            ),
                            table: ({ children }: any) => (
                              <div className="overflow-x-auto my-2">
                                <table className="min-w-full text-xs border border-white/10">{children}</table>
                              </div>
                            ),
                            th: ({ children }: any) => (
                              <th className="border border-white/10 px-2 py-1 bg-white/5 text-left">{children}</th>
                            ),
                            td: ({ children }: any) => (
                              <td className="border border-white/10 px-2 py-1">{children}</td>
                            ),
                          }}
                        >
                          {msg.text}
                        </ReactMarkdown>
                      )}
                    </div>
                    {/* Typing caret while this bubble is still streaming */}
                    {streaming && (
                      <span className="inline-block w-[7px] h-[14px] ml-0.5 align-middle bg-cyan-300 animate-pulse rounded-sm" />
                    )}
                  </div>
                  {/* Timestamp */}
                  <span className="text-[9px] font-mono text-slate-500 mt-0.5 px-1">
                    {fmtTime(msg.timestamp)}
                  </span>
                </motion.div>
              );
            })}
          </AnimatePresence>
        )}
        {/* Typing indicator when streaming but no model bubble yet */}
        {isStreaming &&
          (messages.length === 0 || messages[messages.length - 1].role === "user") && (
            <div className="flex items-center gap-1.5 mr-8 text-slate-400 text-xs">
              <span className="flex gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-bounce [animation-delay:-0.3s]" />
                <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-bounce [animation-delay:-0.15s]" />
                <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-bounce" />
              </span>
              <span className="font-mono uppercase tracking-wider text-[9px]">
                {assistantName} is typing…
              </span>
            </div>
          )}
      </div>

      <div className="flex gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          placeholder={`Ask ${assistantName} anything...`}
          className="flex-1 bg-white/5 border border-white/20 rounded-lg px-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
        />
        <button
          onClick={handleSend}
          className="px-6 py-2 bg-blue-500 hover:bg-blue-600 rounded-lg transition-all transform hover:scale-105 flex items-center gap-1.5 cursor-pointer"
        >
          <Send size={14} /> Send
        </button>
      </div>
    </motion.div>
  );
};
