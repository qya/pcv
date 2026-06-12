import {
  BrowserConverterOptions,
  BrowserConverterResult,
  BrowserConverterProgress,
  BrowserConverterDebugEvent,
  VideoMetadataProbe,
  probeVideoMetadata,
  resolveOutputSize
} from "./browserPcvConverterCore";
// @ts-ignore
import ConverterWorker from "./converter.worker.ts?worker";
// @ts-ignore
import wasmUrl from "../wasm-encoder/wasm_encoder_bg.wasm?url";

export type {
  BrowserConverterOptions,
  BrowserConverterResult,
  BrowserConverterProgress,
  BrowserConverterDebugEvent,
  VideoMetadataProbe
};
export { probeVideoMetadata, resolveOutputSize };

export async function convertVideoToPcvInBrowser(
  options: BrowserConverterOptions
): Promise<BrowserConverterResult> {
  return new Promise((resolve, reject) => {
    const worker = new ConverterWorker();

    const { onProgress, onDebug, ...serializableOptions } = options;

    worker.onmessage = (event: MessageEvent) => {
      const message = event.data;
      if (message.type === "progress") {
        onProgress?.(message.progress);
      } else if (message.type === "debug") {
        onDebug?.(message.debug);
      } else if (message.type === "done") {
        const result = message.result;
        const url = URL.createObjectURL(result.blob);
        worker.terminate();
        resolve({
          ...result,
          url
        });
      } else if (message.type === "error") {
        worker.terminate();
        reject(new Error(message.error));
      }
    };

    worker.onerror = (err: any) => {
      worker.terminate();
      reject(err);
    };

    worker.postMessage({
      options: serializableOptions,
      wasmUrl
    });
  });
}
