import { TAIL_BITS } from './conv.js';
import { crc16 } from './crc.js';

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
