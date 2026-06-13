import type { PointRenderer } from "./PointRenderer";
import { WebGLPointRenderer } from "./WebGLPointRenderer";
import { WebGPUPointRenderer } from "./WebGPUPointRenderer";

export async function createRenderer(canvas: HTMLCanvasElement): Promise<PointRenderer> {
  if (navigator.gpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) {
        const device = await adapter.requestDevice();
        const renderer = new WebGPUPointRenderer(canvas, device, adapter);
        console.log("Successfully initialized WebGPU renderer!");
        return renderer;
      }
    } catch (e) {
      console.warn("Failed to initialize WebGPU renderer, falling back to WebGL2:", e);
    }
  }
  console.log("Initializing fallback WebGL2 renderer...");
  return new WebGLPointRenderer({ canvas });
}
