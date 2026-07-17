import React, { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Sparkles, Brain, Radio, Heart } from 'lucide-react';

export type MyraaEmotion =
  | 'idle'
  | 'playful'
  | 'happy'
  | 'excited'
  | 'curious'
  | 'thinking'
  | 'proud'
  | 'sad'
  | 'surprised'
  | 'embarrassed'
  | 'confused'
  | 'angry';

interface MyraaCoreVisualizerProps {
  state: 'disconnected' | 'connecting' | 'connected' | 'listening' | 'speaking';
  themeColor: string;
  activeEmotion: MyraaEmotion;
  characterState: 'idle' | 'thinking' | 'talking';
}

// All emotion video assets served from the /assets route.
const EMOTION_VIDEOS: Record<string, string> = {
  talking: 'assets/Talking.mp4',
  thinking: 'assets/Thinking.mp4',
  happy: 'assets/Happy.mp4',
  playful: 'assets/Happy.mp4',
  excited: 'assets/Excited.mp4',
  proud: 'assets/Excited.mp4',
  surprised: 'assets/Excited.mp4',
  angry: 'assets/Angry.mp4',
  sad: 'assets/Sad.mp4',
  embarrassed: 'assets/Sad.mp4',
  confused: 'assets/Thinking.mp4',
  curious: 'assets/Thinking.mp4',
  idle: 'assets/Waiting.mp4',
};

export const MyraaCoreVisualizer: React.FC<MyraaCoreVisualizerProps> = ({
  state,
  themeColor,
  activeEmotion,
  characterState,
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [videoError, setVideoError] = useState<string | null>(null);

  // Resolve the current video path from emotion/character state.
  const getVideoPath = () => {
    if (characterState === 'talking') return EMOTION_VIDEOS.talking;
    if (characterState === 'thinking') return EMOTION_VIDEOS.thinking;
    return EMOTION_VIDEOS[activeEmotion] || EMOTION_VIDEOS.idle;
  };

  const videoPath = getVideoPath();

  // Seamless video swap: reload + play whenever the target path changes.
  useEffect(() => {
    if (videoRef.current) {
      setVideoError(null);
      // Reset to start and reload
      videoRef.current.pause();
      videoRef.current.currentTime = 0;
      videoRef.current.load();
      videoRef.current.play().catch(() => {
        // Autoplay blocked or video not found — will trigger onError
      });
    }
  }, [videoPath]);

  // Fallback Kaomoji when a video file is missing.
  const kaomojiFallback = () => {
    if (characterState === 'talking') return '(๑•̀ㅂ•́)و✧';
    if (characterState === 'thinking') return '(・_・;)';
    switch (activeEmotion) {
      case 'happy':
        return '(❁´◡`❁)';
      case 'playful':
        return '(๑>◡<๑)';
      case 'excited':
        return '(≧▽≦)☆';
      case 'sad':
        return '(｡•́︿•̀｡)';
      case 'angry':
        return '(╬◣д◢)';
      case 'thinking':
        return '(・_・;)';
      default:
        return '(*^^*)';
    }
  };

  return (
    <div className="relative w-full h-full flex flex-col items-center justify-center overflow-hidden">
      <AnimatePresence mode="wait">
        {state === 'disconnected' ? (
          <motion.div
            key="offline-stage"
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 1.1 }}
            transition={{ duration: 0.6 }}
            className="relative flex flex-col items-center"
          >
            <div className="w-24 h-24 rounded-full bg-white/5 border border-white/10 flex items-center justify-center text-slate-500 shadow-inner relative group cursor-pointer backdrop-blur-md">
              <Heart
                size={32}
                className="text-slate-600 group-hover:text-rose-500/70 transition-colors duration-500"
              />
              <div className="absolute inset-0 rounded-full bg-slate-500/5 animate-ping opacity-30" />
            </div>
            <p className="mt-6 font-mono text-xs text-slate-500 tracking-[0.3em] font-medium uppercase">
              SYSTEM STANDBY
            </p>
          </motion.div>
        ) : (
          <motion.div
            key="active-stage"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 1.05 }}
            transition={{ duration: 0.5, ease: 'easeOut' }}
            className="relative flex flex-col items-center justify-center w-full h-full"
          >
            <div className="relative w-full h-full flex items-center justify-center">
              {videoError ? (
                // Graceful kaomoji fallback when video is missing/unavailable
                <div className="flex flex-col items-center justify-center h-48 w-48 rounded-full border border-white/10 bg-white/5 backdrop-blur-xl shadow-2xl">
                  <div className="font-mono text-2xl font-bold tracking-tight text-indigo-400">
                    {kaomojiFallback()}
                  </div>
                  <span className="text-[8px] font-mono text-slate-500 uppercase tracking-widest mt-3">
                    [{activeEmotion}]
                  </span>
                </div>
              ) : (
                <video
                  ref={videoRef}
                  className="w-full h-full object-cover select-none pointer-events-none"
                  autoPlay
                  loop
                  muted
                  playsInline
                  onError={() => setVideoError(activeEmotion)}
                >
                  <source src={videoPath} type="video/mp4" />
                </video>
              )}
            </div>

            {/* Status indicator */}
            <div className="mt-4 flex flex-col items-center z-10 pointer-events-none">
              <div className="flex items-center gap-1.5 px-3 py-1 rounded-full border border-white/5 bg-slate-950/60 backdrop-blur-md">
                <span className="relative flex h-1.5 w-1.5">
                  {characterState === 'talking' ? (
                    <>
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-cyan-400"></span>
                    </>
                  ) : characterState === 'thinking' ? (
                    <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-purple-400 animate-pulse"></span>
                  ) : (
                    <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-slate-500 animate-pulse"></span>
                  )}
                </span>
                <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-slate-400 font-semibold">
                  {characterState === 'talking'
                    ? 'Speaking'
                    : characterState === 'thinking'
                      ? 'Thinking'
                      : 'Listening'}
                </span>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
