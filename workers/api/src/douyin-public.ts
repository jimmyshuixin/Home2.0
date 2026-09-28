import { DOUYIN_SEC_UID, DOUYIN_PROFILE_URL, type DouyinProfile } from '@xvyin/contracts';

/** No upstream reads in the visitor request path, and no invented counts before the first successful import. */
export function unavailableDouyinProfile(): DouyinProfile {
  return { secUid: DOUYIN_SEC_UID, profileUrl: DOUYIN_PROFILE_URL, name: null, signature: null, avatarUrl: null, followers: null, following: null, postCount: null, likes: null, updatedAt: null, status: 'unavailable', authorization: 'public' };
}
