import { SAMPLE_RATE, TONE_SPACING_HZ, symbolSamples } from './config.js';
import type { SpectroGeometry } from './spectro.js';
import { syncMarkerPositions } from './synclayout.js';

/**
 * Operators mistune, and a signal relayed through a WebSDR arrives on whatever dial the
 * listener happened to click. Half a tone spacing already lands the comb on the wrong tone,
 * so acquisition searches a span far wider than that.
 */
export const OFFSET_SPAN_HZ = 60;
export const OFFSET_STEP_HZ = 2;

/**
 * Sound cards and internet relays never run at exactly 48 kHz. A few hundred ppm is invisible
 * inside one burst but walks the folded period past a whole symbol across the schedule, so the
 * listening gap is treated as approximate and searched too.
 */
export const DRIFT_SPAN_PPM = 3000;
export const DRIFT_STEP_PPM = 100;

const grid = (span: number, step: number): number[] => {
  const out: number[] = [];
  for (let v = -span; v <= span + 1e-9; v += step) out.push(Number(v.toFixed(6)));
  return out;
};

export const offsetGrid = (): number[] => grid(OFFSET_SPAN_HZ, OFFSET_STEP_HZ);
export const driftGrid = (): number[] => grid(DRIFT_SPAN_PPM, DRIFT_STEP_PPM);

export interface TuneOptions {
  baud: number;
  sampleRate: number;
  periodSamples: number;
  preamblePairs: number;
  /** Needed to locate the sync markers, which are now scattered across the data span. */
  dataSymbols: number;
}

export interface TuneHit {
  offsetHz: number;
  driftPpm: number;
  /** Preamble energy over the mean folded sync-tone power; comparable across offsets. */
  score: number;
}

/**
 * Scores one tuning offset by folding the two sync tones at every drift candidate and
 * matched-filtering the scattered marker pattern. Two tones instead of 144 make the offset
 * sweep affordable; the winner is then handed to a full decode.
 */
export function scoreOffset(
  sync: Float64Array,
  geom: SpectroGeometry,
  offsetHz: number,
  opts: TuneOptions,
  drifts: number[] = driftGrid()
): TuneHit {
  const { hop, windows } = geom;
  const nominalSpb = symbolSamples(opts.baud, opts.sampleRate);
  const markerPositions = syncMarkerPositions(opts.dataSymbols, opts.preamblePairs);
  const maxWindows = Math.max(1, Math.round((opts.periodSamples * (1 + DRIFT_SPAN_PPM / 1e6)) / hop)) + 1;
  const folded = new Float64Array(maxWindows * 2);
  const hits = new Int32Array(maxWindows);

  let best: TuneHit = { offsetHz, driftPpm: 0, score: 0 };

  for (const driftPpm of drifts) {
    const stretch = 1 + driftPpm / 1e6;
    const period = opts.periodSamples * stretch;
    const spb = nominalSpb * stretch;
    const periodWindows = Math.max(1, Math.round(period / hop));
    const slotAt = (pos: number): number => Math.round((pos % period) / hop) % periodWindows;

    folded.fill(0, 0, periodWindows * 2);
    hits.fill(0, 0, periodWindows);
    for (let w = 0; w < windows; w++) {
      const slot = slotAt(w * hop);
      folded[slot * 2]! += sync[w * 2]!;
      folded[slot * 2 + 1]! += sync[w * 2 + 1]!;
      hits[slot]!++;
    }

    let mean = 0;
    for (let slot = 0; slot < periodWindows; slot++) {
      const n = Math.max(1, hits[slot]!);
      folded[slot * 2]! /= n;
      folded[slot * 2 + 1]! /= n;
      mean += folded[slot * 2]! + folded[slot * 2 + 1]!;
    }
    mean = Math.max(mean / (periodWindows * 2), 1e-20);

    for (let slot = 0; slot < periodWindows; slot++) {
      let score = 0;
      for (let j = 0; j < markerPositions.length; j++) {
        score += folded[slotAt(slot * hop + markerPositions[j]! * spb) * 2 + (j % 2)]!;
      }
      score /= markerPositions.length * mean;
      if (score > best.score) best = { offsetHz, driftPpm, score };
    }
  }

  return best;
}

/**
 * Picks the strongest offsets that are far enough apart to be genuinely different tunings;
 * without the separation rule the whole shortlist would be neighbours of one peak.
 */
export function topOffsets(hits: TuneHit[], count: number, separationHz = TONE_SPACING_HZ / 2): TuneHit[] {
  const ranked = [...hits].sort((a, b) => b.score - a.score);
  const picked: TuneHit[] = [];
  for (const hit of ranked) {
    if (picked.length >= count) break;
    if (picked.some((p) => Math.abs(p.offsetHz - hit.offsetHz) < separationHz)) continue;
    picked.push(hit);
  }
  return picked;
}

export const defaultTuneOptions = (
  baud: number,
  periodSamples: number,
  preamblePairs: number,
  dataSymbols: number,
  sampleRate = SAMPLE_RATE
): TuneOptions => ({ baud, sampleRate, periodSamples, preamblePairs, dataSymbols });
