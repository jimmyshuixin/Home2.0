import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { PhotographyBackfill } from '../src/photography-backfill';
import { MemoryStore } from '../src/store/memory';
import type { MediaAsset } from '../src/media';
import type { AuthProvider } from '../src/auth';
import { createApi } from '../src/app';
import { ApiError } from '../src/errors';
import { sha256 } from '../src/security';

const now = Date.parse('2026-09-19T14:00:00Z'), codeSha = 'a'.repeat(40), origin = 'https://site.invalid';
let mf: Miniflare, bucket: R2Bucket, store: MemoryStore, backfill: PhotographyBackfill;
beforeAll(async () => { mf = new Miniflare({ ...convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response("test")}}', compatibilityDate: '2026-09-11', r2Buckets: ['MEDIA'] }), telemetry: { enabled: false }, cf: false }); bucket = await mf.getR2Bucket('MEDIA') as unknown as R2Bucket; });
beforeEach(() => { store = new MemoryStore(); backfill = new PhotographyBackfill(store, bucket, () => now); });
afterAll(async () => { await mf.dispose(); });
async function seed(id = 'photo', overrides: Partial<MediaAsset> = {}) {
  const source = new TextEncoder().encode(`private-original-${id}`), hash = await sha256(source), originalKey = `originals/${id}/source`;
  const asset: MediaAsset = { id, kind:'image', status:'ready', originalName:'private-camera-name.jpg', originalKey, originalBytes:source.length, expectedMime:'image/jpeg', createdAt:'2026-01-01T00:00:00Z', updatedAt:'2026-01-01T00:00:00Z', metadata:{kind:'image', detectedMime:'image/jpeg', bytes:source.length, sha256:hash, width:300,height:200}, variants:[{role:'large',key:`variants/${id}/large`,url:'/large',mime:'image/webp',bytes:8,sha256:'b'.repeat(64),width:300,height:200}], ...overrides };
  await bucket.put(originalKey,source); await bucket.put(`variants/${id}/large`,'existing');
  await store.transaction(async tx => { tx.put(`media/${id}`,asset); });
  return {asset,source,hash};
}
describe('metadata-only existing photo maintenance', () => {
  it('dispatches the fixed maintenance task only from an authenticated administrator with CSRF', async () => {
    const dispatchMedia=vi.fn(async()=>{});
    const auth: AuthProvider = {signIn:async()=>({uid:'admin',authTime:now/1000}),assertSession:async()=>{},changePassword:async()=>{},requestPasswordReset:async()=>{},confirmPasswordReset:async()=>({uid:'admin'}),revokeAllSessions:async()=>{}};
    const api=createApi({store,bucket,auth,now:()=>now,privacySalt:'test-only-salt-01234567890123456789',secureCookies:true,allowedOrigins:[origin],adminUsername:'test',codeSha,dispatchMedia});
    const session=await api.sessions.create({uid:'admin',authTime:now/1000}), path=origin+'/api/v1/admin/media/photography-backfill';
    const send=(headers:Record<string,string>)=>api.app.fetch(new Request(path,{method:'POST',headers:{origin,'content-type':'application/json',...headers},body:'{}'}));
    expect((await send({})).status).toBe(401);
    expect((await send({cookie:session.cookie.split(';')[0]!})).status).toBe(403);
    expect(dispatchMedia).not.toHaveBeenCalled();
    expect((await send({cookie:session.cookie.split(';')[0]!,'x-csrf-token':session.session.csrfToken})).status).toBe(200);
    expect(dispatchMedia).toHaveBeenCalledExactlyOnceWith('maintenance-photography-v1');
  });
  it('streams a verified private original and only adds metadata, preserving quota, drafts and all object bytes', async () => {
    const {asset,hash,source} = await seed();
    await store.transaction(async tx => { tx.put('system/media_quota',{usedBytes:123,reservedBytes:7}); tx.put('albums/draft',{title:'unsaved unpublished content'}); });
    const original = await bucket.head(asset.originalKey), derivative = await bucket.head(asset.variants[0]!.key);
    const stream = await backfill.source(asset.id); expect(stream.headers.get('cache-control')).toBe('private, no-store'); expect(new Uint8Array(await stream.arrayBuffer())).toEqual(source);
    expect(await backfill.complete(asset.id,{sha256:hash,photography:{cameraModel:'ILCE-7M4',iso:400,takenAt:'2025-03-04T12:30:00',takenDate:'2025-03-04'}})).toEqual({status:'updated'});
    const updated = (await store.get<MediaAsset>(`media/${asset.id}`))!;
    expect(updated.metadata).toMatchObject({...asset.metadata,photography:{cameraModel:'ILCE-7M4',iso:400}});
    expect(updated.variants).toEqual(asset.variants); expect(updated.originalKey).toBe(asset.originalKey); expect(updated.originalBytes).toBe(asset.originalBytes); expect(updated.version).toBe(2);
    expect((await store.get<MediaAsset>(`media_catalog/${asset.id}`))!.metadata).toEqual(updated.metadata);
    expect((await bucket.head(asset.originalKey))!.etag).toBe(original!.etag); expect((await bucket.head(asset.variants[0]!.key))!.etag).toBe(derivative!.etag);
    expect(await store.get('system/media_quota')).toEqual({usedBytes:123,reservedBytes:7}); expect(await store.get('albums/draft')).toEqual({title:'unsaved unpublished content'});
    expect(await backfill.complete(asset.id,{sha256:hash,photography:{cameraModel:'do not overwrite'}})).toEqual({status:'already_done'});
    expect(await store.get(`media/${asset.id}`)).toEqual(updated);
  });
  it('marks absent EXIF once without inventing values and paginates even a fully skipped page', async () => {
    for(let i=0;i<22;i++) await seed(`photo-${String(i).padStart(2,'0')}`, i<20?{status:'failed'}:{});
    const first = await backfill.page(); expect(first.scanned).toBe(20); expect(first.items).toEqual([]); expect(first.nextCursor).toBeTruthy();
    const second = await backfill.page(first.nextCursor!); expect(second.scanned).toBe(2); expect(second.items).toHaveLength(2); expect(second.nextCursor).toBeNull();
    const item=second.items[0]!; expect(Object.keys(item).sort()).toEqual(['bytes','id','mime','sha256','sourceUrl']);
    expect(await backfill.complete(item.id,{sha256:item.sha256,photography:null})).toEqual({status:'no_exif'});
    expect(await backfill.complete(item.id,{sha256:item.sha256,photography:null})).toEqual({status:'already_done'});
    const updated = (await store.get<MediaAsset>(`media/${item.id}`))!; expect(updated.metadata).not.toHaveProperty('photography'); expect(updated.photographyBackfill?.status).toBe('no_exif');
    expect((await backfill.page(first.nextCursor!)).items).toHaveLength(1);
  });
  it('rejects private fields, stale hashes, missing originals and lifecycle races', async () => {
    const {asset,hash}=await seed();
    await expect(backfill.complete(asset.id,{sha256:hash,photography:{cameraModel:'camera',gps:'private'}})).rejects.toHaveProperty('name','ZodError');
    await expect(backfill.complete(asset.id,{sha256:hash,photography:{}})).rejects.toHaveProperty('name','ZodError');
    await expect(backfill.complete(asset.id,{sha256:'f'.repeat(64),photography:{iso:100}})).rejects.toMatchObject({code:'ORIGINAL_MISMATCH'});
    await bucket.put(asset.originalKey,'changed'); await expect(backfill.source(asset.id)).rejects.toMatchObject({code:'ORIGINAL_MISMATCH'});
    await store.transaction(async tx=>{tx.put(`media/${asset.id}`,{...asset,lifecycle:'trash'});});
    await expect(backfill.complete(asset.id,{sha256:hash,photography:{iso:100}})).rejects.toMatchObject({code:'PHOTO_NOT_READY'});
    expect((await backfill.page()).items).toEqual([]);
  });
  it('requires authenticated current-revision runner for every maintenance endpoint', async () => {
    const {hash}=await seed();
    const api=createApi({store,bucket,auth:{} as AuthProvider,now:()=>now,privacySalt:'test-only-salt-01234567890123456789',secureCookies:true,allowedOrigins:[origin],adminUsername:'test',codeSha,
      verifyRunner:async request=>{const auth=request.headers.get('authorization');if(!['Bearer approved','Bearer old'].includes(auth || ''))throw new ApiError('RUNNER_UNAUTHORIZED',403,'denied'); return {runId:'github-test',codeSha:auth==='Bearer old'?'b'.repeat(40):codeSha};}});
    for(const path of ['/api/v1/internal/photography','/api/v1/internal/photography/photo/source','/api/v1/internal/photography/photo/complete']){
      const method=path.endsWith('/complete')?'POST':'GET', body=method==='POST'?JSON.stringify({sha256:hash,photography:{iso:100}}):undefined;
      for(const authorization of [undefined,'Bearer invalid','Bearer old']){
        const response=await api.app.fetch(new Request(origin+path,{method,headers:{origin,...(authorization?{authorization}:{})},body})); expect([401,403]).toContain(response.status);
      }
      const response=await api.app.fetch(new Request(origin+path,{method,headers:{authorization:'Bearer approved','content-type':'application/json'},body})); expect(response.status).toBe(200);
    }
  });
});
