import { applyChannel, meanPower, type WattersonProfile } from './channel.js';
import { SAMPLE_RATE, symbolSamples } from './config.js';
import type { CodeRate } from './conv.js';
import { dataSymbolCount, foldDecode } from './fold.js';
import { mulberry32 } from './rng.js';
import { modulateSchedule, textToSymbols } from './tx.js';

export interface FoldConfig {
  baud: number;
  message: string;
  interleaverWidth: number;
  preamblePairs: number;
  rate: CodeRate;
  repeats: number;
  gapSeconds: number;
}

export interface FoldTask {
  config: FoldConfig;
  profile: WattersonProfile | null;
  snrDb: number;
  seeds: number[];
}

export function periodSamplesFor(cfg: FoldConfig): number {
  const frameOpts = {
    interleaverWidth: cfg.interleaverWidth,
    preamblePairs: cfg.preamblePairs,
    rate: cfg.rate,
  };
  const burst = textToSymbols(cfg.message, 'conv', frameOpts).length * symbolSamples(cfg.baud);
  return burst + Math.round(cfg.gapSeconds * SAMPLE_RATE);
}

export function runFoldTrial(
  cfg: FoldConfig,
  profile: WattersonProfile | null,
  snrDb: number,
  seed: number
): boolean {
  const frameOpts = {
    interleaverWidth: cfg.interleaverWidth,
    preamblePairs: cfg.preamblePairs,
    rate: cfg.rate,
  };
  const bursts = modulateSchedule(
    cfg.message,
    cfg.baud,
    cfg.repeats,
    cfg.gapSeconds,
    0.5,
    SAMPLE_RATE,
    frameOpts
  );

  const rand = mulberry32(seed * 7919 + 13);
  const lead = Math.round((0.3 + rand() * 2.2) * SAMPLE_RATE);
  const samples = new Float32Array(lead + bursts.length + SAMPLE_RATE);
  samples.set(bursts, lead);

  const faded = applyChannel(samples, {
    sampleRate: SAMPLE_RATE,
    snrDb,
    profile,
    seed,
    referencePower: meanPower(bursts),
  });

  const decoded = foldDecode(faded, {
    baud: cfg.baud,
    periodSamples: periodSamplesFor(cfg),
    preamblePairs: cfg.preamblePairs,
    dataSymbols: dataSymbolCount(cfg.message.length, cfg.rate),
    interleaverWidth: cfg.interleaverWidth,
    rate: cfg.rate,
  });
  return decoded === cfg.message;
}

export function runFoldCell(task: FoldTask): number {
  let ok = 0;
  for (const seed of task.seeds) {
    if (runFoldTrial(task.config, task.profile, task.snrDb, seed)) ok++;
  }
  return ok;
}
