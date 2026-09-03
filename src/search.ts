import { NUM_TONES, SAMPLE_RATE, symbolSamples } from './config.js';
import { decodeSpectrogram, decodeSpectrogramAll, noiseFloors, type FoldOptions, type FoldResult } from './fold.js';
import { WorkerPool, chunk, workerCount } from './pool.js';
import { sharedPower, sharedSamples, spectroGeometry, type SpectroGeometry } from './spectro.js';
import type { SpectroTask, TuneTask } from './searchWorker.js';
import { DRIFT_STEP_PPM, driftGrid, offsetGrid, topOffsets, type TuneHit, type TuneOptions } from './tune.js';

const SEARCH_WORKER = new URL('./searchWorker.js', import.meta.url);

/**
 * Full decodes retained after preamble acquisition. Interleaved data can make a few false
 * sync-tone peaks, so five keeps the true tuning available for both basic-frame lanes.
 */
const DECODE_OFFSETS = 5;
/** Drift steps swept around the acquisition estimate, which was made on two tones only. */
const DRIFT_REFINE_STEPS = 5;

export interface SearchProgress {
  stage: 'tune' | 'decode';
  detail: string;
}

export interface SearchResult extends FoldResult {
  /** Best tuning found by acquisition, whether or not a frame came out of it. */
  tuning?: TuneHit;
  /** Seconds of audio the accepted frame came out of. */
  usedSeconds?: number;
}

/** Audio prefixes tried, in bursts. A clean signal stops at the first and never sees the rest. */
const LADDER = [1, 2, 4];

/**
 * Two-stage receiver. Acquisition sweeps tuning offset and clock drift on the two preamble
 * tones, which is cheap enough to brute force; the shortlist it produces is then decoded with
 * the full 144-tone bank. Both stages are split across the worker pool, and the audio lives in
 * shared memory so a pass never copies it.
 */
export class DecodeSearch {
  private readonly pool: WorkerPool;

  constructor(
    private readonly opts: FoldOptions,
    readonly jobs: number = workerCount()
  ) {
    this.pool = new WorkerPool(SEARCH_WORKER, jobs);
  }

  async decode(samples: Float32Array, onProgress?: (p: SearchProgress) => void): Promise<SearchResult> {
    const sampleRate = this.opts.sampleRate ?? SAMPLE_RATE;
    const geom = spectroGeometry(samples.length, this.opts.baud, sampleRate);
    let best: SearchResult = { text: '', score: 0, offsetHz: 0, driftPpm: 0 };
    if (geom.windows <= 0) return best;

    const audio = sharedSamples(samples);
    const tuning = await this.acquire(audio, geom, sampleRate);
    const shortlist = topOffsets(tuning, DECODE_OFFSETS);
    if (shortlist.length === 0) return best;

    onProgress?.({
      stage: 'tune',
      detail: `${shortlist[0]!.offsetHz >= 0 ? '+' : ''}${shortlist[0]!.offsetHz.toFixed(1)} Hz, ${shortlist[0]!.driftPpm.toFixed(0)} ppm`,
    });

    for (const hit of shortlist) {
      onProgress?.({ stage: 'decode', detail: `${hit.offsetHz >= 0 ? '+' : ''}${hit.offsetHz.toFixed(1)} Hz` });
      const result = await this.decodeAt(audio, geom, sampleRate, hit);
      if (result.text) return { ...result, tuning: hit };
      if (result.score > best.score) best = { ...result, tuning: hit };
    }

    return best;
  }

  /**
   * Keeps every independently CRC-valid preamble phase. This is the live-receiver path: an
   * alternating station in the other basic-frame must not disappear merely because another
   * station ranked first in acquisition.
   */
  async decodeAll(
    samples: Float32Array,
    onProgress?: (p: SearchProgress) => void,
    sampleOffset = 0
  ): Promise<SearchResult[]> {
    const sampleRate = this.opts.sampleRate ?? SAMPLE_RATE;
    const geom = spectroGeometry(samples.length, this.opts.baud, sampleRate);
    if (geom.windows <= 0) return [];

    const audio = sharedSamples(samples);
    const tuning = await this.acquire(audio, geom, sampleRate);
    const shortlist = topOffsets(tuning, DECODE_OFFSETS);
    if (shortlist.length === 0) return [];

    onProgress?.({
      stage: 'tune',
      detail: `${shortlist[0]!.offsetHz >= 0 ? '+' : ''}${shortlist[0]!.offsetHz.toFixed(1)} Hz, ${shortlist[0]!.driftPpm.toFixed(0)} ppm`,
    });

    const results: SearchResult[] = [];
    for (const hit of shortlist) {
      onProgress?.({ stage: 'decode', detail: `${hit.offsetHz >= 0 ? '+' : ''}${hit.offsetHz.toFixed(1)} Hz` });
      const atTuning = await this.decodeAtAll(audio, geom, sampleRate, hit, sampleOffset);
      for (const result of atTuning) results.push({ ...result, tuning: hit });
    }

    return this.distinct(results, sampleRate);
  }

  /**
   * Decodes from the least audio that can carry a frame, growing the window only when that
   * fails. A strong signal is answered after its first burst instead of after the whole
   * schedule; a weak one still gets every burst before the search gives up.
   */
  async decodeProgressive(
    samples: Float32Array,
    onProgress?: (p: SearchProgress) => void
  ): Promise<SearchResult> {
    const sampleRate = this.opts.sampleRate ?? SAMPLE_RATE;
    let best: SearchResult = { text: '', score: 0, offsetHz: 0, driftPpm: 0 };

    for (const span of this.spans(samples.length)) {
      const seconds = span / sampleRate;
      const result = await this.decode(samples.subarray(0, span), (p) =>
        onProgress?.({ ...p, detail: `${p.detail}  (${seconds.toFixed(0)}s)` })
      );
      if (result.text) return { ...result, usedSeconds: seconds };
      if (result.score > best.score) best = result;
    }

    return best;
  }

  /**
   * A window of one period plus one burst always contains a whole burst wherever it starts,
   * so k of them guarantee k complete bursts without knowing the recording's lead-in.
   */
  private spans(total: number): number[] {
    const burst = this.opts.burstSamples ?? this.opts.periodSamples;
    const steps = LADDER.map((k) => k * this.opts.periodSamples + burst).filter((n) => n < total);
    return [...new Set([...steps, total])];
  }

  close(): void {
    this.pool.close();
  }

  private async acquire(
    audio: Float32Array,
    geom: SpectroGeometry,
    sampleRate: number
  ): Promise<TuneHit[]> {
    const tune: TuneOptions = {
      baud: this.opts.baud,
      sampleRate,
      periodSamples: this.opts.periodSamples,
      preamblePairs: this.opts.preamblePairs,
    };
    const drifts = driftGrid();
    const tasks: TuneTask[] = chunk(offsetGrid(), this.jobs).map((offsets) => ({
      kind: 'tune',
      audio: audio.buffer as SharedArrayBuffer,
      samples: audio.length,
      geom,
      offsets,
      drifts,
      tune,
    }));
    return (await this.pool.map<TuneTask, TuneHit[]>(tasks)).flat();
  }

  private async decodeAt(
    audio: Float32Array,
    geom: SpectroGeometry,
    sampleRate: number,
    hit: TuneHit
  ): Promise<FoldResult> {
    const power = sharedPower(geom);
    const bounds = chunk([...Array(NUM_TONES).keys()], this.jobs);
    const tasks: SpectroTask[] = bounds.map((tones) => ({
      kind: 'spectro',
      audio: audio.buffer as SharedArrayBuffer,
      samples: audio.length,
      geom,
      sampleRate,
      offsetHz: hit.offsetHz,
      toneStart: tones[0]!,
      toneEnd: tones[tones.length - 1]! + 1,
      out: power.buffer as SharedArrayBuffer,
    }));
    await this.pool.map<SpectroTask, number>(tasks);

    const spec = { ...geom, power };
    const floors = noiseFloors(spec);
    let best: FoldResult = { text: '', score: 0, offsetHz: hit.offsetHz, driftPpm: hit.driftPpm };

    for (const driftPpm of refineDrifts(hit.driftPpm)) {
      const result = decodeSpectrogram(
        spec,
        { ...this.opts, offsetHz: hit.offsetHz, driftPpm },
        floors
      );
      if (result.text) return result;
      if (result.score > best.score) best = result;
    }
    return best;
  }

  private async decodeAtAll(
    audio: Float32Array,
    geom: SpectroGeometry,
    sampleRate: number,
    hit: TuneHit,
    sampleOffset: number
  ): Promise<FoldResult[]> {
    const power = sharedPower(geom);
    const bounds = chunk([...Array(NUM_TONES).keys()], this.jobs);
    const tasks: SpectroTask[] = bounds.map((tones) => ({
      kind: 'spectro',
      audio: audio.buffer as SharedArrayBuffer,
      samples: audio.length,
      geom,
      sampleRate,
      offsetHz: hit.offsetHz,
      toneStart: tones[0]!,
      toneEnd: tones[tones.length - 1]! + 1,
      out: power.buffer as SharedArrayBuffer,
    }));
    await this.pool.map<SpectroTask, number>(tasks);

    const spec = { ...geom, power };
    const floors = noiseFloors(spec);
    const results: FoldResult[] = [];
    for (const driftPpm of refineDrifts(hit.driftPpm)) {
      results.push(
        ...decodeSpectrogramAll(
          spec,
          { ...this.opts, offsetHz: hit.offsetHz, driftPpm, sampleOffset },
          floors
        )
      );
    }
    return results;
  }

  private distinct(results: SearchResult[], sampleRate: number): SearchResult[] {
    const accepted: SearchResult[] = [];
    const phaseTolerance = symbolSamples(this.opts.baud, sampleRate);
    for (const result of results.sort((left, right) => right.score - left.score)) {
      const duplicate = accepted.some((prior) => {
        if (prior.text !== result.text || prior.phaseSamples === undefined || result.phaseSamples === undefined) {
          return false;
        }
        const distance = Math.abs(prior.phaseSamples - result.phaseSamples);
        const wrappedDistance = Math.min(distance, this.opts.periodSamples - distance);
        return wrappedDistance < phaseTolerance;
      });
      if (!duplicate) accepted.push(result);
    }
    return accepted;
  }
}

/** Acquisition saw only two tones, so the full bank re-checks the neighbouring drift steps. */
function refineDrifts(centerPpm: number): number[] {
  const out = [centerPpm];
  for (let i = 1; i <= DRIFT_REFINE_STEPS; i++) {
    out.push(centerPpm + i * DRIFT_STEP_PPM, centerPpm - i * DRIFT_STEP_PPM);
  }
  return out;
}
