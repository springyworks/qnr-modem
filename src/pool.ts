import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';

export const workerCount = (): number =>
  Number(process.argv.find((a) => a.startsWith('--jobs='))?.slice(7) ?? availableParallelism());

/** Runs tasks across a persistent worker pool; results come back in task order. */
export function runTasks<T, R>(workerUrl: URL, tasks: T[]): Promise<R[]> {
  return new Promise((resolve, reject) => {
    if (tasks.length === 0) {
      resolve([]);
      return;
    }

    const results = new Array<R>(tasks.length);
    const size = Math.max(1, Math.min(workerCount(), tasks.length));
    const workers: Worker[] = [];
    let next = 0;
    let done = 0;

    const shutdown = (): void => {
      for (const w of workers) void w.terminate();
    };

    for (let i = 0; i < size; i++) {
      const worker = new Worker(workerUrl);
      workers.push(worker);

      const dispatch = (): void => {
        if (next >= tasks.length) {
          void worker.terminate();
          return;
        }
        const id = next++;
        worker.postMessage({ id, task: tasks[id] });
      };

      worker.on('message', (msg: { id: number } & Record<string, unknown>) => {
        results[msg.id] = (msg.result ?? msg.ok) as R;
        done++;
        if (done === tasks.length) {
          shutdown();
          resolve(results);
          return;
        }
        dispatch();
      });

      worker.on('error', (err) => {
        shutdown();
        reject(err);
      });

      dispatch();
    }
  });
}

export const CELL_WORKER = new URL('./worker.js', import.meta.url);
export const REPEAT_WORKER = new URL('./repeatWorker.js', import.meta.url);

export const runCells = (tasks: unknown[]): Promise<number[]> => runTasks<unknown, number>(CELL_WORKER, tasks);
