import { onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { api, errorMessage, type Envelope, type MediaItem } from './api';
export function useMediaCatalog(initial: { kind?: string; status?: string } = {}) {
  const filters = reactive({ q: '', kind: initial.kind || '', status: initial.status || '', category: '', uncategorized: false, order: 'created:desc', lifecycle: 'active' });
  const items = ref<MediaItem[]>([]), nextCursor = ref<string>(), loading = ref(false), error = ref(''), indexing = ref(false), indexed = ref(0);
  const quota = ref<Envelope<unknown>['meta']['quota']>();
  let request: AbortController | undefined, sequence = 0, timer: ReturnType<typeof setTimeout> | undefined;
  async function load(more = false) {
    request?.abort(); const controller = new AbortController(); request = controller; const seq = ++sequence;
    loading.value = true; error.value = '';
    if (!more) { items.value = []; nextCursor.value = undefined; }
    try {
      let catalog = (await api.request<{ ready: boolean; processed: number }>('/admin/media/catalog', { signal: controller.signal })).data;
      while (!catalog.ready) {
        indexing.value = true; indexed.value = catalog.processed;
        catalog = (await api.request<typeof catalog>('/admin/media/catalog/advance', { method: 'POST', body: {}, signal: controller.signal })).data;
      }
      indexing.value = false;
      const [sort, direction] = filters.order.split(':');
      const query = new URLSearchParams({ q: filters.q.trim(), sort: sort!, direction: direction!, lifecycle: filters.lifecycle });
      for (const name of ['kind', 'status'] as const) if (filters[name]) query.set(name, filters[name]);
      if (filters.uncategorized || filters.category.trim()) query.set('category', filters.uncategorized ? '' : filters.category.trim());
      if (more && nextCursor.value) query.set('cursor', nextCursor.value);
      const result = await api.request<MediaItem[]>('/admin/media?' + query, { signal: controller.signal });
      if (seq !== sequence) return;
      const rows = more ? [...items.value, ...result.data] : result.data;
      items.value = [...new Map(rows.map(item => [item.id, item])).values()];
      nextCursor.value = result.meta.nextCursor || undefined; quota.value = result.meta.quota;
    } catch (e) { if (seq === sequence && !controller.signal.aborted) error.value = errorMessage(e); }
    finally { if (seq === sequence) { loading.value = false; indexing.value = false; } }
  }
  watch(filters, () => { clearTimeout(timer); request?.abort(); sequence++; loading.value = true; timer = setTimeout(() => void load(), 300); });
  onMounted(() => void load());
  onBeforeUnmount(() => { clearTimeout(timer); sequence++; request?.abort(); });
  return { filters, items, nextCursor, loading, error, indexing, indexed, quota, load };
}
