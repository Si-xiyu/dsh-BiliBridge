/**
 * 列表与低风险写：稍后观看、收藏夹、点赞。
 *
 * 写操作全部走 postForm（自动带 csrf）；调用方负责审批与预算，
 * 这里只做参数校验和结果投影。
 */
import { BiliError } from './errors.mjs';
import { postForm, request } from './http.mjs';
import { getCurrentUser } from './api.mjs';
import { assertMid, positiveInteger } from './read.mjs';

const TOVIEW = 'https://api.bilibili.com/x/v2/history/toview';
const TOVIEW_ADD = 'https://api.bilibili.com/x/v2/history/toview/add';
const TOVIEW_DEL = 'https://api.bilibili.com/x/v2/history/toview/del';
const FAV_FOLDERS = 'https://api.bilibili.com/x/v3/fav/folder/created/list-all';
const FAV_ITEMS = 'https://api.bilibili.com/x/v3/fav/resource/list';
const FAV_DEAL = 'https://api.bilibili.com/x/v3/fav/resource/deal';
const LIKE = 'https://api.bilibili.com/x/web-interface/archive/like';

async function requireLogin(jar) {
  const me = await getCurrentUser({ jar });
  if (!me) throw new BiliError('AUTH_REQUIRED', '需要先登录');
  return me;
}

/** 稍后观看列表（B站最多保留约 100 条）。 */
export async function listWatchLater({ jar } = {}) {
  await requireLogin(jar);
  const data = await request(TOVIEW, { jar });
  const list = data?.list ?? [];
  return {
    count: Number(data?.count ?? list.length),
    items: list.map((item) => ({
      aid: item.aid,
      bvid: item.bvid,
      title: item.title,
      cover: item.pic,
      duration: item.duration,
      progress: item.progress,
      addedAt: item.add_at ? new Date(item.add_at * 1000).toISOString() : undefined,
    })),
  };
}

/** 加/移除稍后观看；目标状态语义，重复调用不会反转。 */
export async function setWatchLater({ jar, aid, added } = {}) {
  if (!aid) throw new BiliError('INVALID_ARGUMENT', '缺少 aid');
  await writeLogin(jar);
  const url = added ? TOVIEW_ADD : TOVIEW_DEL;
  await postForm(url, { jar, fields: { aid } });
  return { aid: String(aid), inWatchLater: Boolean(added) };
}

/** 收藏夹列表。 */
export async function listFavoriteFolders({ jar, mid } = {}) {
  if (mid !== undefined) assertMid(String(mid));
  const me = await requireLogin(jar);
  const upMid = mid ?? me.mid;
  const data = await request(FAV_FOLDERS, { query: { up_mid: upMid }, jar });
  const list = data?.list ?? [];
  return {
    mid: String(upMid),
    items: list.map((f) => ({
      mediaId: f.id,
      title: f.title,
      mediaCount: f.media_count,
      isDefault: f.id === 0,
    })),
  };
}

/** 收藏夹内容。 */
export async function listFavoriteItems({ jar, mediaId, pn = 1, ps = 20, keyword = '', order = 'mtime' } = {}) {
  if (mediaId === undefined || mediaId === null) throw new BiliError('INVALID_ARGUMENT', '缺少 mediaId');
  assertMid(String(mediaId)); positiveInteger(pn, 'pn', 1); positiveInteger(ps, 'ps', 20, 50);
  if (!['mtime', 'view', 'pubtime'].includes(order) || typeof keyword !== 'string' || keyword.length > 100) throw new BiliError('INVALID_ARGUMENT', '收藏夹排序或关键词无效');
  await requireLogin(jar);
  const data = await request(FAV_ITEMS, {
    query: { media_id: mediaId, pn, ps, platform: 'web', order, keyword, type: 0, tid: 0 },
    jar,
  });
  const medias = data?.medias ?? [];
  return {
    mediaId: String(mediaId),
    page: Number(data?.pn ?? pn),
    pageSize: Number(data?.ps ?? ps),
    total: Number(data?.total ?? medias.length),
    hasMore: Boolean(data?.has_more),
    items: medias.map((m) => ({
      bvid: m.bvid,
      aid: m.id,
      title: m.title,
      cover: m.cover,
      duration: m.duration,
      upper: m.upper?.name,
      play: m.cnt_info?.play,
      favTime: m.fav_time ? new Date(m.fav_time * 1000).toISOString() : undefined,
    })),
  };
}

/** 收藏 / 取消收藏。 */
export async function setFavorite({ jar, aid, mediaId, added } = {}) {
  if (!aid) throw new BiliError('INVALID_ARGUMENT', '缺少 aid');
  if (mediaId === undefined || mediaId === null) throw new BiliError('INVALID_ARGUMENT', '缺少 mediaId');
  await writeLogin(jar);
  const fields = { rid: aid, type: 2, platform: 'web' };
  if (added) fields.add_media_ids = mediaId;
  else fields.del_media_ids = mediaId;
  await postForm(FAV_DEAL, { jar, fields });
  return { aid: String(aid), mediaId: String(mediaId), favorited: Boolean(added) };
}

/** 点赞 / 取消点赞（目标状态语义）。 */
export async function setVideoLike({ jar, aid, liked } = {}) {
  if (!aid) throw new BiliError('INVALID_ARGUMENT', '缺少 aid');
  await writeLogin(jar);
  // 这个接口用 1=点赞、2=取消；传 0 会直接返回“请求参数不合法”，等于什么都没做。
  await postForm(LIKE, { jar, fields: { aid, like: liked ? 1 : 2 } });
  return { aid: String(aid), liked: Boolean(liked) };
}

// Only this preflight happens before any mutation request can be submitted.
async function writeLogin(jar) {
  try { await requireLogin(jar); }
  catch (error) { error.submission = 'not-submitted'; throw error; }
}
