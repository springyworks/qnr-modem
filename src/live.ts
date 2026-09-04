import { SAMPLE_RATE } from './config.js';
import { workerCount } from './pool.js';
import {
  BAUD,
  BURST_SAMPLES,
  DATA_SYMBOLS,
  DECODE_OPTIONS,
  FRAME_OPTIONS,
  GUARD_SAMPLES,
  INTERLEAVER_WIDTH,
  PAYLOAD_BYTES,
  PERIOD_SAMPLES,
  RATE,
  REPEATS,
  SCHEDULE_SAMPLES,
  SLOT_SAMPLES,
} from './protocol.js';
import { Receiver, type RxState } from './rx.js';
import { DecodeSearch, type SearchProgress, type SearchResult } from './search.js';

const RING_CAPACITY = SCHEDULE_SAMPLES + PERIOD_SAMPLES;
const MIN_DECODE_SAMPLES = BURST_SAMPLES + GUARD_SAMPLES;
const DUPLICATE_WINDOW_MS = (SCHEDULE_SAMPLES / SAMPLE_RATE) * 1000;

export type FrameLane = 'tx' | 'rx' | 'unsynced';
export type DecodeSource = 'folded' | 'loud';

export interface HeardFrame {
  text: string;
  lane: FrameLane;
  source: DecodeSource;
  bursts: number;
  score?: number;
  offsetHz?: number;
  driftPpm?: number;
  /** Matched preamble position in the shared world-time period. */
  phaseSamples?: number;
}

export interface ContinuousReceiverStatus {
  inputDb: number;
  peakDb: number;
  bufferedSamples: number;
  readyPercent: number;
  decoding: boolean;
  progress: string;
  directState: RxState;
  evidence: string;
  foldedBursts: number;
  repeatTarget: number;
}

export interface ContinuousReceiverCallbacks {
  onFrame?(frame: HeardFrame): void;
  onStatus?(status: ContinuousReceiverStatus): void;
  onError?(error: Error): void;
}

const dbfs = (rms: number): number => 20 * Math.log10(Math.max(rms, 1e-6));
const modulo = (value: number, divisor: number): number => ((value % divisor) + divisor) % divisor;

/**
 * A phase is synchronized only when its sync markers land near the burst position inside one
 * of the two basic frames (tx, rx). Search still accepts any phase; this label is for routing
 * and display.
 */
export function laneForPhase(phaseSamples: number | undefined): FrameLane {
  if (phaseSamples === undefined) return 'unsynced';

  const slotPhase = modulo(phaseSamples - GUARD_SAMPLES, PERIOD_SAMPLES);
  const slot = Math.floor(slotPhase / SLOT_SAMPLES);
  const expected = slot * SLOT_SAMPLES;
  const distance = Math.min(Math.abs(slotPhase - expected), PERIOD_SAMPLES - Math.abs(slotPhase - expected));
  if (distance > GUARD_SAMPLES / 2) return 'unsynced';
  return slot === 0 ? 'tx' : 'rx';
}

/**
 * Holds the raw audio for the current repeat schedule and emits every decodable lane. The
 * folded search is the weak-signal path; the direct receiver is intentionally single-burst so
 * a strong, off-grid signal can be decoded immediately without polluting a repeat accumulator.
 */
export class ContinuousReceiver {
  private readonly search: DecodeSearch;
  private readonly direct: Receiver;
  private readonly ring = new Float32Array(RING_CAPACITY);
  private readonly sampleOrigin = Math.round((Date.now() / 1000) * SAMPLE_RATE);
  private readonly seen = new Map<string, number>();
  private write = 0;
  private filled = 0;
  private capturedSamples = 0;
  private inputDb = -100;
  private peakDb = -100;
  private decoding = false;
  private progress = 'waiting for a complete burst';
  private evidence = 'no repeat evidence yet';
  private foldedBursts = 0;
  private directState: RxState = 'SEARCH';
  private directText = '';

  constructor(
    private readonly callbacks: ContinuousReceiverCallbacks = {},
    jobs: number = workerCount()
  ) {
    this.search = new DecodeSearch(DECODE_OPTIONS, jobs);
    this.direct = new Receiver(
      BAUD,
      {
        onChar: (character) => {
          this.directText += character;
        },
        onFrame: (frame) => {
          if (!frame.ok || !this.directText) {
            this.directText = '';
            return;
          }
          const text = this.directText;
          this.directText = '';
          this.emit({ text, lane: 'unsynced', source: 'loud', bursts: 1 });
        },
        onState: (state) => {
          this.directState = state;
          this.publishStatus();
        },
      },
      SAMPLE_RATE,
      'conv',
      {
        interleaverWidth: INTERLEAVER_WIDTH,
        rate: RATE,
        combineRepeats: false,
        maxPayloadBytes: PAYLOAD_BYTES,
        dataSymbols: DATA_SYMBOLS,
        preamblePairs: FRAME_OPTIONS.preamblePairs,
      }
    );
  }

  push(block: Float32Array): void {
    let energy = 0;
    for (const sample of block) {
      this.ring[this.write] = sample;
      this.write = (this.write + 1) % this.ring.length;
      energy += sample * sample;
    }
    this.filled = Math.min(this.ring.length, this.filled + block.length);
    this.capturedSamples += block.length;
    this.inputDb = dbfs(Math.sqrt(energy / Math.max(block.length, 1)));
    this.peakDb = Math.max(this.peakDb, this.inputDb);
    this.direct.push(block);
    this.publishStatus();
  }

  /** Runs one full weak-signal search if a previous search is not already using the worker pool. */
  async decode(): Promise<void> {
    if (this.decoding || this.filled < MIN_DECODE_SAMPLES) return;

    this.decoding = true;
    this.progress = 'acquiring preamble';
    this.publishStatus();
    const samples = this.orderedRing();
    const sampleOffset = this.sampleOrigin + this.capturedSamples - this.filled;

    try {
      const results = await this.search.decodeAll(samples, (progress) => this.updateProgress(progress), sampleOffset);
      if (results.length === 0) {
        this.evidence = 'no CRC-valid lane yet; raw evidence remains in the repeat ring';
      } else {
        this.foldedBursts = Math.max(...results.map((result) => result.bursts ?? 0));
        this.evidence = results
          .map((result) => `${laneForPhase(result.phaseSamples)} ${result.bursts ?? 1}x LLR`)
          .join(' | ');
        for (const result of results) this.emitFolded(result);
        // A typewriter packet has finished its repeat run. Its likelihoods must not be mixed
        // into the next character's packet, while direct acquisition keeps running unchanged.
        this.resetFoldingWindow();
      }
    } catch (error) {
      this.callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.decoding = false;
      this.progress = 'listening';
      this.publishStatus();
    }
  }

  getStatus(): ContinuousReceiverStatus {
    return {
      inputDb: this.inputDb,
      peakDb: this.peakDb,
      bufferedSamples: this.filled,
      readyPercent: Math.min(100, (this.filled / MIN_DECODE_SAMPLES) * 100),
      decoding: this.decoding,
      progress: this.progress,
      directState: this.directState,
      evidence: this.evidence,
      foldedBursts: this.foldedBursts,
      repeatTarget: REPEATS,
    };
  }

  takePeakDb(): number {
    const peak = this.peakDb;
    this.peakDb = -100;
    return peak;
  }

  close(): void {
    this.search.close();
  }

  /** Starts a fresh raw-LLR epoch without losing direct acquisition or world-time accounting. */
  resetFoldingWindow(): void {
    this.write = 0;
    this.filled = 0;
    this.foldedBursts = 0;
    this.evidence = 'CRC-valid packet emitted; collecting raw evidence for the next packet';
  }

  private updateProgress(progress: SearchProgress): void {
    this.progress = progress.stage === 'tune' ? `tuning ${progress.detail}` : `decoding ${progress.detail}`;
    this.publishStatus();
  }

  private orderedRing(): Float32Array {
    const ordered = new Float32Array(this.filled);
    const start = (this.write - this.filled + this.ring.length) % this.ring.length;
    for (let sampleIndex = 0; sampleIndex < this.filled; sampleIndex++) {
      ordered[sampleIndex] = this.ring[(start + sampleIndex) % this.ring.length]!;
    }
    return ordered;
  }

  private emitFolded(result: SearchResult): void {
    this.emit({
      text: result.text,
      lane: laneForPhase(result.phaseSamples),
      source: 'folded',
      bursts: result.bursts ?? 1,
      score: result.score,
      offsetHz: result.offsetHz,
      driftPpm: result.driftPpm,
      phaseSamples: result.phaseSamples,
    });
  }

  private emit(frame: HeardFrame): void {
    const now = Date.now();
    const key = `${frame.lane}:${frame.text}`;
    const previous = this.seen.get(key);
    if (previous !== undefined && now - previous < DUPLICATE_WINDOW_MS) return;
    this.seen.set(key, now);
    for (const [seenKey, seenAt] of this.seen) {
      if (now - seenAt > DUPLICATE_WINDOW_MS) this.seen.delete(seenKey);
    }
    this.callbacks.onFrame?.(frame);
  }

  private publishStatus(): void {
    this.callbacks.onStatus?.(this.getStatus());
  }
}