import { parentPort } from 'node:worker_threads';
import { runFoldCell, type FoldTask } from './foldTrial.js';

parentPort?.on('message', (msg: { id: number; task: FoldTask }) => {
  parentPort?.postMessage({ id: msg.id, result: runFoldCell(msg.task) });
});
