import { BITS_PER_SYMBOL } from './config.js';
import { TAIL_BITS, viterbiDecode, type CodeRate } from './conv.js';
import { crc16 } from './crc.js';
import { deinterleave } from './interleave.js';

export const LENGTH_BITS = 16;
export const MAX_PAYLOAD_BYTES = 512;

function pushByte(bits: number[], value: number, width: number): void {
  for (let i = width - 1; i >= 0; i--) bits.push((value >> i) & 1);
}

function readNumber(bits: Uint8Array, offset: number, width: number): number {
  let value = 0;
  for (let i = 0; i < width; i++) value = (value << 1) | (bits[offset + i]! & 1);
  return value;
}

/** Frame layout: length:16 | payload | crc16(payload) | zero tail. */
export function buildInfoBits(data: Uint8Array): Uint8Array {
  const bits: number[] = [];
  pushByte(bits, data.length, LENGTH_BITS);
  for (const byte of data) pushByte(bits, byte, 8);
  pushByte(bits, crc16(data), 16);
  for (let i = 0; i < TAIL_BITS; i++) bits.push(0);
  return Uint8Array.from(bits);
}

export interface ParsedFrame {
  ok: boolean;
  reason?: string;
  data?: Uint8Array;
}

export function parseInfoBits(bits: Uint8Array): ParsedFrame {
  if (bits.length < LENGTH_BITS + 16) return { ok: false, reason: 'frame too short' };

  const length = readNumber(bits, 0, LENGTH_BITS);
  if (length === 0 || length > MAX_PAYLOAD_BYTES) return { ok: false, reason: `bad length ${length}` };

  const needed = LENGTH_BITS + length * 8 + 16;
  if (bits.length < needed) return { ok: false, reason: 'truncated frame' };

  const data = new Uint8Array(length);
  for (let i = 0; i < length; i++) data[i] = readNumber(bits, LENGTH_BITS + i * 8, 8);

  const received = readNumber(bits, LENGTH_BITS + length * 8, 16);
  if (received !== crc16(data)) return { ok: false, reason: 'CRC mismatch' };

  return { ok: true, data };
}

export interface TieredDecodeOptions {
  interleaverWidth: number;
  rate: CodeRate;
  /** Protocol's payload ceiling; every length from here down to 1 byte is tried. */
  maxPayloadBytes: number;
}

/** Coded+padded bit count for one payload length; must track tx.ts's own per-unit padding. */
function unitCodedBits(payloadBytes: number, rate: CodeRate): number {
  const infoBits = LENGTH_BITS + payloadBytes * 8 + 16 + TAIL_BITS;
  return Math.ceil((infoBits * rate) / BITS_PER_SYMBOL) * BITS_PER_SYMBOL;
}

/**
 * A short chat message tiles its own coded unit to fill the fixed symbol budget instead of
 * sending padding, so this recombines however many whole copies fit (same LLR-summing trick
 * already used to combine repeated bursts, just inside a single one) before a single Viterbi
 * decode. Tries every payload length down from the ceiling; CRC-16 alone decides which length,
 * if any, is the true one -- a wrong hypothesis passing by chance is astronomically unlikely.
 */
export function decodeTieredFrame(soft: Float64Array, opts: TieredDecodeOptions): ParsedFrame | undefined {
  for (let length = opts.maxPayloadBytes; length >= 1; length--) {
    const unitBits = unitCodedBits(length, opts.rate);
    const repeats = Math.floor(soft.length / unitBits);
    if (repeats < 1) continue;

    const unitSoft = new Float64Array(unitBits);
    for (let r = 0; r < repeats; r++) {
      const base = r * unitBits;
      for (let i = 0; i < unitBits; i++) unitSoft[i]! += soft[base + i]!;
    }

    const frame = parseInfoBits(viterbiDecode(deinterleave(unitSoft, opts.interleaverWidth), opts.rate));
    if (frame.ok && frame.data && frame.data.length === length) return frame;
  }
  return undefined;
}
