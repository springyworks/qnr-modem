import { readFileSync, writeFileSync } from 'node:fs';

export function writeWav16(path: string, samples: Float32Array, sampleRate: number): void {
  let peak = 0;
  for (const v of samples) peak = Math.max(peak, Math.abs(v));
  const scale = peak > 0 ? 0.89 / peak : 1;

  const header = Buffer.alloc(44);
  const dataBytes = samples.length * 2;
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataBytes, 40);

  const pcm = Buffer.alloc(dataBytes);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]! * scale));
    pcm.writeInt16LE(Math.round(v * 32767), i * 2);
  }

  writeFileSync(path, Buffer.concat([header, pcm]));
}

export interface WavData {
  samples: Float32Array;
  sampleRate: number;
}

/** Reads 16-bit PCM WAV, mixing to mono by taking the first channel. */
export function readWav16(path: string): WavData {
  const buf = readFileSync(path);
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') {
    throw new Error(`${path} is not a RIFF WAV file`);
  }

  let sampleRate = 48000;
  let channels = 1;
  let bits = 16;
  let dataStart = -1;
  let dataLength = 0;

  let pos = 12;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(pos + 10);
      sampleRate = buf.readUInt32LE(pos + 12);
      bits = buf.readUInt16LE(pos + 22);
    } else if (id === 'data') {
      dataStart = pos + 8;
      dataLength = Math.min(size, buf.length - dataStart);
      break;
    }
    pos += 8 + size + (size % 2);
  }

  if (dataStart < 0) throw new Error(`${path} has no data chunk`);
  if (bits !== 16) throw new Error(`${path} is ${bits}-bit; only 16-bit PCM is supported`);

  const frames = Math.floor(dataLength / 2 / channels);
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    samples[i] = buf.readInt16LE(dataStart + i * 2 * channels) / 32768;
  }
  return { samples, sampleRate };
}
