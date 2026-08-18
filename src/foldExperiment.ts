import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { applyChannel, meanPower, type WattersonProfile } from './channel.js';
import { NUM_TONES, SAMPLE_RATE, toneFreq } from './config.js';
import type { CodeRate } from './conv.js';
import type { FoldConfig, FoldTask } from './foldTrial.js';
import { runTasks, workerCount } from './pool.js';
import { modulateSchedule } from './tx.js';
import { writeWav16 } from './wav.js';

const FOLD_WORKER = new URL('./foldWorker.js', import.meta.url);
const BAUD = 8;
const MESSAGE = 'CQ DE QNR 144';
const WAV_DIR = join(process.cwd(), 'wav');
const TRIALS = Number(process.argv.find((a) => a.startsWith('--trials='))?.slice(9) ?? 16);

const SLOW: WattersonProfile = { name: 'slow 0.5ms/0.1Hz', delayMs: 0.5, dopplerHz: 0.1 };
const BAD: WattersonProfile = { name: 'bad 2ms/1Hz', delayMs: 2, dopplerHz: 1 };
const WORST: WattersonProfile = { name: 'worst 4ms/2Hz', delayMs: 4, dopplerHz: 2 };

const BASE: FoldConfig = {
  baud: BAUD,
  message: MESSAGE,
  interleaverWidth: 32,
  preamblePairs: 4,
  rate: 2,
  repeats: 8,
  gapSeconds: 2,
};

const seeds = (salt: number): number[] => Array.from({ length: TRIALS }, (_, t) => 30000 + salt * 7717 + t);
const run = (tasks: FoldTask[]): Promise<number[]> => runTasks<FoldTask, number>(FOLD_WORKER, tasks);
const pct = (ok: number): string => `${Math.round((ok / TRIALS) * 100)}%`;

function table(title: string, cols: string[], rows: Array<[string, ...string[]]>): void {
  console.log(`\n${title}`);
  const header = ['setting', ...cols].map((h) => h.padEnd(12)).join('');
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const row of rows) console.log(row.map((c) => c.padEnd(12)).join(''));
}

async function main(): Promise<void> {
  const span = toneFreq(NUM_TONES - 1) - toneFreq(0);
  console.log('QNR exact-repeat-correlation experiment (folded acquisition + LLR combining)');
  console.log(
    `${BAUD} Bd fixed, ${NUM_TONES} tones ${toneFreq(0).toFixed(0)}-${toneFreq(NUM_TONES - 1).toFixed(0)} Hz (${(span / 1000).toFixed(2)} kHz, fits 2.7 kHz)`
  );
  console.log(`${TRIALS} trials/cell, ${workerCount()} workers, random 0.3-2.5 s noise lead-in\n`);
  const t0 = Date.now();

  // --- Stage 1: repeats vs SNR ---------------------------------------------
  const repeatCounts = [1, 2, 4, 8, 16];
  const snrs = [-14, -18, -22, -26, -30];
  const s1Tasks: FoldTask[] = repeatCounts.flatMap((repeats, i) =>
    snrs.map((snrDb) => ({ config: { ...BASE, repeats }, profile: BAD, snrDb, seeds: seeds(i) }))
  );
  const s1 = await run(s1Tasks);
  table(
    `Stage 1 - repeats vs SNR, ${BAD.name}`,
    snrs.map((s) => `${s} dB`),
    repeatCounts.map((r, i) => [`x${r}`, ...s1.slice(i * snrs.length, (i + 1) * snrs.length).map(pct)] as [string, ...string[]])
  );
  console.log(`  (${((Date.now() - t0) / 1000).toFixed(0)}s)`);

  // --- Stage 2: listening gap vs fade decorrelation ------------------------
  const gaps = [1, 2, 4, 8];
  const profiles = [SLOW, BAD, WORST];
  const s2Tasks: FoldTask[] = gaps.flatMap((gapSeconds, i) =>
    profiles.map((profile) => ({ config: { ...BASE, gapSeconds }, profile, snrDb: -22, seeds: seeds(20 + i) }))
  );
  const s2 = await run(s2Tasks);
  table(
    'Stage 2 - listening gap at -22 dB, 8 repeats',
    profiles.map((p) => p.name),
    gaps.map((g, i) => [`gap ${g}s`, ...s2.slice(i * profiles.length, (i + 1) * profiles.length).map(pct)] as [string, ...string[]])
  );
  console.log(`  (${((Date.now() - t0) / 1000).toFixed(0)}s)`);

  // --- Stage 3: FEC parameters ---------------------------------------------
  const fec: Array<{ label: string; rate: CodeRate; interleaverWidth: number }> = [
    { label: 'r1/2 il16', rate: 2, interleaverWidth: 16 },
    { label: 'r1/2 il32', rate: 2, interleaverWidth: 32 },
    { label: 'r1/2 il64', rate: 2, interleaverWidth: 64 },
    { label: 'r1/3 il16', rate: 3, interleaverWidth: 16 },
    { label: 'r1/3 il32', rate: 3, interleaverWidth: 32 },
    { label: 'r1/3 il64', rate: 3, interleaverWidth: 64 },
  ];
  const fecSnrs = [-22, -26];
  const s3Tasks: FoldTask[] = fec.flatMap((v, i) =>
    fecSnrs.map((snrDb) => ({
      config: { ...BASE, rate: v.rate, interleaverWidth: v.interleaverWidth },
      profile: BAD,
      snrDb,
      seeds: seeds(40 + i),
    }))
  );
  const s3 = await run(s3Tasks);
  table(
    'Stage 3 - FEC parameters, 8 repeats, bad channel',
    fecSnrs.map((s) => `${s} dB`),
    fec.map((v, i) => [v.label, ...s3.slice(i * fecSnrs.length, (i + 1) * fecSnrs.length).map(pct)] as [string, ...string[]])
  );
  console.log(`  (${((Date.now() - t0) / 1000).toFixed(0)}s)`);

  const bestIdx = s3.reduce((bi, _, i, arr) => {
    const score = (j: number): number => arr[j * fecSnrs.length]! + arr[j * fecSnrs.length + 1]!;
    return i < fec.length && score(i) > score(bi) ? i : bi;
  }, 0);
  const BEST: FoldConfig = { ...BASE, rate: fec[bestIdx]!.rate, interleaverWidth: fec[bestIdx]!.interleaverWidth };
  console.log(`Best FEC: ${fec[bestIdx]!.label}`);

  // --- Stage 4: Doppler x delay with the best settings ---------------------
  const dopplers = [0.1, 0.5, 1.0, 2.0];
  const delays = [0.5, 1.0, 2.0, 4.0];
  const s4Tasks: FoldTask[] = dopplers.flatMap((dopplerHz, i) =>
    delays.map((delayMs) => ({
      config: BEST,
      profile: { name: `${dopplerHz}/${delayMs}`, delayMs, dopplerHz },
      snrDb: -22,
      seeds: seeds(60 + i),
    }))
  );
  const s4 = await run(s4Tasks);
  table(
    'Stage 4 - Doppler x delay at -22 dB, 8 repeats',
    delays.map((d) => `${d} ms`),
    dopplers.map((d, i) => [`${d} Hz`, ...s4.slice(i * delays.length, (i + 1) * delays.length).map(pct)] as [string, ...string[]])
  );

  // --- Reference WAVs -------------------------------------------------------
  rmSync(WAV_DIR, { recursive: true, force: true });
  mkdirSync(WAV_DIR, { recursive: true });

  const frameOpts = {
    interleaverWidth: BEST.interleaverWidth,
    preamblePairs: BEST.preamblePairs,
    rate: BEST.rate,
  };
  const bursts = modulateSchedule(MESSAGE, BAUD, 8, BEST.gapSeconds, 0.5, SAMPLE_RATE, frameOpts);
  const lead = Math.round(1.7 * SAMPLE_RATE);
  const schedule = new Float32Array(lead + bursts.length + SAMPLE_RATE);
  schedule.set(bursts, lead);
  const power = meanPower(bursts);

  writeWav16(join(WAV_DIR, 'qnr-tx-8bd-x8.wav'), schedule, SAMPLE_RATE);
  for (const snrDb of [-14, -18, -22]) {
    for (const [key, profile] of Object.entries({ bad: BAD, worst: WORST })) {
      const faded = applyChannel(schedule, {
        sampleRate: SAMPLE_RATE,
        snrDb,
        profile,
        seed: 909,
        referencePower: power,
      });
      writeWav16(join(WAV_DIR, `qnr-x8-${key}${snrDb}db.wav`), faded, SAMPLE_RATE);
    }
  }

  console.log(`\nWrote 8-burst transmit reference + 6 channel WAVs to ${WAV_DIR}`);
  console.log(`Total wall time: ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

main().catch((e: Error) => {
  console.error(e);
  process.exit(1);
});
