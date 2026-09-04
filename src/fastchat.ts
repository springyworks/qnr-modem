import * as readline from 'node:readline';
import { createAudioIdentity, startCapture, startPersistentPlayback, type PersistentPlayback } from './audio.js';
import { chunkIdAt, decodeChunkedSamples, modulateChunk, type ChunkOptions } from './chunked.js';
import { SAMPLE_RATE } from './config.js';
import { decodeChatMessage, encodeChatMessage } from './packet.js';
import {
  AMPLITUDE,
  BAUD,
  CHUNKS,
  CHUNK_DATA_SYMBOLS,
  CHUNK_GUARD_SAMPLES,
  CHUNK_SLOT_SAMPLES,
  CHUNK_TOTAL_BITS,
  FRAME_OPTIONS,
  RATE,
} from './protocol.js';

const CHUNK_OPTS: ChunkOptions = {
  baud: BAUD,
  rate: RATE,
  interleaverWidth: FRAME_OPTIONS.interleaverWidth!,
  preamblePairs: FRAME_OPTIONS.preamblePairs!,
  chunks: CHUNKS,
  totalBits: CHUNK_TOTAL_BITS,
  dataSymbols: CHUNK_DATA_SYMBOLS,
};

const SLOT_MS = (CHUNK_SLOT_SAMPLES / SAMPLE_RATE) * 1000;
/** How many chunk bursts the RX ring keeps: a few full wraps, so weak signals get real repeat gain. */
const RING_SLOTS = CHUNKS * 3;
const RING_CAPACITY = RING_SLOTS * CHUNK_SLOT_SAMPLES;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const nowSamples = (): number => Math.round((Date.now() / 1000) * SAMPLE_RATE);

/** Fixes the codeword's total bit count regardless of message length -- see protocol.ts's CHUNK_*. */
function padTo16(message: string): Uint8Array {
  const bytes = encodeChatMessage(message);
  const out = new Uint8Array(16).fill(0x20);
  out.set(bytes.subarray(0, Math.min(bytes.length, 16)));
  return out;
}

export interface FastChatOptions {
  message?: string;
}

/**
 * The "3-second grid": one fixed-size chat codeword striped across `CHUNKS` short bursts
 * instead of one long one (see chunked.ts). Every burst lands on a shared, clock-derived slot
 * (`chunkIdAt`) so any station -- near or far, joined early or late -- can fold whatever chunk
 * bursts it actually hears into a CRC-16 decode without needing to know what came before it.
 * A message is repeated forever, one chunk per slot, until the operator sends a new one.
 */
export function runFastChat(opts: FastChatOptions): void {
  const identity = createAudioIdentity();
  let stopped = false;
  let outboundData: Uint8Array | undefined;
  let outboundText = '';

  const ring = new Float32Array(RING_CAPACITY);
  const sampleOrigin = nowSamples();
  let write = 0;
  let filled = 0;
  let capturedSamples = 0;
  let decoding = false;

  let playback: PersistentPlayback | undefined;
  let capture: ReturnType<typeof startCapture> | undefined;
  let decodeTimer: ReturnType<typeof setInterval> | undefined;
  let lineReader: readline.Interface | undefined;

  const log = (line: string): void => {
    if (lineReader) {
      readline.cursorTo(process.stdout, 0);
      readline.clearLine(process.stdout, 0);
      console.log(line);
      lineReader.prompt(true);
    } else {
      console.log(line);
    }
  };

  const orderedRing = (): Float32Array => {
    const ordered = new Float32Array(filled);
    const start = (write - filled + ring.length) % ring.length;
    for (let i = 0; i < filled; i++) ordered[i] = ring[(start + i) % ring.length]!;
    return ordered;
  };

  const resetRing = (): void => {
    write = 0;
    filled = 0;
  };

  const pushCapture = (block: Float32Array): void => {
    for (const sample of block) {
      ring[write] = sample;
      write = (write + 1) % ring.length;
    }
    filled = Math.min(ring.length, filled + block.length);
    capturedSamples += block.length;
  };

  const tryDecode = (): void => {
    if (decoding || filled < CHUNK_SLOT_SAMPLES * 2) return;
    decoding = true;
    try {
      const samples = orderedRing();
      const sampleOffset = sampleOrigin + capturedSamples - filled;
      const result = decodeChunkedSamples(samples, CHUNK_OPTS, CHUNK_SLOT_SAMPLES, sampleOffset);
      if (result?.frame.data) {
        const text = decodeChatMessage(result.frame.data)?.replace(/\s+$/, '');
        if (text) {
          log(`  RX "${text}"  (${result.chunksHeard}/${CHUNKS} chunks, ${result.bursts} bursts folded)`);
          resetRing();
        }
      }
    } finally {
      decoding = false;
    }
  };

  const queueMessage = (raw: string): void => {
    const text = decodeChatMessage(encodeChatMessage(raw)) ?? '';
    if (text.length === 0) {
      log('nothing to send: no printable ASCII characters');
      return;
    }
    outboundText = text;
    outboundData = padTo16(text);
    log(`  queued for the fast grid: "${text}"`);
  };

  async function txLoop(): Promise<void> {
    let lastSlotIndex = -1;
    while (!stopped) {
      if (!outboundData) {
        await delay(200);
        continue;
      }
      const now = nowSamples();
      let slotIndex = Math.floor(now / CHUNK_SLOT_SAMPLES);
      if (slotIndex <= lastSlotIndex) slotIndex = lastSlotIndex + 1;
      const slotStart = slotIndex * CHUNK_SLOT_SAMPLES;
      const waitMs = ((slotStart - now) / SAMPLE_RATE) * 1000;
      if (waitMs > 1) await delay(waitMs);
      if (stopped || !outboundData) continue;

      const chunkId = chunkIdAt(slotIndex * CHUNK_SLOT_SAMPLES, CHUNK_SLOT_SAMPLES, CHUNKS);
      const burst = modulateChunk(outboundData, chunkId, CHUNK_OPTS, AMPLITUDE);
      await delay((CHUNK_GUARD_SAMPLES / SAMPLE_RATE) * 1000);
      log(`  TX chunk ${chunkId + 1}/${CHUNKS}  "${outboundText}"`);
      try {
        await playback?.play(burst);
      } catch (error) {
        log(`transmit error: ${error instanceof Error ? error.message : String(error)}`);
      }
      lastSlotIndex = slotIndex;
    }
  }

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (decodeTimer) clearInterval(decodeTimer);
    capture?.stop();
    playback?.stop();
    lineReader?.close();
    process.exit(0);
  };

  playback = startPersistentPlayback({ identity, onError: (error) => log(`playback error: ${error.message}`) });
  capture = startCapture((block) => pushCapture(block), {
    identity,
    onError: (error) => log(`capture error: ${error.message}`),
  });
  decodeTimer = setInterval(tryDecode, SLOT_MS);
  process.on('SIGINT', stop);

  if (opts.message) queueMessage(opts.message);
  void txLoop();

  lineReader = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
  log(
    `fastchat  ${identity.label}  ${(CHUNK_SLOT_SAMPLES / SAMPLE_RATE).toFixed(2)}s grid, ${CHUNKS}-way incremental redundancy  -  type a message and press enter, Ctrl-D to quit`
  );
  lineReader.prompt();
  lineReader.on('line', (line) => {
    queueMessage(line);
    lineReader?.prompt();
  });
  lineReader.on('close', stop);
}
