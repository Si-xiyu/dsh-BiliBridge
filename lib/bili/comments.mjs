import { getVideo } from './api.mjs';
import { BiliError } from './errors.mjs';
import { request } from './http.mjs';
import { getWbiKeys, signQuery } from './wbi.mjs';
import { isoTime, positiveInteger, requireArray } from './read.mjs';

export const COMMENTS_ENDPOINT = 'https://api.bilibili.com/x/v2/reply';
const WBI_MAIN = 'https://api.bilibili.com/x/v2/reply/wbi/main';
const REPLIES = 'https://api.bilibili.com/x/v2/reply/reply';

export function projectComment(reply, includeReplies = true) {
  return {
    rpid: String(reply.rpid_str ?? reply.rpid), user: reply.member?.uname,
    uid: reply.member?.mid === undefined ? undefined : String(reply.member.mid),
    message: Array.from(String(reply.content?.message ?? '')).slice(0, 600).join(''),
    like: Number(reply.like ?? 0), replyCount: Number(reply.rcount ?? reply.count ?? 0),
    createdAt: isoTime(reply.ctime),
    replies: includeReplies ? (reply.replies ?? []).slice(0, 3).map((child) => projectComment(child, false)) : [],
  };
}

export async function listComments({ bvid, sort = 'hot', page = 1, pageSize = 20, includeReplies = true, jar, signal } = {}) {
  if (!['hot', 'new'].includes(sort)) throw new BiliError('INVALID_ARGUMENT', 'sort 只能是 hot 或 new');
  positiveInteger(page, 'page', 1);
  positiveInteger(pageSize, 'pageSize', 20, 20);
  if (typeof includeReplies !== 'boolean') throw new BiliError('INVALID_ARGUMENT', 'includeReplies 必须是 boolean');
  const video = await getVideo(bvid, { jar, signal });
  let data;
  let endpoint = COMMENTS_ENDPOINT;
  try {
    data = await request(COMMENTS_ENDPOINT, { query: { type: 1, oid: video.aid, sort: sort === 'hot' ? 2 : 0, ps: pageSize, pn: page }, jar, signal });
  } catch (error) {
    // Legacy reply can reject parameters (-400) or explicitly request WBI.
    // Do not reinterpret permission/risk-control failures as a reason to retry.
    if (error.biliCode !== -400 && !(error.code === 'UPSTREAM_ERROR' && /wbi/i.test(error.message))) throw error;
    // WBI main uses cursor pagination, not pn. Never fabricate a page N cursor.
    if (page !== 1) throw new BiliError('UNSUPPORTED', '评论接口要求 WBI 游标，当前仅支持第一页；不能把页码转换为游标');
    const keys = await getWbiKeys(jar);
    const query = signQuery({ type: 1, oid: video.aid, mode: sort === 'hot' ? 3 : 2, pagination_str: JSON.stringify({ offset: '' }) }, keys.imgKey, keys.subKey);
    data = await request(`${WBI_MAIN}?${query}`, { jar, signal });
    endpoint = WBI_MAIN;
  }
  const rows = requireArray(data.replies ?? (data.page || data.cursor ? [] : undefined), '评论');
  const items = [];
  const maxReplyFetches = 5;
  let replyFetches = 0;
  for (const row of rows.slice(0, pageSize)) {
    const item = projectComment(row, includeReplies);
    // Only supplement the first five incomplete previews; keep all later previews.
    if (includeReplies && replyFetches < maxReplyFetches && item.replyCount > item.replies.length && item.replies.length < 3) {
      replyFetches += 1;
      const children = await request(REPLIES, { query: { type: 1, oid: video.aid, root: item.rpid, ps: 20, pn: 1 }, jar, signal });
      item.replies = requireArray(children.replies ?? (children.page ? [] : undefined), '楼中楼').slice(0, 3).map((child) => projectComment(child, false));
    }
    items.push(item);
  }
  const total = Number(data.page?.count ?? data.cursor?.all_count ?? 0);
  return { total, page, pageSize, hasMore: endpoint === WBI_MAIN ? data.cursor?.is_end === false || rows.length > pageSize : page * pageSize < total,
    items, endpoint, note: 'createdAt 是评论发布的绝对时间，不是视频时间轴。',
    ...(endpoint === WBI_MAIN ? { limitation: 'WBI 降级仅支持第一页，hasMore 表示上游仍有评论，不代表支持页码续取。' } : {}),
  };
}
