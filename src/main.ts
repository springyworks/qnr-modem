import { DEFAULT_BAUD, DEFAULT_FEC, DEFAULT_SQUELCH_DB, SAMPLE_RATE, type FecMode } from './config.js';
import { listAudioNodes, playSamples, startCapture, type Capture } from './audio.js';
import { Receiver, type RxState } from './rx.js';
import { modulate } from './tx.js';
import { Dashboard } from './ui.js';

const BAUDS = [2, 4, 8, 16];

function argValue(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

async function printDevices(): Promise<void> {
  const nodes = await listAudioNodes();
  const sources = nodes.filter((n) => n.mediaClass === 'Audio/Source');
  const sinks = nodes.filter((n) => n.mediaClass === 'Audio/Sink');
  console.log('Capture devices (--input=<name>):');
  for (const n of sources) console.log(`  ${String(n.id).padStart(4)}  ${n.name}\n        ${n.description}`);
  console.log('\nPlayback devices (--output=<name>):');
  for (const n of sinks) console.log(`  ${String(n.id).padStart(4)}  ${n.name}\n        ${n.description}`);
}

async function main(): Promise<void> {
  if (process.argv.includes('--devices')) {
    await printDevices();
    return;
  }

  const input = argValue('input');
  const output = argValue('output');
  let baud = Number(argValue('baud') ?? DEFAULT_BAUD);
  if (!BAUDS.includes(baud)) baud = DEFAULT_BAUD;

  let loopback = true;
  let playAudio = true;
  let fec: FecMode = DEFAULT_FEC;
  let capture: Capture | null = null;
  let transmitting = false;
  let txStatus = 'idle';
  let state: RxState = 'SEARCH';
  let db = -100;

  const receiver = new Receiver(baud, {
    onChar: (ch) => ui.appendChar(ch),
    onLog: (msg, kind) => ui.log(msg, kind),
    onState: (s) => {
      state = s;
      refreshRx();
    },
    onLevel: (level, symbol, amps) => {
      db = level;
      ui.setLevel(level, symbol, amps);
      refreshRx();
    },
  }, SAMPLE_RATE, fec);
  receiver.squelchDb = DEFAULT_SQUELCH_DB;

  const refreshTx = (): void => ui.setTxPanel(baud, txStatus, loopback, playAudio, fec);
  const refreshRx = (): void =>
    ui.setRxPanel(state, db, receiver.squelchDb, input ?? 'default', capture !== null);

  const shutdown = (): void => {
    capture?.stop();
    ui.destroy();
    process.exit(0);
  };

  const ui = new Dashboard({
    onQuit: shutdown,
    onCycleBaud: () => {
      if (transmitting) return;
      baud = BAUDS[(BAUDS.indexOf(baud) + 1) % BAUDS.length]!;
      receiver.setBaud(baud);
      ui.log(`Baud set to ${baud}`, 'info');
      refreshTx();
    },
    onSquelch: (delta) => {
      receiver.squelchDb = Math.max(-100, Math.min(-10, receiver.squelchDb + delta));
      refreshRx();
    },
    onToggleLoopback: () => {
      loopback = !loopback;
      ui.log(`Internal loopback ${loopback ? 'enabled' : 'disabled'}`, 'info');
      refreshTx();
    },
    onToggleFec: () => {
      if (transmitting) return;
      fec = fec === 'conv' ? 'hamming' : 'conv';
      receiver.setFec(fec);
      ui.log(`FEC set to ${fec === 'conv' ? 'convolutional K=7 + Viterbi' : 'Hamming(7,4)'}`, 'info');
      refreshTx();
    },
    onToggleReceiver: () => {
      if (capture) {
        capture.stop();
        capture = null;
        ui.log('Capture stopped', 'info');
      } else {
        receiver.reset();
        capture = startCapture((samples) => receiver.push(samples), {
          target: input,
          onError: (e) => {
            ui.log(`Capture error: ${e.message}`, 'fail');
            capture = null;
            refreshRx();
          },
        });
        ui.log(`Capture started on ${input ?? 'default source'}`, 'info');
      }
      refreshRx();
    },
    onTransmit: () => {
      if (transmitting) return;
      const message = ui.message;
      if (!message) return;

      transmitting = true;
      txStatus = 'transmitting...';
      refreshTx();

      const samples = modulate(message, baud, 0.5, SAMPLE_RATE, fec);

      if (playAudio) {
        playSamples(samples, output).catch((e: Error) => ui.log(`Playback error: ${e.message}`, 'fail'));
      }

      if (loopback) {
        // Feed the demodulator in real time so the UI behaves like a live over-the-air decode.
        const chunk = Math.round(SAMPLE_RATE / 20);
        let pos = 0;
        const timer = setInterval(() => {
          if (pos >= samples.length) {
            clearInterval(timer);
            transmitting = false;
            txStatus = 'idle';
            refreshTx();
            return;
          }
          receiver.push(samples.subarray(pos, Math.min(pos + chunk, samples.length)));
          pos += chunk;
        }, 50);
      } else {
        const ms = (samples.length / SAMPLE_RATE) * 1000 + 200;
        setTimeout(() => {
          transmitting = false;
          txStatus = 'idle';
          refreshTx();
        }, ms);
      }
    },
  });

  ui.log('Ready. Press t to transmit, r to enable capture, l to toggle loopback.', 'info');
  refreshTx();
  refreshRx();
  ui.render();
}

main().catch((e: Error) => {
  console.error(e);
  process.exit(1);
});
