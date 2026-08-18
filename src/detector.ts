import { NUM_TONES, SAMPLE_RATE, toneFreq } from './config.js';

/** Rectangular window on purpose: a Hann window's main lobe is wider than the 17.6 Hz tone spacing. */
export function goertzelPower(
  samples: Float32Array,
  offset: number,
  length: number,
  freq: number,
  sampleRate: number
): number {
  const coeff = 2 * Math.cos((2 * Math.PI * freq) / sampleRate);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < length; i++) {
    const s0 = samples[offset + i]! + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2;
}

export interface ToneEstimate {
  symbol: number;
  db: number;
  amplitudes: Float64Array;
}

export class ToneDetector {
  private readonly freqs: Float64Array;
  private readonly amplitudes: Float64Array;

  constructor(private readonly sampleRate: number = SAMPLE_RATE) {
    this.freqs = new Float64Array(NUM_TONES);
    this.amplitudes = new Float64Array(NUM_TONES);
    for (let s = 0; s < NUM_TONES; s++) this.freqs[s] = toneFreq(s);
  }

  detect(samples: Float32Array, offset: number, length: number): ToneEstimate {
    let best = -1;
    let bestAmp = 0;
    for (let s = 0; s < NUM_TONES; s++) {
      const power = goertzelPower(samples, offset, length, this.freqs[s]!, this.sampleRate);
      const amp = (2 * Math.sqrt(Math.max(power, 0))) / length;
      this.amplitudes[s] = amp;
      if (amp > bestAmp) {
        bestAmp = amp;
        best = s;
      }
    }
    return {
      symbol: best,
      db: 20 * Math.log10(Math.max(bestAmp, 1e-10)),
      amplitudes: this.amplitudes,
    };
  }
}
