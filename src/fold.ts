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
import { ToneDetector } from './detector.js';
import { LENGTH_BITS, parseInfoBits } from './framing.js';
import { deinterleave } from './interleave.js';

/** Symbols a frame occupies, derived from the protocol rather than detected. */
export function dataSymbolCount(messageBytes: number, rate: CodeRate): number {
  const infoBits = LENGTH_BITS + messageBytes * 8 + 16 + TAIL_BITS;
  return Math.ceil((infoBits * rate) / BITS_PER_SYMBOL);
}

export interface FoldOptions {
  baud: number;
  /** Burst length + listening gap, in samples. Known by protocol, so folding needs no absolute start. */
  periodSamples: number;
  preamblePairs: number;
  dataSymbols: number;
  interleaverWidth: number;
  rate: CodeRate;
  candidates?: number;
  sampleRate?: number;
}

/**
 * Exact repeat correlation. Bursts recur at a known period, so tone powers are folded
 * modulo that period, the preamble is found by matched filtering that folded view, and
 * the per-burst soft metrics are then summed. Folding carries acquisition; summing LLRs
 * across independent fades is what buys the diversity gain.
 */
export function foldDecode(samples: Float32Array, opts: FoldOptions): string {
  const sampleRate = opts.sampleRate ?? SAMPLE_RATE;
  const spb = symbolSamples(opts.baud, sampleRate);
  const windowLen = Math.min(spb, 8192, Math.max(2048, Math.floor(spb * 0.75)));
  const hop = Math.max(1, Math.floor(spb / 8));
  const perSymbol = Math.round(spb / hop);
  const preambleSymbols = opts.preamblePairs * 2;

  const windows = Math.floor((samples.length - windowLen) / hop) + 1;
  if (windows <= 0) return '';

  const detector = new ToneDetector(sampleRate);
  const power = new Float64Array(windows * NUM_TONES);
  for (let w = 0; w < windows; w++) {
    const est = detector.detect(samples, w * hop, windowLen);
    const base = w * NUM_TONES;
    for (let s = 0; s < NUM_TONES; s++) power[base + s] = est.amplitudes[s]! * est.amplitudes[s]!;
  }

  const periodWindows = Math.max(1, Math.round(opts.periodSamples / hop));
  const folded = new Float64Array(periodWindows * NUM_TONES);
  const hits = new Int32Array(periodWindows);
  for (let w = 0; w < windows; w++) {
    const src = w * NUM_TONES;
    const dst = (w % periodWindows) * NUM_TONES;
    for (let s = 0; s < NUM_TONES; s++) folded[dst + s]! += power[src + s]!;
    hits[w % periodWindows]!++;
  }
  for (let slot = 0; slot < periodWindows; slot++) {
    const n = Math.max(1, hits[slot]!);
    const dst = slot * NUM_TONES;
    for (let s = 0; s < NUM_TONES; s++) folded[dst + s]! /= n;
  }

  const scratch = new Float64Array(NUM_TONES);
  /** Median tone power approximates the noise floor without being dragged up by the signal tone. */
  const noiseFloor = (buf: Float64Array, base: number): number => {
    for (let s = 0; s < NUM_TONES; s++) scratch[s] = buf[base + s]!;
    scratch.sort();
    return Math.max(scratch[NUM_TONES >> 1]!, 1e-20);
  };

  // Matched filter on the known alternating preamble, evaluated over the folded period.
  const scores: Array<{ slot: number; score: number }> = [];
  for (let slot = 0; slot < periodWindows; slot++) {
    let score = 0;
    for (let j = 0; j < preambleSymbols; j++) {
      const at = (slot + j * perSymbol) % periodWindows;
      const base = at * NUM_TONES;
      const tone = j % 2 === 0 ? SYM_SYNC_1 : SYM_SYNC_2;
      score += folded[base + tone]! / noiseFloor(folded, base);
    }
    scores.push({ slot, score });
  }
  scores.sort((a, b) => b.score - a.score);

  const softInto = (base: number, out: Float64Array, offset: number): void => {
    const n = noiseFloor(power, base);
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

  const repeats = Math.max(1, Math.ceil(windows / periodWindows));
  const bits = opts.dataSymbols * BITS_PER_SYMBOL;
  const top = Math.min(opts.candidates ?? 12, scores.length);

  for (let c = 0; c < top; c++) {
    const start = scores[c]!.slot + preambleSymbols * perSymbol;
    const soft = new Float64Array(bits);

    // Each repeat is an independent look at the same coded bits, so LLRs add.
    for (let r = 0; r < repeats; r++) {
      for (let i = 0; i < opts.dataSymbols; i++) {
        const w = (start + i * perSymbol) % periodWindows + r * periodWindows;
        if (w < 0 || w >= windows) continue;
        softInto(w * NUM_TONES, soft, i * BITS_PER_SYMBOL);
      }
    }

    const frame = parseInfoBits(viterbiDecode(deinterleave(soft, opts.interleaverWidth), opts.rate));
    if (frame.ok && frame.data) return String.fromCharCode(...frame.data);
  }

  return '';
}
