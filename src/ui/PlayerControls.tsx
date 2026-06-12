import { useEffect, useState, useRef, type RefObject } from "react";
import type { PointCloudPlayer, PlayerStats } from "../player/PointCloudPlayer";

// Render mode type to avoid duplicate imports
type RenderMode = "normal" | "neon" | "matrix" | "wireframe";

type PlayerControlsProps = {
  player: PointCloudPlayer | null;
  stats: PlayerStats;
  fullscreenTargetRef?: RefObject<HTMLElement | null>;
  onVolumeChange?: (volume: number) => void;
  // settings
  mode?: RenderMode;
  onModeChange?: (mode: RenderMode) => void;
  pointSize?: number;
  onPointSizeChange?: (size: number) => void;
  fps?: number;
  onFpsChange?: (fps: number) => void;
  loop?: boolean;
  onLoopChange?: (loop: boolean) => void;
};

export function PlayerControls({
  player,
  stats,
  fullscreenTargetRef,
  onVolumeChange,
  mode,
  onModeChange,
  pointSize,
  onPointSizeChange,
  fps,
  onFpsChange,
  loop,
  onLoopChange
}: PlayerControlsProps) {
  const seekValue = stats.duration > 0 ? Math.round((stats.currentTime / stats.duration) * 1000) : 0;
  const progressPercent = stats.duration > 0 ? (stats.currentTime / stats.duration) * 100 : 0;
  const volume = Math.round(stats.volume * 100);
  
  const [fullscreen, setFullscreen] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const settingsRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const updateFullscreen = () => setFullscreen(document.fullscreenElement === fullscreenTargetRef?.current);
    document.addEventListener("fullscreenchange", updateFullscreen);
    updateFullscreen();
    return () => document.removeEventListener("fullscreenchange", updateFullscreen);
  }, [fullscreenTargetRef]);

  // Click outside to close settings popover
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (settingsRef.current && !settingsRef.current.contains(event.target as Node)) {
        setShowSettings(false);
      }
    }
    if (showSettings) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showSettings]);

  const toggleMute = () => {
    if (!player) return;
    const nextVolume = stats.volume > 0 ? 0 : 0.8;
    player.setVolume(nextVolume);
    onVolumeChange?.(nextVolume);
  };

  return (
    <div className="player-overlay-controls" style={{ "--progress-percent": `${progressPercent}%` } as React.CSSProperties}>
      {/* Time Slider Track (Timeline) */}
      <div className="w-full flex items-center">
        <input
          className="yt-range"
          type="range"
          min="0"
          max="1000"
          value={seekValue}
          onChange={(event) => player?.seek(Number(event.target.value) / 1000)}
        />
      </div>

      {/* Control Buttons Row */}
      <div className="player-controls-row">
        <div className="player-controls-left">
          {/* Play/Pause */}
          <button
            className="yt-control-btn"
            type="button"
            title={stats.playing ? "Pause" : "Play"}
            onClick={() => {
              if (!player) return;
              if (stats.playing) player.pause();
              else player.play();
            }}
          >
            {stats.playing ? (
              <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                <path d="M8 5v14l11-7z" />
              </svg>
            )}
          </button>

          {/* Volume Container */}
          <div className="yt-volume-container">
            <button
              className="yt-control-btn"
              type="button"
              title={stats.volume === 0 ? "Unmute" : "Mute"}
              onClick={toggleMute}
            >
              {stats.volume === 0 ? (
                <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                  <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.21.05-.42.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                  <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z" />
                </svg>
              )}
            </button>
            <div className="yt-volume-slider-wrapper">
              <input
                className="yt-volume-slider"
                type="range"
                min="0"
                max="100"
                value={volume}
                style={{ "--volume-percent": `${volume}%` } as React.CSSProperties}
                onChange={(event) => {
                  const nextVolume = Number(event.target.value) / 100;
                  player?.setVolume(nextVolume);
                  onVolumeChange?.(nextVolume);
                }}
              />
            </div>
          </div>

          {/* Time Display */}
          <div className="yt-time-display font-mono">
            <span>{formatTime(stats.currentTime)}</span>
            <span className="mx-1 text-slate-500">/</span>
            <span>{formatTime(stats.duration)}</span>
          </div>
        </div>

        <div className="player-controls-right">
          {/* Settings / Gear Button */}
          {onModeChange && (
            <div className="relative" ref={settingsRef}>
              <button
                className={`yt-control-btn ${showSettings ? "bg-white/10 opacity-100 rotate-45" : ""}`}
                type="button"
                title="Settings"
                onClick={() => setShowSettings(!showSettings)}
              >
                <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" className="transition-transform duration-300">
                  <path d="M19.43 12.98c.04-.32.07-.64.07-.98s-.03-.66-.07-.98l2.11-1.65c.19-.15.24-.42.12-.64l-2-3.46c-.12-.22-.39-.3-.61-.22l-2.49 1c-.52-.4-1.08-.73-1.69-.98l-.38-2.65C14.46 2.18 14.25 2 14 2h-4c-.25 0-.46.18-.49.42l-.38 2.65c-.61.25-1.17.59-1.69.98l-2.49-1c-.23-.09-.49 0-.61.22l-2 3.46c-.13.22-.07.49.12.64l2.11 1.65c-.04.32-.07.65-.07.98s.03.66.07.98l-2.11 1.65c-.19.15-.24.42-.12.64l2 3.46c.12.22.39.3.61.22l2.49-1c.52.4 1.08.73 1.69.98l.38 2.65c.03.24.24.42.49.42h4c.25 0 .46-.18.49-.42l.38-2.65c.61-.25 1.17-.59 1.69-.98l2.49 1c.23.09.49 0 .61-.22l2-3.46c.12-.22.07-.49-.12-.64l-2.11-1.65zM12 15.5c-1.93 0-3.5-1.57-3.5-3.5s1.57-3.5 3.5-3.5 3.5 1.57 3.5 3.5-1.57 3.5-3.5 3.5z" />
                </svg>
              </button>

              {/* Popover Settings */}
              {showSettings && (
                <div className="yt-settings-popover">
                  <div className="yt-popover-title">Player Settings</div>
                  
                  {/* Mode */}
                  {mode !== undefined && onModeChange && (
                    <div className="yt-popover-item">
                      <label>Render Mode</label>
                      <select
                        className="bg-[#06080c] text-white border border-white/10 rounded px-2 py-1 text-[11px] outline-none"
                        value={mode}
                        onChange={(e) => onModeChange(e.target.value as RenderMode)}
                      >
                        <option value="normal">Normal</option>
                        <option value="neon">Neon Glow</option>
                        <option value="matrix">Matrix Code</option>
                        <option value="wireframe">Wireframe</option>
                      </select>
                    </div>
                  )}

                  {/* Particle Size */}
                  {pointSize !== undefined && onPointSizeChange && (
                    <div className="yt-popover-item">
                      <div className="flex justify-between">
                        <label>Particle Size</label>
                        <span className="text-cyan-400 font-mono text-[10px]">{pointSize}px</span>
                      </div>
                      <input
                        type="range"
                        min="1"
                        max="8"
                        step="0.5"
                        value={pointSize}
                        onChange={(e) => onPointSizeChange(Number(e.target.value))}
                        className="accent-cyan-400 h-1"
                      />
                    </div>
                  )}

                  {/* FPS */}
                  {fps !== undefined && onFpsChange && (
                    <div className="yt-popover-item">
                      <div className="flex justify-between">
                        <label>Target FPS</label>
                        <span className="text-cyan-400 font-mono text-[10px]">{fps}</span>
                      </div>
                      <input
                        type="range"
                        min="12"
                        max="60"
                        step="1"
                        value={fps}
                        onChange={(e) => onFpsChange(Number(e.target.value))}
                        className="accent-cyan-400 h-1"
                      />
                    </div>
                  )}

                  {/* Loop */}
                  {loop !== undefined && onLoopChange && (
                    <div className="flex items-center justify-between text-xs mt-1 border-t border-white/5 pt-2">
                      <span className="text-slate-300">Loop Playback</span>
                      <input
                        type="checkbox"
                        checked={loop}
                        onChange={(e) => onLoopChange(e.target.checked)}
                        className="accent-cyan-400 rounded h-3.5 w-3.5"
                      />
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Fullscreen */}
          <button
            className="yt-control-btn"
            type="button"
            title={fullscreen ? "Exit Fullscreen" : "Fullscreen"}
            onClick={() => void toggleFullscreen(fullscreenTargetRef?.current)}
          >
            {fullscreen ? (
              <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                <path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z" />
              </svg>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

async function toggleFullscreen(target: HTMLElement | null | undefined): Promise<void> {
  if (!target) return;
  if (document.fullscreenElement) {
    await document.exitFullscreen();
    return;
  }
  await target.requestFullscreen();
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const minutes = Math.floor(seconds / 60);
  const remaining = Math.floor(seconds % 60);
  return `${minutes}:${remaining.toString().padStart(2, "0")}`;
}
