import blessed from 'blessed';
import type { ContinuousReceiverStatus } from './live.js';
import { CHAT_PAYLOAD_BYTES } from './packet.js';

const METER_WIDTH = 22;
/** Terminals that support the "CSI u" / modifyOtherKeys encoding send one of these for Shift+Enter. */
const SHIFT_ENTER_SEQUENCES = new Set(['\x1b[13;2u', '\x1b[27;2;13~']);
const CHAT_LOG_LINES = 4;
const CONTROL_ROW_COUNT = 5;

export interface TxDashboardState {
  message: string;
  sending: boolean;
  repeat: number;
  repeats: number;
  queued: number;
  outputDb: number;
  status: string;
  fecLevel: number;
  fecMax: number;
  offGrid: boolean;
  /** undefined/null means the test-channel control is OFF. */
  txSnrDb?: number;
  txProfileName?: string | null;
}

export interface StationDashboardHandlers {
  onSubmit(message: string): void;
  onQuit(): void;
  onFecLevel(level: number): void;
  onTune(): void;
  onOffGrid(enabled: boolean): void;
  onTxSnrCycle(direction: 1 | -1): void;
  onTxProfileCycle(direction: 1 | -1): void;
}

const escapeTags = (text: string): string => text.replaceAll('{', '\\{').replaceAll('}', '\\}');

function meter(db: number, percent?: number): string {
  const normalized = percent ?? Math.max(0, Math.min(1, (db + 60) / 60));
  const filled = Math.round(Math.max(0, Math.min(1, normalized)) * METER_WIDTH);
  return `|${'#'.repeat(filled)}${'-'.repeat(METER_WIDTH - filled)}| ${db.toFixed(1).padStart(6)} dB`;
}

/** Full-screen station console used by `qnr rxtx -tui`. */
export class StationDashboard {
  readonly screen: blessed.Widgets.Screen;
  private readonly rxPane: blessed.Widgets.BoxElement;
  private readonly txPane: blessed.Widgets.BoxElement;
  private readonly events: blessed.Widgets.Log;
  private readonly input: blessed.Widgets.BoxElement;
  private readonly controlsPane: blessed.Widgets.BoxElement;
  private readonly controlRows: blessed.Widgets.BoxElement[];
  private readonly footer: blessed.Widgets.BoxElement;
  private lastRx: ContinuousReceiverStatus | undefined;
  private readonly chatLog: string[] = [];
  private draft = '';
  private fecLevel = 0;
  private fecMax = 0;
  private offGrid = false;
  private txSnrDb: number | undefined;
  private txProfileName: string | null = null;
  private controlSelected = 0;
  private controlsFocused = false;

  constructor(private readonly handlers: StationDashboardHandlers) {
    this.screen = blessed.screen({ smartCSR: true, title: 'QNR-144 Station' });

    blessed.box({
      parent: this.screen,
      top: 0,
      left: 0,
      height: 3,
      width: '100%',
      align: 'center',
      border: 'line',
      tags: true,
      style: { border: { fg: 'cyan' } },
      content: '{bold}{cyan-fg}QNR-144{/}  weak-signal chat station',
    });

    this.rxPane = blessed.box({
      parent: this.screen,
      label: ' RX / DECODER ',
      top: 3,
      left: 0,
      width: '50%',
      height: 12,
      border: 'line',
      tags: true,
      style: { border: { fg: 'green' } },
    });

    this.txPane = blessed.box({
      parent: this.screen,
      label: ' TX / SCHEDULER ',
      top: 3,
      left: '50%',
      width: '50%',
      height: 12,
      border: 'line',
      tags: true,
      style: { border: { fg: 'red' } },
    });

    this.events = blessed.log({
      parent: this.screen,
      label: ' AIR TRAFFIC / DECODER TRACE ',
      top: 15,
      left: 0,
      width: '100%',
      bottom: 13,
      border: 'line',
      tags: true,
      scrollback: 300,
      alwaysScroll: true,
      style: { border: { fg: 'yellow' } },
    });

    this.input = blessed.box({
      parent: this.screen,
      label: ` MESSAGE  (Tab/^L switch focus, Enter sends, Shift+Enter newline, ${CHAT_PAYLOAD_BYTES} chars max) `,
      bottom: 1,
      left: 0,
      width: '100%',
      height: 4,
      border: 'line',
      tags: false,
      mouse: true,
      clickable: true,
      style: { border: { fg: 'magenta' }, fg: 'white' },
    });
    this.input.on('click', () => {
      if (this.controlsFocused) this.toggleControlsFocus();
    });

    // Always-visible controls, nano-style: Ctrl-chords are single control bytes, never a
    // multi-byte terminal-dependent escape sequence (unlike F-keys), and never collide with
    // typed chat text (unlike the old '[' ']' bindings). Tab/^L moves keyboard focus onto this
    // pane for arrow-key/mouse navigation; the Ctrl-chords themselves work whether focused or not.
    this.controlsPane = blessed.box({
      parent: this.screen,
      label: ' CONTROLS  (Tab/^L focus, Esc back)  ',
      bottom: 5,
      left: 0,
      width: '100%',
      height: 8,
      border: 'line',
      tags: true,
      mouse: true,
      clickable: true,
      style: { border: { fg: 'blue' } },
    });
    this.controlsPane.on('click', () => {
      if (!this.controlsFocused) this.toggleControlsFocus();
    });

    this.controlRows = Array.from({ length: CONTROL_ROW_COUNT }, (_, index) => {
      const row = blessed.box({
        parent: this.controlsPane,
        top: index,
        left: 1,
        right: 1,
        height: 1,
        tags: true,
        mouse: true,
        clickable: true,
        style: { fg: 'white' },
      });
      row.on('click', () => this.activateControl(index));
      return row;
    });

    this.footer = blessed.box({
      parent: this.screen,
      bottom: 0,
      left: 0,
      width: '100%',
      height: 1,
      align: 'center',
      tags: true,
      style: { fg: 'gray' },
      content: '144-tone MFSK  |  Conv r1/3  |  CRC-16  |  fixed 8 Bd  |  Tab/^L controls  |  ^F FEC  ^G Off-grid  ^T Tune  ^N SNR  ^P HF  |  ^X/^C quit',
    });

    this.screen.key(['C-c', 'C-x'], () => this.handlers.onQuit());
    this.screen.key(['tab', 'C-l'], () => this.toggleControlsFocus());
    this.screen.key(['C-f'], () => this.activateControl(0));
    this.screen.key(['C-g'], () => this.activateControl(1));
    this.screen.key(['C-t'], () => this.activateControl(2));
    this.screen.key(['C-n'], () => this.activateControl(3));
    this.screen.key(['C-p'], () => this.activateControl(4));
    this.screen.key(['escape'], () => {
      if (this.controlsFocused) {
        this.toggleControlsFocus();
        return;
      }
      this.draft = '';
      this.renderInput();
    });
    this.screen.key(['backspace'], () => {
      if (this.controlsFocused) return;
      this.draft = this.draft.slice(0, -1);
      this.renderInput();
    });
    this.screen.on('keypress', (ch, key) => {
      if (this.controlsFocused) {
        this.handleControlsKey(ch, key);
        return;
      }
      if (!ch) return;
      if (key?.name === 'enter') {
        const message = this.draft;
        this.draft = '';
        this.renderInput();
        if (message.trim().length > 0) this.handlers.onSubmit(message);
        return;
      }
      if (key?.name === 'linefeed') {
        this.draft += '\n';
        this.renderInput();
        return;
      }
      if (key?.name === 'backspace' || key?.name === 'escape' || key?.ctrl || key?.meta) return;
      if (/^[\x20-\x7e]$/.test(ch)) {
        this.draft += ch;
        this.renderInput();
      }
    });
    // Some terminals only report Shift+Enter as a raw CSI-u escape sequence keys.js does not parse.
    process.stdin.on('data', (buffer: Buffer) => {
      if (this.controlsFocused) return;
      if (SHIFT_ENTER_SEQUENCES.has(buffer.toString('utf8'))) {
        this.draft += '\n';
        this.renderInput();
      }
    });

    this.setRx({
      inputDb: -100,
      peakDb: -100,
      bufferedSamples: 0,
      readyPercent: 0,
      decoding: false,
      progress: 'waiting for audio',
      directState: 'SEARCH',
      evidence: 'no repeat evidence yet',
      foldedBursts: 0,
      repeatTarget: 0,
    });
    this.setTx({
      message: '',
      sending: false,
      repeat: 0,
      repeats: 0,
      queued: 0,
      outputDb: -100,
      status: 'idle',
      fecLevel: 1,
      fecMax: 8,
      offGrid: false,
      txSnrDb: undefined,
      txProfileName: null,
    });
    this.input.focus();
    this.input.style.border.fg = 'green';
    this.renderInput();
    this.render();
  }

  setRx(state: ContinuousReceiverStatus): void {
    this.lastRx = state;
    const stateColor = state.decoding ? 'yellow' : 'green';
    const log = this.chatLog.length > 0 ? this.chatLog.slice(-CHAT_LOG_LINES).map(escapeTags).join('\n            ') : '--';
    this.rxPane.setContent(
      [
        ` IN        ${meter(state.inputDb)}`,
        ` PEAK      ${meter(state.peakDb)}`,
        ` RING      ${meter(-60 + state.readyPercent * 60, state.readyPercent)}  ${state.bufferedSamples.toLocaleString()} samples`,
        ` FOLD      ${meter(-60 + (state.foldedBursts / Math.max(state.repeatTarget, 1)) * 60, state.foldedBursts / Math.max(state.repeatTarget, 1))}  ${state.foldedBursts}/${state.repeatTarget || 0} raw repeats`,
        ` DIRECT    {${state.directState === 'DATA' ? 'green' : 'cyan'}-fg}${state.directState}{/}`,
        ` SEARCH    {${stateColor}-fg}${state.decoding ? 'RUNNING' : 'READY'}{/}  ${escapeTags(state.progress)}`,
        ` EVIDENCE  ${escapeTags(state.evidence)}`,
        ` CHAT      ${log}`,
      ].join('\n')
    );
    this.render();
  }

  appendReceivedMessage(text: string): void {
    this.chatLog.push(text);
    if (this.chatLog.length > 64) this.chatLog.shift();
    if (this.lastRx) this.setRx(this.lastRx);
  }

  setTx(state: TxDashboardState): void {
    this.fecLevel = state.fecLevel;
    this.fecMax = state.fecMax;
    this.offGrid = state.offGrid;
    this.txSnrDb = state.txSnrDb;
    this.txProfileName = state.txProfileName ?? null;
    const mode = state.sending ? '{red-fg}KEYED{/}' : '{green-fg}LISTEN{/}';
    const grid = state.offGrid ? '{yellow-fg}OFF-GRID (immediate){/}' : '{gray-fg}grid-scheduled{/}';
    const repeatPercent = state.repeats > 0 ? state.repeat / state.repeats : 0;
    const queuePercent = Math.min(1, state.queued / 4);
    this.txPane.setContent(
      [
        ` OUT       ${meter(state.outputDb)}`,
        ` REPEAT    ${meter(-60 + repeatPercent * 60, repeatPercent)}  ${state.repeat}/${state.repeats || 0}`,
        ` QUEUE     ${meter(-60 + queuePercent * 60, queuePercent)}  ${state.queued}`,
        ` RADIO     ${mode}  ${grid}`,
        ` STATUS    ${escapeTags(state.status)}`,
        ` MESSAGE   ${escapeTags(state.message || '--')}`,
      ].join('\n')
    );
    this.renderControls();
  }

  log(message: string, color: 'green' | 'yellow' | 'red' | 'cyan' | 'gray' = 'gray'): void {
    this.events.log(`{${color}-fg}${escapeTags(message)}{/}`);
    this.render();
  }

  destroy(): void {
    this.screen.destroy();
  }

  private renderInput(): void {
    const printable = [...this.draft].filter((c) => c !== '\n').length;
    this.input.setLabel(
      ` MESSAGE  (Enter sends, Shift+Enter newline, ${printable}/${CHAT_PAYLOAD_BYTES} chars) `
    );
    this.input.setContent(this.draft);
    this.render();
  }

  /** Rows 0-2 as before; row 3 cycles TX test SNR, row 4 cycles the Watterson HF profile. */
  private activateControl(index: number): void {
    if (index === 0) this.handlers.onFecLevel(this.fecLevel >= this.fecMax ? 1 : this.fecLevel + 1);
    else if (index === 1) this.handlers.onOffGrid(!this.offGrid);
    else if (index === 2) this.handlers.onTune();
    else if (index === 3) this.handlers.onTxSnrCycle(1);
    else if (index === 4) this.handlers.onTxProfileCycle(1);
  }

  private toggleControlsFocus(): void {
    this.controlsFocused = !this.controlsFocused;
    if (!this.controlsFocused) this.controlSelected = 0;
    // Drive blessed's real focus system (not just our own flag) so cursor/click targeting agree.
    if (this.controlsFocused) this.controlsPane.focus();
    else this.input.focus();
    this.input.style.border.fg = this.controlsFocused ? 'magenta' : 'green';
    this.renderControls();
  }

  private handleControlsKey(_ch: string, key: { name?: string } | undefined): void {
    if (key?.name === 'up') {
      this.controlSelected = (this.controlSelected - 1 + CONTROL_ROW_COUNT) % CONTROL_ROW_COUNT;
      this.renderControls();
    } else if (key?.name === 'down') {
      this.controlSelected = (this.controlSelected + 1) % CONTROL_ROW_COUNT;
      this.renderControls();
    } else if (key?.name === 'return' || key?.name === 'enter' || key?.name === 'space') {
      this.activateControl(this.controlSelected);
    } else if (key?.name === 'right' && this.controlSelected === 0) {
      this.handlers.onFecLevel(this.fecLevel + 1);
    } else if (key?.name === 'left' && this.controlSelected === 0) {
      this.handlers.onFecLevel(this.fecLevel - 1);
    } else if (key?.name === 'right' && this.controlSelected === 3) {
      this.handlers.onTxSnrCycle(1);
    } else if (key?.name === 'left' && this.controlSelected === 3) {
      this.handlers.onTxSnrCycle(-1);
    } else if (key?.name === 'right' && this.controlSelected === 4) {
      this.handlers.onTxProfileCycle(1);
    } else if (key?.name === 'left' && this.controlSelected === 4) {
      this.handlers.onTxProfileCycle(-1);
    }
  }

  private renderControls(): void {
    const snrLabel = this.txSnrDb === undefined ? '{gray-fg}OFF{/}' : `{yellow-fg}${this.txSnrDb} dB{/}`;
    const profileLabel = this.txProfileName === null ? '{gray-fg}OFF{/}' : `{yellow-fg}${this.txProfileName}{/}`;
    const rows = [
      ` FEC strength    x${this.fecLevel} / x${this.fecMax}   (^F cycles, \u2190/\u2192 when focused)`,
      ` Off-grid mode   ${this.offGrid ? '{yellow-fg}ON{/}' : '{gray-fg}OFF{/}'}   (^G toggles)`,
      ` Tune test tone  1 kHz, 0.5 s   (^T plays)`,
      ` TX test SNR     ${snrLabel}   (^N cycles, \u2190/\u2192 when focused)`,
      ` Watterson HF    ${profileLabel}   (^P cycles, \u2190/\u2192 when focused)`,
    ];
    rows.forEach((content, index) => {
      const selected = this.controlsFocused && index === this.controlSelected;
      this.controlRows[index].setContent(content);
      this.controlRows[index].style = selected ? { bg: 'blue', fg: 'white' } : { fg: 'white' };
    });
    this.controlsPane.style.border.fg = this.controlsFocused ? 'green' : 'blue';
    this.render();
  }

  private render(): void {
    this.screen.render();
  }
}