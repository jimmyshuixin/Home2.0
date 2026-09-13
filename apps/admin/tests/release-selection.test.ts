import { describe, expect, it } from 'vitest';
import { changeKey, isPending, releaseNeedsPolling, releaseSignature, selectionChanges, type ReleaseCandidate } from '../src/releases';
const candidate = (id: string, changeKind: ReleaseCandidate['changeKind'], collection: ReleaseCandidate['collection'] = 'creations'): ReleaseCandidate => ({ collection, id, title: id, version: 2, draftRevisionId: `draft-${id}`, publishedRevisionId: null, changeKind, actions: ['publish', 'hide'] });
describe('administrator release selection', () => {
  it('collects cross-module saved changes while leaving hidden and unchanged records unselected', () => {
    const items = [candidate('new', 'new'), candidate('updated', 'modified', 'albums'), candidate('hidden', 'hidden'), candidate('same', 'unchanged'), candidate('site', 'modified', 'settings')];
    const selected = Object.fromEntries(items.filter(isPending).map(item => [changeKey(item), 'publish' as const]));
    expect(selectionChanges(items, selected).map(item => changeKey(item))).toEqual(['creations/new', 'albums/updated', 'settings/site']);
    expect(selectionChanges(items, { ...selected, 'creations/hidden': 'publish' })).toHaveLength(4);
  });
  it('uses current versions and only actions allowed by the server', () => {
    const item = { ...candidate('site', 'modified', 'settings'), version: 9, actions: ['publish'] as const };
    expect(selectionChanges([{ ...item, actions: [...item.actions] }], { 'settings/site': 'hide' })).toEqual([]);
    expect(selectionChanges([{ ...item, actions: [...item.actions] }], { 'settings/site': 'publish' })[0]?.version).toBe(9);
  });
  it('keeps a request identity stable when selection order changes but separates newer drafts and public baselines', () => {
    const changes = selectionChanges([candidate('one', 'new'), candidate('two', 'modified', 'albums')], { 'creations/one': 'publish', 'albums/two': 'hide' });
    expect(releaseSignature(changes, 'baseline')).toBe(releaseSignature([...changes].reverse(), 'baseline'));
    expect(releaseSignature(changes, 'new-baseline')).not.toBe(releaseSignature(changes, 'baseline'));
    expect(releaseSignature(changes.map(item => ({ ...item, version: 3 })), 'baseline')).not.toBe(releaseSignature(changes, 'baseline'));
  });
  it('continues synchronization after the public pointer is live until every record is reconciled', () => {
    const changes = Array.from({ length: 25 }, (_, index) => ({ collection: 'creations', id: String(index), version: 1, action: 'publish' }));
    expect(releaseNeedsPolling({ id: 'batch', status: 'live', changes, reconciledRecords: 10 })).toBe(true);
    expect(releaseNeedsPolling({ id: 'batch', status: 'live', changes, reconciledRecords: 25, reconciliationPending: false })).toBe(false);
    expect(releaseNeedsPolling({ id: 'batch', status: 'failed' })).toBe(false);
  });
});
