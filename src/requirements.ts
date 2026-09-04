import {
  BITS_PER_SYMBOL,
  DATA_TONES,
  NUM_TONES,
  SAMPLE_RATE,
  TONE_SPACING_HZ,
  symbolSamples,
  toneFreq,
} from './config.js';
import { TAIL_BITS } from './conv.js';
import { LENGTH_BITS } from './framing.js';
import {
  BASIC_FRAMES_PER_REPEAT,
  BAUD,
  BURST_SAMPLES,
  DATA_SYMBOLS,
  FRAME_OPTIONS,
  GUARD_SECONDS,
  LIVE_FOLD_REPEATS,
  PAYLOAD_BYTES,
  PERIOD_SAMPLES,
  RATE,
  REPEATS,
  SLOT_SAMPLES,
} from './protocol.js';
import { modulateChatMessage } from './tx.js';
import { encodeChatMessage } from './packet.js';

/**
 * Checks the station's stated on-air requirements against what the code actually builds, so a
 * drift between intent and implementation shows up as a failing line instead of a claim in a
 * README. Run with `node dist/requirements.js`.
 */

let failures = 0;
const rows: string[] = [];

function check(requirement: string, ok: boolean, actual: string): void {
  rows.push(`  ${ok ? 'PASS' : 'FAIL'}  ${requirement.padEnd(46)} ${actual}`);
  if (!ok) failures++;
}

const seconds = (samples: number): number => samples / SAMPLE_RATE;

/** Peak-to-average power ratio of the real transmitted waveform. */
function papr(signal: Float32Array): number {
  let peak = 0;
  let sum = 0;
  for (const sample of signal) {
    const power = sample * sample;
    if (power > peak) peak = power;
    sum += power;
  }
  return 10 * Math.log10(peak / (sum / signal.length));
}

/** Largest sample-to-sample step, as a multiple of the step a single tone can produce. */
function worstDiscontinuity(signal: Float32Array, amplitude: number): number {
  const maxToneStep = (2 * Math.PI * toneFreq(NUM_TONES - 1)) / SAMPLE_RATE;
  let worst = 0;
  // Skip the deliberate fade-in/out at the burst edges.
  for (let i = 300; i < signal.length - 300; i++) {
    const step = Math.abs(signal[i]! - signal[i - 1]!);
    if (step > worst) worst = step;
  }
  return worst / (amplitude * maxToneStep);
}

const burst = modulateChatMessage(encodeChatMessage('REQUIREMENT TEST'), DATA_SYMBOLS, BAUD, 0.5, SAMPLE_RATE, FRAME_OPTIONS);

console.log('QNR stated requirements vs. built protocol\n');

check('144-tone MFSK', NUM_TONES === 144, `${NUM_TONES} tones`);
check('8 baud', BAUD === 8, `${BAUD} Bd (${symbolSamples(BAUD)} samples/symbol)`);
check(
  'fits an SSB channel (< 2.7 kHz)',
  toneFreq(NUM_TONES - 1) - toneFreq(0) < 2700,
  `${((toneFreq(NUM_TONES - 1) - toneFreq(0)) / 1000).toFixed(2)} kHz, ${toneFreq(0).toFixed(0)}..${toneFreq(NUM_TONES - 1).toFixed(0)} Hz, ${TONE_SPACING_HZ.toFixed(1)} Hz spacing`
);
check(
  'one tone at a time (equal power / constant envelope)',
  DATA_TONES === 1 << BITS_PER_SYMBOL && DATA_TONES <= NUM_TONES,
  `${BITS_PER_SYMBOL} bits/symbol over ${DATA_TONES} data tones, ${NUM_TONES - DATA_TONES} reserved`
);
check('low PAPR (< 3.5 dB, i.e. near single-tone)', papr(burst) < 3.5, `${papr(burst).toFixed(2)} dB`);
check(
  'phase-continuous (no step larger than one tone can make)',
  worstDiscontinuity(burst, 0.5) <= 1.02,
  `worst step = ${worstDiscontinuity(burst, 0.5).toFixed(3)}x a single-tone step`
);
check(
  'symmetric tx/rx alternation (tx, rx, tx, rx ...)',
  BASIC_FRAMES_PER_REPEAT === 2,
  `${BASIC_FRAMES_PER_REPEAT} basic frames per period`
);
check(
  'repeats not capped at a quick-chat count',
  REPEATS >= 32,
  `up to ${REPEATS} repeats (live receiver folds ${LIVE_FOLD_REPEATS} deep in real time)`
);
check(
  'live fold fits its real-time budget',
  LIVE_FOLD_REPEATS * PERIOD_SAMPLES < REPEATS * PERIOD_SAMPLES,
  `live ring ${seconds((LIVE_FOLD_REPEATS + 1) * PERIOD_SAMPLES).toFixed(0)}s vs ${seconds(REPEATS * PERIOD_SAMPLES).toFixed(0)}s tx schedule`
);

const burstSeconds = seconds(BURST_SAMPLES);
const slotSeconds = seconds(SLOT_SAMPLES);
check('5 s transmission burst', Math.abs(burstSeconds - 5) < 0.5, `${burstSeconds.toFixed(2)} s burst`);
check('5 s listening turn', Math.abs(slotSeconds - 5) < 0.5, `${slotSeconds.toFixed(2)} s slot (burst + 2x${GUARD_SECONDS}s guard)`);

console.log(rows.join('\n'));

if (failures > 0) {
  const totalSymbols = burst.length / symbolSamples(BAUD);
  const markerAndIdle = totalSymbols - DATA_SYMBOLS;
  const budget = (target: number, rate: number, lengthBits: number): number => {
    const data = Math.round(target * BAUD) - markerAndIdle;
    const info = Math.floor((data * BITS_PER_SYMBOL) / rate);
    return Math.floor((info - lengthBits - 16 - TAIL_BITS) / 8);
  };
  console.log(`\n${failures} requirement(s) not met.\n`);
  console.log('Burst length is set by the payload, so a 5 s burst means a smaller message.');
  console.log(`Today: ${totalSymbols} symbols = ${burstSeconds.toFixed(2)} s carrying ${PAYLOAD_BYTES} bytes`);
  console.log(`       (${markerAndIdle} sync/idle + ${DATA_SYMBOLS} data symbols, rate 1/${RATE}, ${LENGTH_BITS}-bit length field)\n`);
  console.log('  A 5 s burst (40 symbols at 8 Bd) could carry, depending on what is traded:');
  console.log(`    rate 1/${RATE}, ${LENGTH_BITS}-bit length (as now)   ->  ${budget(5, RATE, LENGTH_BITS)} bytes`);
  console.log(`    rate 1/${RATE}, 4-bit length              ->  ${budget(5, RATE, 4)} bytes`);
  console.log(`    rate 1/2, 4-bit length              ->  ${budget(5, 2, 4)} bytes  (less coding gain)`);
  console.log('\n  Changing this is a protocol break and moves every measured sensitivity figure,');
  console.log('  so it is left as an explicit decision rather than silently applied.');
  process.exitCode = 1;
} else {
  console.log('\nAll stated requirements met.');
}
