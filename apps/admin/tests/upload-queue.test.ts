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
});
