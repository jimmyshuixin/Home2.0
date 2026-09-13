import { describe, it, expect } from 'vitest';
import { ApiError } from '../src/api';
import { transferParts } from '../src/upload-transfer';

describe('bounded resumable upload transfer', () => {
  it('uses at most two requests and sends each missing part once', async () => {
    let active = 0, peak = 0; const sent: number[] = [];
    await transferParts([2, 4, 5, 6], async part => {
      active++; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 2)); sent.push(part); active--;
    }, new AbortController().signal);
    expect(peak).toBe(2); expect(sent.sort()).toEqual([2, 4, 5, 6]);
  });
  it('retries transport errors without retrying validation errors', async () => {
    const attempts = new Map<number, number>();
    await transferParts([1, 2], async part => {
      const count = (attempts.get(part) || 0) + 1; attempts.set(part, count);
      if (part === 1 && count < 3) throw new ApiError(503, 'UNAVAILABLE', 'Temporary');
    }, new AbortController().signal, async () => {});
    expect(attempts.get(1)).toBe(3); expect(attempts.get(2)).toBe(1);
    let invalidAttempts = 0;
    await expect(transferParts([1], async () => { invalidAttempts++; throw new ApiError(422, 'INVALID', 'Invalid'); }, new AbortController().signal)).rejects.toMatchObject({ status: 422 });
    expect(invalidAttempts).toBe(1);
  });
  it('settles already-started requests before reporting a failed batch', async () => {
    let completed = false;
    await expect(transferParts([1, 2, 3], async part => {
      if (part === 1) throw new ApiError(422, 'INVALID', 'Invalid');
      await new Promise(resolve => setTimeout(resolve, 5)); completed = true;
    }, new AbortController().signal)).rejects.toThrow('Invalid');
    expect(completed).toBe(true);
  });
});
