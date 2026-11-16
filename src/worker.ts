/// <reference lib="webworker" />
import { generate, type Job } from './core/generate';

export type WorkerRequest = Omit<Job, 'onProgress' | 'signal'>;
export type WorkerMessage =
  | { type: 'progress'; done: number; total: number }
  | { type: 'done'; bytes: Uint8Array; pageCount: number; warnings: string[] }
  | { type: 'error'; message: string };

const post = (msg: WorkerMessage, transfer: Transferable[] = []) => self.postMessage(msg, { transfer });

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  try {
    const res = await generate({ ...e.data, onProgress: (done, total) => post({ type: 'progress', done, total }) });
    post({ type: 'done', ...res }, [res.bytes.buffer]);
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
