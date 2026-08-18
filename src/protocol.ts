import { SAMPLE_RATE, symbolSamples } from './config.js';
import type { CodeRate } from './conv.js';
import { dataSymbolCount, type FoldOptions } from './fold.js';
import { textToSymbols, type FrameOptions } from './tx.js';

/**
 * Frozen protocol. Every value here won its parameter sweep; nothing is user tunable,
 * so any two builds of this program can always talk to each other.
 */
export const BAUD = 8;
export const RATE: CodeRate = 3;
export const INTERLEAVER_WIDTH = 64;
export const PREAMBLE_PAIRS = 4;
export const REPEATS = 8;
export const GAP_SECONDS = 8;
export const PAYLOAD_BYTES = 16;
export const AMPLITUDE = 0.5;
export const LEAD_SECONDS = 1;

export const FRAME_OPTIONS: FrameOptions = {
  interleaverWidth: INTERLEAVER_WIDTH,
  preamblePairs: PREAMBLE_PAIRS,
  rate: RATE,
};

/** Fixed payload size keeps the frame length constant, so the receiver never has to guess it. */
export function padMessage(message: string): string {
  return message.slice(0, PAYLOAD_BYTES).padEnd(PAYLOAD_BYTES, ' ');
}

export const DATA_SYMBOLS = dataSymbolCount(PAYLOAD_BYTES, RATE);

export const BURST_SAMPLES =
  textToSymbols(padMessage(''), 'conv', FRAME_OPTIONS).length * symbolSamples(BAUD);

export const GAP_SAMPLES = GAP_SECONDS * SAMPLE_RATE;
export const PERIOD_SAMPLES = BURST_SAMPLES + GAP_SAMPLES;
export const SCHEDULE_SAMPLES = REPEATS * BURST_SAMPLES + (REPEATS - 1) * GAP_SAMPLES;

export const DECODE_OPTIONS: FoldOptions = {
  baud: BAUD,
  periodSamples: PERIOD_SAMPLES,
  preamblePairs: PREAMBLE_PAIRS,
  dataSymbols: DATA_SYMBOLS,
  interleaverWidth: INTERLEAVER_WIDTH,
  rate: RATE,
};

export const summary = (): string =>
  [
    `${BAUD} Bd - 144 tones - 498..3012 Hz (2.51 kHz)`,
    `conv K=7 rate 1/${RATE} + Viterbi, interleave ${INTERLEAVER_WIDTH}, CRC-16`,
    `${REPEATS} bursts of ${(BURST_SAMPLES / SAMPLE_RATE).toFixed(1)}s, ${GAP_SECONDS}s listening gaps`,
    `schedule ${(SCHEDULE_SAMPLES / SAMPLE_RATE).toFixed(0)}s, payload ${PAYLOAD_BYTES} chars`,
  ].join('\n');
