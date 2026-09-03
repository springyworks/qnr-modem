/**
 * Windowed-sinc resampler. Audio relayed through a WebSDR or a stream recorder rarely arrives
 * at 48 kHz, and the tone comb reaches 3 kHz, so linear interpolation would fold audible images
 * straight onto the data tones.
 */
const LOBES = 12;
/** Fractional delays are quantised into a tap table; 1/1024 of a sample is far below the noise. */
const PHASES = 1024;

function blackman(x: number): number {
  const t = (x + 1) / 2;
  return 0.42 - 0.5 * Math.cos(2 * Math.PI * t) + 0.08 * Math.cos(4 * Math.PI * t);
}

function sinc(x: number): number {
  if (x === 0) return 1;
  const pix = Math.PI * x;
  return Math.sin(pix) / pix;
}

export function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to || input.length === 0) return input;

  const ratio = to / from;
  // Decimation has to move the anti-alias cutoff down to the new Nyquist.
  const cutoff = Math.min(1, ratio);
  const half = Math.ceil(LOBES / cutoff);
  const taps = 2 * half + 1;
  const span = half + 1;

  const table = new Float64Array(PHASES * taps);
  for (let p = 0; p < PHASES; p++) {
    const base = p * taps;
    let sum = 0;
    for (let k = 0; k < taps; k++) {
      const t = p / PHASES + half - k;
      const tap = sinc(cutoff * t) * blackman(t / span);
      table[base + k] = tap;
      sum += tap;
    }
    // Unity DC gain per phase keeps the passband flat without trusting the window's algebra.
    if (sum !== 0) for (let k = 0; k < taps; k++) table[base + k]! /= sum;
  }

  const outLength = Math.floor(input.length * ratio);
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const center = i / ratio;
    const start = Math.floor(center);
    const base = Math.min(PHASES - 1, Math.floor((center - start) * PHASES)) * taps;
    const first = start - half;
    let acc = 0;
    for (let k = 0; k < taps; k++) {
      const n = first + k;
      if (n >= 0 && n < input.length) acc += input[n]! * table[base + k]!;
    }
    out[i] = acc;
  }

  return out;
}
