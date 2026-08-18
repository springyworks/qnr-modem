import blessed from 'blessed';
import { NUM_TONES } from './config.js';
import type { LogKind, RxState } from './rx.js';

const BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

export interface DashboardHandlers {
  onTransmit(): void;
  onToggleReceiver(): void;
  onToggleLoopback(): void;
  onToggleFec(): void;
  onSquelch(delta: number): void;
  onCycleBaud(): void;
  onQuit(): void;
}

export class Dashboard {
  readonly screen: blessed.Widgets.Screen;
  private readonly txBox: blessed.Widgets.BoxElement;
  private readonly rxBox: blessed.Widgets.BoxElement;
  private readonly spectrum: blessed.Widgets.BoxElement;
  private readonly output: blessed.Widgets.BoxElement;
  private readonly logBox: blessed.Widgets.Log;
  private readonly input: blessed.Widgets.TextboxElement;

  private text = '';

  constructor(private readonly handlers: DashboardHandlers) {
    this.screen = blessed.screen({ smartCSR: true, title: 'ROS 144-MFSK Modem' });

    blessed.box({
      parent: this.screen,
      top: 0,
      height: 3,
      width: '100%',
      align: 'center',
      tags: true,
      border: 'line',
      style: { border: { fg: 'cyan' } },
      content: '{bold}{cyan-fg}ROS 144-MFSK BASEBAND{/} — Hamming(7,4) FEC • PipeWire • native TypeScript',
    });

    this.txBox = blessed.box({
      parent: this.screen,
      label: ' TX: MODULATOR ',
      top: 3,
      left: 0,
      width: '50%',
      height: 8,
      border: 'line',
      tags: true,
      style: { border: { fg: 'red' } },
    });

    this.input = blessed.textbox({
      parent: this.txBox,
      top: 3,
      left: 1,
      right: 1,
      height: 1,
      inputOnFocus: true,
      style: { fg: 'white', bg: 'black' },
    });
    this.input.setValue('CQ CQ ROS TEST');
    this.input.on('submit', () => {
      this.screen.focusPop();
      this.render();
    });

    this.rxBox = blessed.box({
      parent: this.screen,
      label: ' RX: DEMODULATOR & FEC ',
      top: 3,
      left: '50%',
      width: '50%',
      height: 8,
      border: 'line',
      tags: true,
      style: { border: { fg: 'green' } },
    });

    this.spectrum = blessed.box({
      parent: this.screen,
      label: ' SPECTRUM (144 tones) ',
      top: 11,
      left: 0,
      width: '100%',
      height: 5,
      border: 'line',
      tags: true,
      style: { border: { fg: 'blue' } },
    });

    this.output = blessed.box({
      parent: this.screen,
      label: ' DECODED ',
      top: 16,
      left: 0,
      width: '50%',
      bottom: 3,
      border: 'line',
      tags: true,
      scrollable: true,
      alwaysScroll: true,
      style: { border: { fg: 'green' } },
    });

    this.logBox = blessed.log({
      parent: this.screen,
      label: ' FEC DIAGNOSTICS ',
      top: 16,
      left: '50%',
      width: '50%',
      bottom: 3,
      border: 'line',
      tags: true,
      scrollback: 200,
      style: { border: { fg: 'magenta' } },
    });

    blessed.box({
      parent: this.screen,
      bottom: 0,
      height: 3,
      width: '100%',
      border: 'line',
      tags: true,
      style: { border: { fg: 'gray' } },
      content:
        ' {bold}t{/} transmit  {bold}r{/} rx on/off  {bold}l{/} loopback  {bold}f{/} FEC  {bold}b{/} baud  {bold}e{/} edit  {bold}[ ]{/} squelch  {bold}q{/} quit',
    });

    this.bindKeys();
    this.setLevel(-100, -1, new Float64Array(NUM_TONES));
  }

  private bindKeys(): void {
    const s = this.screen;
    s.key(['q', 'C-c'], () => this.handlers.onQuit());
    s.key(['t'], () => this.handlers.onTransmit());
    s.key(['r'], () => this.handlers.onToggleReceiver());
    s.key(['l'], () => this.handlers.onToggleLoopback());
    s.key(['f'], () => this.handlers.onToggleFec());
    s.key(['b'], () => this.handlers.onCycleBaud());
    s.key(['['], () => this.handlers.onSquelch(-1));
    s.key([']'], () => this.handlers.onSquelch(1));
    s.key(['e'], () => {
      this.screen.focusPush(this.input);
      this.input.readInput(() => undefined);
    });
  }

  get message(): string {
    return this.input.getValue();
  }

  setTxPanel(baud: number, status: string, loopback: boolean, playAudio: boolean, fec: string): void {
    this.txBox.setContent(
      [
        ` Baud     : {bold}${baud}{/} Bd    FEC: {bold}${fec === 'conv' ? 'Viterbi K=7' : 'Hamming(7,4)'}{/}`,
        ` Routing  : loopback ${loopback ? '{green-fg}ON{/}' : '{gray-fg}off{/}'}   speaker ${
          playAudio ? '{green-fg}ON{/}' : '{gray-fg}off{/}'
        }`,
        ` Status   : ${status}`,
        ' Message  :',
      ].join('\n')
    );
    this.render();
  }

  setRxPanel(state: RxState, db: number, squelch: number, device: string, running: boolean): void {
    const level = Math.max(0, Math.min(1, (db + 100) / 100));
    const width = 28;
    const filled = Math.round(level * width);
    const bar = '█'.repeat(filled) + '·'.repeat(width - filled);
    const stateColor = state === 'DATA' ? 'green' : state === 'SYNC' ? 'yellow' : 'gray';

    this.rxBox.setContent(
      [
        ` Receiver : ${running ? '{green-fg}RUNNING{/}' : '{gray-fg}stopped{/}'}`,
        ` State    : {${stateColor}-fg}{bold}${state}{/}`,
        ` Level    : ${db <= -99 ? '-100.0' : db.toFixed(1).padStart(6)} dB  ${bar}`,
        ` Squelch  : ${squelch} dB`,
        ` Device   : ${device}`,
      ].join('\n')
    );
    this.render();
  }

  setLevel(_db: number, symbol: number, amplitudes: Float64Array): void {
    const width = Math.max(10, (this.spectrum.width as number) - 4);
    const perCol = NUM_TONES / width;
    let line = '';
    for (let c = 0; c < width; c++) {
      let peak = 0;
      for (let s = Math.floor(c * perCol); s < Math.floor((c + 1) * perCol); s++) {
        peak = Math.max(peak, amplitudes[s] ?? 0);
      }
      const db = 20 * Math.log10(Math.max(peak, 1e-10));
      const norm = Math.max(0, Math.min(1, (db + 80) / 80));
      line += norm <= 0 ? ' ' : BLOCKS[Math.min(BLOCKS.length - 1, Math.floor(norm * BLOCKS.length))];
    }
    this.spectrum.setContent(`{cyan-fg}${line}{/}\n symbol: ${symbol < 0 ? '--' : symbol}`);
    this.render();
  }

  appendChar(ch: string): void {
    this.text += ch;
    this.output.setContent(this.text);
    this.output.setScrollPerc(100);
    this.render();
  }

  log(msg: string, kind: LogKind = 'info'): void {
    const color = kind === 'corr' ? 'magenta' : kind === 'fail' ? 'red' : 'gray';
    this.logBox.log(`{${color}-fg}${msg}{/}`);
  }

  render(): void {
    this.screen.render();
  }

  destroy(): void {
    this.screen.destroy();
  }
}
