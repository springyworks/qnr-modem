import {
  BITS_PER_SYMBOL,
  PREAMBLE_PAIRS,
  SAMPLE_RATE,
  SYM_IDLE,
  SYM_SYNC_1,
  SYM_SYNC_2,
  symbolSamples,
  toneFreq,
  type FecMode,
} from './config.js';
import { convEncode, type CodeRate } from './conv.js';
import { buildInfoBits } from './framing.js';
import { hammingEncode } from './hamming.js';
import { INTERLEAVER_WIDTH, interleave } from './interleave.js';

function hammingSymbols(text: string): number[] {
  const symbols: number[] = [];
  for (const char of text) {
    const code = char.charCodeAt(0) & 0xff;
    symbols.push(hammingEncode((code >> 4) & 0x0f));
    symbols.push(hammingEncode(code & 0x0f));
  }
  return symbols;
}

function convSymbols(text: string, interleaverWidth: number, rate: CodeRate): number[] {
  const data = Uint8Array.from(text, (c) => c.charCodeAt(0) & 0xff);
  const coded = convEncode(buildInfoBits(data), rate);

  // Pad to a whole number of symbols before interleaving so the receiver can invert it blindly.
  const padded = new Uint8Array(Math.ceil(coded.length / BITS_PER_SYMBOL) * BITS_PER_SYMBOL);
  padded.set(coded);

  const shuffled = interleave(padded, interleaverWidth);
  const symbols: number[] = [];
  for (let i = 0; i < shuffled.length; i += BITS_PER_SYMBOL) {
    let symbol = 0;
    for (let b = 0; b < BITS_PER_SYMBOL; b++) symbol |= shuffled[i + b]! << (BITS_PER_SYMBOL - 1 - b);
    symbols.push(symbol);
  }
  return symbols;
}

export interface FrameOptions {
  interleaverWidth?: number;
  preamblePairs?: number;
  rate?: CodeRate;
}

export function textToSymbols(text: string, mode: FecMode = 'hamming', opts: FrameOptions = {}): number[] {
  const { interleaverWidth = INTERLEAVER_WIDTH, preamblePairs = PREAMBLE_PAIRS, rate = 2 } = opts;
  const symbols: number[] = [];
  for (let i = 0; i < preamblePairs; i++) symbols.push(SYM_SYNC_1, SYM_SYNC_2);
  symbols.push(...(mode === 'conv' ? convSymbols(text, interleaverWidth, rate) : hammingSymbols(text)));
  symbols.push(SYM_IDLE, SYM_IDLE, SYM_IDLE);
  return symbols;
}

/** Continuous-phase MFSK so symbol transitions stay click-free. */
export function modulateSymbols(
  symbols: number[],
  baud: number,
  amplitude = 0.5,
  sampleRate = SAMPLE_RATE
): Float32Array {
  const spb = symbolSamples(baud, sampleRate);
  const out = new Float32Array(symbols.length * spb);

  let phase = 0;
  let n = 0;
  for (const symbol of symbols) {
    const step = (2 * Math.PI * toneFreq(symbol)) / sampleRate;
    for (let i = 0; i < spb; i++) {
      out[n++] = amplitude * Math.sin(phase);
      phase += step;
      if (phase > 2 * Math.PI) phase -= 2 * Math.PI;
    }
  }

  const fade = Math.min(256, spb);
  for (let i = 0; i < fade; i++) {
    const g = i / fade;
    out[i]! *= g;
    out[out.length - 1 - i]! *= g;
  }
  return out;
}

export function modulate(
  text: string,
  baud: number,
  amplitude = 0.5,
  sampleRate = SAMPLE_RATE,
  mode: FecMode = 'hamming',
  opts: FrameOptions = {}
): Float32Array {
  return modulateSymbols(textToSymbols(text, mode, opts), baud, amplitude, sampleRate);
}

/** send-listen-send-listen: identical bursts separated by exact-length listening gaps. */
export function modulateSchedule(
  text: string,
  baud: number,
  repeats: number,
  gapSeconds: number,
  amplitude = 0.5,
  sampleRate = SAMPLE_RATE,
  opts: FrameOptions = {}
): Float32Array {
  const burst = modulate(text, baud, amplitude, sampleRate, 'conv', opts);
  const gap = Math.round(gapSeconds * sampleRate);
  const out = new Float32Array(repeats * burst.length + (repeats - 1) * gap);
  for (let r = 0; r < repeats; r++) out.set(burst, r * (burst.length + gap));
  return out;
}
