import { spawn, spawnSync, execSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdtempSync, unlinkSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { ALL_FORMATS, FilePathSource, Input } from "mediabunny";
import {
  encodeFrame,
  PCV_FLAG_PCM_AUDIO,
  PCV_FLAG_TEXTURE_RGB565_DELTA,
  PCV_FLAG_ZSTD,
  PCV_HEADER_SIZE,
  type PCVHeader,
  writeHeader
} from "../shared/format";
import { encodeTextureFrame, rgbaToRgb565 } from "../src/converter/textureCodec";

type Quality = "auto" | "160p" | "320p" | "720p" | "1080p" | "custom";
type SizeMode = "small" | "balanced" | "best";

type Options = {
  input: string;
  output: string;
  width: number;
  height: number;
  fps: number;
  quality: Quality;
  sizeMode: SizeMode;
  audio: boolean;
  gpu: boolean | string;
  maxFrames: number | null;
};

type CompressionLevel = number;

type SourceInfo = {
  width: number;
  height: number;
  duration?: number;
  frameCount?: number;
  codec?: string;
  canDecodeWithMediaBunny?: boolean;
  metadataSource: "mediabunny" | "ffprobe" | "combined";
};

type OutputSize = {
  width: number;
  height: number;
};

function parseArgs(argv: string[]): Options {
  const args = [...argv];
  const input = args.shift();
  const output = args.shift();

  if (!input || !output) {
    throw new Error(
      "Usage: npm run convert -- input.mp4 output.pcv --quality auto --size-mode best --fps 24 --audio --gpu --max-frames 300"
    );
  }

  const options: Options = {
    input: resolve(input),
    output: resolve(output),
    width: 320,
    height: 180,
    fps: 15,
    quality: "auto",
    sizeMode: "small",
    audio: false,
    gpu: false,
    maxFrames: null
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = args[index + 1];

    if (arg === "--size" && value) {
      const [width, height] = value.split("x").map(Number);
      if (!Number.isFinite(width) || !Number.isFinite(height)) {
        throw new Error("--size must use WIDTHxHEIGHT, for example 320x180.");
      }
      options.width = width;
      options.height = height;
      options.quality = "custom";
      index += 1;
    } else if (arg === "--quality" && value) {
      if (!["auto", "160p", "320p", "720p", "1080p", "custom"].includes(value)) {
        throw new Error("--quality must be auto, 160p, 320p, 720p, 1080p, or custom.");
      }
      options.quality = value as Quality;
      index += 1;
    } else if (arg === "--size-mode" && value) {
      if (!["small", "balanced", "best"].includes(value)) {
        throw new Error("--size-mode must be small, balanced, or best.");
      }
      options.sizeMode = value as SizeMode;
      index += 1;
    } else if (arg === "--fps" && value) {
      options.fps = Number(value);
      index += 1;
    } else if (arg === "--audio") {
      options.audio = true;
    } else if (arg === "--no-audio") {
      options.audio = false;
    } else if (arg === "--gpu") {
      if (value && !value.startsWith("-")) {
        options.gpu = value;
        index += 1;
      } else {
        options.gpu = "auto";
      }
    } else if (arg === "--max-frames" && value) {
      const maxFrames = Number(value);
      if (!Number.isInteger(maxFrames) || maxFrames <= 0) {
        throw new Error("--max-frames must be a positive integer.");
      }
      options.maxFrames = maxFrames;
      index += 1;
    } else {
      throw new Error(`Unknown converter option: ${arg}`);
    }
  }

  return options;
}

async function getMediaBunnySourceInfo(inputPath: string): Promise<SourceInfo | null> {
  const input = new Input({
    source: new FilePathSource(inputPath),
    formats: ALL_FORMATS
  });

  try {
    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) return null;

    const duration = await videoTrack.getDurationFromMetadata();
    const codec = await videoTrack.getCodecParameterString();
    return {
      width: await videoTrack.getDisplayWidth(),
      height: await videoTrack.getDisplayHeight(),
      duration: duration ?? undefined,
      codec: codec ?? undefined,
      canDecodeWithMediaBunny: await videoTrack.canDecode(),
      metadataSource: "mediabunny"
    };
  } finally {
    input.dispose();
  }
}

function getFfprobeSourceInfo(input: string): SourceInfo {
  const result = spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height,duration,nb_frames",
      "-of",
      "json",
      input
    ],
    { encoding: "utf8" }
  );

  if (result.status !== 0) {
    throw new Error("FFprobe failed to read source dimensions and metadata.");
  }

  const data = JSON.parse(result.stdout);
  const stream = data.streams?.[0];
  if (!stream) {
    throw new Error("FFprobe found no video stream in the source file.");
  }

  const width = Number(stream.width);
  const height = Number(stream.height);
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    throw new Error("FFprobe returned invalid source dimensions.");
  }

  const duration = stream.duration ? Number(stream.duration) : undefined;
  const frameCount = stream.nb_frames ? Number(stream.nb_frames) : undefined;

  return { width, height, duration, frameCount, metadataSource: "ffprobe" };
}

async function getSourceInfo(input: string): Promise<SourceInfo> {
  let mediaBunnyInfo: SourceInfo | null = null;
  let mediaBunnyError: unknown = null;

  try {
    mediaBunnyInfo = await getMediaBunnySourceInfo(input);
  } catch (err) {
    mediaBunnyError = err;
  }

  let ffprobeInfo: SourceInfo | null = null;
  let ffprobeError: unknown = null;
  try {
    ffprobeInfo = getFfprobeSourceInfo(input);
  } catch (err) {
    ffprobeError = err;
  }

  if (!mediaBunnyInfo && !ffprobeInfo) {
    throw new Error(
      `Unable to read source metadata. MediaBunny: ${formatError(mediaBunnyError)} FFprobe: ${formatError(ffprobeError)}`
    );
  }

  if (!mediaBunnyInfo) return ffprobeInfo!;
  if (!ffprobeInfo) return mediaBunnyInfo;

  return {
    ...mediaBunnyInfo,
    duration: mediaBunnyInfo.duration ?? ffprobeInfo.duration,
    frameCount: ffprobeInfo.frameCount ?? mediaBunnyInfo.frameCount,
    metadataSource: "combined"
  };
}

function resolveOutputSize(options: Options, source: SourceInfo): OutputSize {
  if (options.quality === "custom") return evenSize(options.width, options.height);

  const maxHeight = options.quality === "auto" ? autoHeight(source.height) : presetHeight(options.quality);
  const scale = Math.min(1, maxHeight / source.height);
  return evenSize(source.width * scale, source.height * scale);
}

function processFrames(options: Options, size: OutputSize, source: SourceInfo): Promise<Uint8Array[]> {
  return new Promise((resolve, reject) => {
    let hwaccel: string | null = null;
    if (options.gpu) {
      if (options.gpu === "auto") {
        hwaccel = process.platform === "darwin" ? "videotoolbox" : "auto";
      } else {
        hwaccel = String(options.gpu);
      }
    }

    const ffmpegArgs: string[] = ["-y"];
    if (hwaccel) {
      ffmpegArgs.push("-hwaccel", hwaccel);
    }
    ffmpegArgs.push(
      "-i",
      options.input,
      "-vf",
      `fps=${options.fps},scale=${size.width}:${size.height}:flags=lanczos,format=rgba`,
      "-f",
      "rawvideo",
      "-vcodec",
      "rawvideo"
    );
    if (options.maxFrames) {
      ffmpegArgs.push("-frames:v", String(options.maxFrames));
    }
    ffmpegArgs.push("pipe:1");

    const child = spawn("ffmpeg", ffmpegArgs, { stdio: ["ignore", "pipe", "pipe"] });

    const textureSettings = getTextureSettings(options.sizeMode, options.fps);
    const frames: Uint8Array[] = [];
    let previous: Uint16Array | null = null;
    const expectedBytes = size.width * size.height * 4;

    const bufferQueue: Buffer[] = [];
    let totalLength = 0;
    let frameIndex = 0;

    // Estimate total frames
    const estimatedSourceFrames = source.duration ? Math.ceil(source.duration * options.fps) : source.frameCount;
    const estimatedTotal = options.maxFrames
      ? Math.min(options.maxFrames, estimatedSourceFrames ?? options.maxFrames)
      : estimatedSourceFrames;
    const startTime = Date.now();
    let stderrTail = "";

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-4000);
    });

    child.stdout.on("data", (chunk: Buffer) => {
      bufferQueue.push(chunk);
      totalLength += chunk.length;

      while (totalLength >= expectedBytes) {
        const frameBuffer = new Uint8Array(expectedBytes);
        let bytesCopied = 0;

        while (bytesCopied < expectedBytes) {
          const first = bufferQueue[0];
          const needed = expectedBytes - bytesCopied;
          if (first.length <= needed) {
            frameBuffer.set(first, bytesCopied);
            bytesCopied += first.length;
            bufferQueue.shift();
          } else {
            frameBuffer.set(first.subarray(0, needed), bytesCopied);
            bufferQueue[0] = first.subarray(needed);
            bytesCopied += needed;
          }
        }
        totalLength -= expectedBytes;

        const texture = rgbaToRgb565(frameBuffer, textureSettings.colorBits);
        frames.push(
          encodeTextureFrame(texture, previous, frameIndex, {
            width: size.width,
            height: size.height,
            tileSize: 16,
            keyframeInterval: textureSettings.keyframeInterval,
            changedThreshold: textureSettings.changedThreshold,
            colorBits: textureSettings.colorBits,
            motionSearchRadius: textureSettings.motionSearchRadius,
            motionMismatchThreshold: textureSettings.motionMismatchThreshold
          })
        );
        previous = texture;
        frameIndex += 1;

        // Draw progress
        if (estimatedTotal && estimatedTotal > 0) {
          const elapsed = (Date.now() - startTime) / 1000;
          const percent = Math.min(100, Math.round((frameIndex / estimatedTotal) * 100));
          const barWidth = 15;
          const filledWidth = Math.min(barWidth, Math.round((frameIndex / estimatedTotal) * barWidth));
          const emptyWidth = barWidth - filledWidth;
          const bar = "█".repeat(filledWidth) + "░".repeat(emptyWidth);
          const fps = elapsed > 0 ? (frameIndex / elapsed).toFixed(1) : "0.0";
          const eta = frameIndex > 0 && frameIndex < estimatedTotal ? (((estimatedTotal - frameIndex) / frameIndex) * elapsed).toFixed(0) + "s" : "--";
          process.stdout.write(
            `\rEncoding: [${bar}] ${percent}% | ${frameIndex}/${estimatedTotal} | ${fps} fps | ETA: ${eta} | ${elapsed.toFixed(1)}s`
          );
        } else {
          const elapsed = (Date.now() - startTime) / 1000;
          const fps = elapsed > 0 ? (frameIndex / elapsed).toFixed(1) : "0.0";
          process.stdout.write(
            `\rEncoding: ${frameIndex} | ${fps} fps | ${elapsed.toFixed(1)}s`
          );
        }
      }
    });

    child.on("error", (err) => {
      reject(err);
    });

    child.on("close", (code) => {
      process.stdout.write("\n");
      if (code !== 0) {
        reject(new Error(`FFmpeg exited with code ${code}${stderrTail ? `\n${stderrTail.trim()}` : ""}`));
      } else {
        resolve(frames);
      }
    });
  });
}

function extractAudioBlock(options: Options): Uint8Array | null {
  if (!options.audio) return null;

  const result = spawnSync(
    "ffmpeg",
    ["-y", "-i", options.input, "-vn", "-ac", "2", "-ar", "48000", "-f", "s16le", "pipe:1"],
    { maxBuffer: 100 * 1024 * 1024 }
  );
  if (result.status !== 0) return null;

  const pcm = result.stdout;
  if (!pcm || pcm.byteLength === 0) return null;

  // Encode PCM16 to IMA-ADPCM (4-bit) for ~4x smaller audio
  const channels = 2;
  const pcmView = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const sampleCount = pcm.byteLength / 2;
  const frameCount = sampleCount / channels;

  const ADPCM_INDEX_TABLE = [-1, -1, -1, -1, 2, 4, 6, 8];
  const ADPCM_STEP_TABLE = [
    7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60,
    66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371,
    408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878,
    2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845,
    8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086,
    29794, 32767
  ];

  const states = Array.from({ length: channels }, () => ({ predictor: 0, index: 0 }));
  const predictors = new Int16Array(channels);
  const nibbles: number[] = [];

  for (let frame = 0; frame < frameCount; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const sample = pcmView.getInt16((frame * channels + channel) * 2, true);
      const state = states[channel];
      if (frame === 0) {
        state.predictor = sample;
        predictors[channel] = sample;
        nibbles.push(0);
        continue;
      }
      // Encode nibble
      const step = ADPCM_STEP_TABLE[state.index];
      let diff = sample - state.predictor;
      let nibble = 0;
      if (diff < 0) { nibble = 8; diff = -diff; }
      let delta = step >> 3;
      if (diff >= step) { nibble |= 4; diff -= step; delta += step; }
      if (diff >= step >> 1) { nibble |= 2; diff -= step >> 1; delta += step >> 1; }
      if (diff >= step >> 2) { nibble |= 1; delta += step >> 2; }
      state.predictor += nibble & 8 ? -delta : delta;
      state.predictor = Math.max(-32768, Math.min(32767, state.predictor));
      state.index = Math.max(0, Math.min(88, state.index + ADPCM_INDEX_TABLE[nibble & 7]));
      nibbles.push(nibble);
    }
  }

  const adpcmPayload = new Uint8Array(Math.ceil(nibbles.length / 2));
  for (let index = 0; index < nibbles.length; index += 1) {
    if (index & 1) adpcmPayload[index >> 1] |= nibbles[index] << 4;
    else adpcmPayload[index >> 1] = nibbles[index];
  }

  const adpcmHeaderBytes = channels * 4;
  const byteLength = 20 + adpcmHeaderBytes + adpcmPayload.byteLength;
  const block = new Uint8Array(byteLength);
  const view = new DataView(block.buffer);
  view.setUint32(0, 0x41564350, true); // PCVA magic
  view.setUint32(4, 20, true);
  view.setUint32(8, 48000, true);
  view.setUint16(12, channels, true);
  view.setUint16(14, 4, true); // 4-bit ADPCM
  view.setUint32(16, frameCount, true);

  let byteOffset = 20;
  for (let channel = 0; channel < channels; channel += 1) {
    view.setInt16(byteOffset, predictors[channel], true);
    block[byteOffset + 2] = states[channel].index;
    block[byteOffset + 3] = 0;
    byteOffset += 4;
  }
  block.set(adpcmPayload, byteOffset);
  return block;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  try {
    const source = await getSourceInfo(options.input);
    const size = resolveOutputSize(options, source);

    console.log(
      `Source metadata: ${source.width}x${source.height}${
        source.duration ? `, ${source.duration.toFixed(2)}s` : ""
      } via ${source.metadataSource}${source.codec ? `, codec ${source.codec}` : ""}${
        source.canDecodeWithMediaBunny === false ? ", MediaBunny decode unavailable in this runtime" : ""
      }.`
    );
    console.log(`Starting stream conversion for ${options.input} (${size.width}x${size.height} @ ${options.fps} fps)...`);
    const frames = await processFrames(options, size, source);

    if (frames.length === 0) {
      throw new Error("FFmpeg produced no frames.");
    }

    if (options.audio) console.log("Extracting audio...");
    const audioBlock = extractAudioBlock(options);
    const header: PCVHeader = {
      width: size.width,
      height: size.height,
      fps: options.fps,
      frameCount: frames.length,
      particleCount: size.width * size.height,
      flags: 1 | PCV_FLAG_TEXTURE_RGB565_DELTA | PCV_FLAG_ZSTD | (audioBlock ? PCV_FLAG_PCM_AUDIO : 0)
    };

    console.log("Writing PCV file...");
    writeFileSync(options.output, encodeTexturePCV(header, frames, audioBlock, getCompressionLevel(options.sizeMode)));
    console.log(
      `Wrote ${options.output} (${frames.length} frames, ${size.width}x${size.height}, ${options.fps} fps, ${options.sizeMode}).`
    );
  } catch (err) {
    console.error("Conversion failed:", err);
    process.exit(1);
  }
}

function encodeTexturePCV(
  header: PCVHeader,
  frames: Uint8Array[],
  audioBlock: Uint8Array | null,
  compressionLevel: CompressionLevel
): Buffer {
  const headerBuffer = new ArrayBuffer(PCV_HEADER_SIZE);
  writeHeader(new DataView(headerBuffer), header);
  const encodedFrames = frames.map((frame) => encodeFrame(frame, frame.byteLength));
  const totalBytes =
    PCV_HEADER_SIZE +
    encodedFrames.reduce((total, frame) => total + frame.byteLength, 0) +
    (audioBlock?.byteLength ?? 0);
  const file = new Uint8Array(totalBytes);

  file.set(new Uint8Array(headerBuffer), 0);
  let offset = PCV_HEADER_SIZE;
  for (const frame of encodedFrames) {
    file.set(frame, offset);
    offset += frame.byteLength;
  }
  if (audioBlock) file.set(audioBlock, offset);

  return compressWithZstd(Buffer.from(file), compressionLevel);
}

function getCompressionLevel(sizeMode: SizeMode): CompressionLevel {
  if (sizeMode === "best") return 19;
  if (sizeMode === "balanced") return 11;
  return 3;
}

function compressWithZstd(data: Buffer, level: CompressionLevel): Buffer {
  // Try native zstd CLI first (fastest, best compression)
  try {
    const tmpDir = mkdtempSync(join(tmpdir(), "pcv-"));
    const tmpIn = join(tmpDir, "input.bin");
    const tmpOut = join(tmpDir, "output.zst");
    writeFileSync(tmpIn, data);
    execSync(`zstd -${level} -f -o "${tmpOut}" "${tmpIn}"`, { stdio: "ignore" });
    const compressed = readFileSync(tmpOut);
    try { unlinkSync(tmpIn); } catch {}
    try { unlinkSync(tmpOut); } catch {}
    return compressed;
  } catch {
    // zstd CLI not available, fall back to gzip
    console.warn("zstd CLI not found, falling back to gzip. Install zstd for better compression: brew install zstd");
    const { gzipSync } = require("node:zlib");
    const gzipLevel = level >= 15 ? 9 : level >= 7 ? 6 : 1;
    return gzipSync(data, { level: gzipLevel });
  }
}

function getTextureSettings(sizeMode: SizeMode, fps: number) {
  if (sizeMode === "best") {
    return {
      colorBits: 16 as const,
      changedThreshold: 0.025,
      keyframeInterval: Math.max(1, Math.round(fps * 1.5)),
      motionSearchRadius: 16,
      motionMismatchThreshold: 0.03
    };
  }

  if (sizeMode === "balanced") {
    return {
      colorBits: 16 as const,
      changedThreshold: 0.06,
      keyframeInterval: Math.max(1, Math.round(fps * 2)),
      motionSearchRadius: 32,
      motionMismatchThreshold: 0.08
    };
  }

  return {
    colorBits: 12 as const,
    changedThreshold: 0.12,
    keyframeInterval: Math.max(1, Math.round(fps * 4)),
    motionSearchRadius: 32,
    motionMismatchThreshold: 0.16
  };
}

function autoHeight(sourceHeight: number): number {
  if (sourceHeight <= 180) return sourceHeight <= 120 ? 90 : 180;
  return 320;
}

function presetHeight(quality: Exclude<Quality, "auto" | "custom">): number {
  if (quality === "160p") return 90;
  if (quality === "320p") return 180;
  if (quality === "720p") return 720;
  return 1080;
}

function evenSize(width: number, height: number): OutputSize {
  return {
    width: Math.max(2, Math.round(width / 2) * 2),
    height: Math.max(2, Math.round(height / 2) * 2)
  };
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err === null || err === undefined) return "not available";
  return String(err);
}

void main();
