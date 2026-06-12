import type { DecodedFrame } from "../../shared/format";
import type { RenderMode } from "./WebGLPointRenderer";

export interface PointRenderer {
  setSourceSize(width: number, height: number): void;
  render(frame: DecodedFrame): void;
  clear(): void;
  setMode(mode: RenderMode): void;
  setPointSize(size: number): void;
}
