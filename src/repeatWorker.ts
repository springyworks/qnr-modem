import { parentPort } from 'node:worker_threads';
import { runRepeatCell, type RepeatTask } from './repeatTrial.js';

parentPort?.on('message', (msg: { id: number; task: RepeatTask }) => {
  parentPort?.postMessage({ id: msg.id, result: runRepeatCell(msg.task) });
});
