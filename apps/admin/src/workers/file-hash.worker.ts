import { sha256 } from '@noble/hashes/sha2.js';

// Structured cloning a File keeps the large input out of the UI thread's heap.
self.addEventListener('message', async (event: MessageEvent<{ file: File }>) => {
  try {
    const file = event.data.file, hash = sha256.create(), step = 5 * 1024 * 1024;
    for (let start = 0; start < file.size; start += step) {
      hash.update(new Uint8Array(await file.slice(start, start + step).arrayBuffer()));
      self.postMessage({ progress: Math.min(file.size, start + step) });
    }
    self.postMessage({ digest: Array.from(hash.digest(), byte => byte.toString(16).padStart(2, '0')).join('') });
  } catch { self.postMessage({ error: '文件校验失败，请重新选择文件。' }); }
});
