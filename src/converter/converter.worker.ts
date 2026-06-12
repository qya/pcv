// Polyfill AudioBuffer for Web Worker contexts where it is not defined
if (typeof (globalThis as any).AudioBuffer === "undefined") {
  (globalThis as any).AudioBuffer = class AudioBuffer {
    sampleRate: number;
    numberOfChannels: number;
    length: number;
    duration: number;
    _channels: Float32Array[];

    constructor(options: { numberOfChannels: number; length: number; sampleRate: number }) {
      this.numberOfChannels = options.numberOfChannels;
      this.length = options.length;
      this.sampleRate = options.sampleRate;
      this.duration = options.length / options.sampleRate;
      this._channels = Array.from({ length: options.numberOfChannels }, () => new Float32Array(options.length));
    }

    getChannelData(channel: number) {
      if (channel >= this.numberOfChannels) {
        throw new Error("IndexSizeError");
      }
      return this._channels[channel];
    }

    copyFromChannel(destination: Float32Array, channelNumber: number, startInChannel = 0) {
      const source = this._channels[channelNumber];
      destination.set(source.subarray(startInChannel, startInChannel + destination.length));
    }

    copyToChannel(source: Float32Array, channelNumber: number, startInChannel = 0) {
      const dest = this._channels[channelNumber];
      dest.set(source, startInChannel);
    }
  };
}

import { localConvertVideoToPcv } from "./browserPcvConverterCore";

self.onmessage = async (event: MessageEvent) => {
  const { options, wasmUrl } = event.data;

  try {
    const workerOptions = {
      ...options,
      onProgress: (progress: any) => {
        self.postMessage({ type: "progress", progress });
      },
      onDebug: (debug: any) => {
        self.postMessage({ type: "debug", debug });
      }
    };

    const result = await localConvertVideoToPcv(workerOptions, wasmUrl);

    // Send back the raw Blob. The main thread will create the URL to avoid Worker context issues.
    self.postMessage({
      type: "done",
      result: {
        blob: result.blob,
        fileName: result.fileName,
        frameCount: result.frameCount,
        width: result.width,
        height: result.height,
        fps: result.fps,
        maxParticles: result.maxParticles,
        audio: result.audio
      }
    });
  } catch (err) {
    self.postMessage({
      type: "error",
      error: err instanceof Error ? err.message : String(err)
    });
  }
};
