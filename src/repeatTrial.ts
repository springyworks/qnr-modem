import { applyChannel, meanPower, type WattersonProfile } from './channel.js';
import { SAMPLE_RATE } from './config.js';
import type { CodeRate } from './conv.js';
import { Receiver } from './rx.js';
import { mulberry32 } from './rng.js';
import { modulateSchedule } from './tx.js';

export interface RepeatConfig {
  baud: number;
  message: string;
  interleaverWidth: number;
  preamblePairs: number;
  squelchDb: number;
  rate: CodeRate;
  repeats: number;
  gapSeconds: number;
}

export interface RepeatTask {
  config: RepeatConfig;
  profile: WattersonProfile | null;
  snrDb: number;
  seeds: number[];
}

export interface RepeatResult {
  /** successes[k] = decoded using no more than k+1 bursts. */
  successes: number[];
  trials: number;
}

function buildSchedule(cfg: RepeatConfig, seed: number): { samples: Float32Array; power: number } {
  const rand = mulberry32(seed * 7919 + 13);
  const bursts = modulateSchedule(cfg.message, cfg.baud, cfg.repeats, cfg.gapSeconds, 0.5, SAMPLE_RATE, {
    interleaverWidth: cfg.interleaverWidth,
    preamblePairs: cfg.preamblePairs,
    rate: cfg.rate,
  });

  const lead = Math.round((0.3 + rand() * 2.2) * SAMPLE_RATE);
  const tail = Math.round(0.6 * SAMPLE_RATE);
  const samples = new Float32Array(lead + bursts.length + tail);
  samples.set(bursts, lead);
  return { samples, power: meanPower(bursts) };
}

/** Returns how many bursts were needed, or 0 if the message never decoded. */
export function runRepeatTrial(cfg: RepeatConfig, profile: WattersonProfile | null, snrDb: number, seed: number): number {
  const { samples, power } = buildSchedule(cfg, seed);
  const faded = applyChannel(samples, {
    sampleRate: SAMPLE_RATE,
    snrDb,
    profile,
    seed,
    referencePower: power,
  });

  let text = '';
  let burstsUsed = 0;
  let solved = 0;

  const rx = new Receiver(
    cfg.baud,
    {
      onChar: (c) => (text += c),
      onFrame: ({ ok, bursts }) => {
        burstsUsed = bursts;
        if (ok && !solved && text === cfg.message) solved = burstsUsed;
      },
    },
    SAMPLE_RATE,
    'conv',
    { interleaverWidth: cfg.interleaverWidth, rate: cfg.rate, combineRepeats: true }
  );
  rx.squelchDb = cfg.squelchDb;

  const chunk = 8192;
  for (let i = 0; i < faded.length && !solved; i += chunk) {
    rx.push(faded.subarray(i, Math.min(i + chunk, faded.length)));
  }
  return solved;
}

export function runRepeatCell(task: RepeatTask): RepeatResult {
  const successes = new Array<number>(task.config.repeats).fill(0);
  for (const seed of task.seeds) {
    const used = runRepeatTrial(task.config, task.profile, task.snrDb, seed);
    if (used > 0) {
      for (let k = used - 1; k < successes.length; k++) successes[k]!++;
    }
  }
  return { successes, trials: task.seeds.length };
}
