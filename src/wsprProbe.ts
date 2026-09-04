import { ITU_PROFILES, applyChannel, meanPower } from './channel.js';
import { SAMPLE_RATE } from './config.js';
import { decodeChatMessage, encodeChatMessage } from './packet.js';
import { workerCount } from './pool.js';
import { AMPLITUDE, BAUD, DATA_SYMBOLS, DECODE_OPTIONS, FRAME_OPTIONS, GUARD_SAMPLES, PERIOD_SAMPLES, REPEATS } from './protocol.js';
import { DecodeSearch } from './search.js';
import { modulateChatMessage } from './tx.js';

/**
 * WSPR-grade reach test: for a ladder of descending SNRs, uses DecodeSearch's progressive
 * decode (the same escalating 1,2,4,8,16,32,everything repeat ladder the live receiver uses)
 * to find the fewest repeats that actually decode -- then keeps lowering SNR until even the
 * full REPEATS ceiling stops working, which marks the floor for this channel/message.
 * Single-shot per SNR (not averaged over many trials): each ladder run can itself cost several
 * minutes at this repeat ceiling, so this maps the curve rather than each point's confidence
 * interval. Always uses the cores-1 worker pool (see pool.ts workerCount()).
 */

const JOBS = workerCount();
const t0 = Date.now();
const elapsed = (): string => `${((Date.now() - t0) / 1000).toFixed(0)}s`;

const MESSAGE = 'QNR WSPR TEST';
const PROFILE = ITU_PROFILES['poor']!;
const SNR_START = -10;
const SNR_STEP = 3;
const MAX_STEPS = 10;

function fullSchedule(message: string): { samples: Float32Array; burst: Float32Array } {
  const burst = modulateChatMessage(encodeChatMessage(message), DATA_SYMBOLS, BAUD, AMPLITUDE, SAMPLE_RATE, FRAME_OPTIONS);
  const clean = new Float32Array(REPEATS * PERIOD_SAMPLES + SAMPLE_RATE);
  for (let repeat = 0; repeat < REPEATS; repeat++) clean.set(burst, repeat * PERIOD_SAMPLES + GUARD_SAMPLES);
  return { samples: clean, burst };
}

/** Ladder rung (in bursts) that a given `usedSeconds` result actually corresponds to. */
function repeatsFor(usedSeconds: number | undefined, burstSeconds: number, periodSeconds: number): string {
  if (usedSeconds === undefined) return `all ${REPEATS} (full schedule)`;
  const k = Math.round((usedSeconds - burstSeconds) / periodSeconds);
  return `${k}`;
}

async function main(): Promise<void> {
  console.log('=== WSPR-grade reach test: repeats needed vs SNR ===');
  console.log(`message "${MESSAGE}", channel ${PROFILE.name}, REPEATS ceiling ${REPEATS}`);
  console.log(`DecodeSearch worker pool: ${JOBS} threads (cores - 1)`);
  console.log(`ladder starts at ${SNR_START} dB, steps ${SNR_STEP} dB down, single-shot per SNR\n`);

  const search = new DecodeSearch(DECODE_OPTIONS, JOBS);
  const burstSeconds = modulateChatMessage(encodeChatMessage(MESSAGE), DATA_SYMBOLS, BAUD, AMPLITUDE, SAMPLE_RATE, FRAME_OPTIONS).length / SAMPLE_RATE;
  const periodSeconds = PERIOD_SAMPLES / SAMPLE_RATE;

  try {
    let consecutiveFails = 0;
    for (let step = 0; step < MAX_STEPS; step++) {
      const snrDb = SNR_START - step * SNR_STEP;
      console.log(`--- ${snrDb} dB ---`);
      const { samples, burst } = fullSchedule(MESSAGE);
      const noisy = applyChannel(samples, {
        sampleRate: SAMPLE_RATE,
        snrDb,
        profile: PROFILE,
        seed: 5000 + step,
        referencePower: meanPower(burst),
      });

      const started = Date.now();
      const result = await search.decodeProgressive(noisy, (p) => {
        console.log(`    ${p.stage}: ${p.detail}  [${elapsed()}]`);
      });
      const took = ((Date.now() - started) / 1000).toFixed(1);
      const decoded = decodeChatMessage(result.text) === MESSAGE;

      if (decoded) {
        consecutiveFails = 0;
        console.log(
          `  => ${snrDb} dB: PASS, needed ${repeatsFor(result.usedSeconds, burstSeconds, periodSeconds)} repeats (${took}s)  [${elapsed()}]\n`
        );
      } else {
        consecutiveFails++;
        console.log(`  => ${snrDb} dB: FAIL even at the full ${REPEATS}-repeat ceiling (${took}s)  [${elapsed()}]\n`);
        if (consecutiveFails >= 2) {
          console.log(`Two consecutive SNRs failed at the ${REPEATS}-repeat ceiling -- calling ${snrDb + SNR_STEP} dB the floor.`);
          break;
        }
      }
    }
  } finally {
    search.close();
  }

  console.log(`\nDone. Total time ${elapsed()}.`);
}

main().catch((e: Error) => {
  console.error(e.stack ?? e.message);
  process.exit(1);
});
