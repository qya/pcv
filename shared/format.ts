export const PCV_MAGIC = 0x33564350; // "PCV3" little-endian.
export const PCV_VERSION = 3;
export const PCV_HEADER_SIZE = 32;
export const PCV_BYTES_PER_PARTICLE = 8;
export const PCV_FLAG_DENSE_RGBA = 1 << 1;
export const PCV_FLAG_TEXTURE_RGB565_DELTA = 1 << 2;
export const PCV_FLAG_PCM_AUDIO = 1 << 3;
export const PCV_FLAG_ZSTD = 1 << 4;
export const PCV_TEXTURE_KEYFRAME = 1;
export const PCV_TEXTURE_DELTA = 2;
export const PCV_TEXTURE_KEYFRAME_RLE = 3;
export const PCV_TEXTURE_DELTA_RLE = 4;
export const PCV_TEXTURE_DELTA_MOTION = 5;
export const PCV_TEXTURE_DELTA_XOR_RLE = 6;
export const PCV_AUDIO_MAGIC = 0x41564350; // "PCVA" little-endian.

export type PCVHeader = {
  width: number;
  height: number;
  fps: number;
  frameCount: number;
  particleCount: number;
  flags: number;
};

export type PCVFrame = {
  sampleCount: number;
  data: Uint8Array;
};

export type DecodedFrame = {
  particleCount: number;
  interleaved: Uint8Array;
  denseRgba?: Uint8Array;
  rgb565?: Uint16Array;
};

export type PCVAudio = {
  sampleRate: number;
  channels: number;
  frameCount: number;
  pcm: Int16Array;
};

export function writeHeader(view: DataView, header: PCVHeader): void {
  view.setUint32(0, 0x33564350, true); // "PCV3"
  view.setUint16(4, PCV_VERSION, true);
  view.setUint16(6, PCV_HEADER_SIZE, true);
  view.setUint32(8, header.width, true);
  view.setUint32(12, header.height, true);
  view.setFloat32(16, header.fps, true);
  view.setUint32(20, header.frameCount, true);
  view.setUint32(24, header.particleCount, true);
  view.setUint32(28, header.flags, true);
}

export function readHeader(buffer: ArrayBuffer): PCVHeader {
  if (buffer.byteLength < PCV_HEADER_SIZE) {
    throw new Error("PCV header is incomplete.");
  }

  const view = new DataView(buffer, 0, PCV_HEADER_SIZE);
  const magic = view.getUint32(0, true);
  const version = view.getUint16(4, true);
  const headerSize = view.getUint16(6, true);

  if (magic !== 0x33564350 && magic !== 0x32564350) {
    throw new Error("Invalid PCV file: missing PCV magic.");
  }

  if ((version !== 3 && version !== 2) || headerSize !== PCV_HEADER_SIZE) {
    throw new Error(`Unsupported PCV format version ${version}.`);
  }

  return {
    width: view.getUint32(8, true),
    height: view.getUint32(12, true),
    fps: view.getFloat32(16, true),
    frameCount: view.getUint32(20, true),
    particleCount: view.getUint32(24, true),
    flags: view.getUint32(28, true)
  };
}

export function frameByteLength(particleCount: number): number {
  return 4 + particleCount * PCV_BYTES_PER_PARTICLE;
}

export function encodeFrame(data: Uint8Array, sampleCount = data.byteLength / PCV_BYTES_PER_PARTICLE): Uint8Array {
  if (!Number.isInteger(sampleCount) || sampleCount < 0) {
    throw new Error("PCV frame sample count must be a non-negative integer.");
  }

  const frame = new Uint8Array(4 + data.byteLength);
  new DataView(frame.buffer).setUint32(0, sampleCount, true);
  frame.set(data, 4);
  return frame;
}

export function readFrame(buffer: ArrayBuffer, offset: number, bytesPerSample = PCV_BYTES_PER_PARTICLE): PCVFrame | null {
  if (offset + 4 > buffer.byteLength) return null;

  const view = new DataView(buffer);
  const sampleCount = view.getUint32(offset, true);
  const byteLength = sampleCount * bytesPerSample;
  const start = offset + 4;

  if (start + byteLength > buffer.byteLength) return null;

  return {
    sampleCount,
    data: new Uint8Array(buffer, start, byteLength)
  };
}
