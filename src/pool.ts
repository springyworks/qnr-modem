import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';

/** One core is left for the shell, the audio capture and the OS, so the box stays usable. */
export const workerCount = (): number => {
  const override = process.argv.find((a) => a.startsWith('--jobs='))?.slice(7);
  if (override) return Math.max(1, Number(override) || 1);
  return Math.max(1, availableParallelism() - 1);
};

/**
 * Decoder threads for a station that is also playing and capturing audio. The offline default
 * (cores - 1) leaves nothing for the main thread to feed PipeWire with, and the outgoing burst
 * audibly breaks up while a fold is running, so a live station gives up two more cores.
 * `--jobs=N` still overrides.
 */
export const liveWorkerCount = (): number => {
  const override = process.argv.find((a) => a.startsWith('--jobs='))?.slice(7);
  if (override) return Math.max(1, Number(override) || 1);
  return Math.max(1, availableParallelism() - 3);
};

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

/**
 * Long-lived pool for the receiver, which decodes the same audio again every few seconds.
 * Workers are kept warm so a decode pass never pays thread startup or JIT warm-up twice.
 */
export class WorkerPool {
  private readonly workers: Worker[] = [];
  private readonly free: Worker[] = [];
  private readonly waiting: Array<(w: Worker) => void> = [];

  constructor(
    private readonly url: URL,
    readonly size: number = workerCount()
  ) {}

  private acquire(): Promise<Worker> {
    const idle = this.free.pop();
    if (idle) return Promise.resolve(idle);
    if (this.workers.length < Math.max(1, this.size)) {
      const worker = new Worker(this.url);
      this.workers.push(worker);
      return Promise.resolve(worker);
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  private release(worker: Worker): void {
    const next = this.waiting.shift();
    if (next) next(worker);
    else this.free.push(worker);
  }

  async run<T, R>(task: T): Promise<R> {
    const worker = await this.acquire();
    try {
      return await new Promise<R>((resolve, reject) => {
        const done = (): void => {
          worker.off('message', onMessage);
          worker.off('error', onError);
        };
        const onMessage = (result: R): void => {
          done();
          resolve(result);
        };
        const onError = (err: Error): void => {
          done();
          reject(err);
        };
        worker.on('message', onMessage);
        worker.on('error', onError);
        worker.postMessage(task);
      });
    } finally {
      this.release(worker);
    }
  }

  /** Concurrency is bounded by the pool, so this can be handed the whole task list at once. */
  map<T, R>(tasks: T[]): Promise<R[]> {
    return Promise.all(tasks.map((task) => this.run<T, R>(task)));
  }

  close(): void {
    for (const worker of this.workers) void worker.terminate();
    this.workers.length = 0;
    this.free.length = 0;
    this.waiting.length = 0;
  }
}

/** Splits a list into at most `parts` contiguous chunks, so every worker gets one message. */
export function chunk<T>(items: T[], parts: number): T[][] {
  const n = Math.max(1, Math.min(parts, items.length));
  const out: T[][] = [];
  for (let i = 0; i < n; i++) {
    out.push(items.slice(Math.floor((i * items.length) / n), Math.floor(((i + 1) * items.length) / n)));
  }
  return out.filter((c) => c.length > 0);
}

