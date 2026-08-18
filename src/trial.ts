import { applyChannel, meanPower, type WattersonProfile } from './channel.js';
import { SAMPLE_RATE } from './config.js';
import { Receiver } from './rx.js';
import { mulberry32 } from './rng.js';
import { modulate } from './tx.js';

export interface TrialConfig {
  interleaverWidth: number;
  preamblePairs: number;
  squelchDb: number;
  baud: number;
  message: string;
}

export interface CellTask {
  config: TrialConfig;
  profile: WattersonProfile | null;
  snrDb: number;
  seeds: number[];
}

/** Random-length noise lead-in so nothing in the receiver can rely on a coherent start. */
export function buildBurst(cfg: TrialConfig, seed: number): { samples: Float32Array; power: number } {
  const rand = mulberry32(seed * 7919 + 13);
  const burst = modulate(cfg.message, cfg.baud, 0.5, SAMPLE_RATE, 'conv', {
    interleaverWidth: cfg.interleaverWidth,
    preamblePairs: cfg.preamblePairs,
  });
  const lead = Math.round((0.3 + rand() * 2.2) * SAMPLE_RATE);
  const tail = Math.round(0.6 * SAMPLE_RATE);
  const samples = new Float32Array(lead + burst.length + tail);
  samples.set(burst, lead);
  return { samples, power: meanPower(burst) };
}

export function runTrial(
  cfg: TrialConfig,
  profile: WattersonProfile | null,
  snrDb: number,
  seed: number
): boolean {
  const { samples, power } = buildBurst(cfg, seed);
  const faded = applyChannel(samples, {
    sampleRate: SAMPLE_RATE,
    snrDb,
    profile,
    seed,
    referencePower: power,
  });

  let text = '';
  const rx = new Receiver(
    cfg.baud,
    { onChar: (c) => (text += c) },
    SAMPLE_RATE,
    'conv',
    cfg.interleaverWidth
  );
  rx.squelchDb = cfg.squelchDb;

  const chunk = 8192;
  for (let i = 0; i < faded.length; i += chunk) {
    rx.push(faded.subarray(i, Math.min(i + chunk, faded.length)));
  }
  return text === cfg.message;
}

export function runCell(task: CellTask): number {
  let ok = 0;
  for (const seed of task.seeds) {
    if (runTrial(task.config, task.profile, task.snrDb, seed)) ok++;
  }
  return ok;
}
