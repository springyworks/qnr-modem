import {
  BITS_PER_SYMBOL,
  DATA_TONES,
  NUM_TONES,
  SAMPLE_RATE,
  SYM_SYNC_1,
  SYM_SYNC_2,
  symbolSamples,
} from './config.js';
import { TAIL_BITS, viterbiDecode, type CodeRate } from './conv.js';
import { decodeTieredFrame, LENGTH_BITS, parseInfoBits } from './framing.js';
import { deinterleave } from './interleave.js';
import { fullSpectrogram, spectroGeometry, type Spectrogram } from './spectro.js';

/** Symbols a frame occupies, derived from the protocol rather than detected. */
export function dataSymbolCount(messageBytes: number, rate: CodeRate): number {
  const infoBits = LENGTH_BITS + messageBytes * 8 + 16 + TAIL_BITS;
  return Math.ceil((infoBits * rate) / BITS_PER_SYMBOL);
}

export interface FoldOptions {
  baud: number;
  /** Burst length + listening gap, in samples. Known by protocol, so folding needs no absolute start. */
  periodSamples: number;
  /** Absolute index of sample zero. Lets a live receiver preserve its world-time slot grid. */
  sampleOffset?: number;
  preamblePairs: number;
  dataSymbols: number;
  interleaverWidth: number;
  rate: CodeRate;
  candidates?: number;
  sampleRate?: number;
  /** Tuning error of the received signal in Hz; shifts the whole tone comb. */
  offsetHz?: number;
  /** Receiver clock error against the transmitter; stretches both the period and the symbols. */
  driftPpm?: number;
  /** Protocol's payload ceiling; every length from here down to 1 byte is tried against CRC-16. */
  payloadBytes?: number;
  /** Length of one burst; lets the receiver work out the least audio worth an attempt. */
  burstSamples?: number;
}

export interface FoldResult {
  text: string;
  /** Preamble matched-filter score of the winning slot, in units of the noise floor. */
  score: number;
  offsetHz: number;
  driftPpm: number;
  /** Preamble position modulo the repeat period, in absolute samples. */
  phaseSamples?: number;
  /** Number of complete bursts whose soft evidence was combined. */
  bursts?: number;
}

const NOTHING = (opts: FoldOptions, score = 0): FoldResult => ({
  text: '',
  score,
  offsetHz: opts.offsetHz ?? 0,
  driftPpm: opts.driftPpm ?? 0,
});

/** Median tone power approximates the noise floor without being dragged up by the signal tone. */
function medianFloor(buf: Float64Array, base: number, scratch: Float64Array): number {
  for (let s = 0; s < NUM_TONES; s++) scratch[s] = buf[base + s]!;
  scratch.sort();
  return Math.max(scratch[NUM_TONES >> 1]!, 1e-20);
}

/** Per-window noise floors. Hoisted out of the candidate loop so a drift sweep stays cheap. */
export function noiseFloors(spec: Spectrogram): Float64Array {
  const out = new Float64Array(spec.windows);
  const scratch = new Float64Array(NUM_TONES);
  for (let w = 0; w < spec.windows; w++) out[w] = medianFloor(spec.power, w * NUM_TONES, scratch);
  return out;
}

/**
 * Exact repeat correlation. Bursts recur at a known period, so tone powers are folded
 * modulo that period, the preamble is found by matched filtering that folded view, and
 * the per-burst soft metrics are then summed. Folding carries acquisition; summing LLRs
 * across independent fades is what buys the diversity gain.
 *
 * Windows are mapped by absolute sample position, so a fractional period never accumulates
 * rounding error across the schedule and clock drift can be searched as a plain parameter.
 */
export function decodeSpectrogram(
  spec: Spectrogram,
  opts: FoldOptions,
  floors: Float64Array = noiseFloors(spec)
): FoldResult {
  return decodeSpectrogramAll(spec, opts, floors)[0] ?? NOTHING(opts);
}

/**
 * Decodes every distinct CRC-valid frame in a folded recording. Each preamble phase owns its
 * own LLR vector, so interleaved stations remain separate while every repeat of that station
 * contributes its likelihoods before the FEC decoder is called.
 */
export function decodeSpectrogramAll(
  spec: Spectrogram,
  opts: FoldOptions,
  floors: Float64Array = noiseFloors(spec)
): FoldResult[] {
  const { power, windows, hop } = spec;
  if (windows <= 0) return [];

  const sampleRate = opts.sampleRate ?? SAMPLE_RATE;
  const sampleOffset = opts.sampleOffset ?? 0;
  const stretch = 1 + (opts.driftPpm ?? 0) / 1e6;
  const period = opts.periodSamples * stretch;
  const spb = symbolSamples(opts.baud, sampleRate) * stretch;
  const preambleSymbols = opts.preamblePairs * 2;
  const periodWindows = Math.max(1, Math.round(period / hop));
  const modulo = (value: number, divisor: number): number => ((value % divisor) + divisor) % divisor;
  const slotAt = (pos: number): number => Math.round(modulo(pos, period) / hop) % periodWindows;

  const folded = new Float64Array(periodWindows * NUM_TONES);
  const hits = new Int32Array(periodWindows);
  for (let w = 0; w < windows; w++) {
    const src = w * NUM_TONES;
    const slot = slotAt(sampleOffset + w * hop);
    const dst = slot * NUM_TONES;
    for (let s = 0; s < NUM_TONES; s++) folded[dst + s]! += power[src + s]!;
    hits[slot]!++;
  }

  const scratch = new Float64Array(NUM_TONES);
  const foldFloor = new Float64Array(periodWindows);
  for (let slot = 0; slot < periodWindows; slot++) {
    const n = Math.max(1, hits[slot]!);
    const dst = slot * NUM_TONES;
    for (let s = 0; s < NUM_TONES; s++) folded[dst + s]! /= n;
    foldFloor[slot] = medianFloor(folded, dst, scratch);
  }

  // Matched filter on the known alternating preamble, evaluated over the folded period.
  const scores: Array<{ slot: number; score: number }> = [];
  for (let slot = 0; slot < periodWindows; slot++) {
    let score = 0;
    for (let j = 0; j < preambleSymbols; j++) {
      const at = slotAt(slot * hop + j * spb);
      const tone = j % 2 === 0 ? SYM_SYNC_1 : SYM_SYNC_2;
      score += folded[at * NUM_TONES + tone]! / foldFloor[at]!;
    }
    scores.push({ slot, score });
  }
  scores.sort((a, b) => b.score - a.score);

  const softInto = (w: number, out: Float64Array, offset: number): void => {
    const base = w * NUM_TONES;
    const n = floors[w]!;
    for (let b = 0; b < BITS_PER_SYMBOL; b++) {
      let one = 0;
      let zero = 0;
      for (let s = 0; s < DATA_TONES; s++) {
        const m = power[base + s]! / n;
        if ((s >> (BITS_PER_SYMBOL - 1 - b)) & 1) {
          if (m > one) one = m;
        } else if (m > zero) zero = m;
      }
      out[offset + b]! += one - zero;
    }
  };

  const bits = opts.dataSymbols * BITS_PER_SYMBOL;
  const top = Math.min(opts.candidates ?? 24, scores.length);
  const results: FoldResult[] = [];
  const sampleEnd = sampleOffset + windows * hop;

  for (let c = 0; c < top; c++) {
    const phaseSamples = modulo(scores[c]!.slot * hop, period);
    const dataPhase = modulo(phaseSamples + preambleSymbols * spb, period);
    const soft = new Float64Array(bits);
    let bursts = 0;
    const firstBurst = dataPhase + Math.ceil((sampleOffset - dataPhase) / period) * period;

    // Each whole burst is a distinct observation of this phase's coded bits. Do not accept a
    // partial burst at either edge: it would leak an unrelated time slot into the LLR sum.
    for (
      let burstStart = firstBurst;
      burstStart + (opts.dataSymbols - 1) * spb <= sampleEnd;
      burstStart += period
    ) {
      const burstSoft = new Float64Array(bits);
      let complete = true;
      for (let symbolIndex = 0; symbolIndex < opts.dataSymbols; symbolIndex++) {
        const windowIndex = Math.round((burstStart + symbolIndex * spb - sampleOffset) / hop);
        if (windowIndex < 0 || windowIndex >= windows) {
          complete = false;
          break;
        }
        softInto(windowIndex, burstSoft, symbolIndex * BITS_PER_SYMBOL);
      }
      if (!complete) continue;
      for (let bitIndex = 0; bitIndex < bits; bitIndex++) soft[bitIndex]! += burstSoft[bitIndex]!;
      bursts++;
    }
    if (bursts === 0) continue;

    const frame =
      opts.payloadBytes !== undefined
        ? decodeTieredFrame(soft, { interleaverWidth: opts.interleaverWidth, rate: opts.rate, maxPayloadBytes: opts.payloadBytes })
        : (() => {
            const single = parseInfoBits(viterbiDecode(deinterleave(soft, opts.interleaverWidth), opts.rate));
            return single.ok ? single : undefined;
          })();
    if (!frame || !frame.data) continue;

    const result: FoldResult = {
      text: String.fromCharCode(...frame.data),
      score: scores[c]!.score,
      offsetHz: opts.offsetHz ?? 0,
      driftPpm: opts.driftPpm ?? 0,
      phaseSamples,
      bursts,
    };
    const duplicate = results.some((prior) => {
      if (prior.text !== result.text || prior.phaseSamples === undefined) return false;
      const distance = Math.abs(prior.phaseSamples - phaseSamples);
      return Math.min(distance, period - distance) < spb / 2;
    });
    if (!duplicate) results.push(result);
  }

  return results;
}

/** Single-core convenience path: build the whole tone bank here, then decode it. */
export function foldDecode(samples: Float32Array, opts: FoldOptions): FoldResult {
  return foldDecodeAll(samples, opts)[0] ?? NOTHING(opts);
}

/** Single-core convenience path that retains every decodable station in the recording. */
export function foldDecodeAll(samples: Float32Array, opts: FoldOptions): FoldResult[] {
  const sampleRate = opts.sampleRate ?? SAMPLE_RATE;
  const geom = spectroGeometry(samples.length, opts.baud, sampleRate);
  if (geom.windows <= 0) return [];
  return decodeSpectrogramAll(fullSpectrogram(samples, geom, sampleRate, opts.offsetHz ?? 0), opts);
}
