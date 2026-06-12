import { PCV_BYTES_PER_PARTICLE } from "../../shared/format";

export type SamplerOptions = {
  width: number;
  height: number;
  maxParticles: number;
  denseRgba?: boolean;
};

type PixelScore = {
  index: number;
  score: number;
};

export function sampleRgbaFrame(
  current: Uint8ClampedArray | Uint8Array,
  previous: Uint8ClampedArray | Uint8Array | null,
  options: SamplerOptions
): Uint8Array {
  if (options.denseRgba) {
    return new Uint8Array(current);
  }

  const visiblePixelCount = countVisiblePixels(current);
  if (options.maxParticles >= visiblePixelCount * 0.9) {
    return copyVisiblePixels(current, options);
  }

  return sampleHybrid(current, previous, options);
}

function sampleHybrid(
  current: Uint8ClampedArray | Uint8Array,
  previous: Uint8ClampedArray | Uint8Array | null,
  options: SamplerOptions
): Uint8Array {
  const baseCount = Math.max(1, Math.floor(options.maxParticles * 0.72));
  const particles = new Uint8Array(options.maxParticles * PCV_BYTES_PER_PARTICLE);
  const used = new Uint8Array(options.width * options.height);
  let particleIndex = writeGridParticles(current, options, particles, used, baseCount);
  const scores = scorePixels(current, previous, options.width, options.height);
  scores.sort((a, b) => b.score - a.score);

  for (let i = 0; i < scores.length && particleIndex < options.maxParticles; i += 1) {
    const sourceIndex = scores[i].index;
    if (used[sourceIndex]) continue;
    const x = sourceIndex % options.width;
    const y = Math.floor(sourceIndex / options.width);
    const pixel = sourceIndex * 4;
    const target = particleIndex * PCV_BYTES_PER_PARTICLE;

    writeParticle(particles, target, x, y, current, pixel, options);
    used[sourceIndex] = 1;
    particleIndex += 1;
  }

  return particles.subarray(0, particleIndex * PCV_BYTES_PER_PARTICLE);
}

function writeGridParticles(
  current: Uint8ClampedArray | Uint8Array,
  options: SamplerOptions,
  particles: Uint8Array,
  used: Uint8Array,
  maxCount: number
): number {
  const targetRatio = Math.sqrt((options.width * options.height) / maxCount);
  const step = Math.max(1, Math.floor(targetRatio));
  let particleIndex = 0;

  for (let pass = 0; pass < step && particleIndex < maxCount; pass += 1) {
    for (let y = pass; y < options.height && particleIndex < maxCount; y += step) {
      for (let x = pass; x < options.width && particleIndex < maxCount; x += step) {
        const sourceIndex = y * options.width + x;
        const pixel = (y * options.width + x) * 4;
        if (current[pixel + 3] === 0) continue;
        writeParticle(particles, particleIndex * PCV_BYTES_PER_PARTICLE, x, y, current, pixel, options);
        used[sourceIndex] = 1;
        particleIndex += 1;
      }
    }
  }

  return particleIndex;
}

function countVisiblePixels(current: Uint8ClampedArray | Uint8Array): number {
  let count = 0;
  for (let pixel = 0; pixel < current.length; pixel += 4) {
    if (current[pixel + 3] !== 0) count += 1;
  }
  return count;
}

function copyVisiblePixels(current: Uint8ClampedArray | Uint8Array, options: SamplerOptions): Uint8Array {
  const count = Math.min(options.maxParticles, countVisiblePixels(current));
  const particles = new Uint8Array(count * PCV_BYTES_PER_PARTICLE);
  let particleIndex = 0;

  for (let y = 0; y < options.height && particleIndex < count; y += 1) {
    for (let x = 0; x < options.width && particleIndex < count; x += 1) {
      const pixel = (y * options.width + x) * 4;
      if (current[pixel + 3] === 0) continue;

      const target = particleIndex * PCV_BYTES_PER_PARTICLE;
      writeParticle(particles, target, x, y, current, pixel, options);
      particleIndex += 1;
    }
  }

  return particles;
}

function writeParticle(
  particles: Uint8Array,
  target: number,
  x: number,
  y: number,
  current: Uint8ClampedArray | Uint8Array,
  pixel: number,
  options: SamplerOptions
): void {
  const quantizedX = Math.round((x / Math.max(1, options.width - 1)) * 65535);
  const quantizedY = Math.round((y / Math.max(1, options.height - 1)) * 65535);
  particles[target] = quantizedX & 0xff;
  particles[target + 1] = quantizedX >> 8;
  particles[target + 2] = quantizedY & 0xff;
  particles[target + 3] = quantizedY >> 8;
  particles[target + 4] = current[pixel];
  particles[target + 5] = current[pixel + 1];
  particles[target + 6] = current[pixel + 2];
  particles[target + 7] = current[pixel + 3];
}

function scorePixels(
  current: Uint8ClampedArray | Uint8Array,
  previous: Uint8ClampedArray | Uint8Array | null,
  width: number,
  height: number
): PixelScore[] {
  const scores: PixelScore[] = [];

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = (y * width + x) * 4;
      const alpha = current[pixel + 3];
      if (alpha === 0) continue;

      const r = current[pixel];
      const g = current[pixel + 1];
      const b = current[pixel + 2];
      const luma = (r * 54 + g * 183 + b * 19) >> 8;

      let edge = 0;
      if (x > 0 && x < width - 1 && y > 0 && y < height - 1) {
        const left = (y * width + x - 1) * 4;
        const right = (y * width + x + 1) * 4;
        const up = ((y - 1) * width + x) * 4;
        const down = ((y + 1) * width + x) * 4;
        edge =
          Math.abs(current[left] - current[right]) +
          Math.abs(current[up + 1] - current[down + 1]) +
          Math.abs(current[left + 2] - current[right + 2]);
      }

      let motion = 0;
      if (previous) {
        motion =
          Math.abs(r - previous[pixel]) +
          Math.abs(g - previous[pixel + 1]) +
          Math.abs(b - previous[pixel + 2]);
      }

      const spread = ((x * 17 + y * 31) % 11) * 3;
      scores.push({ index: y * width + x, score: motion * 3 + edge * 2 + luma + spread });
    }
  }

  return scores;
}
