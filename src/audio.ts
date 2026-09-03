import { spawn } from 'node:child_process';
import { SAMPLE_RATE } from './config.js';

export type AudioStreamRole = 'rx' | 'tx';

export interface AudioIdentity {
  /** Stable, PipeWire-safe identifier for this qnr process. */
  id: string;
  /** Human-readable station label shown by PipeWire clients such as Pavucontrol. */
  label: string;
}

export interface AudioStreamOptions {
  target?: string;
  identity?: AudioIdentity;
  role?: AudioStreamRole;
  onError?: (error: Error) => void;
}

/** Gives simultaneously running qnr processes distinct, human-readable PipeWire stream labels. */
export function createAudioIdentity(now = new Date(), pid = process.pid): AudioIdentity {
  const two = (value: number): string => value.toString().padStart(2, '0');
  const stamp = `${two(now.getHours())}:${two(now.getMinutes())}`;
  return {
    id: `qnr-${stamp.replace(':', '')}-${pid}`,
    label: `QNR ${stamp} #${pid}`,
  };
}

export interface AudioNode {
  id: number;
  name: string;
  description: string;
  mediaClass: string;
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args);
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err || `${cmd} exited ${code}`))));
  });
}

export async function listAudioNodes(): Promise<AudioNode[]> {
  const raw = await run('pw-dump', []);
  const objects = JSON.parse(raw) as Array<Record<string, any>>;
  return objects
    .filter((o) => o.type === 'PipeWire:Interface:Node')
    .map((o) => ({ id: o.id as number, props: o.info?.props ?? {} }))
    .filter((o) => typeof o.props['media.class'] === 'string' && o.props['media.class'].startsWith('Audio/'))
    .map(({ id, props }) => ({
      id,
      name: String(props['node.name'] ?? `node-${id}`),
      description: String(props['node.description'] ?? props['node.nick'] ?? props['node.name'] ?? `node-${id}`),
      mediaClass: String(props['media.class']),
    }));
}

const quotedProperty = (value: string): string => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;

function properties(identity: AudioIdentity | undefined, role: AudioStreamRole): string | undefined {
  if (!identity) return undefined;
  const label = `${identity.label} ${role.toUpperCase()}`;
  return [
    `node.name=${quotedProperty(`${identity.id}-${role}`)}`,
    `node.description=${quotedProperty(label)}`,
    `media.name=${quotedProperty(label)}`,
    `application.name=${quotedProperty(identity.label)}`,
    'application.icon-name="audio-radio"',
    'node.pause-on-idle=false',
  ].join(' ');
}

const rawArgs = (opts: AudioStreamOptions = {}, defaultRole: AudioStreamRole): string[] => [
  '--raw',
  '--format=f32',
  `--rate=${SAMPLE_RATE}`,
  '--channels=1',
  ...(opts.target ? [`--target=${opts.target}`] : []),
  ...(properties(opts.identity, opts.role ?? defaultRole) ? ['--properties', properties(opts.identity, opts.role ?? defaultRole)!] : []),
  '-',
];

export function playSamples(samples: Float32Array, opts: AudioStreamOptions | string = {}): Promise<void> {
  const stream = typeof opts === 'string' ? { target: opts } : opts;
  return new Promise((resolve, reject) => {
    const child = spawn('pw-play', rawArgs(stream, 'tx'), { stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (error) => {
      stream.onError?.(error);
      reject(error);
    });
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err || `pw-play exited ${code}`))));
    child.stdin.end(Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength));
  });
}

export interface PersistentPlayback {
  /** Writes a burst to the persistent PipeWire stream, retaining the node between transmissions. */
  play(samples: Float32Array): Promise<void>;
  stop(): void;
}

/**
 * Keeps a named playback node alive for the life of a station. An open raw PipeWire stream
 * produces silence while no samples are queued, which is exactly what a continuously keyed SSB
 * transmitter needs between packets.
 */
export function startPersistentPlayback(opts: AudioStreamOptions = {}): PersistentPlayback {
  const child = spawn('pw-play', rawArgs({ ...opts, role: 'tx' }, 'tx'), { stdio: ['pipe', 'ignore', 'pipe'] });
  let err = '';
  let stopped = false;
  let failure: Error | undefined;

  const fail = (error: Error): void => {
    if (failure) return;
    failure = error;
    opts.onError?.(error);
  };

  child.stderr.on('data', (data) => (err += data));
  child.on('error', fail);
  child.stdin.on('error', fail);
  child.on('close', (code) => {
    if (!stopped && code !== 0 && code !== null) fail(new Error(err || `pw-play exited ${code}`));
  });

  return {
    async play(samples: Float32Array): Promise<void> {
      if (failure) throw failure;
      if (stopped) throw new Error('persistent playback has stopped');
      await new Promise<void>((resolve, reject) => {
        child.stdin.write(Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength), (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      // pw-play owns the hardware clock; waiting for the burst duration preserves its slot.
      await new Promise<void>((resolve) => setTimeout(resolve, (samples.length / SAMPLE_RATE) * 1000));
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      child.stdin.end();
      child.kill('SIGTERM');
    },
  };
}

export interface Capture {
  stop(): void;
}

export function startCapture(
  onSamples: (samples: Float32Array) => void,
  opts: AudioStreamOptions = {}
): Capture {
  const child = spawn('pw-record', rawArgs(opts, 'rx'), { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  let leftover = Buffer.alloc(0);

  child.stderr.on('data', (d) => (err += d));
  child.on('error', (e) => opts.onError?.(e));
  child.on('close', (code) => {
    if (code !== 0 && code !== null) opts.onError?.(new Error(err || `pw-record exited ${code}`));
  });

  child.stdout.on('data', (chunk: Buffer) => {
    const buf = leftover.length ? Buffer.concat([leftover, chunk]) : chunk;
    const usable = buf.length - (buf.length % 4);
    leftover = usable === buf.length ? Buffer.alloc(0) : Buffer.from(buf.subarray(usable));
    if (usable === 0) return;

    const samples = new Float32Array(usable / 4);
    for (let i = 0; i < samples.length; i++) samples[i] = buf.readFloatLE(i * 4);
    onSamples(samples);
  });

  return { stop: () => child.kill('SIGTERM') };
}
