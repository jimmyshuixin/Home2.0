import { ApiError } from './api';

export function hashUpload(file: File, signal: AbortSignal, progress: (bytes: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException('上传已暂停。', 'AbortError')); return; }
    const worker = new Worker(new URL('./workers/file-hash.worker.ts', import.meta.url), { type: 'module' });
    const finish = () => { signal.removeEventListener('abort', abort); worker.terminate(); };
    const abort = () => { finish(); reject(new DOMException('上传已暂停。', 'AbortError')); };
    signal.addEventListener('abort', abort, { once: true });
    worker.onerror = () => { finish(); reject(new Error('文件校验失败，请重试。')); };
    worker.onmessage = ({ data }) => {
      if (typeof data.progress === 'number') progress(data.progress);
      if (typeof data.digest === 'string') { finish(); resolve(data.digest); }
      else if (data.error) { finish(); reject(new Error(data.error)); }
    };
    worker.postMessage({ file });
  });
}

function delay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException('上传已暂停。', 'AbortError')); return; }
    const cancel = () => { clearTimeout(timer); reject(new DOMException('上传已暂停。', 'AbortError')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, ms);
    signal.addEventListener('abort', cancel, { once: true });
  });
}

/** Two bounded requests hide network round trips without flooding the free Worker. */
export async function transferParts(numbers: readonly number[], send: (part: number) => Promise<void>, signal: AbortSignal, wait = delay): Promise<void> {
  let cursor = 0, failure: unknown;
  const worker = async () => {
    while (!failure && cursor < numbers.length) {
      if (signal.aborted) throw new DOMException('上传已暂停。', 'AbortError');
      const part = numbers[cursor++]!;
      for (let attempt = 0; ; attempt++) {
        try { await send(part); break; }
        catch (error) {
          const transient = error instanceof ApiError && (error.status === 0 || error.status === 429 || error.status >= 500);
          if (!transient || attempt >= 2 || signal.aborted) { failure = error; throw error; }
          await wait(500 * 2 ** attempt, signal);
        }
      }
    }
  };
  // Wait for both in-flight requests before marking the queue paused or complete.
  const result = await Promise.allSettled([worker(), worker()]);
  const rejected = result.find(item => item.status === 'rejected');
  if (rejected?.status === 'rejected') throw rejected.reason;
}
