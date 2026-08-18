import { spawn } from 'node:child_process';
import { SAMPLE_RATE } from './config.js';

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

const rawArgs = (target?: string): string[] => [
  '--raw',
  '--format=f32',
  `--rate=${SAMPLE_RATE}`,
  '--channels=1',
  ...(target ? [`--target=${target}`] : []),
  '-',
];

export function playSamples(samples: Float32Array, target?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('pw-play', rawArgs(target), { stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err || `pw-play exited ${code}`))));
    child.stdin.end(Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength));
  });
}

export interface Capture {
  stop(): void;
}

export function startCapture(
  onSamples: (samples: Float32Array) => void,
  opts: { target?: string; onError?: (e: Error) => void } = {}
): Capture {
  const child = spawn('pw-record', rawArgs(opts.target), { stdio: ['ignore', 'pipe', 'pipe'] });
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
