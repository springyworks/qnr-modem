import { parentPort } from 'node:worker_threads';
import { foldDecode } from './fold.js';
import { DECODE_OPTIONS } from './protocol.js';

parentPort?.on('message', (samples: Float32Array) => {
  parentPort?.postMessage(foldDecode(samples, DECODE_OPTIONS).trimEnd());
});
