import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ITU_PROFILES, applyChannel, type WattersonProfile } from './channel.js';
import { SAMPLE_RATE } from './config.js';
import { runCells, workerCount } from './pool.js';
import { buildBurst, type CellTask, type TrialConfig } from './trial.js';
import { writeWav16 } from './wav.js';

const BAUD = 8;
const MESSAGE = 'CQ DE QNR 144';
const WAV_DIR = join(process.cwd(), 'wav');
const TRIALS = Number(process.argv.find((a) => a.startsWith('--trials='))?.slice(9) ?? 24);
const SNRS = [-3, -5];

const PROFILES: Record<string, WattersonProfile> = {
  good: ITU_PROFILES.good!,
  moderate: ITU_PROFILES.moderate!,
  poor: ITU_PROFILES.poor!,
};

const BASE: TrialConfig = {
  interleaverWidth: 8,
  preamblePairs: 4,
  squelchDb: -65,
  baud: BAUD,
  message: MESSAGE,
};

const seedsFor = (salt: number): number[] =>
  Array.from({ length: TRIALS }, (_, t) => 5000 + salt * 977 + t);

const columns = Object.keys(PROFILES).flatMap((p) => SNRS.map((s) => `${p} ${s}dB`));

function cellsForConfig(config: TrialConfig, salt: number): CellTask[] {
  return Object.values(PROFILES).flatMap((profile) =>
    SNRS.map((snrDb) => ({ config, profile, snrDb, seeds: seedsFor(salt) }))
  );
}

function table(title: string, cols: string[], rows: Array<[string, ...number[]]>): void {
  console.log(`\n${title}`);
  const header = ['setting', ...cols].map((h) => h.padEnd(15)).join('');
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const [label, ...values] of rows) {
    console.log([label, ...values.map((v) => `${v.toFixed(0)}%`)].map((c) => c.padEnd(15)).join(''));
  }
}

const pct = (ok: number): number => (ok / TRIALS) * 100;
const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

async function sweep<T>(
  label: string,
  variants: T[],
  toConfig: (v: T) => TrialConfig,
  saltBase: number
): Promise<{ rows: Array<[string, ...number[]]>; best: T; bestScore: number }> {
  const tasks = variants.flatMap((v, i) => cellsForConfig(toConfig(v), saltBase + i));
  const t0 = Date.now();
  const oks = await runCells(tasks);

  const perVariant = columns.length;
  const rows: Array<[string, ...number[]]> = [];
  let best: T = variants[0] as T;
  let bestScore = -1;

  variants.forEach((v, i) => {
    const values = oks.slice(i * perVariant, (i + 1) * perVariant).map(pct);
    const m = mean(values);
    if (m > bestScore) {
      bestScore = m;
      best = v;
    }
    rows.push([`${label} ${String(v)}`, ...values]);
  });

  console.log(`  ${label} sweep: ${tasks.length} cells in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return { rows, best, bestScore };
}

async function main(): Promise<void> {
  const jobs = workerCount();
  const totalCells = (5 + 3 + 4) * columns.length + SNRS.length * 16 + 1;

  console.log(`QNR 144-tone MFSK experiment - fixed ${BAUD} Bd, conv+Viterbi`);
  console.log(`${TRIALS} trials/cell, ${totalCells} cells, ${jobs} parallel workers`);
  console.log('Every burst starts with a random 0.3-2.5 s noise lead-in.\n');
  const started = Date.now();

  const widths = await sweep('width', [4, 8, 16, 32, 64], (w) => ({ ...BASE, interleaverWidth: w }), 0);
  table('Stage A - interleaver depth', columns, widths.rows);
  console.log(`Best interleaver width: ${widths.best} (mean ${widths.bestScore.toFixed(0)}%)`);

  const preambles = await sweep(
    'pairs',
    [2, 4, 8],
    (p) => ({ ...BASE, interleaverWidth: widths.best, preamblePairs: p }),
    10
  );
  table('Stage B - preamble length', columns, preambles.rows);
  console.log(`Best preamble: ${preambles.best} pairs (mean ${preambles.bestScore.toFixed(0)}%)`);

  const squelches = await sweep(
    'squelch',
    [-80, -70, -60, -50],
    (s) => ({
      ...BASE,
      interleaverWidth: widths.best,
      preamblePairs: preambles.best,
      squelchDb: s,
    }),
    20
  );
  table('Stage C - squelch threshold', columns, squelches.rows);

  const BEST: TrialConfig = {
    ...BASE,
    interleaverWidth: widths.best,
    preamblePairs: preambles.best,
    squelchDb: squelches.best,
  };
  console.log(
    `\nBest configuration: interleaver ${BEST.interleaverWidth}, preamble ${BEST.preamblePairs} pairs, squelch ${BEST.squelchDb} dB`
  );

  const dopplers = [0.1, 0.5, 1.0, 2.0];
  const delays = [0.5, 1.0, 2.0, 4.0];
  for (const snrDb of SNRS) {
    const tasks: CellTask[] = dopplers.flatMap((dopplerHz) =>
      delays.map((delayMs) => ({
        config: BEST,
        profile: { name: `${dopplerHz}Hz/${delayMs}ms`, delayMs, dopplerHz },
        snrDb,
        seeds: seedsFor(40),
      }))
    );
    const oks = await runCells(tasks);

    const rows: Array<[string, ...number[]]> = dopplers.map((d, i) => [
      `${d} Hz`,
      ...oks.slice(i * delays.length, (i + 1) * delays.length).map(pct),
    ]);
    table(
      `Stage D - Doppler x delay at ${snrDb} dB`,
      delays.map((d) => `${d} ms`),
      rows
    );
  }

  const deepTrials = TRIALS * 4;
  const [deepOk] = await runCells([
    {
      config: BEST,
      profile: PROFILES.poor!,
      snrDb: -5,
      seeds: Array.from({ length: deepTrials }, (_, t) => 90000 + t),
    },
  ]);
  console.log(
    `\nConfidence run - CCIR poor at -5 dB, ${deepTrials} trials: ${((deepOk! / deepTrials) * 100).toFixed(0)}%`
  );

  rmSync(WAV_DIR, { recursive: true, force: true });
  mkdirSync(WAV_DIR, { recursive: true });

  const reference = buildBurst(BEST, 12345);
  writeWav16(join(WAV_DIR, `qnr-tx-${BAUD}bd-clean.wav`), reference.samples, SAMPLE_RATE);
  for (const [key, profile] of Object.entries(PROFILES)) {
    for (const snrDb of SNRS) {
      const faded = applyChannel(reference.samples, {
        sampleRate: SAMPLE_RATE,
        snrDb,
        profile,
        seed: 4242,
        referencePower: reference.power,
      });
      writeWav16(join(WAV_DIR, `qnr-${key}${snrDb}db.wav`), faded, SAMPLE_RATE);
    }
  }

  console.log(`Wrote transmit reference + 6 channel WAVs to ${WAV_DIR}`);
  console.log(`Total wall time: ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

main().catch((e: Error) => {
  console.error(e);
  process.exit(1);
});
