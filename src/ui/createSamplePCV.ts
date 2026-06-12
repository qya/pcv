import { gzipSync } from "fflate";
import { encodeFrame, PCV_HEADER_SIZE, writeHeader } from "../../shared/format";

export function createSamplePCVUrl(): string {
  const width = 160;
  const height = 90;
  const fps = 30;
  const frameCount = 120;
  const particleCount = 5000;
  const header = new ArrayBuffer(PCV_HEADER_SIZE);
  writeHeader(new DataView(header), {
    width,
    height,
    fps,
    frameCount,
    particleCount,
    flags: 1
  });

  const parts: Uint8Array[] = [new Uint8Array(header)];
  for (let frame = 0; frame < frameCount; frame += 1) {
    const particles = new Uint8Array(particleCount * 8);
    for (let i = 0; i < particleCount; i += 1) {
      const angle = i * 0.041 + frame * 0.045;
      const radius = 0.12 + ((i % 997) / 997) * 0.38;
      const wave = Math.sin(frame * 0.07 + i * 0.013) * 0.08;
      const x = 0.5 + Math.cos(angle) * (radius + wave);
      const y = 0.5 + Math.sin(angle * 1.37) * radius;
      const offset = i * 8;
      const qx = Math.max(0, Math.min(65535, Math.round(x * 65535)));
      const qy = Math.max(0, Math.min(65535, Math.round(y * 65535)));
      particles[offset] = qx & 0xff;
      particles[offset + 1] = qx >> 8;
      particles[offset + 2] = qy & 0xff;
      particles[offset + 3] = qy >> 8;
      particles[offset + 4] = 70 + ((i + frame * 2) % 180);
      particles[offset + 5] = 120 + ((i * 3 + frame) % 120);
      particles[offset + 6] = 180 + ((i * 7 + frame * 5) % 70);
      particles[offset + 7] = 230;
    }
    parts.push(encodeFrame(particles));
  }

  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const file = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    file.set(part, offset);
    offset += part.byteLength;
  }

  const compressed = gzipSync(file, { level: 9 });
  const blob = new Blob([compressed], { type: "application/octet-stream" });
  return URL.createObjectURL(blob);
}
