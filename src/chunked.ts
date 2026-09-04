/**
 * Incremental-redundancy "fast grid" coding: the same conv K=7 + Viterbi + CRC-16 pipeline used
 * everywhere else in this codebase, but one fixed-size codeword is striped across `CHUNKS` short
 * bursts instead of sent whole in one long burst (see protocol.ts's `CHUNK_*` constants for why
 * the chunk count is fixed and why this buys a real ~3s TX/listen grid).
 *
 * Which chunk a given burst carries is derived only from that burst's position on the shared
 * time grid (`chunkIdAt`), never signalled in-band -- exactly like the rest of the protocol's
 * schedule-is-the-marker design. That is what makes a late-joining or weak station's job simple:
 * it just demodulates whatever chunk bursts it actually hears, scatters their soft bits into an
 * accumulator at the right striped positions, and retries the CRC after every new one. Bursts
 * that happen to repeat a chunk already held (the schedule wraps every `CHUNKS` bursts) are not
 * wasted: their LLRs add to what is already there, so the wrapped bursts become plain repeat-FEC
 * gain once every chunk has been seen at least once.
 */
import { BITS_PER_SYMBOL, DATA_TONES, NUM_TONES, SAMPLE_RATE, SYM_IDLE, SYM_SYNC_1, SYM_SYNC_2, symbolSamples } from './config.js';
import { convEncode, viterbiDecode, type CodeRate } from './conv.js';
import { noiseFloors } from './fold.js';
import { buildInfoBits, parseInfoBits, type ParsedFrame } from './framing.js';
import { deinterleave, interleave } from './interleave.js';
import { fullSpectrogram, spectroGeometry, type Spectrogram } from './spectro.js';
import { modulateSymbols } from './tx.js';

export interface ChunkOptions {
  baud: number;
  rate: CodeRate;
  interleaverWidth: number;
  preamblePairs: number;
  chunks: number;
  totalBits: number;
  dataSymbols: number;
  sampleRate?: number;
}

/** The full codeword's interleaved, symbol-padded coded bits -- what tx.ts's `convSymbols` also builds. */
function interleavedCodedBits(data: Uint8Array, interleaverWidth: number, rate: CodeRate): Uint8Array {
  const coded = convEncode(buildInfoBits(data), rate);
  const padded = new Uint8Array(Math.ceil(coded.length / BITS_PER_SYMBOL) * BITS_PER_SYMBOL);
  padded.set(coded);
  return interleave(padded, interleaverWidth);
}

/** Every position this chunk owns, in ascending order; both TX and RX must agree on this order. */
export function chunkPositions(totalBits: number, chunkId: number, chunks: number): number[] {
  const out: number[] = [];
  for (let i = chunkId; i < totalBits; i += chunks) out.push(i);
  return out;
}

/**
 * Which chunk a burst at absolute sample position `burstStart` carries. Purely a function of
 * position on the grid (no in-band signalling needed), so any station -- however it joined --
 * always knows what a burst it just heard must contain.
 */
export function chunkIdAt(burstStart: number, slotSamples: number, chunks: number): number {
  const index = Math.round(burstStart / slotSamples);
  return ((index % chunks) + chunks) % chunks;
}

/** Builds one chunk burst's symbols: preamble + this chunk's striped data bits + idle tail. */
export function buildChunkSymbols(data: Uint8Array, chunkId: number, opts: ChunkOptions): number[] {
  const bits = interleavedCodedBits(data, opts.interleaverWidth, opts.rate);
  const positions = chunkPositions(opts.totalBits, chunkId, opts.chunks);
  const symbols: number[] = [];
  for (let i = 0; i < opts.preamblePairs; i++) symbols.push(SYM_SYNC_1, SYM_SYNC_2);
  for (let g = 0; g < positions.length; g += BITS_PER_SYMBOL) {
    let symbol = 0;
    for (let b = 0; b < BITS_PER_SYMBOL; b++) {
      const bit = g + b < positions.length ? bits[positions[g + b]!]! : 0;
      symbol |= bit << (BITS_PER_SYMBOL - 1 - b);
    }
    symbols.push(symbol);
  }
  symbols.push(SYM_IDLE, SYM_IDLE, SYM_IDLE);
  return symbols;
}

/** Continuous-phase MFSK for one chunk burst; identical tone plan to the rest of the protocol. */
export function modulateChunk(data: Uint8Array, chunkId: number, opts: ChunkOptions, amplitude = 0.5): Float32Array {
  const symbols = buildChunkSymbols(data, chunkId, opts);
  return modulateSymbols(symbols, opts.baud, amplitude, opts.sampleRate ?? SAMPLE_RATE);
}

/** Scatters one chunk's demodulated soft bits into the full-codeword accumulator. Additive, so
 * hearing the same chunk again (the schedule wraps every `chunks` bursts) only adds diversity gain. */
export function accumulateChunk(acc: Float64Array, soft: Float64Array, chunkId: number, opts: ChunkOptions): void {
  const positions = chunkPositions(opts.totalBits, chunkId, opts.chunks);
  for (let i = 0; i < positions.length; i++) acc[positions[i]!] += soft[i]!;
}

/** Attempts the full-codeword Viterbi decode + CRC-16 on whatever has been accumulated so far. */
export function tryDecodeChunks(acc: Float64Array, opts: ChunkOptions): ParsedFrame | undefined {
  const frame = parseInfoBits(viterbiDecode(deinterleave(acc, opts.interleaverWidth), opts.rate));
  return frame.ok ? frame : undefined;
}

export interface ChunkFoldResult {
  frame: ParsedFrame;
  chunksHeard: number;
  bursts: number;
  score: number;
}

const modulo = (value: number, divisor: number): number => ((value % divisor) + divisor) % divisor;

/**
 * Finds the strongest recurring preamble at the fast-grid period inside a capture, then folds
 * every complete chunk burst it can find at that phase into a running accumulator, trying the
 * CRC after each one and returning as soon as it passes (or after every burst has been folded).
 * Mirrors fold.ts's `decodeSpectrogramAll` matched-filter/fold approach, generalized so each
 * burst contributes to only the striped positions its chunk id owns instead of the whole frame.
 */
export function decodeChunkedSpectrogram(
  spec: Spectrogram,
  opts: ChunkOptions,
  slotSamples: number,
  sampleOffset = 0,
  floors: Float64Array = noiseFloors(spec)
): ChunkFoldResult | undefined {
  const { power, windows, hop } = spec;
  if (windows <= 0) return undefined;

  const sampleRate = opts.sampleRate ?? SAMPLE_RATE;
  const spb = symbolSamples(opts.baud, sampleRate);
  const preambleSymbols = opts.preamblePairs * 2;
  const slotWindows = Math.max(1, Math.round(slotSamples / hop));
  const slotAt = (pos: number): number => Math.round(modulo(pos, slotSamples) / hop) % slotWindows;

  const folded = new Float64Array(slotWindows * NUM_TONES);
  const hits = new Int32Array(slotWindows);
  for (let w = 0; w < windows; w++) {
    const src = w * NUM_TONES;
    const slot = slotAt(sampleOffset + w * hop);
    const dst = slot * NUM_TONES;
    for (let s = 0; s < NUM_TONES; s++) folded[dst + s]! += power[src + s]!;
    hits[slot]!++;
  }
  const scratch = new Float64Array(NUM_TONES);
  const foldFloor = new Float64Array(slotWindows);
  for (let slot = 0; slot < slotWindows; slot++) {
    const n = Math.max(1, hits[slot]!);
    const dst = slot * NUM_TONES;
    for (let s = 0; s < NUM_TONES; s++) folded[dst + s]! /= n;
    for (let s = 0; s < NUM_TONES; s++) scratch[s] = folded[dst + s]!;
    scratch.sort();
    foldFloor[slot] = Math.max(scratch[NUM_TONES >> 1]!, 1e-20);
  }

  let bestSlot = 0;
  let bestScore = -Infinity;
  for (let slot = 0; slot < slotWindows; slot++) {
    let score = 0;
    for (let j = 0; j < preambleSymbols; j++) {
      const at = slotAt(slot * hop + j * spb);
      const tone = j % 2 === 0 ? 130 : 140; // SYM_SYNC_1 / SYM_SYNC_2
      score += folded[at * NUM_TONES + tone]! / foldFloor[at]!;
    }
    if (score > bestScore) {
      bestScore = score;
      bestSlot = slot;
    }
  }

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

  const phaseSamples = modulo(bestSlot * hop, slotSamples);
  const dataPhase = modulo(phaseSamples + preambleSymbols * spb, slotSamples);
  const sampleEnd = sampleOffset + windows * hop;
  const firstBurst = dataPhase + Math.ceil((sampleOffset - dataPhase) / slotSamples) * slotSamples;

  const acc = new Float64Array(opts.totalBits);
  const seenChunks = new Set<number>();
  let bursts = 0;

  for (
    let burstStart = firstBurst;
    burstStart + (opts.dataSymbols - 1) * spb <= sampleEnd;
    burstStart += slotSamples
  ) {
    const chunkId = chunkIdAt(burstStart, slotSamples, opts.chunks);
    const positions = chunkPositions(opts.totalBits, chunkId, opts.chunks);
    const chunkSymbols = Math.ceil(positions.length / BITS_PER_SYMBOL);
    const soft = new Float64Array(chunkSymbols * BITS_PER_SYMBOL);
    let complete = true;
    for (let symbolIndex = 0; symbolIndex < chunkSymbols; symbolIndex++) {
      const windowIndex = Math.round((burstStart + symbolIndex * spb - sampleOffset) / hop);
      if (windowIndex < 0 || windowIndex >= windows) {
        complete = false;
        break;
      }
      softInto(windowIndex, soft, symbolIndex * BITS_PER_SYMBOL);
    }
    if (!complete) continue;

    for (let i = 0; i < positions.length; i++) acc[positions[i]!] += soft[i]!;
    seenChunks.add(chunkId);
    bursts++;

    const frame = tryDecodeChunks(acc, opts);
    if (frame) return { frame, chunksHeard: seenChunks.size, bursts, score: bestScore };
  }

  return undefined;
}

/** Single-shot convenience: spectrograms `samples` and folds every chunk burst it can find. */
export function decodeChunkedSamples(
  samples: Float32Array,
  opts: ChunkOptions,
  slotSamples: number,
  sampleOffset = 0
): ChunkFoldResult | undefined {
  const geom = spectroGeometry(samples.length, opts.baud, opts.sampleRate ?? SAMPLE_RATE);
  if (geom.windows <= 0) return undefined;
  const spec = fullSpectrogram(samples, geom, opts.sampleRate ?? SAMPLE_RATE, 0);
  return decodeChunkedSpectrogram(spec, opts, slotSamples, sampleOffset);
}
