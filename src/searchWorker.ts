import { parentPort } from 'node:worker_threads';
import { fillSpectrogram, syncSpectrogram, type SpectroGeometry } from './spectro.js';
import { scoreOffset, type TuneHit, type TuneOptions } from './tune.js';

export interface TuneTask {
  kind: 'tune';
  audio: SharedArrayBuffer;
  samples: number;
  geom: SpectroGeometry;
  offsets: number[];
  drifts: number[];
  tune: TuneOptions;
}

export interface SpectroTask {
  kind: 'spectro';
  audio: SharedArrayBuffer;
  samples: number;
  geom: SpectroGeometry;
  sampleRate: number;
  offsetHz: number;
  toneStart: number;
  toneEnd: number;
  out: SharedArrayBuffer;
}

export type SearchTask = TuneTask | SpectroTask;

parentPort?.on('message', (task: SearchTask) => {
  const audio = new Float32Array(task.audio, 0, task.samples);

  if (task.kind === 'tune') {
    const hits: TuneHit[] = task.offsets.map((offsetHz) =>
      scoreOffset(
        syncSpectrogram(audio, task.geom, task.tune.sampleRate, offsetHz),
        task.geom,
        offsetHz,
        task.tune,
        task.drifts
      )
    );
    parentPort?.postMessage(hits);
    return;
  }

  fillSpectrogram(
    audio,
    task.geom,
    task.sampleRate,
    task.offsetHz,
    task.toneStart,
    task.toneEnd,
    new Float64Array(task.out)
  );
  parentPort?.postMessage(task.toneEnd - task.toneStart);
});
