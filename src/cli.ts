#!/usr/bin/env node
import { basename } from 'node:path';
import { Worker } from 'node:worker_threads';
import { playSamples, startCapture, type Capture } from './audio.js';
import { SAMPLE_RATE } from './config.js';
import { foldDecode } from './fold.js';
import {
  AMPLITUDE,
  BAUD,
  BURST_SAMPLES,
  DECODE_OPTIONS,
  FRAME_OPTIONS,
  GAP_SECONDS,
  LEAD_SECONDS,
  PAYLOAD_BYTES,
  PERIOD_SAMPLES,
  REPEATS,
  SCHEDULE_SAMPLES,
  padMessage,
  summary,
} from './protocol.js';
import { modulateSchedule } from './tx.js';
import { readWav16, writeWav16 } from './wav.js';

const BAR_WIDTH = 32;
const DECODE_WORKER = new URL('./decodeWorker.js', import.meta.url);

const dbfs = (rms: number): number => 20 * Math.log10(Math.max(rms, 1e-6));

function levelBar(db: number): string {
  const norm = Math.max(0, Math.min(1, (db + 60) / 60));
  const filled = Math.round(norm * BAR_WIDTH);
  const hot = db > -3 ? '!' : '';
  return `[${'#'.repeat(filled)}${'-'.repeat(BAR_WIDTH - filled)}] ${db.toFixed(1).padStart(6)} dBFS ${hot}`;
}

function rmsOf(block: Float32Array): number {
  let sum = 0;
  for (const v of block) sum += v * v;
  return Math.sqrt(sum / Math.max(block.length, 1));
}

function usage(): void {
  console.log(`qnr - 144-tone MFSK weak signal modem

  qnr tx "MESSAGE"            transmit through the default audio output
  qnr tx "MESSAGE" -o out.wav write the transmission to a WAV file
  qnr rx                      listen on the default audio input
  qnr rx -i in.wav            decode a WAV file

Audio routing is left to the system mixer (pavucontrol); there are no device
options. Modem parameters are fixed by the protocol and cannot be changed.

${summary()}`);
}

async function transmit(message: string, outFile?: string): Promise<void> {
  const padded = padMessage(message);
  const bursts = modulateSchedule(padded, BAUD, REPEATS, GAP_SECONDS, AMPLITUDE, SAMPLE_RATE, FRAME_OPTIONS);
  const lead = LEAD_SECONDS * SAMPLE_RATE;
  const samples = new Float32Array(lead + bursts.length + SAMPLE_RATE);
  samples.set(bursts, lead);

  console.log(`TX  "${padded.trimEnd()}"  (${(samples.length / SAMPLE_RATE).toFixed(0)}s, ${REPEATS} bursts)`);

  if (outFile) {
    writeWav16(outFile, samples, SAMPLE_RATE);
    console.log(`Wrote ${outFile}`);
    return;
  }

  const blockSamples = Math.round(SAMPLE_RATE / 10);
  const started = Date.now();
  const timer = setInterval(() => {
    const pos = Math.floor(((Date.now() - started) / 1000) * SAMPLE_RATE);
    if (pos >= samples.length) return;
    const block = samples.subarray(pos, Math.min(pos + blockSamples, samples.length));
    const inBurst = pos >= lead && (pos - lead) % PERIOD_SAMPLES < BURST_SAMPLES;
    const burst = Math.min(REPEATS, Math.floor((pos - lead) / PERIOD_SAMPLES) + 1);
    const tag = pos < lead ? 'lead ' : inBurst ? `TX ${burst}/${REPEATS}` : 'gap  ';
    process.stdout.write(`\r  ${tag}  ${levelBar(dbfs(rmsOf(block)))}  `);
  }, 100);

  try {
    await playSamples(samples);
  } finally {
    clearInterval(timer);
    process.stdout.write('\n');
  }
  console.log('Transmission complete.');
}

function decodeFile(file: string): void {
  const { samples, sampleRate } = readWav16(file);
  if (sampleRate !== SAMPLE_RATE) {
    console.error(`${basename(file)} is ${sampleRate} Hz; this modem needs ${SAMPLE_RATE} Hz.`);
    process.exitCode = 1;
    return;
  }

  console.log(`RX  ${basename(file)}  (${(samples.length / SAMPLE_RATE).toFixed(0)}s)  decoding...`);
  const text = foldDecode(samples, DECODE_OPTIONS).trimEnd();
  if (text) {
    console.log(`\n  >> "${text}"  [CRC OK]\n`);
  } else {
    console.log('\n  no frame decoded\n');
    process.exitCode = 1;
  }
}

function listen(): void {
  const capacity = SCHEDULE_SAMPLES + 6 * SAMPLE_RATE;
  const ring = new Float32Array(capacity);
  let write = 0;
  let filled = 0;
  let peak = -60;
  let busy = false;
  let lastText = '';

  const worker = new Worker(DECODE_WORKER);
  worker.on('message', (text: string) => {
    busy = false;
    if (text && text !== lastText) {
      lastText = text;
      process.stdout.write(`\r${' '.repeat(70)}\r`);
      console.log(`  >> "${text}"  [CRC OK]  ${new Date().toLocaleTimeString()}`);
    }
  });
  worker.on('error', (e) => console.error(`\ndecoder error: ${e.message}`));

  console.log(`RX  listening on the default audio input`);
  console.log(`    needs ${(SCHEDULE_SAMPLES / SAMPLE_RATE).toFixed(0)}s of audio before the first decode attempt\n`);

  const capture: Capture = startCapture(
    (block) => {
      for (const v of block) {
        ring[write] = v;
        write = (write + 1) % capacity;
      }
      filled = Math.min(capacity, filled + block.length);
      peak = Math.max(peak, dbfs(rmsOf(block)));
    },
    { onError: (e) => console.error(`\ncapture error: ${e.message}`) }
  );

  const meter = setInterval(() => {
    const ready = Math.min(100, (filled / SCHEDULE_SAMPLES) * 100);
    process.stdout.write(`\r  IN   ${levelBar(peak)}  buffer ${ready.toFixed(0)}%  `);
    peak = -60;
  }, 200);

  const attempt = setInterval(() => {
    if (busy || filled < SCHEDULE_SAMPLES) return;
    busy = true;
    const ordered = new Float32Array(filled);
    const start = (write - filled + capacity) % capacity;
    for (let i = 0; i < filled; i++) ordered[i] = ring[(start + i) % capacity]!;
    worker.postMessage(ordered);
  }, 15000);

  const stop = (): void => {
    clearInterval(meter);
    clearInterval(attempt);
    capture.stop();
    void worker.terminate();
    process.stdout.write('\n');
    process.exit(0);
  };
  process.on('SIGINT', stop);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const mode = args[0];

  const flag = (...names: string[]): string | undefined => {
    for (const name of names) {
      const i = args.indexOf(name);
      if (i >= 0 && args[i + 1]) return args[i + 1];
    }
    return undefined;
  };

  if (mode === 'tx') {
    const message = args.slice(1).find((a) => !a.startsWith('-') && a !== flag('-o', '--out'));
    if (!message) {
      console.error('tx needs a message, e.g. qnr tx "CQ DE QNR"');
      process.exitCode = 1;
      return;
    }
    if (message.length > PAYLOAD_BYTES) {
      console.log(`note: message truncated to ${PAYLOAD_BYTES} characters`);
    }
    await transmit(message, flag('-o', '--out'));
    return;
  }

  if (mode === 'rx') {
    const input = flag('-i', '--in');
    if (input) decodeFile(input);
    else listen();
    return;
  }

  usage();
  if (mode) process.exitCode = 1;
}

main().catch((e: Error) => {
  console.error(e.message);
  process.exit(1);
});
