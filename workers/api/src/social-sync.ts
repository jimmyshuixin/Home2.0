import { z } from 'zod';
import { BilibiliProfileSchema, GitHubProfileSchema, SocialSyncInputSchema, type BilibiliProfile, type GitHubProfile, type SocialSyncClaim, type SocialSyncResult } from '@xvyin/contracts';
import type { Store } from './store/types';
import type { SocialSyncIdentity } from './social-sync-auth';
import { assert } from './errors';
import { sha256 } from './security';
import { cacheRead, cacheWrite, type PublicReadCache } from './public-read-cache';

const HOUR = 3600_000, LEASE = 15 * 60_000, CONTROL = 'social_sync/control';
const identitySchema = z.object({ runId: z.string().regex(/^github-[1-9]\d{0,24}$/u), runAttempt: z.string().regex(/^[1-9]\d{0,8}$/u), codeSha: z.string().regex(/^[a-f0-9]{40}$/u) }).strict();
const resultSchema = z.object({ imported: z.literal(true), bilibili: z.enum(['updated', 'retained']), github: z.enum(['updated', 'retained']) }).strict();
const controlSchema = z.object({
  claimId: z.uuid(), identity: identitySchema, hour: z.number().int().nonnegative(), startedAt: z.number().int().nonnegative(), expiresAt: z.number().int().nonnegative(),
  digest: z.string().regex(/^[a-f0-9]{64}$/u).nullable(), result: resultSchema.nullable(),
}).strict();
type Control = z.infer<typeof controlSchema>;
type Provider = 'bilibili' | 'github';
type Profile = BilibiliProfile | GitHubProfile;
interface PublicRecord { profile: Profile | null; lastAttemptAt: string; lastError: string | null }
const path = (provider: Provider) => `social_public/${provider}`;
const identityMatches = (a: SocialSyncIdentity, b: SocialSyncIdentity) => a.runId === b.runId && a.runAttempt === b.runAttempt && a.codeSha === b.codeSha;

function validProfile(provider: Provider, raw: unknown, now: number): Profile | null {
  const parsed = provider === 'bilibili' ? BilibiliProfileSchema.safeParse(raw) : GitHubProfileSchema.safeParse(raw);
  if (!parsed.success || !parsed.data.updatedAt || Date.parse(parsed.data.updatedAt) > now || parsed.data.status === 'unavailable') return null;
  const profile = parsed.data;
  const sectionAt = 'uid' in profile ? profile.worksUpdatedAt : profile.repositoriesUpdatedAt;
  const section = 'uid' in profile ? profile.works : profile.repositories;
  if ((section !== undefined && !sectionAt) || (sectionAt && (!section || Date.parse(sectionAt) > now))) return null;
  if ('uid' in profile && profile.works?.some(work => work.url !== `https://www.bilibili.com/video/${work.bvid}/` || (work.publishedAt && Date.parse(work.publishedAt) > now))) return null;
  if ('uid' in profile && profile.works && new Set(profile.works.map(work => work.bvid)).size !== profile.works.length) return null;
  if ('id' in profile && profile.repositories?.some(repo => repo.pushedAt && Date.parse(repo.pushedAt) > now)) return null;
  return profile;
}
function aged(profile: Profile, now: number): Profile {
  const age = now - Date.parse(profile.updatedAt!);
  return { ...profile, status: age < HOUR ? 'fresh' : age < 24 * HOUR ? 'stale' : 'snapshot' };
}
function capturedDuringClaim(profile: Profile, claim: Control, now: number): void {
  const times = [profile.updatedAt, 'uid' in profile ? profile.worksUpdatedAt : profile.repositoriesUpdatedAt].filter((value): value is string => value !== undefined && value !== null);
  assert(times.every(value => Date.parse(value) >= claim.startedAt && Date.parse(value) <= now), 'SOCIAL_SYNC_CAPTURE_TIME', 422, '资料采集时间不在本次同步期间');
}
function mergeSection(incoming: Profile, previous: Profile | null): Profile {
  if ('uid' in incoming && previous && 'uid' in previous && incoming.works === undefined && previous.works !== undefined) return { ...incoming, works: previous.works, worksUpdatedAt: previous.worksUpdatedAt };
  if ('id' in incoming && previous && 'id' in previous && incoming.repositories === undefined && previous.repositories !== undefined) return { ...incoming, repositories: previous.repositories, repositoriesUpdatedAt: previous.repositoriesUpdatedAt };
  return incoming;
}

/** Public, credential-free snapshots imported by one fixed OIDC workflow. Three bounded documents; no per-run accumulation. */
export class SocialPublicSync {
  constructor(private readonly store: Store, private readonly now: () => number, private readonly cache?: PublicReadCache) {}

  async claim(rawIdentity: SocialSyncIdentity): Promise<SocialSyncClaim> {
    const identity = identitySchema.parse(rawIdentity), now = this.now(), hour = Math.floor(now / HOUR), claimId = crypto.randomUUID();
    return this.store.transaction(async tx => {
      const value = await tx.get<unknown>(CONTROL), previous = value === null ? null : controlSchema.parse(value);
      const nextAllowedAt = new Date((Math.max(hour, previous?.hour ?? hour) + 1) * HOUR).toISOString();
      if (previous && previous.hour >= hour) {
        if (previous.hour === hour && identityMatches(previous.identity, identity) && !previous.digest && previous.expiresAt > now) return { accepted: true, claimId: previous.claimId, expiresAt: new Date(previous.expiresAt).toISOString(), nextAllowedAt };
        return { accepted: false, nextAllowedAt };
      }
      // An already-finished run retry is not a new hourly collection, even across a bucket boundary.
      if (previous && identityMatches(previous.identity, identity)) return { accepted: false, nextAllowedAt };
      const current: Control = { claimId, identity, hour, startedAt: now, expiresAt: now + LEASE, digest: null, result: null };
      tx.put(CONTROL, current);
      return { accepted: true, claimId, expiresAt: new Date(current.expiresAt).toISOString(), nextAllowedAt };
    });
  }

  async import(rawIdentity: SocialSyncIdentity, rawInput: unknown): Promise<SocialSyncResult> {
    const identity = identitySchema.parse(rawIdentity), input = SocialSyncInputSchema.parse(rawInput), digest = await sha256(JSON.stringify(input)), now = this.now();
    return this.store.transaction(async tx => {
      const control = controlSchema.safeParse(await tx.get(CONTROL));
      assert(control.success && control.data.claimId === input.claimId && identityMatches(control.data.identity, identity), 'SOCIAL_SYNC_CLAIM_LOST', 409, '同步领取已失效');
      const claim = control.data;
      if (claim.digest) {
        assert(claim.digest === digest && claim.result, 'SOCIAL_SYNC_ALREADY_IMPORTED', 409, '本次同步已提交');
        return claim.result;
      }
      assert(claim.startedAt <= now && claim.expiresAt > now, 'SOCIAL_SYNC_CLAIM_EXPIRED', 409, '同步领取已过期');
      const storedBili = await tx.get<PublicRecord>(path('bilibili')), storedGitHub = await tx.get<PublicRecord>(path('github'));
      const result: SocialSyncResult = { imported: true, bilibili: 'retained', github: 'retained' };
      const writes: Array<[string, PublicRecord]> = [];
      for (const provider of ['bilibili', 'github'] as const) {
        const update = input[provider], stored = provider === 'bilibili' ? storedBili : storedGitHub;
        const previous = validProfile(provider, stored?.profile, now);
        let profile = previous;
        if (update.status === 'ok') {
          const incoming = validProfile(provider, update.profile, now);
          assert(incoming, 'SOCIAL_SYNC_INVALID_PROFILE', 422, '公开资料字段无效');
          capturedDuringClaim(incoming, claim, now);
          // Capture time, not receipt time, controls ordering. A late/old snapshot never wins.
          assert(!previous || Date.parse(incoming.updatedAt!) > Date.parse(previous.updatedAt!), 'SOCIAL_SYNC_OLD_SNAPSHOT', 409, '不能使用较旧资料覆盖已有资料');
          profile = mergeSection(incoming, previous); result[provider] = 'updated';
        }
        writes.push([path(provider), { profile, lastAttemptAt: new Date(now).toISOString(), lastError: update.status === 'failed' ? update.reason : null }]);
      }
      for (const [key, value] of writes) tx.put(key, value);
      tx.put(CONTROL, { ...claim, digest, result });
      return result;
    });
  }

  publicProfile(provider: 'bilibili'): Promise<BilibiliProfile | null>;
  publicProfile(provider: 'github'): Promise<GitHubProfile | null>;
  async publicProfile(provider: Provider): Promise<Profile | null> {
    const now = this.now(), cache = this.cache, key = cache ? new Request(new URL(`/__xvyin_edge/social-public/v1/${provider}`, cache.origin)) : null;
    if (cache && key) {
      const response = await cacheRead(cache, key);
      if (response) {
        try {
          // Cache entries contain only a small sanitized projection; cap reads even if an entry was damaged.
          const reader = response.body?.getReader(); let size = 0, body = '';
          if (reader) {
            const decoder = new TextDecoder('utf-8', { fatal: true });
            try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength; if (size > 32 * 1024) throw new Error('CACHE_TOO_LARGE'); body += decoder.decode(chunk.value, { stream: true }); } body += decoder.decode(); }
            // A Cache response may be a tee branch; awaiting cancel can wait forever for its sibling.
            finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
          }
          const entry = z.object({ profile: z.unknown(), checkedAt: z.number().int().nonnegative() }).strict().parse(JSON.parse(body));
          if (entry.checkedAt <= now && now - entry.checkedAt < 60_000) {
            if (entry.profile === null) return null;
            const profile = validProfile(provider, entry.profile, now); if (profile) return aged(profile, now);
          }
        } catch { /* Ignore a damaged or evicted optional edge cache. */ }
      }
    }
    try {
      const value = await this.store.get<PublicRecord>(path(provider));
      const profile = validProfile(provider, value?.profile, now);
      if (cache && key) await cacheWrite(cache, key, Response.json({ profile, checkedAt: now }, { headers: { 'cache-control': 'public, max-age=60' } }));
      return profile ? aged(profile, now) : null;
    } catch { return null; }
  }
}
