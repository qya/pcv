import { ALL_FORMATS, BlobSource, Input, VideoSampleSink } from "mediabunny";
import {
  encodeFrame,
  PCV_FLAG_PCM_AUDIO,
  PCV_FLAG_TEXTURE_RGB565_DELTA,
  PCV_FLAG_ZSTD,
  PCV_HEADER_SIZE,
  writeHeader
} from "../../shared/format";
import { encodePcmAudioBlock } from "./audioCodec";
import { encodeTextureFrame, rgbaToRgb565 } from "./textureCodec";
import initWasm, { WasmTextureEncoder, zstd_compress } from "../wasm-encoder/wasm_encoder.js";
// @ts-ignore
import wasmUrl from "../wasm-encoder/wasm_encoder_bg.wasm?url";

export type BrowserConverterOptions = {
  file: File;
  width?: number;
  height?: number;
  fps: number;
  maxParticles: number;
  quality?: "auto" | "160p" | "320p" | "720p" | "1080p" | "custom";
  sizeMode?: "balanced" | "small" | "best";
  codec?: "texture" | "particles";
  includeAudio?: boolean;
  onProgress?: (progress: BrowserConverterProgress) => void;
  onDebug?: (event: BrowserConverterDebugEvent) => void;
};

export type BrowserConverterProgress = {
  phase: "idle" | "reading" | "decoding" | "encoding" | "done";
  frame: number;
  frameCount: number;
  message: string;
};

export type BrowserConverterDebugEvent = {
  label: string;
  detail?: Record<string, string | number | boolean>;
  elapsedMs?: number;
};

export type VideoMetadataProbe = {
  sourceWidth: number;
  sourceHeight: number;
  outputWidth: number;
  outputHeight: number;
  duration: number | null;
  estimatedMb: number | null;
};

export type BrowserConverterResult = {
  blob: Blob;
  url: string;
  fileName: string;
  frameCount: number;
  width: number;
  height: number;
  fps: number;
  maxParticles: number;
  audio?: {
    sampleRate: number;
    channels: number;
    frameCount: number;
  };
};

export async function localConvertVideoToPcv(
  options: BrowserConverterOptions,
  customWasmUrl?: string
): Promise<BrowserConverterResult> {
  const startedAt = performance.now();
  const debug = (label: string, detail?: BrowserConverterDebugEvent["detail"]) => {
    options.onDebug?.({ label, detail, elapsedMs: Math.round(performance.now() - startedAt) });
  };

  debug("converter:start", { fileBytes: options.file.size, quality: options.quality ?? "custom" });
  const input = new Input({
    source: new BlobSource(options.file),
    formats: ALL_FORMATS
  });

  let wasmEncoder: WasmTextureEncoder | null = null;

  try {
    options.onProgress?.({
      phase: "reading",
      frame: 0,
      frameCount: 0,
      message: "Reading container metadata"
    });

    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) {
      throw new Error("The selected file does not contain a video track.");
    }

    const canDecode = await videoTrack.canDecode();
    if (!canDecode) {
      const codec = await videoTrack.getCodecParameterString();
      throw new Error(`This browser cannot decode the selected video codec${codec ? ` (${codec})` : ""}.`);
    }

    const sourceWidth = await videoTrack.getDisplayWidth();
    const sourceHeight = await videoTrack.getDisplayHeight();
    const outputSize = resolveOutputSize({
      quality: options.quality ?? "custom",
      sourceWidth,
      sourceHeight,
      width: options.width ?? sourceWidth,
      height: options.height ?? sourceHeight
    });
    debug("metadata:resolved", {
      sourceWidth,
      sourceHeight,
      outputWidth: outputSize.width,
      outputHeight: outputSize.height
    });

    const duration = await videoTrack.computeDuration();
    const frameCount = Math.max(1, Math.ceil(duration * options.fps));
    const estimate = estimateConversionMemory({
      width: outputSize.width,
      height: outputSize.height,
      frameCount,
      includeAudio: options.includeAudio ?? true,
      duration
    });
    debug("memory:estimate", {
      estimatedMb: Math.round(estimate.estimatedBytes / 1024 / 1024),
      limitMb: Math.round(estimate.limitBytes / 1024 / 1024)
    });
    if (estimate.estimatedBytes > estimate.limitBytes) {
      throw new Error(
        `This conversion is too large for in-browser memory (${Math.round(
          estimate.estimatedBytes / 1024 / 1024
        )} MB estimated). Use lower quality/FPS, trim the source, or disable audio.`
      );
    }
    debug("video:duration", { duration: Number(duration.toFixed(3)), frameCount, fps: options.fps });
    const timestamps = Array.from({ length: frameCount }, (_, index) => index / options.fps);
    const sink = new VideoSampleSink(videoTrack);
    const canvas = new OffscreenCanvas(outputSize.width, outputSize.height);
    const context = canvas.getContext("2d", {
      alpha: false,
      willReadFrequently: true
    });

    if (!context) {
      throw new Error("Unable to create a 2D canvas context for frame sampling.");
    }

    const useTextureCodec = options.codec !== "particles";
    const textureSettings = getTextureSettings(options.sizeMode ?? "small", options.fps);
    let previousTexture: Uint16Array | null = null;
    let frameIndex = 0;

    // Write header at start
    const header = new ArrayBuffer(PCV_HEADER_SIZE);
    writeHeader(new DataView(header), {
      width: outputSize.width,
      height: outputSize.height,
      fps: options.fps,
      frameCount,
      particleCount: useTextureCodec ? outputSize.width * outputSize.height : options.maxParticles,
      flags: (useTextureCodec ? 1 | PCV_FLAG_TEXTURE_RGB565_DELTA : 1) | PCV_FLAG_ZSTD | (options.includeAudio ?? true ? PCV_FLAG_PCM_AUDIO : 0)
    });

    // Collect raw uncompressed chunks, then zstd-compress at the end
    const rawChunks: Uint8Array[] = [new Uint8Array(header)];

    if (useTextureCodec) {
      try {
        await initWasm(customWasmUrl || wasmUrl);
        wasmEncoder = new WasmTextureEncoder(
          outputSize.width,
          outputSize.height,
          16, // tileSize
          textureSettings.colorBits
        );
        debug("wasm:initialized");
      } catch (err) {
        debug("wasm:init_failed", { error: String(err) });
        console.warn("WASM encoder failed to initialize, falling back to JS encoder:", err);
      }
    }

    for await (const sample of sink.samplesAtTimestamps(timestamps)) {
      let imageData: ImageData;

      if (!sample) {
        imageData = context.getImageData(0, 0, outputSize.width, outputSize.height);
      } else {
        context.clearRect(0, 0, outputSize.width, outputSize.height);
        sample.draw(context, 0, 0, outputSize.width, outputSize.height);
        imageData = context.getImageData(0, 0, outputSize.width, outputSize.height);
        sample.close();
      }

      let encoded: Uint8Array;
      if (useTextureCodec) {
        if (wasmEncoder) {
          const u8Data = new Uint8Array(imageData.data.buffer, imageData.data.byteOffset, imageData.data.byteLength);
          encoded = wasmEncoder.encode_frame(
            u8Data,
            frameIndex,
            textureSettings.keyframeInterval,
            textureSettings.changedThreshold,
            textureSettings.motionSearchRadius,
            textureSettings.motionMismatchThreshold
          );
        } else {
          const currentTexture = rgbaToRgb565(imageData.data, textureSettings.colorBits);
          encoded = encodeTextureFrame(currentTexture, previousTexture, frameIndex, {
            width: outputSize.width,
            height: outputSize.height,
            tileSize: 16,
            keyframeInterval: textureSettings.keyframeInterval,
            changedThreshold: textureSettings.changedThreshold,
            colorBits: textureSettings.colorBits,
            motionSearchRadius: textureSettings.motionSearchRadius,
            motionMismatchThreshold: textureSettings.motionMismatchThreshold
          });
          previousTexture = currentTexture;
        }
      } else {
        const { sampleRgbaFrame } = await import("./particleSampler");
        encoded = sampleRgbaFrame(imageData.data, null, {
          width: outputSize.width,
          height: outputSize.height,
          maxParticles: options.maxParticles
        });
      }

      rawChunks.push(encodeFrame(encoded, useTextureCodec ? encoded.byteLength : undefined));
      frameIndex += 1;

      if (frameIndex === 1 || frameIndex % 30 === 0 || frameIndex === frameCount) {
        debug("video:frame", { frame: frameIndex, frameCount });
      }

      options.onProgress?.({
        phase: "decoding",
        frame: frameIndex,
        frameCount,
        message: `Decoded ${frameIndex} of ${frameCount} target frames`
      });
    }

    let audioBlock: Awaited<ReturnType<typeof encodePcmAudioBlock>> = null;
    if (options.includeAudio ?? true) {
      options.onProgress?.({
        phase: "encoding",
        frame: frameIndex,
        frameCount: frameIndex,
        message: "Decoding custom PCM audio"
      });
      audioBlock = await encodePcmAudioBlock(await input.getPrimaryAudioTrack());
      debug("audio:encoded", {
        present: Boolean(audioBlock),
        sampleRate: audioBlock?.sampleRate ?? 0,
        channels: audioBlock?.channels ?? 0
      });
      if (audioBlock) {
        rawChunks.push(audioBlock.block);
      }
    }

    options.onProgress?.({
      phase: "encoding",
      frame: frameIndex,
      frameCount: frameIndex,
      message: "Writing binary PCV stream"
    });

    // Assemble all raw chunks into a single buffer
    const totalRawBytes = rawChunks.reduce((total, chunk) => total + chunk.byteLength, 0);
    const rawBuffer = new Uint8Array(totalRawBytes);
    let rawOffset = 0;
    for (const chunk of rawChunks) {
      rawBuffer.set(chunk, rawOffset);
      rawOffset += chunk.byteLength;
    }

    // Compress with zstd via WASM
    const compressionLevel =
      options.sizeMode === "best" ? 11 :
      options.sizeMode === "balanced" ? 7 :
      3;
    let compressedData: Uint8Array;
    try {
      // Ensure WASM is initialized (may already be from encoder)
      try { await initWasm(customWasmUrl || wasmUrl); } catch {}
      compressedData = zstd_compress(rawBuffer, compressionLevel);
      debug("pcv:compressed_zstd", { compressedBytes: compressedData.byteLength, rawBytes: totalRawBytes });
    } catch (err) {
      // Fallback to gzip if WASM zstd fails
      debug("pcv:zstd_fallback_gzip", { error: String(err) });
      const { Gzip } = await import("fflate");
      const gzipChunks: Uint8Array[] = [];
      const gzipLevel = compressionLevel >= 9 ? 9 : compressionLevel >= 5 ? 6 : 1;
      const gzip = new Gzip({ level: gzipLevel as 1 | 6 | 9 }, (chunk: Uint8Array) => {
        gzipChunks.push(chunk);
      });
      gzip.push(rawBuffer, true);
      const totalGzipBytes = gzipChunks.reduce((total, chunk) => total + chunk.byteLength, 0);
      compressedData = new Uint8Array(totalGzipBytes);
      let gzOff = 0;
      for (const chunk of gzipChunks) {
        compressedData.set(chunk, gzOff);
        gzOff += chunk.byteLength;
      }
      debug("pcv:compressed_gzip_fallback", { compressedBytes: compressedData.byteLength });
    }

    const blob = new Blob([compressedData as any], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);

    options.onProgress?.({
      phase: "done",
      frame: frameIndex,
      frameCount: frameIndex,
      message: "PCV file ready"
    });

    return {
      blob,
      url,
      fileName: `${stripExtension(options.file.name)}.pcv`,
      frameCount: frameIndex,
      width: outputSize.width,
      height: outputSize.height,
      fps: options.fps,
      maxParticles: options.maxParticles,
      audio: audioBlock
        ? {
            sampleRate: audioBlock.sampleRate,
            channels: audioBlock.channels,
            frameCount: audioBlock.frameCount
          }
        : undefined
    };
  } finally {
    if (wasmEncoder) {
      try {
        wasmEncoder.free();
      } catch (e) {
        console.error("Error freeing WASM encoder:", e);
      }
    }
    input.dispose();
  }
}

function estimateConversionMemory(options: {
  width: number;
  height: number;
  frameCount: number;
  includeAudio: boolean;
  duration: number;
}) {
  const pixels = options.width * options.height;
  const decodedFrameBytes = pixels * 6; // ImageData RGBA + RGB565 working frame.
  const compressedFrameBytes = pixels * 2 * options.frameCount * 0.05; // Approx compressed Gzip chunks in memory.
  const audioBytes = options.includeAudio ? options.duration * 48000 * 2 * 2 * 0.35 : 0;
  const estimatedBytes = decodedFrameBytes + compressedFrameBytes + audioBytes;
  return {
    estimatedBytes,
    limitBytes: 650 * 1024 * 1024
  };
}

function getTextureSettings(sizeMode: NonNullable<BrowserConverterOptions["sizeMode"]>, fps: number) {
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

export async function probeVideoMetadata(
  file: File,
  quality: NonNullable<BrowserConverterOptions["quality"]> = "auto"
): Promise<VideoMetadataProbe> {
  const input = new Input({
    source: new BlobSource(file),
    formats: ALL_FORMATS
  });

  try {
    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) {
      throw new Error("The selected file does not contain a video track.");
    }

    const sourceWidth = await videoTrack.getDisplayWidth();
    const sourceHeight = await videoTrack.getDisplayHeight();
    const output = resolveOutputSize({
      quality,
      sourceWidth,
      sourceHeight,
      width: sourceWidth,
      height: sourceHeight
    });
    const duration = await videoTrack.getDurationFromMetadata();
    const estimate = duration
      ? estimateConversionMemory({
          width: output.width,
          height: output.height,
          frameCount: Math.max(1, Math.ceil(duration * 15)),
          includeAudio: false,
          duration
        })
      : null;

    return {
      sourceWidth,
      sourceHeight,
      outputWidth: output.width,
      outputHeight: output.height,
      duration,
      estimatedMb: estimate ? Math.round(estimate.estimatedBytes / 1024 / 1024) : null
    };
  } finally {
    input.dispose();
  }
}

export function resolveOutputSize(options: {
  quality: NonNullable<BrowserConverterOptions["quality"]>;
  sourceWidth: number;
  sourceHeight: number;
  width: number;
  height: number;
}): { width: number; height: number } {
  if (options.quality === "custom") {
    return evenSize(options.width, options.height);
  }

  const maxHeight = options.quality === "auto" ? autoHeight(options.sourceHeight) : presetHeight(options.quality);
  const scale = Math.min(1, maxHeight / options.sourceHeight);
  return evenSize(options.sourceWidth * scale, options.sourceHeight * scale);
}

function autoHeight(sourceHeight: number): number {
  if (sourceHeight <= 180) return sourceHeight <= 120 ? 90 : 180;
  return 320;
}

function presetHeight(quality: Exclude<NonNullable<BrowserConverterOptions["quality"]>, "auto" | "custom">): number {
  if (quality === "160p") return 90;
  if (quality === "320p") return 180;
  if (quality === "720p") return 720;
  return 1080;
}

function evenSize(width: number, height: number): { width: number; height: number } {
  return {
    width: Math.max(2, Math.round(width / 2) * 2),
    height: Math.max(2, Math.round(height / 2) * 2)
  };
}

function stripExtension(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot > 0 ? fileName.slice(0, dot) : fileName;
}
