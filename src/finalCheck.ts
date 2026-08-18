import type { WattersonProfile } from './channel.js';
import type { FoldConfig, FoldTask } from './foldTrial.js';
import { runTasks, workerCount } from './pool.js';

const FOLD_WORKER = new URL('./foldWorker.js', import.meta.url);
const TRIALS = Number(process.argv.find((a) => a.startsWith('--trials='))?.slice(9) ?? 24);
const MESSAGE = 'CQ DE QNR 144';

const BAD: WattersonProfile = { name: 'bad 2ms/1Hz', delayMs: 2, dopplerHz: 1 };
const WORST: WattersonProfile = { name: 'worst 4ms/2Hz', delayMs: 4, dopplerHz: 2 };

/** Winner of every sweep: rate 1/3, deep interleave, and gaps long enough to decorrelate fading. */
const BEST: FoldConfig = {
  baud: 8,
  message: MESSAGE,
  interleaverWidth: 64,
  preamblePairs: 4,
  rate: 3,
  repeats: 8,
  gapSeconds: 8,
};

const snrs = [-21, -22, -23, -24, -25];
const profiles = [BAD];

async function main(): Promise<void> {
  console.log(`Final check - r1/3, interleave 64, 8 s gaps, 8 repeats, ${TRIALS} trials/cell, ${workerCount()} workers`);

  const infoBits = MESSAGE.length * 8;
  const burstSeconds = (8 + Math.ceil((16 + infoBits + 16 + 6) * 3 / 7) + 3) / 8;
  const totalSeconds = BEST.repeats * burstSeconds + (BEST.repeats - 1) * BEST.gapSeconds;
  console.log(`burst ${burstSeconds.toFixed(1)}s, schedule ${totalSeconds.toFixed(0)}s, throughput ${(infoBits / totalSeconds).toFixed(2)} bit/s\n`);

  const tasks: FoldTask[] = profiles.flatMap((profile, i) =>
    snrs.map((snrDb) => ({
      config: BEST,
      profile,
      snrDb,
      seeds: Array.from({ length: TRIALS }, (_, t) => 77000 + i * 991 + t),
    }))
  );

  const t0 = Date.now();
  const oks = await runTasks<FoldTask, number>(FOLD_WORKER, tasks);

  const header = ['channel', ...snrs.map((s) => `${s} dB`)].map((h) => h.padEnd(15)).join('');
  console.log(header);
  console.log('-'.repeat(header.length));
  profiles.forEach((p, i) => {
    const row = oks.slice(i * snrs.length, (i + 1) * snrs.length).map((ok) => `${Math.round((ok / TRIALS) * 100)}%`);
    console.log([p.name, ...row].map((c) => c.padEnd(15)).join(''));
  });
  console.log(`\nwall time ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

main().catch((e: Error) => {
  console.error(e);
  process.exit(1);
});
