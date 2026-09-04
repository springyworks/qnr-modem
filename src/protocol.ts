import { BITS_PER_SYMBOL, SAMPLE_RATE, symbolSamples } from './config.js';
import { TAIL_BITS, type CodeRate } from './conv.js';
import { dataSymbolCount, type FoldOptions } from './fold.js';
import { LENGTH_BITS } from './framing.js';
import { CHAT_PAYLOAD_BYTES } from './packet.js';
import { textToSymbols, type FrameOptions } from './tx.js';

/**
 * Frozen protocol. Every value here won its parameter sweep; nothing is user tunable,
 * so any two builds of this program can always talk to each other.
 */
export const BAUD = 8;
export const RATE: CodeRate = 3;
export const INTERLEAVER_WIDTH = 64;
/** Shortened sync: enough alternating tones to acquire, without the old drawn-out preamble. */
export const PREAMBLE_PAIRS = 2;
/** Ceiling on back-to-back repeats a station may choose as its FEC strength for one message.
 * Raised well past a quick-chat count so the same protocol can also reach for WSPR-grade
 * weak-signal margin by just repeating longer; the receiver already blindly folds however many
 * of them it actually hears, so this is a practical/memory bound, not a protocol requirement. */
export const REPEATS = 60;
/** Dead air at both ends of a burst's slot: PTT, path delay, and the other station's decode. */
export const GUARD_SECONDS = 2;
/** Chat payload ceiling: fixes the burst's duration. A shorter message doesn't shrink the
 * burst -- it tiles its own coded unit to fill the same fixed budget instead of padding, which
 * is what buys it extra weak-signal margin (see tx.ts `chatBytesToSymbols` / framing.ts
 * `decodeTieredFrame`). */
export const PAYLOAD_BYTES = CHAT_PAYLOAD_BYTES;
export const AMPLITUDE = 0.5;
export const LEAD_SECONDS = 1;

export const FRAME_OPTIONS: FrameOptions = {
  interleaverWidth: INTERLEAVER_WIDTH,
  preamblePairs: PREAMBLE_PAIRS,
  rate: RATE,
};

/** Pads/truncates a chat message to the fixed payload size before it is framed and coded. */
export function padMessage(message: string): string {
  return message.slice(0, PAYLOAD_BYTES).padEnd(PAYLOAD_BYTES, ' ');
}

export const DATA_SYMBOLS = dataSymbolCount(PAYLOAD_BYTES, RATE);

export const BURST_SAMPLES =
  textToSymbols(padMessage(''), 'conv', FRAME_OPTIONS).length * symbolSamples(BAUD);

export const GUARD_SAMPLES = GUARD_SECONDS * SAMPLE_RATE;

/**
 * One repeat is two basic frames: a transmit frame and a listening frame -- always tx, rx, tx,
 * rx... no separate second listening/reply slot (the chat protocol dropped ACK/reply handling
 * already; a second frame just sitting idle bought nothing). A message is sent once, or as
 * several of these back-to-back repeats chosen as its FEC strength -- the receiver folds
 * however many of them it actually hears, without needing to know the count.
 *
 *   |<----- TX ----->|<------- RX ------->|
 *   | g |  BURST  |g|                     |
 *   |<--------- repeat period ----------->|
 */
export const SLOT_SAMPLES = BURST_SAMPLES + 2 * GUARD_SAMPLES;
export const BASIC_FRAMES_PER_REPEAT = 2;
export const PERIOD_SAMPLES = BASIC_FRAMES_PER_REPEAT * SLOT_SAMPLES;
export const GAP_SAMPLES = PERIOD_SAMPLES - BURST_SAMPLES;
export const GAP_SECONDS = GAP_SAMPLES / SAMPLE_RATE;
export const SCHEDULE_SAMPLES = REPEATS * PERIOD_SAMPLES;

/**
 * How deep a *live* station folds. The transmit ceiling (`REPEATS`) may be far larger, but a
 * live receiver has to finish one fold inside a single decode cycle: the search saturates the
 * whole worker pool, and if it overruns, the main thread stops feeding PipeWire and the
 * outgoing audio breaks up. Folding ~28 minutes of ring every 14 s did exactly that. Deep,
 * WSPR-style accumulation belongs in the offline `qnr rx -i file.wav` path, which may take as
 * long as it likes because nothing is being transmitted while it runs.
 *
 * Measured on 12 cores / 9 live worker threads, worst case (idle noise, so no early exit):
 * depth 1 -> 11.6 s, depth 2 -> 14.5 s, depth 4 -> 20.4 s. One decode per period gives a
 * 27.8 s budget, so depth 4 fits with headroom while still buying real repeat gain.
 */
export const LIVE_FOLD_REPEATS = 4;
export const LIVE_RING_SAMPLES = (LIVE_FOLD_REPEATS + 1) * PERIOD_SAMPLES;
/** Live redecode cadence: one attempt per period, which is one attempt per transmitted burst. */
export const LIVE_DECODE_SAMPLES = PERIOD_SAMPLES;

/**
 * World-clock frame grid.
 *
 * The slot grid is anchored to the Unix epoch in UTC, and that anchor is hard-coded here and
 * nowhere else. It is never negotiated, announced or detected: two stations line up simply by
 * both having a correct clock, which any modern computer or radio does. This is what lets a
 * receiver fold by absolute sample position, and what lets a station know whose turn it is
 * without anyone transmitting a "now you go" marker -- the schedule itself is the marker.
 *
 * Sample zero is 1970-01-01T00:00:00Z. Every station therefore computes the same period
 * boundaries, forever, with no shared state.
 */
const modulo = (value: number, divisor: number): number => ((value % divisor) + divisor) % divisor;

/** Absolute position on the world grid, in samples since the Unix epoch. */
export const worldSample = (nowMs: number = Date.now()): number => Math.round((nowMs / 1000) * SAMPLE_RATE);

/** Where we are inside the current period, in samples. */
export const worldPhase = (nowMs: number = Date.now()): number => modulo(worldSample(nowMs), PERIOD_SAMPLES);

/** Burst phase within a period: the transmit slot starts one guard in. */
export const TX_PHASE_SAMPLES = GUARD_SAMPLES;

/** Whose turn the world clock says it is right now. */
export const worldLane = (nowMs: number = Date.now()): 'tx' | 'rx' =>
  Math.floor(worldPhase(nowMs) / SLOT_SAMPLES) === 0 ? 'tx' : 'rx';

/**
 * Milliseconds until the next occurrence of `phaseSamples` on the world grid. A phase that has
 * just passed (or is within `guardMs`) rolls into the following period rather than firing late.
 */
export function msUntilPhase(phaseSamples: number, nowMs: number = Date.now(), guardMs = 20): number {
  const now = worldSample(nowMs);
  const phase = modulo(phaseSamples, PERIOD_SAMPLES);
  let target = Math.floor(now / PERIOD_SAMPLES) * PERIOD_SAMPLES + phase;
  if (target <= now + (guardMs / 1000) * SAMPLE_RATE) target += PERIOD_SAMPLES;
  return ((target - now) / SAMPLE_RATE) * 1000;
}

export const DECODE_OPTIONS: FoldOptions = {
  baud: BAUD,
  periodSamples: PERIOD_SAMPLES,
  preamblePairs: PREAMBLE_PAIRS,
  dataSymbols: DATA_SYMBOLS,
  interleaverWidth: INTERLEAVER_WIDTH,
  rate: RATE,
  payloadBytes: PAYLOAD_BYTES,
  burstSamples: BURST_SAMPLES,
};

/**
 * Fast/chunked grid ("3-second grid"): the same conv+Viterbi+CRC-16 pipeline as the plain chat
 * burst above, but one fixed-size codeword is spread across `CHUNKS` short incremental-redundancy
 * bursts (a striped subset of the interleaved coded bits per burst) instead of sent whole in one
 * long burst. A nearby station can decode once it has folded enough chunk bursts to cover the
 * code; a late-joining or weak station keeps accumulating LLR from whatever subset of bursts it
 * actually hears -- which chunk a given burst carries is derived purely from its position on the
 * shared time grid, so no station needs to know what anyone else already sent (see chunked.ts).
 */
export const CHUNK_INFO_BITS = LENGTH_BITS + PAYLOAD_BYTES * 8 + 16 + TAIL_BITS;
export const CHUNK_TOTAL_BITS = Math.ceil((CHUNK_INFO_BITS * RATE) / BITS_PER_SYMBOL) * BITS_PER_SYMBOL;
/** Must divide CHUNK_TOTAL_BITS exactly so every chunk burst is the same fixed length. */
export const CHUNKS = 6;
if (CHUNK_TOTAL_BITS % CHUNKS !== 0) {
  throw new Error(`CHUNKS=${CHUNKS} must divide CHUNK_TOTAL_BITS=${CHUNK_TOTAL_BITS} evenly`);
}
export const CHUNK_DATA_SYMBOLS = CHUNK_TOTAL_BITS / CHUNKS / BITS_PER_SYMBOL;
export const CHUNK_GUARD_SECONDS = 0.3;
export const CHUNK_GUARD_SAMPLES = Math.round(CHUNK_GUARD_SECONDS * SAMPLE_RATE);
export const CHUNK_BURST_SYMBOLS = PREAMBLE_PAIRS * 2 + CHUNK_DATA_SYMBOLS + 3;
export const CHUNK_BURST_SAMPLES = CHUNK_BURST_SYMBOLS * symbolSamples(BAUD);
/** One 3-second-ish basic frame: chunk burst plus its guards, back to back forever. */
export const CHUNK_SLOT_SAMPLES = CHUNK_BURST_SAMPLES + 2 * CHUNK_GUARD_SAMPLES;

export const summary = (): string =>
  [
    `${BAUD} Bd - 144 tones - 498..3012 Hz (2.51 kHz)`,
    `conv K=7 rate 1/${RATE} + Viterbi, interleave ${INTERLEAVER_WIDTH}, CRC-16`,
    `up to ${REPEATS} repeats of ${(BURST_SAMPLES / SAMPLE_RATE).toFixed(1)}s, chosen as FEC strength, alternating ${(SLOT_SAMPLES / SAMPLE_RATE).toFixed(1)}s tx/rx basic frames (${GUARD_SECONDS}s guards)`,
    `${GAP_SECONDS.toFixed(1)}s listening gap between repeats, up to ${(SCHEDULE_SAMPLES / SAMPLE_RATE / 60).toFixed(0)} min schedule for WSPR-grade weak-signal accumulation`,
    `fast grid: ${(CHUNK_SLOT_SAMPLES / SAMPLE_RATE).toFixed(2)}s chunk bursts, ${CHUNKS}-way incremental redundancy, late-join capable`,
    `schedule ${(SCHEDULE_SAMPLES / SAMPLE_RATE).toFixed(0)}s, chat payload up to ${PAYLOAD_BYTES} bytes (shorter messages tile for extra FEC margin)`,
  ].join('\n');

