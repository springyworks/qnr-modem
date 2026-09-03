import { SAMPLE_RATE } from './config.js';
import { laneForPhase } from './live.js';
import {
  BAUD,
  DATA_SYMBOLS,
  DECODE_OPTIONS,
  FRAME_OPTIONS,
  GUARD_SAMPLES,
  PERIOD_SAMPLES,
  SLOT_SAMPLES,
} from './protocol.js';
import { decodeChatMessage, encodeChatMessage } from './packet.js';
import { DecodeSearch } from './search.js';
import { modulateChatMessage } from './tx.js';

const JOBS = 11;

function addSignal(target: Float32Array, signal: Float32Array, start: number): void {
  for (let sampleIndex = 0; sampleIndex < signal.length; sampleIndex++) {
    target[start + sampleIndex]! += signal[sampleIndex]!;
  }
}

function requireResult(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  const messageA = 'STATION A';
  const messageB = 'STATION B';
  const burstA = modulateChatMessage(encodeChatMessage(messageA), DATA_SYMBOLS, BAUD, 0.5, SAMPLE_RATE, FRAME_OPTIONS);
  const burstB = modulateChatMessage(encodeChatMessage(messageB), DATA_SYMBOLS, BAUD, 0.5, SAMPLE_RATE, FRAME_OPTIONS);
  const repeats = 2;
  const samples = new Float32Array(repeats * PERIOD_SAMPLES);

  for (let repeatIndex = 0; repeatIndex < repeats; repeatIndex++) {
    const periodStart = repeatIndex * PERIOD_SAMPLES;
    addSignal(samples, burstA, periodStart + GUARD_SAMPLES);
    addSignal(samples, burstB, periodStart + 2 * SLOT_SAMPLES + GUARD_SAMPLES);
  }

  const search = new DecodeSearch(DECODE_OPTIONS, JOBS);
  try {
    const results = await search.decodeAll(samples, undefined, 0);
    const stationA = results.find((result) => decodeChatMessage(result.text) === messageA);
    const stationB = results.find((result) => decodeChatMessage(result.text) === messageB);
    requireResult(stationA, 'station A was not decoded by the worker-backed search');
    requireResult(stationB, 'station B was not decoded by the worker-backed search');
    requireResult(stationA.bursts === repeats, `station A combined ${stationA.bursts ?? 0} bursts, expected ${repeats}`);
    requireResult(stationB.bursts === repeats, `station B combined ${stationB.bursts ?? 0} bursts, expected ${repeats}`);
    requireResult(laneForPhase(stationA.phaseSamples) === 'tx', 'station A did not remain in the transmit basic-frame');
    requireResult(laneForPhase(stationB.phaseSamples) === 'listen-2', 'station B did not remain in the second listening frame');

    console.log(`PASS  worker-backed three-frame chat decode (${JOBS} workers)`);
    console.log(`      tx:       "${messageA}" (${stationA.bursts}x LLR)`);
    console.log(`      listen-2: "${messageB}" (${stationB.bursts}x LLR)`);
  } finally {
    search.close();
  }
}

main().catch((error: Error) => {
  console.error(`FAIL  ${error.message}`);
  process.exit(1);
});
