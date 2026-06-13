import {
  PCV_BYTES_PER_PARTICLE,
  PCV_AUDIO_MAGIC,
  PCV_FLAG_DENSE_RGBA,
  PCV_FLAG_PCM_AUDIO,
  PCV_FLAG_TEXTURE_RGB565_DELTA,
  PCV_FLAG_ZSTD,
  PCV_HEADER_SIZE,
  PCV_TEXTURE_DELTA,
  PCV_TEXTURE_DELTA_MOTION,
  PCV_TEXTURE_DELTA_RLE,
  PCV_TEXTURE_DELTA_XOR_RLE,
  PCV_TEXTURE_KEYFRAME,
  PCV_TEXTURE_KEYFRAME_RLE,
  readFrame,
  readHeader,
  type DecodedFrame,
  type PCVAudio,
  type PCVHeader
} from "../../shared/format";
import initWasm, { zstd_decompress } from "../wasm-encoder/wasm_encoder.js";
// @ts-ignore
import wasmUrl from "../wasm-encoder/wasm_encoder_bg.wasm?url";

export type PCVStreamState = {
  header: PCVHeader | null;
  frames: DecodedFrame[];
  audio: PCVAudio | null;
  progress: number;
  done: boolean;
};

type Listener = (state: PCVStreamState) => void;

export class PCVStreamDecoder {
  private readonly frames: DecodedFrame[] = [];
  private readonly listeners = new Set<Listener>();
  private textureFrameBuffer: Uint16Array | null = null;
  private header: PCVHeader | null = null;
  private audio: PCVAudio | null = null;
  private progress = 0;
  private done = false;

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  getHeader(): PCVHeader | null {
    return this.header;
  }

  getFrame(index: number): DecodedFrame | undefined {
    return this.frames[index];
  }

  getFrameCount(): number {
    return this.frames.length;
  }

  getProgress(): number {
    return this.progress;
  }

  getAudio(): PCVAudio | null {
    return this.audio;
  }

  async load(src: string): Promise<void> {
    const response = await fetch(src);
    if (!response.ok || !response.body) {
      throw new Error(`Unable to load PCV stream: ${response.status} ${response.statusText}`);
    }

    const total = Number(response.headers.get("content-length") ?? 0);

    // Read full compressed data to detect format (zstd vs gzip)
    const compressedReader = response.body.getReader();
    const compressedChunks: Uint8Array[] = [];
    let compressedLength = 0;
    while (true) {
      const { value, done } = await compressedReader.read();
      if (done) break;
      compressedChunks.push(value);
      compressedLength += value.byteLength;
    }

    const compressedData = new Uint8Array(compressedLength);
    let copyOffset = 0;
    for (const chunk of compressedChunks) {
      compressedData.set(chunk, copyOffset);
      copyOffset += chunk.byteLength;
    }

    // Detect zstd magic (0xFD2FB528) vs gzip magic (0x1F8B)
    const isZstd = compressedData.length >= 4 &&
      compressedData[0] === 0x28 && compressedData[1] === 0xB5 &&
      compressedData[2] === 0x2F && compressedData[3] === 0xFD;

    let decompressedData: Uint8Array;
    if (isZstd) {
      try {
        await initWasm({ module_or_path: wasmUrl });
      } catch (err) {
        // WASM may already be initialized
      }
      decompressedData = zstd_decompress(compressedData);
    } else {
      // gzip — use DecompressionStream
      const blob = new Blob([compressedData]);
      const ds = new DecompressionStream("gzip");
      const decompressedStream = blob.stream().pipeThrough(ds);
      const reader = decompressedStream.getReader();
      const chunks: Uint8Array[] = [];
      let decompressedLength = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        chunks.push(value);
        decompressedLength += value.byteLength;
      }
      decompressedData = new Uint8Array(decompressedLength);
      let off = 0;
      for (const chunk of chunks) {
        decompressedData.set(chunk, off);
        off += chunk.byteLength;
      }
    }

    // Parse decompressed data
    const queue = new ByteQueue();
    queue.push(decompressedData);

    if (queue.byteLength >= PCV_HEADER_SIZE) {
      this.header = readHeader(toArrayBuffer(queue.read(PCV_HEADER_SIZE)));
    }

    if (this.header) {
      const denseRgba = (this.header.flags & PCV_FLAG_DENSE_RGBA) !== 0;
      const textureDelta = (this.header.flags & PCV_FLAG_TEXTURE_RGB565_DELTA) !== 0;
      const bytesPerSample = textureDelta ? 1 : denseRgba ? 4 : PCV_BYTES_PER_PARTICLE;
      while (this.frames.length < this.header.frameCount) {
        if (queue.byteLength < 4) break;
        const sampleCount = queue.peekUint32();
        const payloadBytes = sampleCount * bytesPerSample;
        if (queue.byteLength < 4 + payloadBytes) break;

        queue.skip(4);
        const data = queue.read(payloadBytes);

        if (textureDelta) {
          this.frames.push(this.decodeTextureFrame(data));
        } else {
          this.frames.push({
            particleCount: sampleCount,
            interleaved: denseRgba ? new Uint8Array(0) : data,
            denseRgba: denseRgba ? data : undefined
          });
        }
      }

      if (!this.audio && this.frames.length === this.header.frameCount && (this.header.flags & PCV_FLAG_PCM_AUDIO)) {
        this.audio = readAudioBlock(queue);
      }
    }

    this.done = true;
    this.progress = 1;
    this.emit();
  }

  private snapshot(): PCVStreamState {
    return {
      header: this.header,
      frames: this.frames,
      audio: this.audio,
      progress: this.progress,
      done: this.done
    };
  }

  private emit(): void {
    const state = this.snapshot();
    for (const listener of this.listeners) listener(state);
  }

  private decodeTextureFrame(data: Uint8Array): DecodedFrame {
    if (!this.header) throw new Error("Cannot decode texture frame before PCV header.");
    if (!this.textureFrameBuffer) {
      this.textureFrameBuffer = new Uint16Array(this.header.width * this.header.height);
    }

    const type = data[0];
    if (type === PCV_TEXTURE_KEYFRAME) {
      let offset = 1;
      for (let index = 0; index < this.textureFrameBuffer.length; index += 1) {
        this.textureFrameBuffer[index] = data[offset] | (data[offset + 1] << 8);
        offset += 2;
      }
    } else if (type === PCV_TEXTURE_KEYFRAME_RLE) {
      this.decodeRleInto(data, 5, this.textureFrameBuffer, 0, this.textureFrameBuffer.length);
    } else if (type === PCV_TEXTURE_DELTA) {
      this.applyDeltaTiles(data);
    } else if (type === PCV_TEXTURE_DELTA_RLE) {
      this.applyDeltaTilesRle(data);
    } else if (type === PCV_TEXTURE_DELTA_MOTION) {
      this.applyDeltaTilesMotion(data);
    } else if (type === PCV_TEXTURE_DELTA_XOR_RLE) {
      this.applyDeltaTilesXorRle(data);
    } else {
      throw new Error(`Unknown PCV texture frame type: ${type}`);
    }

    return {
      particleCount: this.textureFrameBuffer.length,
      interleaved: new Uint8Array(0),
      rgb565: new Uint16Array(this.textureFrameBuffer)
    };
  }

  private applyDeltaTiles(data: Uint8Array): void {
    if (!this.header || !this.textureFrameBuffer) return;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const tileCount = view.getUint16(1, true);
    let offset = 3;

    for (let tile = 0; tile < tileCount; tile += 1) {
      const x = view.getUint16(offset, true);
      const y = view.getUint16(offset + 2, true);
      const tileWidth = data[offset + 4];
      const tileHeight = data[offset + 5];
      offset += 6;

      for (let row = 0; row < tileHeight; row += 1) {
        const target = (y + row) * this.header.width + x;
        for (let col = 0; col < tileWidth; col += 1) {
          this.textureFrameBuffer[target + col] = data[offset] | (data[offset + 1] << 8);
          offset += 2;
        }
      }
    }
  }

  private applyDeltaTilesRle(data: Uint8Array): void {
    if (!this.header || !this.textureFrameBuffer) return;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const tileCount = view.getUint16(1, true);
    let offset = 3;

    for (let tile = 0; tile < tileCount; tile += 1) {
      const x = view.getUint16(offset, true);
      const y = view.getUint16(offset + 2, true);
      const tileWidth = data[offset + 4];
      const tileHeight = data[offset + 5];
      const byteLength = view.getUint16(offset + 6, true);
      offset += 8;

      const tilePixels = new Uint16Array(tileWidth * tileHeight);
      this.decodeRleInto(data, offset, tilePixels, 0, tilePixels.length);
      offset += byteLength;

      let source = 0;
      for (let row = 0; row < tileHeight; row += 1) {
        const target = (y + row) * this.header.width + x;
        for (let col = 0; col < tileWidth; col += 1) {
          this.textureFrameBuffer[target + col] = tilePixels[source];
          source += 1;
        }
      }
    }
  }

  private applyDeltaTilesMotion(data: Uint8Array): void {
    if (!this.header || !this.textureFrameBuffer) return;
    const previous = new Uint16Array(this.textureFrameBuffer);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const tileCount = view.getUint16(1, true);
    let offset = 3;

    for (let tile = 0; tile < tileCount; tile += 1) {
      const mode = data[offset];
      const x = view.getUint16(offset + 1, true);
      const y = view.getUint16(offset + 3, true);
      const tileWidth = data[offset + 5];
      const tileHeight = data[offset + 6];

      if (mode === 1) {
        const dx = view.getInt8(offset + 7);
        const dy = view.getInt8(offset + 8);
        const sx = x + dx;
        const sy = y + dy;
        offset += 9;
        for (let row = 0; row < tileHeight; row += 1) {
          const target = (y + row) * this.header.width + x;
          const source = (sy + row) * this.header.width + sx;
          this.textureFrameBuffer.set(previous.subarray(source, source + tileWidth), target);
        }
      } else if (mode === 2) {
        const byteLength = view.getUint16(offset + 7, true);
        offset += 9;
        const tilePixels = new Uint16Array(tileWidth * tileHeight);
        this.decodeRleInto(data, offset, tilePixels, 0, tilePixels.length);
        offset += byteLength;
        this.blitTile(tilePixels, x, y, tileWidth, tileHeight);
      } else {
        offset += 7;
        const tilePixels = new Uint16Array(tileWidth * tileHeight);
        for (let index = 0; index < tilePixels.length; index += 1) {
          tilePixels[index] = data[offset] | (data[offset + 1] << 8);
          offset += 2;
        }
        this.blitTile(tilePixels, x, y, tileWidth, tileHeight);
      }
    }
  }

  private applyDeltaTilesXorRle(data: Uint8Array): void {
    if (!this.header || !this.textureFrameBuffer) return;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const tileCount = view.getUint16(1, true);
    let offset = 3;

    for (let tile = 0; tile < tileCount; tile += 1) {
      const x = view.getUint16(offset, true);
      const y = view.getUint16(offset + 2, true);
      const tileWidth = data[offset + 4];
      const tileHeight = data[offset + 5];
      const byteLength = view.getUint16(offset + 6, true);
      offset += 8;

      const xorPixels = new Uint16Array(tileWidth * tileHeight);
      this.decodeRleInto(data, offset, xorPixels, 0, xorPixels.length);
      offset += byteLength;

      // XOR back against the previous frame buffer to recover actual pixels
      let source = 0;
      for (let row = 0; row < tileHeight; row += 1) {
        const target = (y + row) * this.header.width + x;
        for (let col = 0; col < tileWidth; col += 1) {
          this.textureFrameBuffer[target + col] ^= xorPixels[source];
          source += 1;
        }
      }
    }
  }

  private blitTile(tilePixels: Uint16Array, x: number, y: number, tileWidth: number, tileHeight: number): void {
    if (!this.header || !this.textureFrameBuffer) return;
    let source = 0;
    for (let row = 0; row < tileHeight; row += 1) {
      const target = (y + row) * this.header.width + x;
      this.textureFrameBuffer.set(tilePixels.subarray(source, source + tileWidth), target);
      source += tileWidth;
    }
  }

  private decodeRleInto(data: Uint8Array, offset: number, target: Uint16Array, targetOffset: number, pixelCount: number): void {
    let written = 0;
    while (written < pixelCount) {
      const run = data[offset] | (data[offset + 1] << 8);
      const value = data[offset + 2] | (data[offset + 3] << 8);
      offset += 4;
      target.fill(value, targetOffset + written, targetOffset + written + run);
      written += run;
    }
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function readAudioBlock(queue: ByteQueue): PCVAudio | null {
  if (queue.byteLength < 20) return null;

  const header = queue.peek(20);
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const magic = view.getUint32(0, true);
  if (magic !== PCV_AUDIO_MAGIC) return null;

  const headerSize = view.getUint32(4, true);
  const sampleRate = view.getUint32(8, true);
  const channels = view.getUint16(12, true);
  const bitsPerSample = view.getUint16(14, true);
  const frameCount = view.getUint32(16, true);
  const pcmByteLength = frameCount * channels * 2;

  if (headerSize !== 20 || (bitsPerSample !== 16 && bitsPerSample !== 4) || channels < 1 || channels > 2) {
    throw new Error("Unsupported PCV audio block.");
  }

  const adpcmHeaderBytes = bitsPerSample === 4 ? channels * 4 : 0;
  const encodedByteLength = bitsPerSample === 4 ? Math.ceil((frameCount * channels) / 2) : pcmByteLength;
  if (queue.byteLength < headerSize + adpcmHeaderBytes + encodedByteLength) return null;

  queue.skip(headerSize);
  let pcm: Int16Array;
  if (bitsPerSample === 16) {
    const bytes = queue.read(pcmByteLength);
    const pcmView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    pcm = new Int16Array(frameCount * channels);
    let source = 0;
    for (let index = 0; index < pcm.length; index += 1) {
      pcm[index] = pcmView.getInt16(source, true);
      source += 2;
    }
  } else {
    const adpcmHeader = queue.read(adpcmHeaderBytes);
    const bytes = queue.read(encodedByteLength);
    pcm = decodeAdpcmAudio(adpcmHeader, bytes, frameCount, channels);
  }

  return { sampleRate, channels, frameCount, pcm };
}

const ADPCM_INDEX_TABLE = [-1, -1, -1, -1, 2, 4, 6, 8];
const ADPCM_STEP_TABLE = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60,
  66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371,
  408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878,
  2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845,
  8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086,
  29794, 32767
];

function decodeAdpcmAudio(header: Uint8Array, data: Uint8Array, frameCount: number, channels: number): Int16Array {
  const headerView = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const states = Array.from({ length: channels }, (_, channel) => ({
    predictor: headerView.getInt16(channel * 4, true),
    index: header[channel * 4 + 2]
  }));
  const pcm = new Int16Array(frameCount * channels);
  let nibbleIndex = 0;

  for (let frame = 0; frame < frameCount; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const nibbleByte = data[nibbleIndex >> 1];
      const nibble = nibbleIndex & 1 ? nibbleByte >> 4 : nibbleByte & 0x0f;
      const state = states[channel];
      if (frame === 0) {
        pcm[channel] = state.predictor;
      } else {
        pcm[frame * channels + channel] = decodeNibble(nibble, state);
      }
      nibbleIndex += 1;
    }
  }

  return pcm;
}

function decodeNibble(nibble: number, state: { predictor: number; index: number }): number {
  const step = ADPCM_STEP_TABLE[state.index];
  let delta = step >> 3;
  if (nibble & 1) delta += step >> 2;
  if (nibble & 2) delta += step >> 1;
  if (nibble & 4) delta += step;

  state.predictor += nibble & 8 ? -delta : delta;
  state.predictor = Math.max(-32768, Math.min(32767, state.predictor));
  state.index = Math.max(0, Math.min(88, state.index + ADPCM_INDEX_TABLE[nibble & 7]));
  return state.predictor;
}

class ByteQueue {
  private chunks: Uint8Array[] = [];
  private headOffset = 0;
  byteLength = 0;

  push(chunk: Uint8Array): void {
    if (chunk.byteLength === 0) return;
    this.chunks.push(chunk);
    this.byteLength += chunk.byteLength;
  }

  peek(byteLength: number): Uint8Array {
    if (byteLength > this.byteLength) {
      throw new Error("ByteQueue underflow.");
    }

    const output = new Uint8Array(byteLength);
    let outputOffset = 0;
    let remaining = byteLength;
    let chunkIndex = 0;
    let chunkOffset = this.headOffset;

    while (remaining > 0) {
      const chunk = this.chunks[chunkIndex];
      const available = chunk.byteLength - chunkOffset;
      const take = Math.min(available, remaining);
      output.set(chunk.subarray(chunkOffset, chunkOffset + take), outputOffset);
      outputOffset += take;
      remaining -= take;
      chunkIndex += 1;
      chunkOffset = 0;
    }

    return output;
  }

  peekUint32(): number {
    const bytes = this.peek(4);
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
  }

  skip(byteLength: number): void {
    this.read(byteLength);
  }

  read(byteLength: number): Uint8Array {
    if (byteLength > this.byteLength) {
      throw new Error("ByteQueue underflow.");
    }

    const output = new Uint8Array(byteLength);
    let outputOffset = 0;
    let remaining = byteLength;

    while (remaining > 0) {
      const head = this.chunks[0];
      const available = head.byteLength - this.headOffset;
      const take = Math.min(available, remaining);
      output.set(head.subarray(this.headOffset, this.headOffset + take), outputOffset);
      this.headOffset += take;
      outputOffset += take;
      remaining -= take;
      this.byteLength -= take;

      if (this.headOffset >= head.byteLength) {
        this.chunks.shift();
        this.headOffset = 0;
      }
    }

    return output;
  }
}
