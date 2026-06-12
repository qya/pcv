import { useRef, useState, useEffect, type CSSProperties } from "react";
import { Link } from "react-router-dom";
import type {
  BrowserConverterDebugEvent,
  BrowserConverterProgress,
  BrowserConverterResult,
  VideoMetadataProbe
} from "../converter/browserPcvConverter";
import { PointCloudPlayer, type PlayerStats } from "../player/PointCloudPlayer";
import { PlayerControls } from "./PlayerControls";

type Quality = "auto" | "160p" | "320p" | "720p" | "1080p" | "custom";
type SizeMode = "small" | "balanced" | "best";
type RenderMode = "normal" | "neon" | "matrix" | "wireframe";

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

type DebugLine = BrowserConverterDebugEvent & {
  at: string;
};

export function ConverterPage() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<PointCloudPlayer | null>(null);
  const resultRef = useRef<BrowserConverterResult | null>(null);
  const probeTokenRef = useRef(0);

  const [file, setFile] = useState<File | null>(null);
  const [width, setWidth] = useState(160);
  const [height, setHeight] = useState(90);
  const [quality, setQuality] = useState<Quality>("auto");
  const [fps, setFps] = useState(15);
  const [maxParticles, setMaxParticles] = useState(15000);
  const [includeAudio, setIncludeAudio] = useState(false);
  const [sizeMode, setSizeMode] = useState<SizeMode>("small");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<BrowserConverterProgress | null>(null);
  const [result, setResult] = useState<BrowserConverterResult | null>(null);
  const [stats, setStats] = useState(initialStats);
  const [error, setError] = useState<string | null>(null);
  const [debugLines, setDebugLines] = useState<DebugLine[]>([]);
  const [probe, setProbe] = useState<VideoMetadataProbe | null>(null);

  // Playback preview configs
  const [renderMode, setRenderMode] = useState<RenderMode>("normal");
  const [pointSize, setPointSize] = useState(3);
  const [loop, setLoop] = useState(true);

  const logContainerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [debugLines]);

  function appendDebug(event: BrowserConverterDebugEvent) {
    setDebugLines((lines) =>
      [
        ...lines,
        {
          ...event,
          at: new Date().toLocaleTimeString()
        }
      ].slice(-80)
    );
  }

  async function handleFile(nextFile: File | null) {
    setFile(nextFile);
    setProbe(null);
    setError(null);
    if (!nextFile) return;

    const token = probeTokenRef.current + 1;
    probeTokenRef.current = token;
    appendDebug({ label: "probe:load-engine", detail: { fileBytes: nextFile.size } });

    try {
      const startedAt = performance.now();
      const { probeVideoMetadata } = await import("../converter/browserPcvConverter");
      const metadata = await probeVideoMetadata(nextFile, quality);
      if (probeTokenRef.current !== token) return;

      setProbe(metadata);
      if (quality === "auto") {
        setWidth(metadata.outputWidth);
        setHeight(metadata.outputHeight);
      }
      appendDebug({
        label: "probe:done",
        elapsedMs: Math.round(performance.now() - startedAt),
        detail: {
          source: `${metadata.sourceWidth}x${metadata.sourceHeight}`,
          output: `${metadata.outputWidth}x${metadata.outputHeight}`,
          duration: metadata.duration ? Number(metadata.duration.toFixed(2)) : 0
        }
      });
    } catch (probeError) {
      if (probeTokenRef.current !== token) return;
      appendDebug({
        label: "probe:error",
        detail: { message: probeError instanceof Error ? probeError.message : "Unknown probe error" }
      });
    }
  }

  async function runConversion() {
    if (!file || !canvasRef.current) return;
    setBusy(true);
    setError(null);
    setProgress(null);
    setResult(null);
    setStats(initialStats);
    playerRef.current?.destroy();
    playerRef.current = null;
    if (resultRef.current) URL.revokeObjectURL(resultRef.current.url);
    
    // Clear canvas WebGL context
    try {
      const gl = canvasRef.current.getContext("webgl2");
      if (gl) {
        gl.clearColor(0.0, 0.0, 0.0, 1.0);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
    } catch (e) {
      console.warn("Failed to clear WebGL context", e);
    }

    try {
      setProgress({
        phase: "reading",
        frame: 0,
        frameCount: 0,
        message: "Loading converter engine"
      });
      const { convertVideoToPcvInBrowser } = await import("../converter/browserPcvConverter");
      const converted = await convertVideoToPcvInBrowser({
        file,
        width,
        height,
        quality,
        fps,
        maxParticles,
        sizeMode,
        includeAudio,
        onProgress: setProgress,
        onDebug: appendDebug
      });
      resultRef.current = converted;
      setResult(converted);

      const player = new PointCloudPlayer({
        canvas: canvasRef.current,
        src: converted.url,
        loop: loop,
        fps: converted.fps
      });
      playerRef.current = player;
      player.setRenderMode(renderMode);
      player.setPointSize(pointSize);
      player.onStats(setStats);
      player.play();
    } catch (conversionError) {
      setError(conversionError instanceof Error ? conversionError.message : "Conversion failed.");
    } finally {
      setBusy(false);
    }
  }

  const stepFrame = (delta: number) => {
    if (!playerRef.current || stats.totalFrames <= 0) return;
    const nextFrame = Math.max(0, Math.min(stats.totalFrames - 1, stats.currentFrame + delta));
    playerRef.current.seek(nextFrame / stats.totalFrames);
  };

  const updateRenderMode = (modeVal: RenderMode) => {
    setRenderMode(modeVal);
    playerRef.current?.setRenderMode(modeVal);
  };

  const updatePointSize = (sizeVal: number) => {
    setPointSize(sizeVal);
    playerRef.current?.setPointSize(sizeVal);
  };

  const progressPercent =
    progress && progress.frameCount > 0 ? Math.round((progress.frame / progress.frameCount) * 100) : 0;

  return (
    <main className="min-h-screen bg-[#080b10] text-slate-100 font-sans pb-10">
      
      {/* 3-Panel Wrapper */}
      <div className="cc-converter-layout">
        
        {/* Header Section */}
        <header className="flex flex-col gap-4 border-b border-white/10 pb-5 sm:flex-row sm:items-center sm:justify-between w-full">
          <div>
            <div className="flex items-center gap-3">
              <span className="flex h-2 w-2 rounded-full bg-emerald-400 animate-pulse"></span>
              <h1 className="text-2xl font-bold tracking-tight bg-gradient-to-r from-white via-slate-200 to-slate-400 bg-clip-text text-transparent">
                Point Cloud Video Converter Suite
              </h1>
            </div>
            <p className="mt-1 text-sm text-slate-400 font-medium">
              Encode standard video streams into lightweight 12-bit / 16-bit keyframed PCV files.
            </p>
          </div>
          <div className="flex items-center gap-6">
            <Link className="text-xs font-semibold uppercase tracking-widest text-cyan-400 hover:text-cyan-300 hover:underline transition-all" to="/">
              ← Back to Playground
            </Link>
          </div>
        </header>

        {/* Top Split Row: Left Controls / Right Preview Monitor */}
        <div className="cc-converter-top">
          
          {/* Panel 1: Left Controls */}
          <aside className="cc-converter-panel">
            <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400 border-b border-white/5 pb-2">
              Conversion Parameters
            </div>

            {/* Source Video Selection */}
            <label className="field">
              <span>Source Video File</span>
              <input
                type="file"
                accept="video/mp4,video/quicktime,video/webm,video/*"
                onChange={(event) => void handleFile(event.target.files?.[0] ?? null)}
              />
            </label>

            {/* Quality Preset */}
            <label className="field">
              <span>Preset Quality</span>
              <select
                value={quality}
                onChange={(event) => {
                  const nextQuality = event.target.value as Quality;
                  setQuality(nextQuality);
                  applyQualityPreset(nextQuality, setWidth, setHeight, setFps);
                  if (nextQuality === "auto" && probe) {
                    setWidth(probe.outputWidth);
                    setHeight(probe.outputHeight);
                  } else if (nextQuality === "auto" && file) {
                    void handleFile(file);
                  }
                }}
              >
                <option value="auto">Auto Probe</option>
                <option value="160p">160p (Default)</option>
                <option value="320p">320p</option>
                <option value="720p">720p</option>
                <option value="1080p">1080p</option>
                <option value="custom">Custom Dimensions</option>
              </select>
            </label>

            {/* Resolution Settings */}
            <div className="grid grid-cols-2 gap-3">
              <label className="field">
                <span>Width</span>
                <input
                  type="number"
                  min="32"
                  max="1920"
                  value={width}
                  onChange={(event) => {
                    setQuality("custom");
                    setWidth(Number(event.target.value));
                  }}
                />
              </label>
              <label className="field">
                <span>Height</span>
                <input
                  type="number"
                  min="32"
                  max="1080"
                  value={height}
                  onChange={(event) => {
                    setQuality("custom");
                    setHeight(Number(event.target.value));
                  }}
                />
              </label>
            </div>

            {/* FPS Settings */}
            <label className="field">
              <span>Target FPS: {fps} FPS</span>
              <input min="6" max="60" type="range" value={fps} onChange={(event) => setFps(Number(event.target.value))} />
            </label>

            {/* Compression Mode */}
            <label className="field">
              <span>Compression Size Mode</span>
              <select value={sizeMode} onChange={(event) => setSizeMode(event.target.value as SizeMode)}>
                <option value="small">Size Saver (12-bit delta)</option>
                <option value="balanced">Balanced</option>
                <option value="best">Best Quality (16-bit keyframes)</option>
              </select>
            </label>

            {/* Audio configuration */}
            <div className="flex items-center justify-between py-1 border-t border-white/5">
              <span className="text-slate-300 text-xs">Include Audio Track</span>
              <input type="checkbox" checked={includeAudio} onChange={(event) => setIncludeAudio(event.target.checked)} className="accent-cyan-400 h-4 w-4" />
            </div>

            {/* Action Buttons */}
            <button className="control border-cyan-400/50 bg-cyan-400/15 py-2.5 font-bold hover:scale-[1.02] active:scale-[0.98] transition-all" disabled={!file || busy} onClick={runConversion}>
              {busy ? "Encoding Stream..." : "Convert to PCV"}
            </button>

            {/* Progress Bar status */}
            {progress && (
              <div className="bg-black/30 border border-white/10 p-3 rounded-lg">
                <div className="h-1.5 overflow-hidden bg-black/60 rounded">
                  <div className="h-full bg-cyan-400 transition-all duration-150" style={{ width: `${progressPercent}%` }} />
                </div>
                <p className="mt-2 font-mono text-[10px] text-cyan-400 font-bold leading-normal">{progress.message} ({progressPercent}%)</p>
              </div>
            )}

            {error && <p className="border border-red-400/30 bg-red-950/20 p-3 text-xs text-red-300 rounded-lg">{error}</p>}

            {/* Downloader card */}
            {result && (
              <div className="flex flex-col gap-2 mt-2 border-t border-white/10 pt-4">
                <div className="text-[10px] uppercase font-bold text-slate-500 tracking-wider">Download Output</div>
                <a 
                  className="flex items-center p-3 bg-gradient-to-r from-emerald-500/15 to-teal-500/10 border border-emerald-500/25 hover:border-emerald-500/50 rounded-xl text-emerald-300 hover:text-emerald-200 transition-all shadow-md group hover:scale-[1.01]" 
                  href={result.url} 
                  download={result.fileName}
                >
                  <svg className="w-5 h-5 mr-3 text-emerald-400 group-hover:scale-110 transition-transform shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                  </svg>
                  <div className="text-left truncate min-w-0">
                    <div className="text-xs font-bold text-slate-200 group-hover:text-white transition-colors">Download PCV Stream</div>
                    <div className="text-[9px] font-mono text-slate-500 truncate mt-0.5" title={result.fileName}>{result.fileName}</div>
                  </div>
                </a>
              </div>
            )}
          </aside>

          {/* Panel 2: Right Preview monitor with probe card at the top */}
          <div className="flex flex-col gap-5 flex-1 min-w-0">
            {probe && (
              <div className="border border-white/10 bg-[#10151d] p-4 font-mono text-[11px] text-slate-400 rounded-xl space-y-1.5 shadow-md">
                <div className="text-[10px] uppercase font-bold text-cyan-400 border-b border-white/5 pb-1 mb-2 tracking-wider">
                  Source Video Metadata Probe
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                  <div>
                    <span className="text-slate-500 block text-[9px] uppercase font-bold">Source Size</span>
                    <span className="text-slate-200 text-xs font-semibold">{probe.sourceWidth} x {probe.sourceHeight}</span>
                  </div>
                  <div>
                    <span className="text-slate-500 block text-[9px] uppercase font-bold">Target Size</span>
                    <span className="text-slate-200 text-xs font-semibold">{probe.outputWidth} x {probe.outputHeight}</span>
                  </div>
                  <div>
                    <span className="text-slate-500 block text-[9px] uppercase font-bold">Duration</span>
                    <span className="text-slate-200 text-xs font-semibold">{probe.duration ? `${probe.duration.toFixed(2)}s` : "N/A"}</span>
                  </div>
                  <div>
                    <span className="text-slate-500 block text-[9px] uppercase font-bold">Est. Memory</span>
                    <span className="text-slate-200 text-xs font-semibold">{probe.estimatedMb ? `${probe.estimatedMb} MB` : "N/A"}</span>
                  </div>
                </div>
              </div>
            )}

            <section className="cc-converter-monitor flex-1 min-h-[480px]">
              <div className="flex items-center justify-between border-b border-white/5 pb-2">
                <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400">Preview Player Monitor</span>
              
              {/* Toolbar configs */}
              <div className="flex items-center gap-3 text-[11px] text-slate-400">
                <select className="bg-black/30 border border-white/10 rounded px-1.5 py-0.5 text-[10px]" value={renderMode} onChange={(e) => updateRenderMode(e.target.value as RenderMode)}>
                  <option value="normal">Normal Mode</option>
                  <option value="neon">Neon Mode</option>
                  <option value="matrix">Matrix Mode</option>
                  <option value="wireframe">Wireframe Mode</option>
                </select>
                <div className="flex items-center gap-1.5 font-mono text-[10px]">
                  <span>Pt Size: {pointSize}px</span>
                  <input type="range" min="1" max="8" step="0.5" value={pointSize} onChange={(e) => updatePointSize(Number(e.target.value))} className="accent-cyan-400 w-16 h-1" />
                </div>
              </div>
            </div>

            {/* Preview shell */}
            <div ref={shellRef} className="player-shell group overflow-hidden border border-white/10 bg-black flex-1 relative">
               {busy ? (
                <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#080b10] z-30">
                  <div className="w-12 h-12 rounded-full border-4 border-cyan-500/20 border-t-cyan-400 animate-spin mb-4"></div>
                  <div className="text-cyan-400 font-mono text-xs font-bold tracking-wider animate-pulse mb-1">
                    ENCODING STREAM: {progressPercent}%
                  </div>
                  <div className="text-[10px] text-slate-500 font-mono animate-pulse">
                    Encoding video keyframes & delta changes...
                  </div>
                </div>
              ) : null}

              <div
                className="media-stage mx-auto bg-black"
                style={
                  {
                    aspectRatio: `${stats.mediaWidth} / ${stats.mediaHeight}`,
                    "--media-ratio": stats.mediaWidth / stats.mediaHeight,
                    "--stage-max-h": "50vh"
                  } as CSSProperties
                }
              >
                <canvas ref={canvasRef} id="converter-preview" className="block h-full w-full pointer-events-none" />
              </div>
              {!busy && (
                <PlayerControls
                  player={playerRef.current}
                  stats={stats}
                  fullscreenTargetRef={shellRef}
                  onVolumeChange={(volume) => setStats((v) => ({ ...v, volume }))}
                />
              )}
            </div>

            {/* Playback monitor toolbar */}
            <div className="flex items-center justify-between bg-black/20 p-3 rounded-lg border border-white/5 font-mono text-[11px]">
              <div className="flex items-center gap-3">
                <button onClick={() => stepFrame(-1)} className="control py-1 px-2.5 text-xs hover:text-cyan-400" title="Step Back (1 Frame)">Prev</button>
                <button onClick={() => stepFrame(1)} className="control py-1 px-2.5 text-xs hover:text-cyan-400" title="Step Forward (1 Frame)">Next</button>
              </div>

              <div className="grid grid-cols-3 gap-5 text-right">
                <Metric label="DRAW FPS" value={stats.displayFps || "..."} />
                <Metric label="PARTICLES" value={stats.particleCount.toLocaleString()} />
                <Metric label="FRAMES" value={`${stats.loadedFrames}/${stats.totalFrames || "..."}`} />
              </div>
            </div>
          </section>
        </div>
      </div>

        {/* Panel 3: Bottom Console Logs info */}
        <div className="cc-converter-bottom">
          <div className="cc-log-panel">
            <div className="flex items-center justify-between bg-[#0e1420] px-4 py-2.5 border-b border-white/10">
              <div className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full bg-red-500/80"></span>
                <span className="h-2.5 w-2.5 rounded-full bg-yellow-500/80"></span>
                <span className="h-2.5 w-2.5 rounded-full bg-green-500/80"></span>
                <span className="text-[10px] font-bold text-slate-400 font-mono ml-1.5">CONVERSION AND ENGINE EVENTS LOGS</span>
              </div>
              <button onClick={() => setDebugLines([])} className="text-[10px] font-semibold text-slate-500 hover:text-slate-300 transition-colors font-mono">Clear Console</button>
            </div>
            
            <div ref={logContainerRef} className="overflow-y-auto p-4 font-mono text-[10px] space-y-2 max-h-[200px] min-h-[150px] bg-[#07090e]">
              {debugLines.length === 0 ? (
                <div className="text-slate-600 italic">No logs yet. Select a file or start conversion to populate events.</div>
              ) : (
                debugLines.map((line, index) => {
                  let level: "info" | "success" | "error" | "system" = "info";
                  if (line.label.toLowerCase().includes("error")) level = "error";
                  else if (line.label.toLowerCase().includes("done") || line.label.toLowerCase().includes("complete")) level = "success";
                  else if (line.label.toLowerCase().includes("probe") || line.label.toLowerCase().includes("load")) level = "system";

                  return (
                    <div key={`${line.at}-${line.label}-${index}`} className="flex items-start gap-2.5 leading-relaxed text-[10px] py-0.5 border-b border-white/5 last:border-b-0 pb-1.5">
                      <span className="text-slate-500 shrink-0 select-none font-mono">{line.at}</span>
                      <span className={`log-badge log-badge-${level} shrink-0`}>{line.label}</span>
                      <div className="flex-1 min-w-0 font-mono">
                        {typeof line.elapsedMs === "number" && (
                          <span className="text-cyan-400 mr-2 font-bold">({line.elapsedMs}ms)</span>
                        )}
                        {line.detail && (
                          <span className="text-slate-300 font-sans text-xs ml-1 leading-normal">
                            {formatLogDetail(line.detail)}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>

      </div>
    </main>
  );
}

function applyQualityPreset(
  quality: Quality,
  setWidth: (value: number) => void,
  setHeight: (value: number) => void,
  _setFps: (value: number) => void
) {
  if (quality === "160p") {
    setWidth(160);
    setHeight(90);
  } else if (quality === "320p") {
    setWidth(320);
    setHeight(180);
  } else if (quality === "720p") {
    setWidth(1280);
    setHeight(720);
  } else if (quality === "1080p") {
    setWidth(1920);
    setHeight(1080);
  }
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex flex-col">
      <div className="text-[9px] font-bold tracking-wider text-slate-500 uppercase">{label}</div>
      <div className="text-slate-200 mt-0.5">{value}</div>
    </div>
  );
}

function formatLogDetail(detail: any): string {
  if (!detail) return "";
  if (typeof detail !== "object") return String(detail);
  
  if (typeof detail.fileBytes === "number") {
    return `File size loaded: ${(detail.fileBytes / 1024 / 1024).toFixed(2)} MB (${detail.fileBytes.toLocaleString()} bytes)`;
  }
  if (detail.source && detail.output) {
    return `Resolution: ${detail.source} ➔ ${detail.output} | Duration: ${detail.duration}s`;
  }
  if (typeof detail.message === "string") {
    return detail.message;
  }
  
  return Object.entries(detail)
    .map(([key, val]) => `${key}: ${typeof val === "object" ? JSON.stringify(val) : val}`)
    .join(" | ");
}
