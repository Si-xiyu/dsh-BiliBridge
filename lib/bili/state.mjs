import { request } from './http.mjs';
const API = 'https://api.bilibili.com';
const unknown = () => ({ state: 'unknown', evidence: 'api' });
const result = state => ({ state, evidence: state ? 'api' : 'not-found' });
export async function getWatchLaterState({ jar, aid }) {
  try {
    const d = await request(API + '/x/v2/history/toview', { jar });
    return Array.isArray(d.list) ? result(d.list.some(i => String(i.aid) === String(aid))) : unknown();
  } catch { return unknown(); }
}
export async function getFavoriteState({ jar, aid, mediaId }) {
  try {
    for (let pn = 1; pn <= 1000; pn++) {
      const d = await request(API + '/x/v3/fav/resource/list', { jar, query: { media_id: mediaId, pn, ps: 20, platform: 'web', order: 'mtime', type: 0, tid: 0 } });
      if (!Array.isArray(d.medias) && !(d.medias === null && d.has_more === false)) return unknown();
      if ((d.medias ?? []).some(i => String(i.id) === String(aid) && Number(i.type) === 2)) return result(true);
      if (d.has_more === false) return result(false);
      if (d.has_more !== true || !d.medias?.length) return unknown();
    }
    return unknown();
  } catch { return unknown(); }
}
export async function getLikeState({ jar, aid }) {
  try {
    const d = await request(API + '/x/web-interface/archive/has/like', { jar, query: { aid } });
    return d === 0 || d === 1 ? { state: d === 1, evidence: 'api' } : unknown();
  } catch { return unknown(); }
}
