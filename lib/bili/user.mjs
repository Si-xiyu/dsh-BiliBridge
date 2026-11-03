import { getUserProfile, listUserVideos } from './api.mjs';
import { request } from './http.mjs';
import { assertMid } from './read.mjs';

export const RELATION_ENDPOINT = 'https://api.bilibili.com/x/relation/stat';

export async function userProfile({ mid, jar, signal } = {}) {
  assertMid(mid);
  // getUserProfile ensures buvid3 and signs acc/info. Relation counts are not acc/info fields.
  const profile = await getUserProfile(mid, { jar, signal });
  const relation = await request(RELATION_ENDPOINT, { query: { vmid: mid }, jar, signal });
  const result = { mid: String(profile.mid), name: profile.name, sign: profile.sign, level: profile.level,
    face: profile.face, fans: relation.follower, following: relation.following };
  try {
    const archives = await listUserVideos(mid, { ps: 1, jar, signal });
    result.archiveCount = archives.total;
  } catch (error) {
    // archiveCount is optional, but auth/risk/rate errors must remain failures.
    if (!['NOT_FOUND', 'PERMISSION_DENIED'].includes(error.code)) throw error;
  }
  try {
    const stats = await request('https://api.bilibili.com/x/space/upstat', { query: { mid }, jar, signal });
    result.stats = { likes: stats.likes ?? null, archiveView: stats.archive?.view ?? null, articleView: stats.article?.view ?? null };
    result.statsStatus = 'ok';
  } catch (error) {
    if (['RISK_CONTROLLED', 'RATE_LIMITED', 'AUTH_REQUIRED'].includes(error.code)) throw error;
    result.stats = null;
    result.statsStatus = error.code ?? 'unavailable';
  }
  return result;
}
