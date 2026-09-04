import {
  BITS_PER_SYMBOL,
  DATA_TONES,
  DEFAULT_SQUELCH_DB,
  PREAMBLE_PAIRS,
  SAMPLE_RATE,
  SYM_IDLE,
  SYM_SYNC_1,
  SYM_SYNC_2,
  symbolSamples,
  type FecMode,
} from './config.js';
import { viterbiDecode, type CodeRate } from './conv.js';
import { ToneDetector } from './detector.js';
import { decodeTieredFrame, parseInfoBits } from './framing.js';
import { hammingDecode } from './hamming.js';
import { deinterleave, INTERLEAVER_WIDTH } from './interleave.js';
import { syncMarkerPositions } from './synclayout.js';

export type RxState = 'SEARCH' | 'SYNC' | 'DATA';
export type LogKind = 'info' | 'corr' | 'fail';

export interface ReceiverCallbacks {
  onLevel?(db: number, symbol: number, amplitudes: Float64Array): void;
  onState?(state: RxState): void;
  onChar?(ch: string): void;
  onLog?(msg: string, kind: LogKind): void;
  onFrame?(result: { ok: boolean; combined: boolean; bursts: number }): void;
}

export interface ReceiverOptions {
  interleaverWidth?: number;
  rate?: CodeRate;
  combineRepeats?: boolean;
  /** Set for tiled chat frames: tries every payload length up to this ceiling against CRC-16. */
  maxPayloadBytes?: number;
  /** Fixed-length chat bursts only: total data-symbol count, needed to locate the mid-burst
   * sync markers (see synclayout.ts) so they can be skipped rather than treated as lost data. */
  dataSymbols?: number;
  preamblePairs?: number;
}

export class Receiver {
  squelchDb = DEFAULT_SQUELCH_DB;

  private readonly detector: ToneDetector;
  private buf = new Float32Array(1 << 16);
  private bufLen = 0;
  private bufStart = 0;

  private spb = 0;
  private windowLen = 0;
  private hop = 0;

  private state: RxState = 'SEARCH';
  private nextWindow = 0;
  private nextCenter = 0;
  private prevSymbol = -1;
  private syncCount = 0;
  private pendingNibble: number | null = null;
  private dropouts = 0;
  private softBits: number[] = [];
  private trailingErasures = 0;
  private accumulated: Float64Array | null = null;
  private burstCount = 0;
  private readonly interleaverWidth?: number;
  private readonly rate: CodeRate;
  private readonly combineRepeats: boolean;
  private readonly maxPayloadBytes?: number;
  /** Physical positions (0-based, from the burst's leading marker pair) holding a mid-burst
   * sync marker; undefined when the burst's data-symbol count isn't known in advance. */
  private readonly markerPositions?: Set<number>;
  /** Physical symbol position within the current burst, counted from the leading marker pair. */
  private framePos = 0;

  constructor(
    baud: number,
    private readonly cb: ReceiverCallbacks = {},
    private readonly sampleRate = SAMPLE_RATE,
    private mode: FecMode = 'hamming',
    options: ReceiverOptions | number = {}
  ) {
    const opts: ReceiverOptions = typeof options === 'number' ? { interleaverWidth: options } : options;
    this.interleaverWidth = opts.interleaverWidth;
    this.rate = opts.rate ?? 2;
    this.combineRepeats = opts.combineRepeats ?? true;
    this.maxPayloadBytes = opts.maxPayloadBytes;
    if (opts.dataSymbols !== undefined) {
      const preamblePairs = opts.preamblePairs ?? PREAMBLE_PAIRS;
      this.markerPositions = new Set(syncMarkerPositions(opts.dataSymbols, preamblePairs).filter((p) => p >= 2));
    }
    this.detector = new ToneDetector(sampleRate);
    this.setBaud(baud);
  }

  /** Clears accumulated repeat energy; call between unrelated transmissions. */
  resetCombining(): void {
    this.accumulated = null;
    this.burstCount = 0;
  }

  setFec(mode: FecMode): void {
    this.mode = mode;
    this.reset();
  }

  setBaud(baud: number): void {
    this.spb = symbolSamples(baud, this.sampleRate);
    this.windowLen = Math.min(this.spb, 8192, Math.max(2048, Math.floor(this.spb * 0.75)));
    this.hop = Math.max(1, Math.floor(this.spb / 8));
    this.reset();
  }

  reset(): void {
    this.bufLen = 0;
    this.bufStart = 0;
    this.nextWindow = 0;
    this.toSearch();
  }

  getState(): RxState {
    return this.state;
  }

  push(chunk: Float32Array): void {
    this.append(chunk);
    const end = () => this.bufStart + this.bufLen;

    for (;;) {
      if (this.state === 'SEARCH') {
        if (this.nextWindow < this.bufStart) this.nextWindow = this.bufStart;
        if (this.nextWindow + this.windowLen > end()) break;
        const est = this.detector.detect(this.buf, this.nextWindow - this.bufStart, this.windowLen);
        this.handleSearch(est.db, est.symbol, est.amplitudes, this.nextWindow);
        if (this.state === 'SEARCH') this.nextWindow += this.hop;
      } else {
        const start = this.nextCenter - Math.floor(this.windowLen / 2);
        if (start + this.windowLen > end()) break;
        if (start < this.bufStart) {
          this.nextCenter += this.spb;
          continue;
        }
        const est = this.detector.detect(this.buf, start - this.bufStart, this.windowLen);
        this.nextCenter += this.spb;
        this.handleLocked(est.db, est.symbol, est.amplitudes);
      }
    }

    const anchor = this.state === 'SEARCH' ? this.nextWindow : this.nextCenter - this.windowLen;
    this.compact(anchor - this.windowLen);
  }

  private handleSearch(db: number, symbol: number, amps: Float64Array, windowStart: number): void {
    const sym = db > this.squelchDb ? symbol : -1;
    this.cb.onLevel?.(db, sym, amps);

    const isSync = sym === SYM_SYNC_1 || sym === SYM_SYNC_2;
    const transitioned =
      (this.prevSymbol === SYM_SYNC_1 && sym === SYM_SYNC_2) ||
      (this.prevSymbol === SYM_SYNC_2 && sym === SYM_SYNC_1);

    if (isSync && transitioned) {
      // First window dominated by the new tone starts ~half a window before the true boundary.
      const boundary = windowStart + Math.floor(this.windowLen / 2);
      this.nextCenter = boundary + Math.floor(this.spb / 2);
      this.syncCount = 1;
      this.setState('SYNC');
    }
    this.prevSymbol = sym;
  }

  private handleLocked(db: number, symbol: number, amps: Float64Array): void {
    const sym = db > this.squelchDb ? symbol : -1;
    this.cb.onLevel?.(db, sym, amps);

    if (this.state === 'SYNC') {
      if (sym === SYM_SYNC_1 || sym === SYM_SYNC_2) {
        this.syncCount++;
        return;
      }
      if (sym >= 0 && sym <= 127 && this.syncCount >= 2) {
        this.pendingNibble = null;
        this.dropouts = 0;
        this.softBits = [];
        this.framePos = 2;
        this.setState('DATA');
        this.cb.onLog?.(`Clock locked after ${this.syncCount} sync symbols`, 'info');
        this.handleData(sym, amps);
        return;
      }
      if (sym < 0) {
        this.dropouts++;
        if (this.dropouts > 2) this.toSearch();
        return;
      }
      this.toSearch();
      return;
    }

    this.handleData(sym, amps);
  }

  /** Max-log soft metric per bit: strongest tone with the bit set versus strongest with it clear. */
  private pushSoftBits(amps: Float64Array): void {
    let peak = 0;
    for (let s = 0; s < DATA_TONES; s++) peak = Math.max(peak, amps[s]!);
    const scale = 1 / (peak + 1e-12);

    for (let b = 0; b < BITS_PER_SYMBOL; b++) {
      let one = 0;
      let zero = 0;
      for (let s = 0; s < DATA_TONES; s++) {
        const a = amps[s]!;
        if ((s >> (BITS_PER_SYMBOL - 1 - b)) & 1) {
          if (a > one) one = a;
        } else if (a > zero) zero = a;
      }
      this.softBits.push((one - zero) * scale);
    }
    this.trailingErasures = 0;
  }

  private decodeSoft(soft: Float64Array): boolean {
    const frame =
      this.maxPayloadBytes !== undefined
        ? decodeTieredFrame(soft, {
            interleaverWidth: this.interleaverWidth ?? INTERLEAVER_WIDTH,
            rate: this.rate,
            maxPayloadBytes: this.maxPayloadBytes,
          })
        : (() => {
            const single = parseInfoBits(viterbiDecode(deinterleave(soft, this.interleaverWidth), this.rate));
            return single.ok ? single : undefined;
          })();
    if (!frame || !frame.data) return false;
    for (const byte of frame.data) this.cb.onChar?.(String.fromCharCode(byte));
    return true;
  }

  private finishFrame(): void {
    // Erasures inserted during the closing IDLE symbols must not extend the interleaver block.
    const drop = this.trailingErasures * BITS_PER_SYMBOL;
    const collected = drop > 0 ? this.softBits.slice(0, this.softBits.length - drop) : this.softBits;
    this.softBits = [];
    this.trailingErasures = 0;
    if (collected.length < BITS_PER_SYMBOL * 4) return;

    const soft = Float64Array.from(collected);
    this.burstCount++;

    if (this.decodeSoft(soft)) {
      this.cb.onLog?.(`Frame OK on burst ${this.burstCount}`, 'info');
      this.cb.onFrame?.({ ok: true, combined: false, bursts: this.burstCount });
      this.resetCombining();
      return;
    }

    if (!this.combineRepeats) {
      this.cb.onLog?.('Frame rejected (CRC)', 'fail');
      this.cb.onFrame?.({ ok: false, combined: false, bursts: this.burstCount });
      return;
    }

    // Identical repeats carry identical coded bits, so summing LLRs buys diversity gain.
    if (this.accumulated && this.accumulated.length === soft.length) {
      for (let i = 0; i < soft.length; i++) this.accumulated[i]! += soft[i]!;
    } else {
      this.accumulated = Float64Array.from(soft);
    }

    if (this.burstCount > 1 && this.decodeSoft(this.accumulated)) {
      this.cb.onLog?.(`Frame OK after combining ${this.burstCount} bursts`, 'info');
      this.cb.onFrame?.({ ok: true, combined: true, bursts: this.burstCount });
      this.resetCombining();
      return;
    }

    this.cb.onLog?.(`Burst ${this.burstCount} failed, accumulating`, 'fail');
    this.cb.onFrame?.({ ok: false, combined: this.burstCount > 1, bursts: this.burstCount });
  }

  private handleData(sym: number, amps: Float64Array): void {
    if (this.mode === 'conv') {
      const pos = this.framePos++;
      if (this.markerPositions?.has(pos)) {
        // Expected mid-burst sync marker (see synclayout.ts): consumes a physical slot but
        // carries no coded bits, so it must be skipped rather than pushed as an erasure.
        this.dropouts = 0;
        return;
      }
      const lost = sym < 0 || sym === SYM_IDLE || sym > 127;
      if (lost) {
        this.dropouts++;
        if (this.dropouts > 2) {
          this.finishFrame();
          this.toSearch();
          return;
        }
        // Keep bit alignment by inserting erasures rather than dropping the slot.
        for (let b = 0; b < BITS_PER_SYMBOL; b++) this.softBits.push(0);
        this.trailingErasures++;
        return;
      }
      this.dropouts = 0;
      this.pushSoftBits(amps);
      return;
    }

    if (sym < 0 || sym === SYM_IDLE || sym > 127) {
      this.dropouts++;
      if (this.dropouts > 2) {
        this.cb.onLog?.('EOT - returning to search', 'fail');
        this.toSearch();
      }
      return;
    }

    this.dropouts = 0;
    const res = hammingDecode(sym);
    if (res.corrected) this.cb.onLog?.(`FEC corrected bit in symbol ${sym}`, 'corr');

    if (this.pendingNibble === null) {
      this.pendingNibble = res.nibble;
    } else {
      const code = (this.pendingNibble << 4) | res.nibble;
      this.pendingNibble = null;
      this.cb.onChar?.(String.fromCharCode(code));
    }
  }

  private toSearch(): void {
    this.nextWindow = Math.max(this.nextWindow, this.nextCenter);
    this.prevSymbol = -1;
    this.syncCount = 0;
    this.pendingNibble = null;
    this.dropouts = 0;
    this.softBits = [];
    this.trailingErasures = 0;
    this.setState('SEARCH');
  }

  private setState(state: RxState): void {
    if (this.state === state) return;
    this.state = state;
    this.cb.onState?.(state);
  }

  private append(chunk: Float32Array): void {
    const needed = this.bufLen + chunk.length;
    if (needed > this.buf.length) {
      const grown = new Float32Array(Math.max(needed, this.buf.length * 2));
      grown.set(this.buf.subarray(0, this.bufLen));
      this.buf = grown;
    }
    this.buf.set(chunk, this.bufLen);
    this.bufLen += chunk.length;
  }

  private compact(keepFromAbs: number): void {
    const drop = Math.max(0, Math.min(keepFromAbs - this.bufStart, this.bufLen));
    if (drop <= 0) return;
    this.buf.copyWithin(0, drop, this.bufLen);
    this.bufLen -= drop;
    this.bufStart += drop;
  }
}
