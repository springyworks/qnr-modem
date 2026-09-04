#!/usr/bin/env node
/**
 * Offline correctness check for the fast/chunked incremental-redundancy grid (chunked.ts):
 * no audio hardware involved, just encode -> optional channel impairment -> decode.
 *
 * 1. Clean round trip through every chunk in order.
 * 2. Late-join: the "receiver" starts folding partway through the schedule (skips the earliest
 *    chunks entirely, as a station that switched on late would) and must still recover the
 *    message purely from the chunks it actually heard plus the wrap-around repeats.
 * 3. Noisy channel: confirms the CRC does not falsely pass and that enough repeats still let it
 *    converge, same spirit as selftest.ts's existing Monte-Carlo checks elsewhere in this repo.
 */
import { chunkIdAt, chunkPositions, decodeChunkedSamples, modulateChunk, type ChunkOptions } from './chunked.js';
import { applyChannel, meanPower } from './channel.js';
import { BAUD, CHUNKS, CHUNK_DATA_SYMBOLS, CHUNK_GUARD_SAMPLES, CHUNK_SLOT_SAMPLES, CHUNK_TOTAL_BITS, FRAME_OPTIONS, RATE } from './protocol.js';
import { SAMPLE_RATE } from './config.js';
import { decodeChatMessage, encodeChatMessage } from './packet.js';

const opts: ChunkOptions = {
  baud: BAUD,
  rate: RATE,
  interleaverWidth: FRAME_OPTIONS.interleaverWidth!,
  preamblePairs: FRAME_OPTIONS.preamblePairs!,
  chunks: CHUNKS,
  totalBits: CHUNK_TOTAL_BITS,
  dataSymbols: CHUNK_DATA_SYMBOLS,
};

let failures = 0;
const check = (label: string, ok: boolean): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures++;
};

function padTo16(message: string): Uint8Array {
  const bytes = encodeChatMessage(message);
  const out = new Uint8Array(16).fill(0x20);
  out.set(bytes.subarray(0, 16));
  return out;
}

function buildBursts(data: Uint8Array, count: number, startChunk = 0): Float32Array[] {
  const bursts: Float32Array[] = [];
  for (let i = 0; i < count; i++) bursts.push(modulateChunk(data, (startChunk + i) % CHUNKS, opts));
  return bursts;
}

// --- 1. Clean round trip, full spectrogram decode path, in order ---
{
  const message = 'HELLO QNR-144';
  const data = padTo16(message);
  const slotSamples = CHUNK_SLOT_SAMPLES;
  const bursts = buildBursts(data, CHUNKS);
  const samples = new Float32Array(CHUNKS * slotSamples + SAMPLE_RATE);
  for (let i = 0; i < bursts.length; i++) samples.set(bursts[i]!, i * slotSamples + CHUNK_GUARD_SAMPLES);
  const result = decodeChunkedSamples(samples, opts, slotSamples, 0);
  const text = result?.frame.data ? decodeChatMessage(result.frame.data) : undefined;
  check(`clean round trip decodes "${message}" (got ${JSON.stringify(text)}, chunksHeard=${result?.chunksHeard})`, text?.trimEnd() === message);
}

// --- 2. Late join: the receiver's capture only starts partway through the (always chunk-0-
// first) schedule, so it never sees the earliest bursts at all -- it must still recover the
// message purely from the chunks it actually captured plus the wrap-around repeats. ---
{
  const message = 'LATE JOIN OK';
  const data = padTo16(message);
  const slotSamples = CHUNK_SLOT_SAMPLES;
  const bursts = buildBursts(data, CHUNKS + 2); // chunks 0,1,2,3,4,5,0,1 -- normal schedule
  const samples = new Float32Array(bursts.length * slotSamples + SAMPLE_RATE);
  for (let i = 0; i < bursts.length; i++) samples.set(bursts[i]!, i * slotSamples + CHUNK_GUARD_SAMPLES);
  // Emulate a receiver whose capture buffer only starts from the 3rd burst onward (chunk id 2)
  // -- it never captured chunks 0 and 1 the first time around, only via the later wrap.
  const lateSamples = samples.subarray(2 * slotSamples);
  const result = decodeChunkedSamples(lateSamples, opts, slotSamples, 2 * slotSamples);
  const text = result?.frame.data ? decodeChatMessage(result.frame.data) : undefined;
  check(
    `late-joining receiver still decodes "${message}" from chunks it actually heard (got ${JSON.stringify(text)}, chunksHeard=${result?.chunksHeard})`,
    text?.trimEnd() === message
  );
}

// --- 3. Noisy channel: needs the full wrap (repeat gain) to converge, must not false-CRC ---
{
  const message = 'WEAK SIGNAL TEST';
  const data = padTo16(message);
  const slotSamples = CHUNK_SLOT_SAMPLES;
  const rounds = 3; // 3 full wraps = 18 chunk bursts of repeat-style accumulation
  const bursts = buildBursts(data, CHUNKS * rounds);
  const clean = new Float32Array(bursts.length * slotSamples + SAMPLE_RATE);
  for (let i = 0; i < bursts.length; i++) clean.set(bursts[i]!, i * slotSamples + CHUNK_GUARD_SAMPLES);
  const noisy = applyChannel(clean, {
    sampleRate: SAMPLE_RATE,
    snrDb: -14,
    seed: 7,
    referencePower: meanPower(bursts[0]!),
  });
  const result = decodeChunkedSamples(noisy, opts, slotSamples, 0);
  const text = result?.frame.data ? decodeChatMessage(result.frame.data) : undefined;
  check(
    `weak-signal (-14dB) decode after repeat-wrap accumulation (got ${JSON.stringify(text)}, chunksHeard=${result?.chunksHeard}, bursts=${result?.bursts})`,
    text?.trimEnd() === message
  );
}

// --- 4. chunkIdAt / chunkPositions basic sanity ---
{
  check('chunkIdAt is periodic in the schedule', chunkIdAt(0, CHUNK_SLOT_SAMPLES, CHUNKS) === chunkIdAt(CHUNKS * CHUNK_SLOT_SAMPLES, CHUNK_SLOT_SAMPLES, CHUNKS));
  const union = new Set<number>();
  for (let c = 0; c < CHUNKS; c++) for (const p of chunkPositions(CHUNK_TOTAL_BITS, c, CHUNKS)) union.add(p);
  check('chunk stripes partition every bit position exactly once', union.size === CHUNK_TOTAL_BITS);
}

console.log(failures === 0 ? '\nAll fast-grid self tests passed.' : `\n${failures} fast-grid self test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
