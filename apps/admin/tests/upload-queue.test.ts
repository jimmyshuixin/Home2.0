import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ request: vi.fn(), hash: vi.fn() }));
vi.mock('../src/api', async () => ({ ...await vi.importActual('../src/api'), api: { request: mock.request } }));
vi.mock('../src/upload-transfer', () => ({ hashUpload: mock.hash, transferParts: async (numbers: number[], send: (number: number) => Promise<void>) => { for (const number of numbers) await send(number); } }));
let storage: Map<string, string>;
const media = (id: string, status = 'ready') => ({ id, kind: 'image', originalBytes: 5, status, variants: [] });
const file = (name = 'photo.jpg') => new File(['photo'], name, { type: 'image/jpeg' });
const settle = async () => { for (let index = 0; index < 500; index++) await Promise.resolve(); };
beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers(); mock.request.mockReset(); mock.hash.mockReset(); mock.hash.mockResolvedValue('a'.repeat(64)); storage = new Map();
  vi.stubGlobal('sessionStorage', { getItem: (key: string) => storage.get(key) || null, setItem: (key: string, value: string) => storage.set(key, value) });
  vi.stubGlobal('document', { visibilityState: 'visible', createElement: () => ({}) });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });
describe('bounded shared upload queue', () => {
  it('retains every resumed file beyond the old 20-entry cutoff and shares one queue across components', async () => {
    storage.set('xvyin-admin-upload-journal-v1', JSON.stringify(Array.from({ length: 45 }, (_, i) => ({ key: `key-${i}`, name: `${i}.jpg`, mime: 'image/jpeg', size: 5, sha256: 'a'.repeat(64), sent: 0, hashing: 0, state: 'uploading' }))));
    const { useUploadQueue } = await import('../src/useUploadQueue'); const queue = useUploadQueue();
    expect(queue.rows.value).toHaveLength(45); expect(queue.rows.value.every(row => row.state === 'paused' && !row.file)).toBe(true);
    expect(useUploadQueue().rows).toBe(queue.rows);
  });
  it('isolates invalid files, deduplicates completed files, and serializes simultaneous additions', async () => {
    let concurrent = 0, peak = 0;
    mock.hash.mockImplementation(async () => { concurrent++; peak = Math.max(peak, concurrent); await Promise.resolve(); concurrent--; return 'a'.repeat(64); });
    mock.request.mockResolvedValue({ data: media('existing') });
    const { useUploadQueue } = await import('../src/useUploadQueue'); const queue = useUploadQueue();
    queue.add([new File(['bad'], 'bad.exe'), file('first.jpg')]); useUploadQueue().add([file('second.jpg')]); await settle();
    expect(peak).toBe(1); expect(queue.rows.value.map(row => row.state)).toEqual(['paused', 'ready', 'ready']);
    expect(queue.rows.value.slice(1).every(row => row.reused && !row.file)).toBe(true);
  });
  it('caps server processing at three jobs and releases a slot only after a completion check', async () => {
    let starts = 0;
    mock.request.mockImplementation(async (path: string) => {
      if (path.includes('/duplicates?')) return { data: null };
      if (path === '/admin/media/uploads') { starts++; return { data: { uploadId: `upload-${starts}`, assetId: `asset-${starts}`, state: 'uploading', partSize: 5, totalParts: 1, parts: [] } }; }
      if (path.includes('/parts/')) return { data: { bytes: 5 } };
      if (path.endsWith('/complete')) return { data: {} };
      return { data: media(path.split('/').pop()!) };
    });
    const { useUploadQueue } = await import('../src/useUploadQueue'); const queue = useUploadQueue();
    queue.add(Array.from({ length: 5 }, (_, i) => file(`${i}.jpg`))); await settle();
    expect(starts).toBe(3); expect(queue.rows.value.map(row => row.state)).toEqual(['processing', 'processing', 'processing', 'queued', 'queued']);
    expect(queue.rows.value.slice(0, 3).every(row => !row.file)).toBe(true);
    await vi.advanceTimersByTimeAsync(3500); await settle(); expect(starts).toBe(4);
    expect(queue.rows.value.filter(row => row.state === 'processing')).toHaveLength(3);
  });
  it('pauses the batch on expired authentication instead of sending every remaining file', async () => {
    const { ApiError } = await import('../src/api'); mock.request.mockRejectedValue(new ApiError(401, 'SESSION_EXPIRED', 'expired'));
    const { useUploadQueue } = await import('../src/useUploadQueue'); const queue = useUploadQueue();
    queue.add([file('first.jpg'), file('second.jpg')]); await settle();
    expect(queue.paused.value).toBe(true); expect(mock.request).toHaveBeenCalledTimes(1); expect(queue.rows.value[1]?.state).toBe('queued');
    await vi.advanceTimersByTimeAsync(70_000); expect(mock.request).toHaveBeenCalledTimes(1);
  });
  it('keeps only 100 pending files and reports omitted selections', async () => {
    const { useUploadQueue } = await import('../src/useUploadQueue'); const queue = useUploadQueue(); queue.pause();
    const keys = queue.add(Array.from({ length: 105 }, (_, i) => file(`${i}.jpg`)));
    expect(keys).toHaveLength(100); expect(queue.rows.value).toHaveLength(100); expect(queue.issue.value).toContain('剩余 5'); expect(mock.hash).not.toHaveBeenCalled();
  });
  it.each([false, true])('continues the interrupted file before the rest of the queue (immediate=%s)', async immediate => {
    mock.hash.mockImplementationOnce((_file: File, signal: AbortSignal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('Paused', 'AbortError')), { once: true });
    }));
    mock.request.mockResolvedValue({ data: media('existing') });
    const { useUploadQueue } = await import('../src/useUploadQueue'); const queue = useUploadQueue();
    queue.add([file('first.jpg'), file('second.jpg')]);
    expect(queue.rows.value[0]?.state).toBe('hashing');
    queue.pause();
    if (!immediate) { await settle(); expect(queue.rows.value[0]?.state).toBe('paused'); }
    queue.continue(); await settle();
    expect(queue.rows.value.map(row => row.state)).toEqual(['ready', 'ready']);
    expect(mock.hash.mock.calls.map(call => call[0].name)).toEqual(['first.jpg', 'first.jpg', 'second.jpg']);
    expect(mock.request).toHaveBeenCalledTimes(2);
    expect(queue.running.value).toBe(false);
  });
  it('retries the authentication-interrupted file after continuing, without retrying a file error', async () => {
    const { ApiError } = await import('../src/api');
    mock.hash.mockRejectedValueOnce(new Error('File cannot be read'));
    mock.request.mockRejectedValueOnce(new ApiError(401, 'SESSION_EXPIRED', 'expired')).mockResolvedValue({ data: media('existing') });
    const { useUploadQueue } = await import('../src/useUploadQueue'); const queue = useUploadQueue();
    queue.add([file('broken.jpg'), file('auth.jpg'), file('next.jpg')]); await settle();
    expect(queue.rows.value.map(row => row.state)).toEqual(['paused', 'paused', 'queued']);
    queue.continue(); await settle();
    expect(queue.rows.value.map(row => row.state)).toEqual(['paused', 'ready', 'ready']);
    expect(queue.rows.value[0]?.error).toBe('File cannot be read');
    expect(mock.hash.mock.calls.map(call => call[0].name)).toEqual(['broken.jpg', 'auth.jpg', 'next.jpg']);
    expect(mock.request).toHaveBeenCalledTimes(3);
  });
  it('does not resume a persisted pause until the original file is selected again', async () => {
    storage.set('xvyin-admin-upload-journal-v2', JSON.stringify([{ key: 'restored', name: 'photo.jpg', mime: 'image/jpeg', size: 5, sent: 0, hashing: 0, state: 'paused', resumeWithQueue: true }]));
    const { useUploadQueue } = await import('../src/useUploadQueue'); const queue = useUploadQueue();
    queue.continue(); await settle();
    expect(queue.rows.value[0]?.state).toBe('paused');
    expect(mock.hash).not.toHaveBeenCalled(); expect(mock.request).not.toHaveBeenCalled();
  });
  it('continues an interrupted multipart upload using its existing session and confirmed parts', async () => {
    let secondPartAttempts = 0;
    const session = { uploadId: 'upload-one', assetId: 'asset-one', state: 'uploading', partSize: 3, totalParts: 2, parts: [] };
    mock.request.mockImplementation(async (path: string, options: { signal?: AbortSignal } = {}) => {
      if (path.includes('/duplicates?')) return { data: null };
      if (path === '/admin/media/uploads') return { data: session };
      if (path === '/admin/media/uploads/upload-one') return { data: { ...session, parts: [{ partNumber: 1, bytes: 3 }] } };
      if (path.endsWith('/parts/1')) return { data: { bytes: 3 } };
      if (path.endsWith('/parts/2')) {
        secondPartAttempts++;
        if (secondPartAttempts === 1) return new Promise((_resolve, reject) => options.signal?.addEventListener('abort', () => reject(new DOMException('Paused', 'AbortError')), { once: true }));
        return { data: { bytes: 2 } };
      }
      if (path.endsWith('/complete')) return { data: {} };
      return { data: media('asset-one') };
    });
    const { useUploadQueue } = await import('../src/useUploadQueue'); const queue = useUploadQueue();
    queue.add([file()]); await settle();
    expect(queue.rows.value[0]?.sent).toBe(3);
    queue.pause(); await settle(); queue.continue(); await settle();
    expect(queue.rows.value[0]?.state).toBe('processing'); expect(queue.rows.value[0]?.sent).toBe(5);
    expect(mock.request.mock.calls.filter(call => call[0].includes('/parts/')).map(call => call[0])).toEqual([
      '/admin/media/uploads/upload-one/parts/1', '/admin/media/uploads/upload-one/parts/2', '/admin/media/uploads/upload-one/parts/2',
    ]);
    expect(mock.request.mock.calls.filter(call => call[0] === '/admin/media/uploads')).toHaveLength(1);
    expect(mock.hash).toHaveBeenCalledTimes(1);
  });
});
