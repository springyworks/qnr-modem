import { NUM_TONES, SAMPLE_RATE, SYM_SYNC_1, SYM_SYNC_2, symbolSamples, toneFreq } from './config.js';
import { goertzelPower } from './detector.js';

export interface SpectroGeometry {
  windowLen: number;
  hop: number;
  windows: number;
}

export interface Spectrogram extends SpectroGeometry {
  /** Tone power laid out as power[window * NUM_TONES + tone]. */
  power: Float64Array;
}

export function spectroGeometry(
  sampleCount: number,
  baud: number,
  sampleRate: number = SAMPLE_RATE
): SpectroGeometry {
  const spb = symbolSamples(baud, sampleRate);
  const windowLen = Math.min(spb, 8192, Math.max(2048, Math.floor(spb * 0.75)));
  const hop = Math.max(1, Math.floor(spb / 8));
  return { windowLen, hop, windows: Math.floor((sampleCount - windowLen) / hop) + 1 };
}

/** Same scaling the tone detector uses, so soft metrics are unchanged by where this runs. */
function tonePower(samples: Float32Array, at: number, len: number, freq: number, sampleRate: number): number {
  const amp = (2 * Math.sqrt(Math.max(goertzelPower(samples, at, len, freq, sampleRate), 0))) / len;
  return amp * amp;
}

/**
 * Fills one slice of the tone comb. Slicing by tone is what makes the bank parallel:
 * every worker walks the same samples and writes disjoint columns, so the result is
 * bit-identical to computing the whole thing on one core.
 */
export function fillSpectrogram(
  samples: Float32Array,
  geom: SpectroGeometry,
  sampleRate: number,
  offsetHz: number,
  toneStart: number,
  toneEnd: number,
  out: Float64Array
): void {
  const { windowLen, hop, windows } = geom;
  for (let s = toneStart; s < toneEnd; s++) {
    const freq = toneFreq(s, offsetHz);
    for (let w = 0; w < windows; w++) {
      out[w * NUM_TONES + s] = tonePower(samples, w * hop, windowLen, freq, sampleRate);
    }
  }
}

export function fullSpectrogram(
  samples: Float32Array,
  geom: SpectroGeometry,
  sampleRate: number,
  offsetHz = 0
): Spectrogram {
  const power = new Float64Array(geom.windows * NUM_TONES);
  fillSpectrogram(samples, geom, sampleRate, offsetHz, 0, NUM_TONES, power);
  return { ...geom, power };
}

/**
 * Only the two preamble tones, laid out as sync[window * 2 + parity]. Acquisition needs
 * nothing else, so scanning tuning offsets costs 2/144 of a full spectrogram per offset.
 */
export function syncSpectrogram(
  samples: Float32Array,
  geom: SpectroGeometry,
  sampleRate: number,
  offsetHz: number
): Float64Array {
  const { windowLen, hop, windows } = geom;
  const out = new Float64Array(windows * 2);
  const freqs = [toneFreq(SYM_SYNC_1, offsetHz), toneFreq(SYM_SYNC_2, offsetHz)];
  for (let t = 0; t < 2; t++) {
    const freq = freqs[t]!;
    for (let w = 0; w < windows; w++) {
      out[w * 2 + t] = tonePower(samples, w * hop, windowLen, freq, sampleRate);
    }
  }
  return out;
}

/** Workers read the audio in place; copying 27 MB per task would cost more than the DSP. */
export function sharedSamples(samples: Float32Array): Float32Array {
  const view = new Float32Array(new SharedArrayBuffer(samples.length * 4));
  view.set(samples);
  return view;
}

export function sharedPower(geom: SpectroGeometry): Float64Array {
  return new Float64Array(new SharedArrayBuffer(geom.windows * NUM_TONES * 8));
}
