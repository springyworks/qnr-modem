import { NUM_TONES, SAMPLE_RATE, toneFreq } from './config.js';
import { ITU_PROFILES, applyChannel, meanPower } from './channel.js';
import { foldDecodeAll } from './fold.js';
import { CHAT_PAYLOAD_BYTES, decodeChatMessage, encodeChatMessage } from './packet.js';
import {
  AMPLITUDE,
  BAUD,
  BURST_SAMPLES,
  DATA_SYMBOLS,
  DECODE_OPTIONS,
  FRAME_OPTIONS,
  GUARD_SAMPLES,
  LIVE_FOLD_REPEATS,
  msUntilPhase,
  PAYLOAD_BYTES,
  PERIOD_SAMPLES,
  REPEATS,
  SLOT_SAMPLES,
  summary,
  TX_PHASE_SAMPLES,
  worldLane,
  worldPhase,
} from './protocol.js';
import { Receiver } from './rx.js';
import { modulate, modulateChatMessage } from './tx.js';
import { QNR_PAGE_URL, qrHalfBlockArt } from './qr.js';

/**
 * Browser-facing facade. Imports only the pure-DSP modules -- nothing that touches
 * node:worker_threads, node:child_process or the filesystem -- so the identical, tested modem
 * code that runs in the CLI can be bundled for a web page. The multi-threaded `search.ts` path
 * is deliberately not used here; the browser gets the single-threaded `foldDecodeAll`.
 */

export const info = {
  sampleRate: SAMPLE_RATE,
  baud: BAUD,
  tones: NUM_TONES,
  payloadBytes: CHAT_PAYLOAD_BYTES,
  repeats: REPEATS,
  liveFoldRepeats: LIVE_FOLD_REPEATS,
  burstSeconds: BURST_SAMPLES / SAMPLE_RATE,
  slotSeconds: SLOT_SAMPLES / SAMPLE_RATE,
  periodSeconds: PERIOD_SAMPLES / SAMPLE_RATE,
  lowHz: toneFreq(0),
  highHz: toneFreq(NUM_TONES - 1),
  summary: summary(),
  profiles: Object.keys(ITU_PROFILES),
};

/** The published GitHub Pages URL for this page, so the terminal's `qr` command doesn't hard-code it twice. */
export const pageUrl = QNR_PAGE_URL;

/** A real, scannable QR code for `text` (default: this page's own URL), as terminal block-art lines. */
export function qrLines(text: string = QNR_PAGE_URL): string[] {
  return qrHalfBlockArt(text);
}

/**
 * Sounds `text` (default: this page's own URL) out as a real modem burst -- arbitrary-length
 * conv+Viterbi frame, not the fixed 16-byte chat protocol, so the full URL survives intact.
 * Best-effort: this frame shape isn't wired into `liveReceiver`/`decode` above.
 */
export function qrAudio(text: string = QNR_PAGE_URL): Float32Array {
  return modulate(text, BAUD, AMPLITUDE, SAMPLE_RATE, 'conv', FRAME_OPTIONS);
}

export const clean = (text: string): string => decodeChatMessage(encodeChatMessage(text)) ?? '';

/**
 * The world-clock frame grid, anchored to the Unix epoch in UTC (see protocol.ts). Exposed so
 * the page can wait for its transmit slot exactly like the terminal station does -- the grid is
 * hard-coded, so a browser and a command-line station agree with no negotiation at all.
 */
export const grid = {
  /** Milliseconds until the next world-time transmit slot. */
  msUntilTx: (nowMs?: number): number => msUntilPhase(TX_PHASE_SAMPLES, nowMs),
  /** Whose turn the world clock says it is: 'tx' or 'rx'. */
  lane: (nowMs?: number): 'tx' | 'rx' => worldLane(nowMs),
  /** Seconds elapsed into the current period. */
  phaseSeconds: (nowMs?: number): number => worldPhase(nowMs) / SAMPLE_RATE,
  periodSeconds: PERIOD_SAMPLES / SAMPLE_RATE,
  slotSeconds: SLOT_SAMPLES / SAMPLE_RATE,
};

/** One burst of the fixed chat protocol, ready to hand to Web Audio. */
export function burst(text: string): Float32Array {
  return modulateChatMessage(encodeChatMessage(text), DATA_SYMBOLS, BAUD, AMPLITUDE, SAMPLE_RATE, FRAME_OPTIONS);
}

/** `repeats` bursts laid out on the protocol's own tx/rx period grid. */
export function schedule(text: string, repeats: number): Float32Array {
  const one = burst(text);
  const count = Math.max(1, Math.min(REPEATS, Math.round(repeats)));
  const out = new Float32Array((count - 1) * PERIOD_SAMPLES + GUARD_SAMPLES + one.length + GUARD_SAMPLES);
  for (let i = 0; i < count; i++) out.set(one, i * PERIOD_SAMPLES + GUARD_SAMPLES);
  return out;
}

export interface SimOptions {
  snrDb: number;
  profile?: string | null;
  seed?: number;
}

/** Adds the same Watterson/AWGN test channel the CLI's `--snr`/`--profile` flags use. */
export function simulate(samples: Float32Array, reference: Float32Array, opts: SimOptions): Float32Array {
  return applyChannel(samples, {
    sampleRate: SAMPLE_RATE,
    snrDb: opts.snrDb,
    profile: opts.profile ? (ITU_PROFILES[opts.profile] ?? null) : null,
    seed: opts.seed ?? 1,
    referencePower: meanPower(reference),
  });
}

export interface DecodeHit {
  text: string;
  bursts: number;
  offsetHz: number;
  driftPpm: number;
}

/** Weak-signal folded decode of a whole recording (single-threaded browser path). */
export function decode(samples: Float32Array): DecodeHit[] {
  const out: DecodeHit[] = [];
  for (const hit of foldDecodeAll(samples, DECODE_OPTIONS)) {
    const text = decodeChatMessage(hit.text);
    if (text) out.push({ text, bursts: hit.bursts ?? 1, offsetHz: hit.offsetHz, driftPpm: hit.driftPpm });
  }
  return out;
}

/**
 * Streaming single-burst receiver for loud/off-grid signals, fed from a live microphone. This
 * is the same class the CLI station uses for its direct decode path.
 */
export function liveReceiver(onText: (text: string) => void): { push(block: Float32Array): void } {
  let pending = '';
  const rx = new Receiver(
    BAUD,
    {
      onChar: (character) => {
        pending += character;
      },
      onFrame: (frame) => {
        const text = frame.ok ? decodeChatMessage(pending) : undefined;
        pending = '';
        if (text) onText(text);
      },
    },
    SAMPLE_RATE,
    'conv',
    {
      interleaverWidth: FRAME_OPTIONS.interleaverWidth,
      rate: FRAME_OPTIONS.rate,
      combineRepeats: false,
      maxPayloadBytes: PAYLOAD_BYTES,
      dataSymbols: DATA_SYMBOLS,
      preamblePairs: FRAME_OPTIONS.preamblePairs,
    }
  );
  return { push: (block: Float32Array) => rx.push(block) };
}
