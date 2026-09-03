import { fft, nextPowerOfTwo } from './fft.js';
import { gaussian, mulberry32 } from './rng.js';

export interface WattersonProfile {
  name: string;
  delayMs: number;
  dopplerHz: number;
}

/** ITU-R F.1487 mid-latitude reference channels. */
export const ITU_PROFILES: Record<string, WattersonProfile> = {
  good: { name: 'CCIR Good', delayMs: 0.5, dopplerHz: 0.1 },
  moderate: { name: 'CCIR Moderate', delayMs: 1.0, dopplerHz: 0.5 },
  poor: { name: 'CCIR Poor', delayMs: 2.0, dopplerHz: 1.0 },
  worst: { name: 'CCIR Worst', delayMs: 4.0, dopplerHz: 2.0 },
};

export interface ChannelOptions {
  sampleRate: number;
  snrDb: number;
  profile?: WattersonProfile | null;
  seed?: number;
  noiseBandwidthHz?: number;
  /** Power of the active burst; pass it when the buffer contains long silent lead-ins. */
  referencePower?: number;
}

function analytic(signal: Float32Array): { re: Float64Array; im: Float64Array } {
  const n = nextPowerOfTwo(signal.length);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  re.set(signal);

  fft(re, im);
  const half = n / 2;
  for (let k = 1; k < half; k++) {
    re[k]! *= 2;
    im[k]! *= 2;
  }
  for (let k = half + 1; k < n; k++) {
    re[k] = 0;
    im[k] = 0;
  }
  fft(re, im, true);
  return { re, im };
}

/**
 * Gaussian-shaped Doppler spectrum, generated at a low rate and interpolated,
 * which is far cheaper than synthesising it at the audio sample rate.
 */
function fadingProcess(
  samples: number,
  sampleRate: number,
  dopplerHz: number,
  rand: () => number
): { re: Float64Array; im: Float64Array } {
  const fadeRate = 64;
  const count = nextPowerOfTwo(Math.ceil((samples / sampleRate) * fadeRate) + 4);

  const re = new Float64Array(count);
  const im = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    re[i] = gaussian(rand);
    im[i] = gaussian(rand);
  }

  fft(re, im);
  const sigma = Math.max(dopplerHz / 2, 1e-6);
  for (let k = 0; k < count; k++) {
    const f = (k <= count / 2 ? k : k - count) * (fadeRate / count);
    const h = Math.exp(-(f * f) / (2 * sigma * sigma));
    re[k]! *= h;
    im[k]! *= h;
  }
  fft(re, im, true);

  let power = 0;
  for (let i = 0; i < count; i++) power += re[i]! * re[i]! + im[i]! * im[i]!;
  const norm = Math.sqrt(count / Math.max(power, 1e-30));
  for (let i = 0; i < count; i++) {
    re[i]! *= norm;
    im[i]! *= norm;
  }

  const outRe = new Float64Array(samples);
  const outIm = new Float64Array(samples);
  const step = fadeRate / sampleRate;
  for (let n = 0; n < samples; n++) {
    const x = n * step;
    const i0 = Math.min(Math.floor(x), count - 2);
    const frac = x - i0;
    outRe[n] = re[i0]! * (1 - frac) + re[i0 + 1]! * frac;
    outIm[n] = im[i0]! * (1 - frac) + im[i0 + 1]! * frac;
  }
  return { re: outRe, im: outIm };
}

export function meanPower(signal: Float32Array): number {
  let power = 0;
  for (const v of signal) power += v * v;
  return power / Math.max(signal.length, 1);
}

export function applyChannel(signal: Float32Array, opts: ChannelOptions): Float32Array {
  const { sampleRate, snrDb, profile = null, seed = 1, noiseBandwidthHz = 3000, referencePower } = opts;
  const rand = mulberry32(seed);
  const out = new Float32Array(signal.length);

  if (!profile) {
    out.set(signal);
  } else {
    const { re, im } = analytic(signal);
    const delay = Math.round((profile.delayMs / 1000) * sampleRate);
    const p1 = fadingProcess(signal.length, sampleRate, profile.dopplerHz, rand);
    const p2 = fadingProcess(signal.length, sampleRate, profile.dopplerHz, rand);

    for (let n = 0; n < signal.length; n++) {
      let acc = re[n]! * p1.re[n]! - im[n]! * p1.im[n]!;
      const d = n - delay;
      if (d >= 0) acc += re[d]! * p2.re[n]! - im[d]! * p2.im[n]!;
      out[n] = acc / Math.SQRT2;
    }
  }

  let power = referencePower;
  if (power === undefined) {
    power = 0;
    for (const v of out) power += v * v;
    power /= Math.max(out.length, 1);
  }

  const snrLinear = 10 ** (snrDb / 10);
  const noiseVar = (power * (sampleRate / 2)) / (noiseBandwidthHz * snrLinear);
  const noiseSigma = Math.sqrt(Math.max(noiseVar, 0));
  for (let n = 0; n < out.length; n++) out[n]! += noiseSigma * gaussian(rand);

  return out;
}
