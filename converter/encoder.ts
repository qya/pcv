import { gzipSync } from "node:zlib";
import { PCV_FLAG_DENSE_RGBA, PCV_HEADER_SIZE, type PCVHeader, writeHeader, encodeFrame } from "../shared/format";

export function encodePCV(header: PCVHeader, frames: Uint8Array[]): Buffer {
  const headerBuffer = new ArrayBuffer(PCV_HEADER_SIZE);
  writeHeader(new DataView(headerBuffer), header);

  const denseRgba = (header.flags & PCV_FLAG_DENSE_RGBA) !== 0;
  const encodedFrames = frames.map((frame) => encodeFrame(frame, denseRgba ? header.particleCount : undefined));
  const totalBytes =
    PCV_HEADER_SIZE + encodedFrames.reduce((total, frame) => total + frame.byteLength, 0);
  const file = new Uint8Array(totalBytes);

  file.set(new Uint8Array(headerBuffer), 0);
  let offset = PCV_HEADER_SIZE;
  for (const frame of encodedFrames) {
    file.set(frame, offset);
    offset += frame.byteLength;
  }

  return gzipSync(file, { level: 9 });
}
