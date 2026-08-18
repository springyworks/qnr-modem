import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { applyChannel, meanPower, type WattersonProfile } from './channel.js';
import { NUM_TONES, SAMPLE_RATE, toneFreq } from './config.js';
import type { CodeRate } from './conv.js';
import { REPEAT_WORKER, runTasks, workerCount } from './pool.js';
import type { RepeatConfig, RepeatResult, RepeatTask } from './repeatTrial.js';
import { modulateSchedule } from './tx.js';
import { writeWav16 } from './wav.js';

const BAUD = 8;
const MESSAGE = 'CQ DE QNR 144';
const WAV_DIR = join(process.cwd(), 'wav');
const TRIALS = Number(process.argv.find((a) => a.startsWith('--trials='))?.slice(9) ?? 48);

const BAD: WattersonProfile = { name: 'bad (2ms/1Hz)', delayMs: 2, dopplerHz: 1 };
const WORST: WattersonProfile = { name: 'worst (4ms/2Hz)', delayMs: 4, dopplerHz: 2 };
const SLOW: WattersonProfile = { name: 'slow (0.5ms/0.1Hz)', delayMs: 0.5, dopplerHz: 0.1 };

const BASE: RepeatConfig = {
  baud: BAUD,
  message: MESSAGE,
  interleaverWidth: 32,
  preamblePairs: 4,
  squelchDb: -70,
  rate: 2,
  repeats: 4,
  gapSeconds: 2,
};

const seeds = (salt: number): number[] => Array.from({ length: TRIALS }, (_, t) => 20000 + salt * 7717 + t);

const run = (tasks: RepeatTask[]): Promise<RepeatResult[]> =>
  runTasks<RepeatTask, RepeatResult>(REPEAT_WORKER, tasks);

const rates = (r: RepeatResult): number[] => r.successes.map((s) => (s / r.trials) * 100);

function table(title: string, cols: string[], rows: Array<[string, ...string[]]>): void {
  console.log(`\n${title}`);
  const header = ['setting', ...cols].map((h) => h.padEnd(13)).join('');
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const row of rows) console.log(row.map((c) => c.padEnd(13)).join(''));
}

async function main(): Promise<void> {
  const span = toneFreq(NUM_TONES - 1) - toneFreq(0);
  console.log('QNR repeat-correlation experiment - send / listen / send / listen');
  console.log(`${BAUD} Bd, ${NUM_TONES} tones, ${toneFreq(0).toFixed(0)}-${toneFreq(NUM_TONES - 1).toFixed(0)} Hz (${(span / 1000).toFixed(2)} kHz occupied, fits 2.7 kHz)`);
  console.log(`${TRIALS} trials/cell, ${workerCount()} workers, random 0.3-2.5 s noise lead-in\n`);
  const t0 = Date.now();

  // --- Stage 1: how many repeats are needed, per SNR, on a bad channel ------
  const snrs = [-12, -16, -18, -20, -22, -24];
  const stage1 = await run(
    snrs.map((snrDb, i) => ({ config: { ...BASE, repeats: 6 }, profile: BAD, snrDb, seeds: seeds(i) }))
  );
  table(
    `Stage 1 - cumulative decode rate vs repeats, ${BAD.name}`,
    ['1 burst', '2', '3', '4', '5', '6'],
    stage1.map((r, i) => [`${snrs[i]} dB`, ...rates(r).map((v) => `${v.toFixed(0)}%`)] as [string, ...string[]])
  );
  console.log(`  (${((Date.now() - t0) / 1000).toFixed(0)}s elapsed)`);

  // --- Stage 2: listening gap length vs fade decorrelation -----------------
  const gaps = [1, 2, 4, 8];
  for (const profile of [SLOW, BAD]) {
    const tasks = gaps.map((gapSeconds, i) => ({
      config: { ...BASE, repeats: 4, gapSeconds },
      profile,
      snrDb: -18,
      seeds: seeds(20 + i),
    }));
    const res = await run(tasks);
    table(
      `Stage 2 - listening gap at -18 dB, ${profile.name}`,
      ['1 burst', '2', '3', '4'],
      res.map((r, i) => [`gap ${gaps[i]}s`, ...rates(r).map((v) => `${v.toFixed(0)}%`)] as [string, ...string[]])
    );
  }

  // --- Stage 3: FEC parameters --------------------------------------------
  const fecVariants: Array<{ label: string; rate: CodeRate; interleaverWidth: number }> = [
    { label: 'r1/2 il16', rate: 2, interleaverWidth: 16 },
    { label: 'r1/2 il32', rate: 2, interleaverWidth: 32 },
    { label: 'r1/2 il64', rate: 2, interleaverWidth: 64 },
    { label: 'r1/3 il16', rate: 3, interleaverWidth: 16 },
    { label: 'r1/3 il32', rate: 3, interleaverWidth: 32 },
    { label: 'r1/3 il64', rate: 3, interleaverWidth: 64 },
  ];
  for (const snrDb of [-18, -22]) {
    const tasks = fecVariants.map((v, i) => ({
      config: { ...BASE, repeats: 4, rate: v.rate, interleaverWidth: v.interleaverWidth },
      profile: BAD,
      snrDb,
      seeds: seeds(40 + i),
    }));
    const res = await run(tasks);
    table(
      `Stage 3 - FEC parameters at ${snrDb} dB, ${BAD.name}`,
      ['1 burst', '2', '3', '4'],
      res.map((r, i) => [fecVariants[i]!.label, ...rates(r).map((v) => `${v.toFixed(0)}%`)] as [string, ...string[]])
    );
  }

  // --- Stage 4: worst-case channel with the best settings ------------------
  const best: RepeatConfig = { ...BASE, repeats: 6, rate: 3, interleaverWidth: 32, gapSeconds: 4 };
  const worstSnrs = [-16, -18, -20, -22, -24];
  const worstTasks = worstSnrs.map((snrDb, i) => ({
    config: best,
    profile: WORST,
    snrDb,
    seeds: seeds(60 + i),
  }));
  const worstRes = await run(worstTasks);
  table(
    `Stage 4 - r1/3, 6 repeats, 4 s gaps, ${WORST.name}`,
    ['1 burst', '2', '3', '4', '5', '6'],
    worstRes.map((r, i) => [`${worstSnrs[i]} dB`, ...rates(r).map((v) => `${v.toFixed(0)}%`)] as [string, ...string[]])
  );

  // --- Reference WAVs ------------------------------------------------------
  rmSync(WAV_DIR, { recursive: true, force: true });
  mkdirSync(WAV_DIR, { recursive: true });

  const bursts = modulateSchedule(MESSAGE, BAUD, 4, best.gapSeconds, 0.5, SAMPLE_RATE, {
    interleaverWidth: best.interleaverWidth,
    preamblePairs: best.preamblePairs,
    rate: best.rate,
  });
  const lead = Math.round(1.7 * SAMPLE_RATE);
  const schedule = new Float32Array(lead + bursts.length + SAMPLE_RATE);
  schedule.set(bursts, lead);
  const power = meanPower(bursts);

  writeWav16(join(WAV_DIR, 'qnr-tx-8bd-x4.wav'), schedule, SAMPLE_RATE);
  for (const snrDb of [-16, -20, -22]) {
    for (const [key, profile] of Object.entries({ bad: BAD, worst: WORST })) {
      const faded = applyChannel(schedule, {
        sampleRate: SAMPLE_RATE,
        snrDb,
        profile,
        seed: 555,
        referencePower: power,
      });
      writeWav16(join(WAV_DIR, `qnr-x4-${key}${snrDb}db.wav`), faded, SAMPLE_RATE);
    }
  }

  console.log(`\nWrote 4-burst transmit reference + 6 channel WAVs to ${WAV_DIR}`);
  console.log(`Total wall time: ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

main().catch((e: Error) => {
  console.error(e);
  process.exit(1);
});
