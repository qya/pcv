import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Link } from "react-router-dom";
import { PointCloudPlayer, type PlayerStats } from "../player/PointCloudPlayer";
import type { RenderMode } from "../renderer/WebGLPointRenderer";
import { createSamplePCVUrl } from "./createSamplePCV";
import { PlayerControls } from "./PlayerControls";
import { AppLogo } from "./AppLogo";

const initialStats: PlayerStats = {
  loadedFrames: 0,
  totalFrames: 0,
  fps: 24,
  displayFps: 0,
  particleCount: 0,
  progress: 0,
  playing: false,
  currentFrame: 0,
  currentTime: 0,
  duration: 0,
  volume: 1,
  mediaWidth: 16,
  mediaHeight: 9
};

type AppLog = {
  timestamp: string;
  level: "info" | "player" | "system" | "success" | "error";
  message: string;
  details?: string;
};

export function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<PointCloudPlayer | null>(null);
  const [stats, setStats] = useState(initialStats);
  const [mode, setMode] = useState<RenderMode>("normal");
  const [pointSize, setPointSize] = useState(3);
  const [fps, setFps] = useState(30);
  const [loop, setLoop] = useState(true);
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string>("Sample Video");

  // Log state
  const [logs, setLogs] = useState<AppLog[]>([
    { timestamp: new Date().toLocaleTimeString(), level: "system", message: "System initialized. PCV Player Engine ready." }
  ]);
  const [filter, setFilter] = useState<"all" | "info" | "player" | "system">("all");
  const logEndRef = useRef<HTMLDivElement | null>(null);

  const addLog = (level: AppLog["level"], message: string, details?: string) => {
    setLogs((prev) => [
      ...prev,
      { timestamp: new Date().toLocaleTimeString(), level, message, details }
    ].slice(-80)); // limit log count
  };

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  // Load initial sample
  useEffect(() => {
    const sampleUrl = createSamplePCVUrl();
    setSourceUrl(sampleUrl);
    setFileName("Sample Video");
    addLog("system", "Loading initial sample point cloud stream...");

    return () => {
      URL.revokeObjectURL(sampleUrl);
    };
  }, []);

  // Re-create player when sourceUrl changes
  useEffect(() => {
    if (!canvasRef.current || !sourceUrl) return;

    addLog("system", `Spawning new PointCloudPlayer instance`, `Source: ${sourceUrl}`);
    const player = new PointCloudPlayer({
      canvas: canvasRef.current,
      src: sourceUrl,
      loop: loop
    });

    playerRef.current = player;
    player.setRenderMode(mode);
    player.setPointSize(pointSize);
    player.setFps(fps);

    const unsubscribe = player.onStats((newStats) => {
      setStats(newStats);
    });
    player.play();

    addLog("success", "Player pipeline successfully mounted and active");

    return () => {
      addLog("system", "Destroying current PointCloudPlayer instance");
      unsubscribe();
      player.destroy();
    };
  }, [sourceUrl]);

  // Watch playback state change
  const prevPlayingRef = useRef(false);
  useEffect(() => {
    if (stats.playing !== prevPlayingRef.current) {
      addLog("player", stats.playing ? "Playback resume signal received" : "Playback pause signal received");
      prevPlayingRef.current = stats.playing;
    }
  }, [stats.playing]);

  function updateMode(nextMode: RenderMode) {
    setMode(nextMode);
    playerRef.current?.setRenderMode(nextMode);
    addLog("player", `Render mode changed to: ${nextMode.toUpperCase()}`);
  }

  function updatePointSize(nextSize: number) {
    setPointSize(nextSize);
    playerRef.current?.setPointSize(nextSize);
    addLog("player", `Particle size adjusted: ${nextSize}px`);
  }

  function updateFps(nextFps: number) {
    setFps(nextFps);
    playerRef.current?.setFps(nextFps);
    addLog("player", `Speed limit adjusted: ${nextFps} FPS`);
  }

  function updateLoop(nextLoop: boolean) {
    setLoop(nextLoop);
    if (playerRef.current) {
      playerRef.current.loop = nextLoop;
    }
    addLog("player", `Loop mode toggled: ${nextLoop ? "ON" : "OFF"}`);
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    addLog("system", `Opening local file: ${file.name}`, `Size: ${(file.size / 1024 / 1024).toFixed(2)} MB`);

    if (sourceUrl && sourceUrl !== "Sample Video") {
      URL.revokeObjectURL(sourceUrl);
    }

    const objectUrl = URL.createObjectURL(file);
    setFileName(file.name);
    setSourceUrl(objectUrl);
  };

  const clearLogs = () => {
    setLogs([]);
  };

  const copyLogs = () => {
    const text = logs.map(l => `[${l.timestamp}] [${l.level.toUpperCase()}] ${l.message} ${l.details ? `(${l.details})` : ""}`).join("\n");
    navigator.clipboard.writeText(text);
    addLog("info", "Logs copied to system clipboard");
  };

  const filteredLogs = logs.filter(log => {
    if (filter === "all") return true;
    if (filter === "info" && (log.level === "info" || log.level === "success")) return true;
    return log.level === filter;
  });

  return (
    <main className="min-h-screen bg-[#080b10] text-slate-100 font-sans">
      <div className="mx-auto flex min-h-screen w-full max-w-7xl flex-col gap-6 px-5 py-6">
        
        {/* Header Block */}
        <header className="flex flex-col gap-4 border-b border-white/10 pb-5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="flex items-center gap-3">
              <AppLogo size={36} className="rounded-lg shadow-lg shadow-cyan-500/10" />
              <h1 className="text-2xl font-bold tracking-tight bg-gradient-to-r from-white via-slate-200 to-slate-400 bg-clip-text text-transparent">
                Point Cloud Video Playground
              </h1>
            </div>
            <p className="mt-1 text-sm text-slate-400 font-medium">
              Compressed PCV streams parsed via typed arrays and rendered inside custom WebGL2 context.
            </p>
          </div>
          <div className="flex items-center gap-6">
            <Link className="text-xs font-semibold uppercase tracking-widest text-cyan-400 hover:text-cyan-300 hover:underline transition-all" to="/converter">
              Converter →
            </Link>
          </div>
        </header>

        {/* Dashboard Panels */}
        <section className="grid flex-1 gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
          
          {/* Main Stage (Player & Overlay Controls) */}
          <div className="flex flex-col gap-4">
            <div ref={shellRef} className="player-shell group overflow-hidden border border-white/10 bg-[#020406] shadow-2xl relative">
              <div
                className="media-stage mx-auto bg-black"
                style={
                  {
                    aspectRatio: `${stats.mediaWidth} / ${stats.mediaHeight}`,
                    "--media-ratio": stats.mediaWidth / stats.mediaHeight,
                    "--stage-max-h": "60vh"
                  } as CSSProperties
                }
              >
                <canvas ref={canvasRef} id="player" className="block h-full w-full pointer-events-none" />
              </div>
              
              <PlayerControls
                player={playerRef.current}
                stats={stats}
                fullscreenTargetRef={shellRef}
                onVolumeChange={(volume) => {
                  setStats((value) => ({ ...value, volume }));
                  addLog("player", `Volume level changed: ${Math.round(volume * 100)}%`);
                }}
                mode={mode}
                onModeChange={updateMode}
                pointSize={pointSize}
                onPointSizeChange={updatePointSize}
                fps={fps}
                onFpsChange={updateFps}
                loop={loop}
                onLoopChange={updateLoop}
              />
            </div>

            {/* Quick Metrics Bar below Player */}
            <div className="grid grid-cols-4 gap-4 bg-[#0e141e] border border-white/10 p-4 rounded-xl font-mono text-xs text-slate-300">
              <Metric label="DISPLAY FPS" value={stats.displayFps || stats.fps} />
              <Metric label="PARTICLES" value={stats.particleCount.toLocaleString()} />
              <Metric label="FRAMES" value={`${stats.currentFrame} / ${stats.totalFrames || "..."}`} />
              <Metric label="PROGRESS" value={`${Math.round(stats.progress * 100)}%`} />
            </div>
          </div>

          {/* Right Sidebar (Source, Import, Developer Console) */}
          <aside className="flex flex-col gap-5">
            
            {/* Active Source Card */}
            <div className="bg-[#0e141e] border border-white/10 p-4 rounded-xl">
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Active Source</div>
              <div className="text-sm font-semibold text-cyan-400 font-mono truncate mt-1.5" title={fileName}>
                {fileName}
              </div>
            </div>

            {/* Drag & Drop Upload */}
            <div className="border border-dashed border-white/20 hover:border-cyan-500/50 rounded-xl p-4 transition-all text-center relative cursor-pointer bg-[#0e141e]/50 hover:bg-[#0e141e] group">
              <input
                type="file"
                accept=".pcv"
                onChange={handleFileChange}
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
              />
              <div className="text-xs text-slate-400">
                <svg className="w-6 h-6 mx-auto mb-1 text-slate-500 group-hover:text-cyan-400 transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                </svg>
                <p className="font-semibold text-slate-200">Import Local PCV File</p>
                <p className="mt-0.5 text-[11px] text-slate-500">Drag & drop or click to upload</p>
              </div>
            </div>

            {/* Player Configurations */}
            <div className="bg-[#0e141e] border border-white/10 p-4 rounded-xl flex flex-col gap-3.5">
              <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Playback Configurations</div>
              
              <div className="grid grid-cols-2 gap-2">
                <button className="control text-xs py-1.5" onClick={() => playerRef.current?.stop()}>Stop</button>
                <button className="control text-xs py-1.5" onClick={() => playerRef.current?.seek(0)}>Restart</button>
              </div>

              <label className="field">
                <span>Render mode</span>
                <select value={mode} onChange={(event) => updateMode(event.target.value as RenderMode)}>
                  <option value="normal">Normal</option>
                  <option value="neon">Neon</option>
                  <option value="matrix">Matrix</option>
                  <option value="wireframe">Wireframe</option>
                </select>
              </label>

              <label className="field">
                <span>FPS control: {fps}</span>
                <input
                  type="range"
                  min="12"
                  max="60"
                  step="1"
                  value={fps}
                  onChange={(event) => updateFps(Number(event.target.value))}
                />
              </label>

              <label className="field">
                <span>Particle size: {pointSize}px</span>
                <input
                  type="range"
                  min="1"
                  max="8"
                  step="0.5"
                  value={pointSize}
                  onChange={(event) => updatePointSize(Number(event.target.value))}
                />
              </label>

              <div className="flex items-center justify-between py-1 border-t border-white/5">
                <span className="text-slate-300">Loop playback</span>
                <input
                  type="checkbox"
                  checked={loop}
                  onChange={(event) => updateLoop(event.target.checked)}
                  className="accent-cyan-400 h-4 w-4"
                />
              </div>
            </div>
          </aside>
        </section>

        {/* Developer Log Console */}
        <div className="flex flex-col border border-white/10 bg-[#0a0d14] rounded-xl overflow-hidden min-h-[200px]">
          <div className="flex items-center justify-between bg-[#0e1420] px-4 py-2 border-b border-white/10">
            <div className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full bg-red-500/80"></span>
              <span className="h-2.5 w-2.5 rounded-full bg-yellow-500/80"></span>
              <span className="h-2.5 w-2.5 rounded-full bg-green-500/80"></span>
              <span className="text-[10px] font-bold text-slate-400 font-mono ml-1.5">CONSOLE LOGS</span>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={clearLogs} className="text-[10px] font-semibold text-slate-500 hover:text-slate-300 transition-colors">Clear</button>
              <span className="text-slate-700">|</span>
              <button onClick={copyLogs} className="text-[10px] font-semibold text-slate-500 hover:text-slate-300 transition-colors">Copy</button>
            </div>
          </div>
          
          {/* Filters */}
          <div className="flex items-center gap-1.5 px-3 py-1.5 bg-[#080b10] border-b border-white/5 overflow-x-auto">
            {(["all", "info", "player", "system"] as const).map(f => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`px-2 py-0.5 rounded text-[9px] font-mono capitalize transition-all ${
                  filter === f
                    ? "bg-cyan-500/10 text-cyan-400 border border-cyan-500/30"
                    : "text-slate-500 hover:text-slate-300 border border-transparent"
                }`}
              >
                {f}
              </button>
            ))}
          </div>

          {/* Logs area */}
          <div className="flex-1 overflow-y-auto p-3 font-mono text-[10px] space-y-2 max-h-[200px] min-h-[150px] bg-[#07090e]">
            {filteredLogs.length === 0 ? (
              <div className="text-slate-600 italic">No console logs recorded. Engage player actions.</div>
            ) : (
              filteredLogs.map((log, idx) => (
                <div key={idx} className="flex items-start gap-2 leading-relaxed">
                  <span className="text-slate-500 shrink-0 select-none">{log.timestamp}</span>
                  <span className={`log-badge log-badge-${log.level} shrink-0`}>{log.level}</span>
                  <div className="flex-1 min-w-0">
                    <span className="text-slate-300 break-words">{log.message}</span>
                    {log.details && (
                      <pre className="mt-1 p-1 bg-black/40 rounded border border-white/5 text-[9px] text-slate-400 overflow-x-auto whitespace-pre">
                        {log.details}
                      </pre>
                    )}
                  </div>
                </div>
              ))
            )}
            <div ref={logEndRef} />
          </div>
        </div>
      </div>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex flex-col">
      <div className="text-[9px] font-bold tracking-wider text-slate-500 uppercase">{label}</div>
      <div className="text-sm font-semibold text-slate-200 mt-0.5">{value}</div>
    </div>
  );
}
