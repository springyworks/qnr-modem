/** Tone plan is kept bit-identical to the browser version so both ends interoperate. */
export const SAMPLE_RATE = 48000;
export const FFT_SIZE = 8192;
export const HZ_PER_BIN = SAMPLE_RATE / FFT_SIZE;
export const TONE_SPACING_BINS = 3;
export const NUM_TONES = 144;
export const BASE_BIN = Math.round(500 / HZ_PER_BIN);

export const SYM_SYNC_1 = 130;
export const SYM_SYNC_2 = 140;
export const SYM_IDLE = 143;

export const PREAMBLE_PAIRS = 4;
export const DEFAULT_BAUD = 4;
export const DEFAULT_SQUELCH_DB = -65;

/** Data rides on tones 0..127 so the sync/idle tones and the 144-tone melody stay unchanged. */
export const DATA_TONES = 128;
export const BITS_PER_SYMBOL = 7;

export type FecMode = 'hamming' | 'conv';
export const DEFAULT_FEC: FecMode = 'conv';

/** offsetHz shifts the whole comb to follow a mistuned transmitter or receiver. */
export function toneFreq(symbol: number, offsetHz = 0): number {
  return (BASE_BIN + symbol * TONE_SPACING_BINS) * HZ_PER_BIN + offsetHz;
}

export const TONE_SPACING_HZ = TONE_SPACING_BINS * HZ_PER_BIN;

export function symbolSamples(baud: number, sampleRate = SAMPLE_RATE): number {
  return Math.round(sampleRate / baud);
}
