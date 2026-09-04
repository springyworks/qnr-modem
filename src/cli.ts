#!/usr/bin/env node
import { basename } from 'node:path';
import { createAudioIdentity, playSamples, startCapture } from './audio.js';
import { ITU_PROFILES, applyChannel, meanPower, type WattersonProfile } from './channel.js';
import { SAMPLE_RATE } from './config.js';
import { ContinuousReceiver, laneForPhase, type HeardFrame } from './live.js';
import { CHAT_PAYLOAD_BYTES, decodeChatMessage, encodeChatMessage } from './packet.js';
import { liveWorkerCount, workerCount } from './pool.js';
import { resample } from './resample.js';
import { DecodeSearch, type SearchResult } from './search.js';
import { OFFSET_SPAN_HZ } from './tune.js';
import {
  AMPLITUDE,
  BAUD,
  BURST_SAMPLES,
  CHUNKS,
  CHUNK_SLOT_SAMPLES,
  DATA_SYMBOLS,
  DECODE_OPTIONS,
  FRAME_OPTIONS,
  GUARD_SAMPLES,
  LIVE_DECODE_SAMPLES,
  LIVE_FOLD_REPEATS,
  PERIOD_SAMPLES,
  REPEATS,
  SLOT_SAMPLES,
  summary,
} from './protocol.js';
import { runFastChat } from './fastchat.js';
import { runRxTx } from './rxtx.js';
import { modulateChatMessage } from './tx.js';
import { readWav, writeWav16 } from './wav.js';

const BAR_WIDTH = 32;
const DECODE_MS = (LIVE_DECODE_SAMPLES / SAMPLE_RATE) * 1000;

/** Channel simulation for making test material; `none` is AWGN only. */
const PROFILES: Record<string, WattersonProfile | null> = { none: null, ...ITU_PROFILES };

export interface ChannelRequest {
  snrDb: number;
  profile: WattersonProfile | null;
  seed: number;
}

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

The station:
  qnr -tui                     the station: full-screen dashboard, tx and rx together
  qnr -tui "MESSAGE"           same, with one message already queued

Headless and testing:
  qnr                          the same station on a plain line prompt, no TUI
  qnr "MESSAGE"                queue one chat message and keep listening
  qnr tx "MESSAGE"             one-shot transmit only, never listens
  qnr tx "MESSAGE" -o out.wav  one-shot transmit, written to a WAV file instead
  qnr rx                       listen only, never transmits
  qnr rx -i in.wav             decode a recording (the deep weak-signal path)
  qnr fastchat ["MESSAGE"]     experimental 3-second incremental-redundancy grid

Messages are plain chat: up to ${CHAT_PAYLOAD_BYTES} printable ASCII characters per frame,
no per-character mode, no ACK handshake, no automatic retry. A typed line is sent as
soon as Enter is pressed (Shift+Enter inserts a line break instead in the TUI),
repeated back-to-back as many times as the dashboard's FEC strength control says.
Type '/qr' at the line prompt (or press ^Q in the TUI) for a scannable QR code linking
to the project's web station.

Test-signal options for tx (both to file and to the air):
  --snr=<dB>                  add noise at this SNR, 3 kHz reference, measured
                              while transmitting so gaps do not flatter it
  --profile=<name>            fading channel: ${Object.keys(PROFILES).join(', ')}
  --seed=<n>                  repeatable channel realisation (default 1)
  --jobs=N                    decoder threads (default: cores-1 offline, cores-3 live)

Examples:
  qnr -tui "CQ CQ"
  qnr tx "CQ CQ" -o weak.wav --snr=-20 --profile=poor
  qnr rx -i weak.wav

A live station folds ${LIVE_FOLD_REPEATS} repeats deep so a fold always finishes inside one period;
overrunning starves the audio and breaks up the transmitted tone. A transmitter may
send up to ${REPEATS} repeats, so to use all of that gain, record the audio and decode it
offline with 'qnr rx -i file.wav', which has no real-time deadline.

qnr fastchat: the same chat payload and conv+Viterbi+CRC-16 pipeline as the default
station, but the codeword is striped into ${CHUNKS} equal chunks and sent as a repeating
cycle of short (~${(CHUNK_SLOT_SAMPLES / SAMPLE_RATE).toFixed(1)}s) bursts on a shared clock-derived grid instead of one long burst. A station
folds whatever chunk bursts it actually hears -- there is no need to have heard the earlier
ones, or to know how many exist -- so nearby stations decode after a couple of bursts while
weak/late-joining stations keep accumulating LLR across as many wraps of the cycle as it
takes. A message repeats forever, one chunk per ~3s slot, until you send a new one.

Audio routing is left to the system mixer (pavucontrol); there are no device
options. Modem parameters are fixed by the protocol and cannot be changed.

The receiver searches +/-${OFFSET_SPAN_HZ} Hz of tuning error and a few thousand ppm of clock
drift, so a mistuned transmitter or a resampled WebSDR feed still decodes.
Input WAVs at any sample rate are resampled to ${SAMPLE_RATE} Hz.

${summary()}`);
}

function printableMessage(text: string): string {
  const message = decodeChatMessage(encodeChatMessage(text));
  if (!message) throw new Error(`a transmission needs at least one printable ASCII character (max ${CHAT_PAYLOAD_BYTES})`);
  return message;
}

function chatSchedule(message: string): { samples: Float32Array; firstBurst: Float32Array } {
  const burst = modulateChatMessage(encodeChatMessage(message), DATA_SYMBOLS, BAUD, AMPLITUDE, SAMPLE_RATE, FRAME_OPTIONS);
  const samples = new Float32Array(REPEATS * PERIOD_SAMPLES + SAMPLE_RATE);
  for (let repeat = 0; repeat < REPEATS; repeat++) {
    samples.set(burst, repeat * PERIOD_SAMPLES + GUARD_SAMPLES);
  }
  return { samples, firstBurst: burst };
}

async function transmit(rawMessage: string, outFile?: string, channel?: ChannelRequest): Promise<void> {
  const message = printableMessage(rawMessage);
  const clean = chatSchedule(message);

  console.log(`TX  "${message}"  (${(clean.samples.length / SAMPLE_RATE).toFixed(0)}s, ${REPEATS} repeats)`);

  if (channel) {
    const name = channel.profile ? channel.profile.name : 'AWGN only';
    console.log(`    channel ${name}, ${channel.snrDb} dB SNR (3 kHz ref), seed ${channel.seed}`);
  }

  const samples = channel
    ? applyChannel(clean.samples, {
        sampleRate: SAMPLE_RATE,
        snrDb: channel.snrDb,
        profile: channel.profile,
        seed: channel.seed,
        // Power while transmitting, so the figure means the same whatever the gaps are.
        referencePower: meanPower(clean.firstBurst),
      })
    : clean.samples;

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
    const inBurst = pos >= GUARD_SAMPLES && pos % PERIOD_SAMPLES < GUARD_SAMPLES + BURST_SAMPLES;
    const burst = Math.min(REPEATS, Math.floor(pos / PERIOD_SAMPLES) + 1);
    const tag = inBurst ? `TX ${burst}/${REPEATS}` : 'gap  ';
    process.stdout.write(`\r  ${tag}  ${levelBar(dbfs(rmsOf(block)))}  `);
  }, 100);

  try {
    const identity = createAudioIdentity();
    console.log(`    PipeWire ${identity.label} TX`);
    await playSamples(samples, { identity });
  } finally {
    clearInterval(timer);
    process.stdout.write('\n');
  }
  console.log('Transmission complete.');
}

const tuningNote = (r: SearchResult): string => {
  if (!r.tuning) return '';
  const sign = (v: number): string => (v >= 0 ? '+' : '');
  return `  tuning ${sign(r.offsetHz)}${r.offsetHz.toFixed(1)} Hz, clock ${sign(r.driftPpm)}${r.driftPpm.toFixed(0)} ppm`;
};

function heardFrameNote(frame: HeardFrame): string {
  if (frame.source === 'loud') return '  direct off-grid decode';
  const sign = (value: number): string => (value >= 0 ? '+' : '');
  return `  ${frame.bursts}x LLR, tuning ${sign(frame.offsetHz ?? 0)}${(frame.offsetHz ?? 0).toFixed(1)} Hz, clock ${sign(frame.driftPpm ?? 0)}${(frame.driftPpm ?? 0).toFixed(0)} ppm`;
}

async function decodeFile(file: string): Promise<void> {
  const wav = readWav(file);
  const samples = resample(wav.samples, wav.sampleRate, SAMPLE_RATE);
  const seconds = samples.length / SAMPLE_RATE;
  const rateNote = wav.sampleRate === SAMPLE_RATE ? '' : `  ${wav.sampleRate} Hz -> ${SAMPLE_RATE} Hz`;

  const jobs = workerCount();
  console.log(`RX  ${basename(file)}  (${seconds.toFixed(0)}s)${rateNote}  ${jobs} threads  searching...`);

  const search = new DecodeSearch(DECODE_OPTIONS, jobs);
  try {
    const results = await search.decodeAll(samples, (p) => {
      process.stdout.write(`\r  ${p.stage === 'tune' ? 'tuned  ' : 'decode '} ${p.detail}${' '.repeat(20)}`);
    }, 0);
    process.stdout.write(`\r${' '.repeat(70)}\r`);

    const messages = results
      .map((result) => ({ result, text: decodeChatMessage(result.text) }))
      .filter((entry): entry is { result: SearchResult; text: string } => entry.text !== undefined && entry.text.length > 0);

    if (messages.length > 0) {
      console.log('');
      for (const { result, text } of messages) {
        const lane = laneForPhase(result.phaseSamples);
        console.log(`  >> [${lane}] "${text}"  [CRC OK]  ${result.bursts ?? 1}x LLR${tuningNote(result)}`);
      }
      console.log('');
    } else {
      console.log('\n  no frame decoded\n');
      process.exitCode = 1;
    }
  } finally {
    search.close();
  }
}

function listen(): void {
  const jobs = liveWorkerCount();
  const identity = createAudioIdentity();
  const receiver = new ContinuousReceiver(
    {
      onFrame: (frame) => {
        const text = decodeChatMessage(frame.text);
        process.stdout.write(`\r${' '.repeat(120)}\r`);
        if (text === undefined || text.length === 0) {
          console.log(`  >> [${frame.lane}] ignored non-chat frame  [CRC OK]  ${new Date().toLocaleTimeString()}${heardFrameNote(frame)}`);
          return;
        }
        console.log(`  >> [${frame.lane}] "${text}"  [CRC OK]  ${new Date().toLocaleTimeString()}${heardFrameNote(frame)}`);
      },
      onError: (error) => console.error(`\ndecoder error: ${error.message}`),
    },
    jobs
  );

  console.log(`RX  ${identity.label} listening on the default audio input  (${jobs} decoder threads)`);
  console.log('    direct decode for loud off-grid frames; folded LLR search once per basic-frame\n');

  const capture = startCapture(
    (block) => receiver.push(block),
    { identity, onError: (e) => console.error(`\ncapture error: ${e.message}`) }
  );

  const meter = setInterval(() => {
    const status = receiver.getStatus();
    const peak = receiver.takePeakDb();
    const activity = status.decoding ? status.progress : status.evidence;
    process.stdout.write(`\r  IN   ${levelBar(peak)}  buffer ${status.readyPercent.toFixed(0)}%  ${activity}  `);
  }, 200);

  const attempt = setInterval(() => void receiver.decode(), DECODE_MS);

  const stop = (): void => {
    clearInterval(meter);
    clearInterval(attempt);
    capture.stop();
    receiver.close();
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

  // `--name=value` form, so a negative SNR is never mistaken for another flag.
  const option = (name: string): string | undefined => {
    const prefix = `--${name}=`;
    return args.find((a) => a.startsWith(prefix))?.slice(prefix.length);
  };

  const channelRequest = (): ChannelRequest | undefined => {
    const snr = option('snr');
    const profileName = option('profile');
    if (snr === undefined && profileName === undefined) return undefined;
    if (snr === undefined) throw new Error('--profile needs --snr=<dB> as well');

    const snrDb = Number(snr);
    if (!Number.isFinite(snrDb)) throw new Error(`--snr=${snr} is not a number`);

    const key = profileName ?? 'none';
    if (!(key in PROFILES)) {
      throw new Error(`unknown --profile=${key}; try ${Object.keys(PROFILES).join(', ')}`);
    }
    return { snrDb, profile: PROFILES[key]!, seed: Number(option('seed') ?? 1) || 1 };
  };

  if (mode === 'tx') {
    const message = args.slice(1).find((a) => !a.startsWith('-') && a !== flag('-o', '--out'));
    if (!message) {
      console.error('tx needs a message, e.g. qnr tx "CQ CQ"');
      process.exitCode = 1;
      return;
    }
    await transmit(message, flag('-o', '--out'), channelRequest());
    return;
  }

  if (mode === 'rx') {
    const input = flag('-i', '--in');
    if (input) await decodeFile(input);
    else listen();
    return;
  }

  if (mode === 'rxtx') {
    console.error('qnr rxtx has been folded into the default station -- just run `qnr` (or `qnr "MESSAGE"`, `qnr -tui`).');
    process.exitCode = 1;
    return;
  }

  if (mode === 'fastchat') {
    const message = args.slice(1).find((a) => !a.startsWith('-'));
    runFastChat({ message });
    return;
  }

  if (mode === '-h' || mode === '--help') {
    usage();
    return;
  }

  // Default: continuous rxtx station -- bare `qnr`, `qnr "MESSAGE"`, `qnr -tui` all land here.
  const tui = args.includes('-tui') || args.includes('--tui');
  const message = args.find((a) => !a.startsWith('-'));
  runRxTx({ message, tui });
}

main().catch((e: Error) => {
  console.error(e.message);
  process.exit(1);
});
