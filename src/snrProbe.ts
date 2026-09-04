import { ITU_PROFILES, applyChannel, meanPower } from './channel.js';
import { SAMPLE_RATE } from './config.js';
import { CHAT_PAYLOAD_BYTES, decodeChatMessage, encodeChatMessage } from './packet.js';
import { workerCount } from './pool.js';
import {
  AMPLITUDE,
  BAUD,
  DATA_SYMBOLS,
  DECODE_OPTIONS,
  FRAME_OPTIONS,
  GUARD_SAMPLES,
  PAYLOAD_BYTES,
  PERIOD_SAMPLES,
  REPEATS,
} from './protocol.js';
import { Receiver } from './rx.js';
import { DecodeSearch } from './search.js';
import { modulateChatMessage } from './tx.js';

/**
 * Real-pipeline SNR probes, run on demand (not part of `npm run selftest`): exercises the exact
 * production tx/rx code paths (rx.ts's streaming direct decoder for fast off-grid chat, and
 * search.ts's DecodeSearch for the folded weak-signal path) so results reflect what an operator
 * would actually get, not a synthetic proxy. Logs continuously so a long run is never silent.
 */

const JOBS = workerCount();
const t0 = Date.now();
const elapsed = (): string => `${((Date.now() - t0) / 1000).toFixed(0)}s`;

function withSilence(signal: Float32Array, padSamples: number): Float32Array {
  const out = new Float32Array(signal.length + padSamples * 2);
  out.set(signal, padSamples);
  return out;
}

function oneBurst(message: string): { samples: Float32Array; burst: Float32Array } {
  const burst = modulateChatMessage(encodeChatMessage(message), DATA_SYMBOLS, BAUD, AMPLITUDE, SAMPLE_RATE, FRAME_OPTIONS);
  return { samples: withSilence(burst, Math.round(SAMPLE_RATE * 0.5)), burst };
}

function fullSchedule(message: string): { samples: Float32Array; burst: Float32Array } {
  const burst = modulateChatMessage(encodeChatMessage(message), DATA_SYMBOLS, BAUD, AMPLITUDE, SAMPLE_RATE, FRAME_OPTIONS);
  const clean = new Float32Array(REPEATS * PERIOD_SAMPLES + SAMPLE_RATE);
  for (let repeat = 0; repeat < REPEATS; repeat++) clean.set(burst, repeat * PERIOD_SAMPLES + GUARD_SAMPLES);
  return { samples: clean, burst };
}

/** Direct/off-grid decode of one un-repeated burst, exactly as live.ts's ContinuousReceiver.direct does. */
function decodeDirect(samples: Float32Array): string | undefined {
  let ok = false;
  let text = '';
  const rx = new Receiver(
    BAUD,
    {
      onChar: (ch) => (text += ch),
      onFrame: (frame) => {
        ok = frame.ok;
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
  const chunk = 4096;
  for (let i = 0; i < samples.length; i += chunk) rx.push(samples.subarray(i, Math.min(i + chunk, samples.length)));
  return ok ? decodeChatMessage(text) : undefined;
}

async function fastChatProbe(): Promise<void> {
  const message = 'CQ CQ DE QNR';
  const profile = ITU_PROFILES['moderate']!;
  const snrList = [-4, -8, -12, -16];
  const trials = 12;

  console.log('\n=== Fast chat: single off-grid burst, no repeat-fold ===');
  console.log(`message "${message}", channel ${profile.name}, ${trials} trials/SNR, direct streaming decoder\n`);

  for (const snrDb of snrList) {
    let passed = 0;
    for (let t = 0; t < trials; t++) {
      const { samples, burst } = oneBurst(message);
      const noisy = applyChannel(samples, { sampleRate: SAMPLE_RATE, snrDb, profile, seed: 1000 + t, referencePower: meanPower(burst) });
      const decoded = decodeDirect(noisy);
      const ok = decoded === message;
      if (ok) passed++;
      process.stdout.write(ok ? '.' : 'x');
    }
    console.log(`  ${snrDb.toString().padStart(4)} dB : ${passed}/${trials} (${Math.round((passed / trials) * 100)}%)  [${elapsed()}]`);
  }
}

interface CellResult {
  rate: number;
  passed: number;
  trials: number;
}

async function foldCell(search: DecodeSearch, message: string, profile: typeof ITU_PROFILES['poor'], snrDb: number, trials: number): Promise<CellResult> {
  let passed = 0;
  for (let t = 0; t < trials; t++) {
    const { samples, burst } = fullSchedule(message);
    const noisy = applyChannel(samples, { sampleRate: SAMPLE_RATE, snrDb, profile, seed: 2000 + t, referencePower: meanPower(burst) });
    const started = Date.now();
    const result = await search.decodeAll(noisy);
    const decoded = result.find((r) => decodeChatMessage(r.text) === message);
    const ok = decoded !== undefined;
    if (ok) passed++;
    console.log(
      `    trial ${t + 1}/${trials}: ${ok ? 'PASS' : 'fail'} (${((Date.now() - started) / 1000).toFixed(1)}s)  [${elapsed()}]`
    );
  }
  return { rate: passed / trials, passed, trials };
}

/**
 * Adaptive SNR ladder: try the extreme first, fall back to an easy sanity point, then bisect
 * the bracket -- exactly the scheme the user described, so a run never wastes time on the
 * whole 24-30dB span at fixed steps when a handful of probes pin the limit down directly.
 */
async function farAwayProbe(): Promise<void> {
  const message = 'CQ QNR TEST';
  const profile = ITU_PROFILES['poor']!;
  const trials = 5;
  const successThreshold = 0.5; // majority of `trials` decodes counts as "works" for the ladder

  console.log('\n=== Far-away station: full 8-repeat folded schedule ===');
  console.log(`message "${message}", channel ${profile.name}, ${trials} trials/SNR, ${REPEATS}x repeats`);
  console.log(
    `protocol ceiling: REPEATS=${REPEATS}, one full schedule = ${(REPEATS * PERIOD_SAMPLES / SAMPLE_RATE / 60).toFixed(1)} min of audio`
  );
  console.log(`(note: this tests the protocol's built-in 8-repeat diversity, not hour-long WSPR-style`);
  console.log(` accumulation across repeated schedules -- that would need a new receiver mode, not built yet)`);
  console.log(`DecodeSearch worker pool: ${JOBS} threads (cores - 1)\n`);

  const search = new DecodeSearch(DECODE_OPTIONS, JOBS);
  try {
    const tested = new Map<number, CellResult>();
    const probe = async (snrDb: number): Promise<CellResult> => {
      const cached = tested.get(snrDb);
      if (cached) return cached;
      console.log(`--- probing ${snrDb} dB ---`);
      const result = await foldCell(search, message, profile, snrDb, trials);
      console.log(`  => ${snrDb} dB: ${result.passed}/${result.trials} (${Math.round(result.rate * 100)}%)  [${elapsed()}]`);
      tested.set(snrDb, result);
      return result;
    };

    console.log('Step 1: extreme -24 dB');
    const extreme = await probe(-24);
    if (extreme.rate >= successThreshold) {
      console.log('-24 dB already works -- pushing one step further to -28 dB as a stretch check.');
      const stretch = await probe(-28);
      console.log(
        stretch.rate >= successThreshold
          ? 'Even -28 dB works with this channel/trial count; the real floor is beyond this probe.'
          : 'Limit sits between -28 dB (fails) and -24 dB (works).'
      );
      return;
    }

    console.log('-24 dB fails. Step 2: easy sanity point -5 dB');
    const easy = await probe(-5);
    if (easy.rate < successThreshold) {
      console.log(
        'ANOMALY: -5 dB also fails. That should be an easy decode -- treat this as a bug report, not a channel limit.'
      );
      return;
    }

    console.log('-5 dB works, -24 dB fails: bisecting the bracket.');
    let bad = -24; // known to fail
    let good = -5; // known to work
    for (let iter = 0; iter < 5 && good - bad > 1.5; iter++) {
      const mid = Math.round((bad + good) / 2);
      if (mid === bad || mid === good) break;
      console.log(`Step ${3 + iter}: bisect midpoint ${mid} dB (bracket [${bad}, ${good}])`);
      const cell = await probe(mid);
      if (cell.rate >= successThreshold) good = mid;
      else bad = mid;
    }
    console.log(`\nLimit for ${profile.name} at ${REPEATS}x repeats: works at ${good} dB, fails at ${bad} dB.`);
  } finally {
    search.close();
  }
}

async function main(): Promise<void> {
  console.log(`SNR probe starting, ${JOBS} worker threads (cores - 1) available to the folded search.`);
  await fastChatProbe();
  await farAwayProbe();
  console.log(`\nDone. Total time ${elapsed()}.`);
}

main().catch((e: Error) => {
  console.error(e.stack ?? e.message);
  process.exit(1);
});
