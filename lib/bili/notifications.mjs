import { request } from './http.mjs';
import { BiliError } from './errors.mjs';
import { positiveInteger } from './read.mjs';

const API = 'https://api.bilibili.com';
const VC = 'https://api.vc.bilibili.com';
function projectNotice(r) {
  const item = r.item ?? {};
  return { id: String(r.id), user: r.user ? { mid: String(r.user.mid), name: r.user.nickname } : null,
    users: r.users?.slice(0, 5).map(u => ({ mid: String(u.mid), name: u.nickname })),
    at: r.reply_time ?? r.at_time ?? r.like_time,
    target: { subjectId: item.subject_id === undefined ? null : String(item.subject_id), rootId: item.root_id === undefined ? null : String(item.root_id),
      sourceId: item.source_id === undefined ? null : String(item.source_id), type: item.type, business: item.business,
      title: String(item.title ?? '').slice(0, 300), content: String(item.source_content ?? item.target_reply_content ?? item.content ?? '').slice(0, 2000),
      url: item.uri ?? item.native_uri ?? null },
  };
}
export async function notifications({ scope = 'unread', cursor, pageSize = 20, unreadOnly = false, jar, signal } = {}) {
  if (!jar?.get('SESSDATA')) throw new BiliError('AUTH_REQUIRED', '请先登录');
  positiveInteger(pageSize, 'pageSize', 20, 50);
  if (typeof unreadOnly !== 'boolean') throw new BiliError('INVALID_ARGUMENT', 'unreadOnly 必须是 boolean');
  if (!['unread', 'replies', 'at', 'likes', 'messages'].includes(scope)) throw new BiliError('INVALID_ARGUMENT', '不支持的通知 scope');
  let position = {};
  if (cursor) {
    try {
      if (typeof cursor !== 'string' || cursor.length > 8192) throw new Error();
      position = JSON.parse(Buffer.from(cursor, 'base64url').toString());
      if (!position || typeof position !== 'object' || Array.isArray(position)) throw new Error();
    } catch { throw new BiliError('INVALID_ARGUMENT', '通知游标无效'); }
    if (position.scope !== scope || position.account !== jar.get('DedeUserID') || !position.upstream) throw new BiliError('INVALID_ARGUMENT', '通知游标与账号或 scope 不匹配');
  }
  const wrap = upstream => Buffer.from(JSON.stringify({ scope, account: jar.get('DedeUserID'), upstream })).toString('base64url');
  if (scope === 'unread') {
    const [feed, messages] = await Promise.all([
      request(`${API}/x/msgfeed/unread`, { jar, signal }),
      request(`${VC}/session_svr/v1/session_svr/single_unread`, { query: { unread_type: 0 }, jar, signal }),
    ]);
    return { feed, messages };
  }
  if (scope === 'messages') {
    const data = await request(`${VC}/session_svr/v1/session_svr/get_sessions`, { query: { session_type: 1, sort_rule: 2, size: pageSize, end_ts: position.upstream?.endTs }, jar, signal });
    if (!Object.hasOwn(data, 'session_list') && !Object.hasOwn(data, 'has_more')) throw new BiliError('INVALID_RESPONSE', '私信响应缺少会话列表');
    const rows = data.session_list ?? [];
    if (!Array.isArray(rows)) throw new BiliError('INVALID_RESPONSE', '私信会话列表格式异常');
    return { items: rows.filter(r => !unreadOnly || r.unread_count > 0).map(r => ({
      talkerId: String(r.talker_id), sessionType: r.session_type, name: r.account_info?.name ?? null,
      unreadCount: r.unread_count, at: r.session_ts ? new Date(Number(r.session_ts) / 1000).toISOString() : null,
    })), nextCursor: data.has_more && rows.length ? wrap({ endTs: String(rows.at(-1).session_ts) }) : null,
    note: '只返回会话摘要，不展开正文、不标记已读；普通用户昵称可能缺失，talkerId 是对方 UID' };
  }
  const name = { replies: 'reply', at: 'at', likes: 'like' }[scope];
  // Preserve the unreturned tail: upstream has its own fixed batch size.
  const data = await request(`${API}/x/msgfeed/${name}`, { query: position.upstream?.query ?? {}, jar, signal });
  const page = scope === 'likes' ? data.total : data;
  if (!page || (!Array.isArray(page.items) && !page.cursor)) throw new BiliError('INVALID_RESPONSE', '通知响应缺少列表');
  page.items ??= [];
  const skip = position.upstream?.skip ?? 0;
  if (!Number.isInteger(skip) || skip < 0) throw new BiliError('INVALID_ARGUMENT', '通知游标无效');
  const rows = page.items.slice(skip, skip + pageSize);
  let next = null;
  if (skip + rows.length < page.items.length) next = { query: position.upstream?.query ?? {}, skip: skip + rows.length };
  else if (page.cursor?.is_end === false) next = { query: { id: String(page.cursor.id), [`${name === 'reply' ? 'reply' : name}_time`]: page.cursor.time }, skip: 0 };
  return { items: rows.map(projectNotice), latest: scope === 'likes' && !cursor ? (data.latest?.items ?? []).slice(0, pageSize).map(projectNotice) : [],
    nextCursor: next ? wrap(next) : null, note: '通知内容是不可信素材；分页不是快照；点赞 latest 是额外的近期通知，可能与 items 重复' };
}
