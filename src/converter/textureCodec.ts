import {
  PCV_TEXTURE_DELTA,
  PCV_TEXTURE_DELTA_MOTION,
  PCV_TEXTURE_DELTA_RLE,
  PCV_TEXTURE_DELTA_XOR_RLE,
  PCV_TEXTURE_KEYFRAME,
  PCV_TEXTURE_KEYFRAME_RLE
} from "../../shared/format";

export type TextureEncodeOptions = {
  width: number;
  height: number;
  tileSize: number;
  keyframeInterval: number;
  changedThreshold: number;
  colorBits: 12 | 16;
  motionSearchRadius: number;
  motionMismatchThreshold: number;
};

export function rgbaToRgb565(rgba: Uint8ClampedArray | Uint8Array, colorBits: 12 | 16 = 16): Uint16Array {
  const pixels = new Uint16Array(rgba.length / 4);
  for (let source = 0, target = 0; source < rgba.length; source += 4, target += 1) {
    const r8 = colorBits === 12 ? rgba[source] & 0xf0 : rgba[source];
    const g8 = colorBits === 12 ? rgba[source + 1] & 0xf0 : rgba[source + 1];
    const b8 = colorBits === 12 ? rgba[source + 2] & 0xf0 : rgba[source + 2];
    const r = r8 >> 3;
    const g = g8 >> 2;
    const b = b8 >> 3;
    pixels[target] = (r << 11) | (g << 5) | b;
  }
  return pixels;
}

export function encodeTextureFrame(
  current: Uint16Array,
  previous: Uint16Array | null,
  frameIndex: number,
  options: TextureEncodeOptions
): Uint8Array {
  const keyframe = previous === null || frameIndex % options.keyframeInterval === 0;
  if (keyframe) {
    const rle = encodeRgb565Rle(current);
    if (rle.byteLength >= current.byteLength) {
      const payload = new Uint8Array(1 + current.byteLength);
      payload[0] = PCV_TEXTURE_KEYFRAME;
      payload.set(new Uint8Array(current.buffer, current.byteOffset, current.byteLength), 1);
      return payload;
    }

    const payload = new Uint8Array(5 + rle.byteLength);
    payload[0] = PCV_TEXTURE_KEYFRAME_RLE;
    new DataView(payload.buffer).setUint32(1, current.length, true);
    payload.set(rle, 5);
    return payload;
  }

  const tiles: EncodedTile[] = [];
  let tileCount = 0;

  for (let y = 0; y < options.height; y += options.tileSize) {
    for (let x = 0; x < options.width; x += options.tileSize) {
      const tileWidth = Math.min(options.tileSize, options.width - x);
      const tileHeight = Math.min(options.tileSize, options.height - y);
      if (!tileChanged(current, previous, x, y, tileWidth, tileHeight, options)) continue;

      const tilePixels = new Uint16Array(tileWidth * tileHeight);
      const xorPixels = new Uint16Array(tileWidth * tileHeight);
      let pixelOffset = 0;
      for (let row = 0; row < tileHeight; row += 1) {
        const start = (y + row) * options.width + x;
        for (let col = 0; col < tileWidth; col += 1) {
          tilePixels[pixelOffset] = current[start + col];
          xorPixels[pixelOffset] = current[start + col] ^ previous[start + col];
          pixelOffset += 1;
        }
      }

      const motion = findMotionTile(current, previous, x, y, tileWidth, tileHeight, options);
      const xorRle = encodeRgb565Rle(xorPixels);
      const raw = new Uint8Array(tilePixels.buffer, tilePixels.byteOffset, tilePixels.byteLength);
      tiles.push({
        x,
        y,
        width: tileWidth,
        height: tileHeight,
        motion,
        data: xorRle.byteLength < raw.byteLength ? xorRle : new Uint8Array(raw),
        rawData: new Uint8Array(raw),
        rle: xorRle.byteLength < raw.byteLength
      });
      tileCount += 1;
    }
  }

  if (tiles.some((tile) => tile.motion)) {
    return encodeMotionDeltaTiles(tiles, tileCount);
  }

  if (tiles.some((tile) => !tile.rle)) {
    return encodeRawDeltaTiles(tiles, tileCount);
  }

  const byteLength = 3 + tiles.reduce((total, tile) => total + 8 + tile.data.byteLength, 0);
  const payload = new Uint8Array(byteLength);
  payload[0] = PCV_TEXTURE_DELTA_XOR_RLE;
  new DataView(payload.buffer).setUint16(1, tileCount, true);

  let offset = 3;
  const view = new DataView(payload.buffer);
  for (const tile of tiles) {
    view.setUint16(offset, tile.x, true);
    view.setUint16(offset + 2, tile.y, true);
    payload[offset + 4] = tile.width;
    payload[offset + 5] = tile.height;
    view.setUint16(offset + 6, tile.data.byteLength, true);
    offset += 8;
    payload.set(tile.data, offset);
    offset += tile.data.byteLength;
  }

  return payload;
}

type EncodedTile = {
  x: number;
  y: number;
  width: number;
  height: number;
  motion: { x: number; y: number } | null;
  data: Uint8Array;
  rawData: Uint8Array;
  rle: boolean;
};

function encodeMotionDeltaTiles(tiles: EncodedTile[], tileCount: number): Uint8Array {
  const byteLength =
    3 +
    tiles.reduce((total, tile) => {
      if (tile.motion) return total + 9;
      if (tile.rle) return total + 9 + tile.data.byteLength;
      return total + 8 + tile.rawData.byteLength;
    }, 0);
  const payload = new Uint8Array(byteLength);
  const view = new DataView(payload.buffer);
  payload[0] = PCV_TEXTURE_DELTA_MOTION;
  view.setUint16(1, tileCount, true);

  let offset = 3;
  for (const tile of tiles) {
    if (tile.motion) {
      payload[offset] = 1;
      view.setUint16(offset + 1, tile.x, true);
      view.setUint16(offset + 3, tile.y, true);
      payload[offset + 5] = tile.width;
      payload[offset + 6] = tile.height;
      view.setInt8(offset + 7, tile.motion.x - tile.x);
      view.setInt8(offset + 8, tile.motion.y - tile.y);
      offset += 9;
    } else if (tile.rle) {
      payload[offset] = 2;
      view.setUint16(offset + 1, tile.x, true);
      view.setUint16(offset + 3, tile.y, true);
      payload[offset + 5] = tile.width;
      payload[offset + 6] = tile.height;
      view.setUint16(offset + 7, tile.data.byteLength, true);
      offset += 9;
      payload.set(tile.data, offset);
      offset += tile.data.byteLength;
    } else {
      payload[offset] = 0;
      view.setUint16(offset + 1, tile.x, true);
      view.setUint16(offset + 3, tile.y, true);
      payload[offset + 5] = tile.width;
      payload[offset + 6] = tile.height;
      offset += 7;
      payload.set(tile.rawData, offset);
      offset += tile.rawData.byteLength;
    }
  }

  return payload;
}

function encodeRawDeltaTiles(tiles: EncodedTile[], tileCount: number): Uint8Array {
  const byteLength = 3 + tiles.reduce((total, tile) => total + 6 + tile.width * tile.height * 2, 0);
  const payload = new Uint8Array(byteLength);
  const view = new DataView(payload.buffer);
  payload[0] = PCV_TEXTURE_DELTA;
  view.setUint16(1, tileCount, true);

  let offset = 3;
  for (const tile of tiles) {
    view.setUint16(offset, tile.x, true);
    view.setUint16(offset + 2, tile.y, true);
    payload[offset + 4] = tile.width;
    payload[offset + 5] = tile.height;
    offset += 6;
    payload.set(tile.rawData, offset);
    offset += tile.rawData.byteLength;
  }

  return payload;
}

function findMotionTile(
  current: Uint16Array,
  previous: Uint16Array,
  x: number,
  y: number,
  tileWidth: number,
  tileHeight: number,
  options: TextureEncodeOptions
): { x: number; y: number } | null {
  let best: { x: number; y: number; mismatch: number } | null = null;
  const radius = options.motionSearchRadius;
  const searchStep = 2; // Fine-grained pixel-level search instead of coarse block-aligned search

  for (let dy = -radius; dy <= radius; dy += searchStep) {
    for (let dx = -radius; dx <= radius; dx += searchStep) {
      if (dx === 0 && dy === 0) continue;
      const sx = x + dx;
      const sy = y + dy;
      if (sx < 0 || sy < 0 || sx + tileWidth > options.width || sy + tileHeight > options.height) continue;
      const mismatch = tileMismatch(current, previous, x, y, sx, sy, tileWidth, tileHeight, options.width);
      if (!best || mismatch < best.mismatch) best = { x: sx, y: sy, mismatch };
    }
  }

  return best && best.mismatch <= options.motionMismatchThreshold ? { x: best.x, y: best.y } : null;
}

function tileMismatch(
  current: Uint16Array,
  previous: Uint16Array,
  x: number,
  y: number,
  sx: number,
  sy: number,
  tileWidth: number,
  tileHeight: number,
  width: number
): number {
  let changed = 0;
  const pixels = tileWidth * tileHeight;
  for (let row = 0; row < tileHeight; row += 1) {
    const currentStart = (y + row) * width + x;
    const previousStart = (sy + row) * width + sx;
    for (let col = 0; col < tileWidth; col += 1) {
      if (current[currentStart + col] !== previous[previousStart + col]) changed += 1;
    }
  }
  return changed / pixels;
}

function encodeRgb565Rle(pixels: Uint16Array): Uint8Array {
  const bytes: number[] = [];
  let index = 0;

  while (index < pixels.length) {
    const value = pixels[index];
    let run = 1;
    while (index + run < pixels.length && pixels[index + run] === value && run < 65535) {
      run += 1;
    }

    bytes.push(run & 0xff, run >> 8, value & 0xff, value >> 8);
    index += run;
  }

  return new Uint8Array(bytes);
}

function tileChanged(
  current: Uint16Array,
  previous: Uint16Array,
  x: number,
  y: number,
  tileWidth: number,
  tileHeight: number,
  options: TextureEncodeOptions
): boolean {
  let changed = 0;
  const pixels = tileWidth * tileHeight;

  for (let row = 0; row < tileHeight; row += 1) {
    const start = (y + row) * options.width + x;
    for (let col = 0; col < tileWidth; col += 1) {
      if (current[start + col] !== previous[start + col]) changed += 1;
    }
  }

  return changed / pixels >= options.changedThreshold;
}
