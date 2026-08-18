import { parentPort } from 'node:worker_threads';
import { runCell, type CellTask } from './trial.js';

parentPort?.on('message', (msg: { id: number; task: CellTask }) => {
  parentPort?.postMessage({ id: msg.id, ok: runCell(msg.task) });
});
