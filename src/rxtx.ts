import * as readline from 'node:readline';
import { createAudioIdentity, startCapture, startPersistentPlayback, type PersistentPlayback } from './audio.js';
import { ITU_PROFILES, applyChannel, meanPower } from './channel.js';
import { SAMPLE_RATE } from './config.js';
import { ContinuousReceiver, type HeardFrame } from './live.js';
import { CHAT_PAYLOAD_BYTES, decodeChatMessage, encodeChatMessage } from './packet.js';
import { liveWorkerCount } from './pool.js';
import { AMPLITUDE, BAUD, DATA_SYMBOLS, FRAME_OPTIONS, GUARD_SAMPLES, LIVE_DECODE_SAMPLES, msUntilPhase, PERIOD_SAMPLES, REPEATS } from './protocol.js';
import { QNR_PAGE_URL, qrHalfBlockArt } from './qr.js';
import { StationDashboard, type TxDashboardState } from './stationUi.js';
import { modulate, modulateChatMessage } from './tx.js';

/** One decode attempt per period, which is one attempt per transmitted burst. A worst-case
 * (idle-noise, no early exit) fold measures ~20 s, so a per-slot cadence would overrun. */
const DECODE_MS = (LIVE_DECODE_SAMPLES / SAMPLE_RATE) * 1000;
/** Default FEC strength: this many identical bursts sent back-to-back for one message. */
const DEFAULT_FEC_LEVEL = 2;
/** [Tune] menu item: a plain audio-chain test tone, not a protocol frame. */
const TUNE_FREQUENCY_HZ = 1000;
const TUNE_DURATION_SECONDS = 0.5;
/** Manual test-channel controls: `undefined` is OFF (no synthetic noise added at all). */
const TX_SNR_STEPS_DB: Array<number | undefined> = [undefined, 0, -6, -10, -14, -18, -20, -22, -24, -26, -30];
/** SNR to feed `applyChannel` when only fading (no deliberate added noise) is wanted. */
const TX_CLEAN_SNR_DB = 60;
const TX_PROFILE_KEYS: Array<string | null> = [null, ...Object.keys(ITU_PROFILES)];

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const modulo = (value: number, divisor: number): number => ((value % divisor) + divisor) % divisor;

function generateTone(frequencyHz: number, durationSeconds: number, amplitude: number, sampleRate: number): Float32Array {
  const samples = new Float32Array(Math.round(durationSeconds * sampleRate));
  const step = (2 * Math.PI * frequencyHz) / sampleRate;
  for (let n = 0; n < samples.length; n++) samples[n] = amplitude * Math.sin(step * n);
  return samples;
}

function sampleDb(samples: Float32Array): number {
  let energy = 0;
  for (const sample of samples) energy += sample * sample;
  return 20 * Math.log10(Math.max(Math.sqrt(energy / Math.max(samples.length, 1)), 1e-6));
}

function frameDetail(frame: HeardFrame): string {
  if (frame.source === 'loud') return 'direct off-grid';
  const sign = (value: number): string => (value >= 0 ? '+' : '');
  return `${frame.bursts}x LLR  ${sign(frame.offsetHz ?? 0)}${(frame.offsetHz ?? 0).toFixed(1)} Hz  ${sign(frame.driftPpm ?? 0)}${(frame.driftPpm ?? 0).toFixed(0)} ppm`;
}

interface ActiveOutbound {
  message: string;
  phaseSamples: number;
}

export interface RxTxOptions {
  /** Queued for transmission as soon as the station starts. */
  message?: string;
  /** Interactive full-screen station console. */
  tui: boolean;
}

/**
 * Transmits and receives at the same time, in one process: playback and capture are
 * independent PipeWire subprocesses, so a queued message goes out while the decoder keeps
 * trying every elementary time-slot regardless. Audio routing (loopback vs a real radio)
 * is left entirely to the operator, same as `tx`/`rx`.
 *
 * This is plain chat: no timing handshake, no ACK, no automatic retry. A typed line is sent
 * once as `fecLevel` identical back-to-back bursts (1..REPEATS, adjustable live from the
 * dashboard) -- more bursts trade air time for a stronger folded decode, but the receiver
 * never needs to be told how many were sent; it just folds whatever it hears.
 */
export function runRxTx(opts: RxTxOptions): void {
  const jobs = liveWorkerCount();
  const identity = createAudioIdentity();
  const messageQueue: string[] = [];
  let sending = false;
  let stopped = false;
  let fecLevel = DEFAULT_FEC_LEVEL;
  let offGrid = false;
  let txSnrIndex = 0;
  let txProfileIndex = 0;
  let txSeed = 1;
  let currentMessage = '';
  let currentRepeat = 0;
  let currentOutputDb = -100;
  let txStatus = 'idle';
  let active: ActiveOutbound | undefined;
  let dashboard: StationDashboard | undefined;
  let lineReader: readline.Interface | undefined;
  let capture: ReturnType<typeof startCapture> | undefined;
  let playback: PersistentPlayback | undefined;
  let decodeTimer: ReturnType<typeof setInterval> | undefined;

  const renderTx = (): void => {
    const state: TxDashboardState = {
      message: currentMessage,
      sending,
      repeat: currentRepeat,
      repeats: sending ? fecLevel : 0,
      queued: messageQueue.length,
      outputDb: currentOutputDb,
      status: txStatus,
      fecLevel,
      fecMax: REPEATS,
      offGrid,
      txSnrDb: TX_SNR_STEPS_DB[txSnrIndex],
      txProfileName: TX_PROFILE_KEYS[txProfileIndex] ? ITU_PROFILES[TX_PROFILE_KEYS[txProfileIndex]!]!.name : null,
    };
    dashboard?.setTx(state);
  };

  const log = (line: string, color: 'green' | 'yellow' | 'red' | 'cyan' | 'gray' = 'gray'): void => {
    if (dashboard) {
      dashboard.log(line, color);
    } else if (lineReader) {
      readline.cursorTo(process.stdout, 0);
      readline.clearLine(process.stdout, 0);
      console.log(line);
      lineReader.prompt(true);
    } else {
      console.log(line);
    }
  };

  /** Wait for one exact world-time burst phase; a passed phase rolls into the next period. */
  const waitForPhase = async (phaseSamples: number): Promise<void> => {
    const waitMs = msUntilPhase(phaseSamples);
    if (waitMs > 1) await delay(waitMs);
  };

  const startOutbound = (message: string, phaseSamples: number): void => {
    if (sending || stopped) return;
    void runOutbound(message, phaseSamples);
  };

  async function runOutbound(message: string, phaseSamples: number): Promise<void> {
    const clean = modulateChatMessage(encodeChatMessage(message), DATA_SYMBOLS, BAUD, AMPLITUDE, SAMPLE_RATE, FRAME_OPTIONS);
    const snrDb = TX_SNR_STEPS_DB[txSnrIndex];
    const profileKey = TX_PROFILE_KEYS[txProfileIndex];
    const profile = profileKey ? ITU_PROFILES[profileKey]! : null;
    // Both OFF: skip applyChannel entirely so a clean test signal costs no extra FFT work.
    const burst =
      snrDb === undefined && !profile
        ? clean
        : applyChannel(clean, {
            sampleRate: SAMPLE_RATE,
            snrDb: snrDb ?? TX_CLEAN_SNR_DB,
            profile,
            seed: txSeed++,
            referencePower: meanPower(clean),
          });
    const outbound: ActiveOutbound = { message, phaseSamples };
    active = outbound;
    sending = true;
    currentMessage = message;
    currentOutputDb = sampleDb(burst);
    currentRepeat = 0;
    txStatus = `waiting for transmit frame (FEC x${fecLevel})`;
    renderTx();

    try {
      // Off-grid: key up the moment the operator hits enter -- no shared-grid alignment, so no
      // repeat-fold gain, just an immediate single-shot (or fast back-to-back) burst that the
      // always-on direct/loud receiver below can decode without knowing the schedule.
      if (!offGrid) await waitForPhase(phaseSamples);
      for (let repeat = 1; repeat <= fecLevel && !stopped; repeat++) {
        currentRepeat = repeat;
        txStatus = `burst ${repeat}/${fecLevel} - "${message}"`;
        renderTx();
        log(`  TX ${repeat}/${fecLevel}  "${message}"${offGrid ? '  [off-grid]' : ''}`, 'red');
        // The folded search would otherwise hold every worker thread while this burst is being
        // written to PipeWire, starving the writer and breaking the transmitted tone up.
        receiver.setPaused(true);
        try {
          await playback?.play(burst);
        } finally {
          receiver.setPaused(false);
        }
        if (repeat < fecLevel) {
          txStatus = 'listening between repeats';
          renderTx();
          const gapSamples = offGrid ? GUARD_SAMPLES : PERIOD_SAMPLES - burst.length;
          await delay((gapSamples / SAMPLE_RATE) * 1000);
        }
      }
    } catch (error) {
      log(`transmit error: ${error instanceof Error ? error.message : String(error)}`, 'red');
    } finally {
      if (active === outbound) active = undefined;
      sending = false;
      currentRepeat = 0;
      currentMessage = '';
      currentOutputDb = -100;
      txStatus = 'listening';
      renderTx();
      pumpQueue();
    }
  }

  const pumpQueue = (): void => {
    if (sending || stopped) return;
    const message = messageQueue.shift();
    if (message) startOutbound(message, GUARD_SAMPLES);
  };

  const queueMessage = (raw: string): void => {
    const text = decodeChatMessage(encodeChatMessage(raw)) ?? '';
    if (text.length === 0) {
      log('nothing to send: no printable ASCII characters', 'yellow');
      return;
    }
    if (text.length < [...raw].filter((c) => c.length === 1 && c.charCodeAt(0) >= 0x20 && c.charCodeAt(0) <= 0x7e).length) {
      log(`truncated to ${CHAT_PAYLOAD_BYTES} payload characters: "${text}"`, 'yellow');
    }
    messageQueue.push(text);
    renderTx();
    pumpQueue();
  };

  const setFecLevel = (level: number): void => {
    fecLevel = Math.max(1, Math.min(REPEATS, Math.round(level)));
    log(`FEC strength set to x${fecLevel}`, 'cyan');
    renderTx();
  };

  const setOffGrid = (enabled: boolean): void => {
    offGrid = enabled;
    log(offGrid ? 'off-grid mode ON: sends immediately, no repeat-fold gain' : 'off-grid mode OFF: sends on the shared timing grid', 'cyan');
    renderTx();
  };

  /** Manual test-channel controls, applied to the outbound burst only: real signal path is untouched. */
  const cycleTxSnr = (direction: 1 | -1): void => {
    txSnrIndex = modulo(txSnrIndex + direction, TX_SNR_STEPS_DB.length);
    const db = TX_SNR_STEPS_DB[txSnrIndex];
    log(db === undefined ? 'TX test SNR OFF: sending a clean signal' : `TX test SNR set to ${db} dB`, 'cyan');
    renderTx();
  };

  const cycleTxProfile = (direction: 1 | -1): void => {
    txProfileIndex = modulo(txProfileIndex + direction, TX_PROFILE_KEYS.length);
    const key = TX_PROFILE_KEYS[txProfileIndex];
    log(key === null ? 'Watterson HF profile OFF' : `Watterson HF profile set to ${ITU_PROFILES[key]!.name}`, 'cyan');
    renderTx();
  };

  // Local audio-chain check only: no protocol data, safe to play any time. Later this is the
  // natural place to key a real radio via hamlib (WFview / IC-705) instead of the sound card.
  const playTune = (): void => {
    log(`TUNE  ${TUNE_FREQUENCY_HZ} Hz test tone (${TUNE_DURATION_SECONDS}s)`, 'cyan');
    void playback?.play(generateTone(TUNE_FREQUENCY_HZ, TUNE_DURATION_SECONDS, AMPLITUDE, SAMPLE_RATE));
  };

  // Sounds the page URL out as a real modem burst (arbitrary-length conv+Viterbi frame, not the
  // fixed 16-byte chat protocol) so it can be heard, recorded, or even received -- best-effort,
  // this frame shape isn't wired into the live rx chain here, unlike the chat protocol above.
  const playQrAudio = (): void => {
    const burst = modulate(QNR_PAGE_URL, BAUD, AMPLITUDE, SAMPLE_RATE, 'conv', FRAME_OPTIONS);
    log(`QR AUDIO  "${QNR_PAGE_URL}"  (${(burst.length / SAMPLE_RATE).toFixed(1)}s)`, 'cyan');
    void playback?.play(burst);
  };

  const handleFrame = (frame: HeardFrame): void => {
    const text = decodeChatMessage(frame.text);
    if (text === undefined) {
      log(`  ignored non-chat frame [${frame.lane}]  ${frameDetail(frame)}`, 'yellow');
      return;
    }
    if (text.length === 0) return;

    log(`  RX "${text}"  ${frameDetail(frame)}`, 'green');
    dashboard?.appendReceivedMessage(text);
  };

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (decodeTimer) clearInterval(decodeTimer);
    capture?.stop();
    playback?.stop();
    receiver.close();
    lineReader?.close();
    dashboard?.destroy();
    process.stdout.write('\n');
    process.exit(0);
  };

  const useDashboard = opts.tui && Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (useDashboard) {
    dashboard = new StationDashboard({
      onSubmit: queueMessage,
      onQuit: stop,
      onFecLevel: setFecLevel,
      onTune: playTune,
      onOffGrid: setOffGrid,
      onTxSnrCycle: cycleTxSnr,
      onTxProfileCycle: cycleTxProfile,
      onQrAudio: playQrAudio,
    });
  } else if (opts.tui) {
    lineReader = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
    console.error('qnr rxtx -tui needs a TTY; using the line prompt instead');
  }

  const receiver = new ContinuousReceiver(
    {
      onFrame: handleFrame,
      onStatus: (status) => dashboard?.setRx(status),
      onError: (error) => log(`decoder error: ${error.message}`, 'red'),
    },
    jobs
  );

  playback = startPersistentPlayback({ identity, onError: (error) => log(`playback error: ${error.message}`, 'red') });
  capture = startCapture((block) => receiver.push(block), {
    identity,
    onError: (error) => log(`capture error: ${error.message}`, 'red'),
  });
  decodeTimer = setInterval(() => void receiver.decode(), DECODE_MS);
  process.on('SIGINT', stop);

  if (opts.message) queueMessage(opts.message);

  if (lineReader) {
    log(`rxtx  ${identity.label}  ${jobs} decoder threads  -  type a message and press enter, '/qr' for a scannable link, '/qr audio' to hear it, Ctrl-D to quit`);
    lineReader.prompt();
    lineReader.on('line', (line) => {
      const trimmed = line.trim();
      if (trimmed === '/qr') {
        console.log(`${qrHalfBlockArt(QNR_PAGE_URL).join('\n')}\n\n${QNR_PAGE_URL}`);
      } else if (trimmed === '/qr audio') {
        playQrAudio();
      } else {
        queueMessage(line);
      }
      lineReader?.prompt();
    });
    lineReader.on('close', stop);
  } else if (!dashboard) {
    log(`rxtx  ${identity.label}  ${jobs} decoder threads  -  listening continuously`);
  } else {
    dashboard.log(`${identity.label} online - ${jobs} decoder threads`, 'cyan');
    renderTx();
  }
}
