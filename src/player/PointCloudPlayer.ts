import { PCVStreamDecoder } from "../decoder/PCVStreamDecoder";
import { createRenderer } from "../renderer/createRenderer";
import type { PointRenderer } from "../renderer/PointRenderer";
import type { RenderMode } from "../renderer/WebGLPointRenderer";
import type { PCVAudio } from "../../shared/format";

export type PointCloudPlayerOptions = {
  canvas: HTMLCanvasElement;
  src: string;
  loop?: boolean;
  fps?: number;
};

export type PlayerStats = {
  loadedFrames: number;
  totalFrames: number;
  fps: number;
  displayFps: number;
  particleCount: number;
  progress: number;
  playing: boolean;
  currentFrame: number;
  currentTime: number;
  duration: number;
  volume: number;
  mediaWidth: number;
  mediaHeight: number;
};

type StatsListener = (stats: PlayerStats) => void;

export class PointCloudPlayer {
  private readonly decoder = new PCVStreamDecoder();
  private renderer: PointRenderer | null = null;
  private readonly statsListeners = new Set<StatsListener>();
  private animationHandle = 0;
  private lastTime = 0;
  private displayFrameCounter = 0;
  private displayFpsLastTime = 0;
  private displayFps = 0;
  private currentFrame = 0;
  private playing = false;
  private fpsOverride: number | null;
  private volumeValue = 1;
  private audioContext: AudioContext | null = null;
  private audioGain: GainNode | null = null;
  private audioSource: AudioBufferSourceNode | null = null;
  private audioStartedAt = 0;
  loop: boolean;

  constructor(private readonly options: PointCloudPlayerOptions) {
    this.loop = options.loop ?? true;
    this.fpsOverride = options.fps ?? null;

    void createRenderer(options.canvas).then((renderer) => {
      this.renderer = renderer;
      if (this.decoder.getHeader() && this.decoder.getFrameCount() > 0) {
        const header = this.decoder.getHeader()!;
        this.renderer.setSourceSize(header.width, header.height);
        const frame = this.decoder.getFrame(this.currentFrame);
        if (frame) this.renderer.render(frame);
      }
    });

    this.decoder.subscribe((state) => {
      if (state.header && state.frames.length > 0 && !this.playing) {
        this.renderer?.setSourceSize(state.header.width, state.header.height);
        const frame = state.frames[Math.min(this.currentFrame, state.frames.length - 1)];
        if (frame) this.renderer?.render(frame);
      } else {
        this.renderer?.clear();
      }
      if (this.playing && state.audio && !this.audioSource) {
        void this.startAudio();
      }
      this.emitStats();
    });
    void this.decoder.load(options.src);
  }

  onStats(listener: StatsListener): () => void {
    this.statsListeners.add(listener);
    listener(this.getStats());
    return () => this.statsListeners.delete(listener);
  }

  play(): void {
    if (this.playing) return;
    this.playing = true;
    this.lastTime = performance.now();
    this.displayFpsLastTime = this.lastTime;
    void this.startAudio();
    this.tick(this.lastTime);
    this.emitStats();
  }

  pause(): void {
    this.playing = false;
    cancelAnimationFrame(this.animationHandle);
    this.stopAudio();
    this.emitStats();
  }

  stop(): void {
    this.pause();
    this.seek(0);
  }

  seek(frameOrRatio: number): void {
    const total = this.getTotalFrames();
    const frame = frameOrRatio <= 1 ? Math.round(frameOrRatio * Math.max(0, total - 1)) : Math.round(frameOrRatio);
    this.currentFrame = clamp(frame, 0, Math.max(0, total - 1));
    const decoded = this.decoder.getFrame(this.currentFrame);
    if (decoded) this.renderer?.render(decoded);
    if (this.playing) void this.startAudio();
    this.emitStats();
  }

  setFps(fps: number | null): void {
    this.fpsOverride = fps && fps > 0 ? fps : null;
    this.emitStats();
  }

  setRenderMode(mode: RenderMode): void {
    this.renderer?.setMode(mode);
    const decoded = this.decoder.getFrame(this.currentFrame);
    if (decoded) this.renderer?.render(decoded);
  }

  setPointSize(size: number): void {
    this.renderer?.setPointSize(size);
    const decoded = this.decoder.getFrame(this.currentFrame);
    if (decoded) this.renderer?.render(decoded);
  }

  setVolume(volume: number): void {
    this.volumeValue = clamp(volume, 0, 1);
    if (this.audioGain) this.audioGain.gain.value = this.volumeValue;
  }

  get volume(): number {
    return this.volumeValue;
  }

  getCurrentTime(): number {
    const fps = this.fpsOverride ?? this.decoder.getHeader()?.fps ?? 24;
    return this.currentFrame / fps;
  }

  getDuration(): number {
    const header = this.decoder.getHeader();
    const fps = this.fpsOverride ?? header?.fps ?? 24;
    return header ? header.frameCount / fps : 0;
  }

  destroy(): void {
    this.pause();
    void this.audioContext?.close();
    this.statsListeners.clear();
  }

  private tick = (now: number): void => {
    if (!this.playing) return;

    const header = this.decoder.getHeader();
    const fps = this.fpsOverride ?? header?.fps ?? 24;
    const frameDuration = 1000 / fps;
    if (header) this.renderer?.setSourceSize(header.width, header.height);

    if (now - this.lastTime >= frameDuration) {
      const loadedFrames = this.decoder.getFrameCount();
      const nextFrame = this.currentFrame + 1;

      if (nextFrame < loadedFrames) {
        this.currentFrame = nextFrame;
      } else if (header && this.currentFrame >= header.frameCount - 1 && this.loop) {
        this.currentFrame = 0;
        void this.startAudio();
      } else if (!this.loop && header && this.currentFrame >= header.frameCount - 1) {
        this.pause();
        return;
      }

      const frame = this.decoder.getFrame(this.currentFrame);
      if (frame) {
        this.renderer?.render(frame);
        this.displayFrameCounter += 1;
      }

      this.lastTime = now;
      this.emitStats();
    }

    if (now - this.displayFpsLastTime >= 1000) {
      this.displayFps = this.displayFrameCounter;
      this.displayFrameCounter = 0;
      this.displayFpsLastTime = now;
    }

    this.animationHandle = requestAnimationFrame(this.tick);
  };

  private getStats(): PlayerStats {
    const header = this.decoder.getHeader();
    const frame = this.decoder.getFrame(this.currentFrame);
    return {
      loadedFrames: this.decoder.getFrameCount(),
      totalFrames: header?.frameCount ?? 0,
      fps: this.fpsOverride ?? header?.fps ?? 24,
      displayFps: this.displayFps,
      particleCount: frame?.particleCount ?? header?.particleCount ?? 0,
      progress: this.getProgress(),
      playing: this.playing,
      currentFrame: this.currentFrame,
      currentTime: this.getCurrentTime(),
      duration: this.getDuration(),
      volume: this.volumeValue,
      mediaWidth: header?.width ?? 16,
      mediaHeight: header?.height ?? 9
    };
  }

  private getProgress(): number {
    return this.decoder.getProgress();
  }

  private getTotalFrames(): number {
    return this.decoder.getHeader()?.frameCount ?? this.decoder.getFrameCount();
  }

  private emitStats(): void {
    const stats = this.getStats();
    for (const listener of this.statsListeners) listener(stats);
  }

  private async startAudio(): Promise<void> {
    const audio = this.decoder.getAudio();
    if (!audio) return;

    if (!this.audioContext) {
      this.audioContext = new AudioContext({ sampleRate: audio.sampleRate });
      this.audioGain = this.audioContext.createGain();
      this.audioGain.connect(this.audioContext.destination);
    }

    await this.audioContext.resume();
    this.stopAudio();

    const buffer = this.createAudioBuffer(audio);
    const source = this.audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(this.audioGain ?? this.audioContext.destination);
    source.onended = () => {
      if (this.audioSource === source) {
        this.audioSource.disconnect();
        this.audioSource = null;
      }
    };
    if (this.audioGain) this.audioGain.gain.value = this.volumeValue;

    const startTime = this.currentFrame / (this.fpsOverride ?? this.decoder.getHeader()?.fps ?? 24);
    this.audioStartedAt = this.audioContext.currentTime - startTime;
    source.start(0, Math.min(startTime, buffer.duration));
    this.audioSource = source;
  }

  private stopAudio(): void {
    if (!this.audioSource) return;
    const source = this.audioSource;
    this.audioSource = null;
    source.onended = null;
    try {
      source.stop();
    } catch {
      // Source may already be stopped by the Web Audio graph.
    }
    source.disconnect();
  }

  private createAudioBuffer(audio: PCVAudio): AudioBuffer {
    const context = this.audioContext;
    if (!context) throw new Error("AudioContext is not initialized.");

    const buffer = context.createBuffer(audio.channels, audio.frameCount, audio.sampleRate);
    for (let channel = 0; channel < audio.channels; channel += 1) {
      const output = buffer.getChannelData(channel);
      for (let frame = 0; frame < audio.frameCount; frame += 1) {
        output[frame] = audio.pcm[frame * audio.channels + channel] / 32768;
      }
    }
    return buffer;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
