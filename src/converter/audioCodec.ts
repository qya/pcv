import { AudioBufferSink, type InputAudioTrack } from "mediabunny";
import { PCV_AUDIO_MAGIC } from "../../shared/format";

export type EncodedAudioBlock = {
  block: Uint8Array;
  sampleRate: number;
  channels: number;
  frameCount: number;
};

export async function encodePcmAudioBlock(audioTrack: InputAudioTrack | null) {
  if (!audioTrack) return null;

  const canDecode = await audioTrack.canDecode();
  if (!canDecode) return null;

  const sink = new AudioBufferSink(audioTrack);
  const chunks: Int16Array[] = [];
  let sampleRate = await audioTrack.getSampleRate();
  let channels = Math.min(2, Math.max(1, await audioTrack.getNumberOfChannels()));
  let frameCount = 0;

  for await (const wrapped of sink.buffers()) {
    const buffer = wrapped.buffer;
    sampleRate = buffer.sampleRate;
    channels = Math.min(2, buffer.numberOfChannels);
    const chunk = new Int16Array(buffer.length * channels);

    for (let frame = 0; frame < buffer.length; frame += 1) {
      for (let channel = 0; channel < channels; channel += 1) {
        const source = buffer.getChannelData(channel)[frame] ?? 0;
        chunk[frame * channels + channel] = floatToPcm16(source);
      }
    }

    chunks.push(chunk);
    frameCount += buffer.length;
  }

  if (frameCount === 0) return null;

  const adpcm = encodeAdpcm(chunks, channels);
  const adpcmHeaderBytes = channels * 4;
  const byteLength = 20 + adpcmHeaderBytes + adpcm.payload.byteLength;
  const block = new Uint8Array(byteLength);
  const view = new DataView(block.buffer);
  view.setUint32(0, PCV_AUDIO_MAGIC, true);
  view.setUint32(4, 20, true);
  view.setUint32(8, sampleRate, true);
  view.setUint16(12, channels, true);
  view.setUint16(14, 4, true);
  view.setUint32(16, frameCount, true);

  let byteOffset = 20;
  for (let channel = 0; channel < channels; channel += 1) {
    view.setInt16(byteOffset, adpcm.predictors[channel], true);
    block[byteOffset + 2] = adpcm.indices[channel];
    block[byteOffset + 3] = 0;
    byteOffset += 4;
  }
  block.set(adpcm.payload, byteOffset);

  return { block, sampleRate, channels, frameCount } satisfies EncodedAudioBlock;
}

function floatToPcm16(value: number): number {
  const clamped = Math.max(-1, Math.min(1, value));
  return clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
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

function encodeAdpcm(chunks: Int16Array[], channels: number) {
  const predictors = new Int16Array(channels);
  const indices = new Uint8Array(channels);
  const nibbles: number[] = [];

  let first = true;
  const states = Array.from({ length: channels }, () => ({ predictor: 0, index: 0 }));

  for (const chunk of chunks) {
    for (let frame = 0; frame < chunk.length / channels; frame += 1) {
      for (let channel = 0; channel < channels; channel += 1) {
        const sample = chunk[frame * channels + channel];
        const state = states[channel];
        if (first) {
          state.predictor = sample;
          predictors[channel] = sample;
          nibbles.push(0);
          continue;
        }
        nibbles.push(encodeNibble(sample, state));
      }
      first = false;
    }
  }

  const payload = new Uint8Array(Math.ceil(nibbles.length / 2));
  for (let index = 0; index < nibbles.length; index += 1) {
    if (index & 1) payload[index >> 1] |= nibbles[index] << 4;
    else payload[index >> 1] = nibbles[index];
  }

  for (let channel = 0; channel < channels; channel += 1) {
    indices[channel] = states[channel].index;
  }

  return { predictors, indices, payload };
}

function encodeNibble(sample: number, state: { predictor: number; index: number }): number {
  let step = ADPCM_STEP_TABLE[state.index];
  let diff = sample - state.predictor;
  let nibble = 0;
  if (diff < 0) {
    nibble = 8;
    diff = -diff;
  }

  let delta = step >> 3;
  if (diff >= step) {
    nibble |= 4;
    diff -= step;
    delta += step;
  }
  if (diff >= step >> 1) {
    nibble |= 2;
    diff -= step >> 1;
    delta += step >> 1;
  }
  if (diff >= step >> 2) {
    nibble |= 1;
    delta += step >> 2;
  }

  state.predictor += nibble & 8 ? -delta : delta;
  state.predictor = Math.max(-32768, Math.min(32767, state.predictor));
  state.index = Math.max(0, Math.min(88, state.index + ADPCM_INDEX_TABLE[nibble & 7]));
  return nibble;
}
