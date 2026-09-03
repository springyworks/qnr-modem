import { SAMPLE_RATE, symbolSamples } from './config.js';
import type { CodeRate } from './conv.js';
import { dataSymbolCount, type FoldOptions } from './fold.js';
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
/** Maximum back-to-back repeats a station may choose as its FEC strength for one message. */
export const REPEATS = 8;
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
 * One repeat is three basic frames: a transmit frame and two listening frames. A message is
 * sent once, or as several of these back-to-back repeats chosen as its FEC strength -- the
 * receiver folds however many of them it actually hears, without needing to know the count.
 *
 *   |<----- TX ----->|<--- listen 1 --->|<--- listen 2 ----->|
 *   | g |  BURST  |g|                 ...                    |
 *   |<------------------------- repeat period -------------------->|
 */
export const SLOT_SAMPLES = BURST_SAMPLES + 2 * GUARD_SAMPLES;
export const BASIC_FRAMES_PER_REPEAT = 3;
export const PERIOD_SAMPLES = BASIC_FRAMES_PER_REPEAT * SLOT_SAMPLES;
export const GAP_SAMPLES = PERIOD_SAMPLES - BURST_SAMPLES;
export const GAP_SECONDS = GAP_SAMPLES / SAMPLE_RATE;
export const SCHEDULE_SAMPLES = REPEATS * PERIOD_SAMPLES;

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

export const summary = (): string =>
  [
    `${BAUD} Bd - 144 tones - 498..3012 Hz (2.51 kHz)`,
    `conv K=7 rate 1/${RATE} + Viterbi, interleave ${INTERLEAVER_WIDTH}, CRC-16`,
    `up to ${REPEATS} repeats of ${(BURST_SAMPLES / SAMPLE_RATE).toFixed(1)}s, chosen as FEC strength, in three ${(SLOT_SAMPLES / SAMPLE_RATE).toFixed(1)}s basic frames (${GUARD_SECONDS}s guards)`,
    `${GAP_SECONDS.toFixed(1)}s listening gap between repeats`,
    `schedule ${(SCHEDULE_SAMPLES / SAMPLE_RATE).toFixed(0)}s, chat payload up to ${PAYLOAD_BYTES} bytes (shorter messages tile for extra FEC margin)`,
  ].join('\n');

