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

/** Reads PCM WAV, mixing to mono by taking the first channel. */
export function readWav(path: string): WavData {
  const buf = readFileSync(path);
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') {
    throw new Error(`${path} is not a RIFF WAV file`);
  }

  let sampleRate = 48000;
  let channels = 1;
  let bits = 16;
  let format = 1;
  let dataStart = -1;
  let dataLength = 0;

  let pos = 12;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === 'fmt ') {
      format = buf.readUInt16LE(pos + 8);
      channels = buf.readUInt16LE(pos + 10);
      sampleRate = buf.readUInt32LE(pos + 12);
      bits = buf.readUInt16LE(pos + 22);
      // WAVE_FORMAT_EXTENSIBLE carries the real format in its sub-format GUID.
      if (format === 0xfffe && size >= 40) format = buf.readUInt16LE(pos + 32);
    } else if (id === 'data') {
      dataStart = pos + 8;
      dataLength = Math.min(size, buf.length - dataStart);
      break;
    }
    pos += 8 + size + (size % 2);
  }

  if (dataStart < 0) throw new Error(`${path} has no data chunk`);

  const bytes = bits / 8;
  // Recorders that feed this modem emit 8/16/24/32-bit PCM or 32-bit float; accept all of them.
  const read = readerFor(format, bits);
  if (!read) throw new Error(`${path} is ${bits}-bit format ${format}, which is not supported`);

  const frames = Math.floor(dataLength / bytes / channels);
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i++) samples[i] = read(buf, dataStart + i * bytes * channels);
  return { samples, sampleRate };
}

type SampleReader = (buf: Buffer, at: number) => number;

function readerFor(format: number, bits: number): SampleReader | undefined {
  if (format === 3 && bits === 32) return (buf, at) => buf.readFloatLE(at);
  if (format === 3 && bits === 64) return (buf, at) => buf.readDoubleLE(at);
  if (format !== 1) return undefined;
  if (bits === 8) return (buf, at) => (buf.readUInt8(at) - 128) / 128;
  if (bits === 16) return (buf, at) => buf.readInt16LE(at) / 32768;
  if (bits === 24) return (buf, at) => buf.readIntLE(at, 3) / 8388608;
  if (bits === 32) return (buf, at) => buf.readInt32LE(at) / 2147483648;
  return undefined;
}
