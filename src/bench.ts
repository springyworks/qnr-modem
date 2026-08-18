import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ITU_PROFILES, applyChannel, type WattersonProfile } from './channel.js';
import { SAMPLE_RATE, type FecMode } from './config.js';
import { Receiver } from './rx.js';
import { modulate } from './tx.js';
import { writeWav16 } from './wav.js';

const WAV_DIR = join(process.cwd(), 'wav');
const MESSAGE = 'CQ DE QNR 144';
const BAUD = 8;
const TRIALS = 12;
const SNRS = [0, -3, -6, -9];

const CONDITIONS: Array<{ key: string; profile: WattersonProfile | null }> = [
  { key: 'awgn', profile: null },
  { key: 'good', profile: ITU_PROFILES.good! },
  { key: 'moderate', profile: ITU_PROFILES.moderate! },
  { key: 'poor', profile: ITU_PROFILES.poor! },
];

function padSilence(signal: Float32Array, pad: number): Float32Array {
  const out = new Float32Array(signal.length + pad * 2);
  out.set(signal, pad);
  return out;
}

function decode(samples: Float32Array, mode: FecMode): string {
  let text = '';
  const rx = new Receiver(BAUD, { onChar: (ch) => (text += ch) }, SAMPLE_RATE, mode);
  const chunk = 8192;
  for (let i = 0; i < samples.length; i += chunk) {
    rx.push(samples.subarray(i, Math.min(i + chunk, samples.length)));
  }
  return text;
}

function runCell(mode: FecMode, profile: WattersonProfile | null, snrDb: number): number {
  const clean = padSilence(modulate(MESSAGE, BAUD, 0.5, SAMPLE_RATE, mode), SAMPLE_RATE / 4);
  let ok = 0;
  for (let trial = 0; trial < TRIALS; trial++) {
    const faded = applyChannel(clean, { sampleRate: SAMPLE_RATE, snrDb, profile, seed: 1000 + trial });
    if (decode(faded, mode) === MESSAGE) ok++;
  }
  return (ok / TRIALS) * 100;
}

function writeSamples(): void {
  rmSync(WAV_DIR, { recursive: true, force: true });
  mkdirSync(WAV_DIR, { recursive: true });

  const clean = padSilence(modulate(MESSAGE, BAUD, 0.5, SAMPLE_RATE, 'conv'), SAMPLE_RATE / 4);
  writeWav16(join(WAV_DIR, 'qnr-clean.wav'), clean, SAMPLE_RATE);

  for (const { key, profile } of CONDITIONS) {
    if (!profile) continue;
    const faded = applyChannel(clean, { sampleRate: SAMPLE_RATE, snrDb: -3, profile, seed: 7 });
    writeWav16(join(WAV_DIR, `qnr-${key}-snr-3db.wav`), faded, SAMPLE_RATE);
  }
  console.log(`\nWrote reference WAVs to ${WAV_DIR}`);
}

console.log(`HF Watterson benchmark - "${MESSAGE}" at ${BAUD} Bd, ${TRIALS} trials/cell`);
console.log('Success = exact message recovered (conv mode also requires a valid CRC)\n');

const header = ['condition', 'SNR dB', 'hamming', 'conv'].map((h) => h.padEnd(14)).join('');
console.log(header);
console.log('-'.repeat(header.length));

for (const { key, profile } of CONDITIONS) {
  for (const snrDb of SNRS) {
    const hamming = runCell('hamming', profile, snrDb);
    const conv = runCell('conv', profile, snrDb);
    console.log(
      [key, String(snrDb), `${hamming.toFixed(0)}%`, `${conv.toFixed(0)}%`]
        .map((c) => c.padEnd(14))
        .join('')
    );
  }
}

writeSamples();
