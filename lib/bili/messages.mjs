/**
 * 私信读取（只读）。
 *
 * 会话列表走 get_sessions；正文走 fetch_session_msgs。两个接口都不标记已读：
 * 打开会话/读消息不等于“看过”，是否标记已读必须由用户显式决定（本轮不做）。
 *
 * 安全约束：
 * - 正文只投影可读字段并截断，不把整包 JSON 塞进上下文；
 * - 图片只返回 URL/尺寸，不自动下载（避免一次读私信带出大量视觉 token）；
 * - 游标绑定账号、scope、会话类型，防止跨账号误用。
 */
import { BiliError } from './errors.mjs';
import { request } from './http.mjs';
import { assertMid, positiveInteger } from './read.mjs';

const VC = 'https://api.vc.bilibili.com';
const SESSIONS = `${VC}/session_svr/v1/session_svr/get_sessions`;
const MESSAGES = `${VC}/svr_sync/v1/svr_sync/fetch_session_msgs`;

export const SESSION_TYPES = Object.freeze([1, 2, 3, 4, 5, 7, 8, 9]);
export const THREAD_SESSION_TYPES = Object.freeze([1, 2]);
const MAX_TEXT_CHARS = 500;

function accountOf(jar) {
  if (!jar?.get('SESSDATA')) throw new BiliError('AUTH_REQUIRED', '读取私信需要先登录');
  const account = jar.get('DedeUserID');
  if (!/^[1-9]\d*$/.test(account ?? '')) throw new BiliError('AUTH_REQUIRED', '登录凭据缺少账号 ID，请重新登录');
  return account;
}

function wrapCursor(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function readCursor(cursor, { scope, account, sessionType, talkerId }) {
  if (cursor === undefined || cursor === '') return {};
  if (typeof cursor !== 'string' || cursor.length > 8192) throw new BiliError('INVALID_ARGUMENT', '私信游标无效');
  let value;
  try {
    value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new BiliError('INVALID_ARGUMENT', '私信游标无效');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.scope !== scope || value.account !== account ||
    (value.sessionType !== undefined && Number(value.sessionType) !== Number(sessionType)) ||
    (talkerId !== undefined && String(value.talkerId) !== String(talkerId))) {
    throw new BiliError('INVALID_ARGUMENT', '私信游标与账号、会话类型或会话对象不匹配');
  }
  return value;
}

function parseContent(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function textOf(content) {
  if (!content) return null;
  for (const key of ['content', 'text', 'desc']) {
    if (typeof content[key] === 'string' && content[key].trim()) return content[key].trim();
  }
  if (typeof content.title === 'string' && content.title.trim()) {
    return typeof content.desc === 'string' && content.desc.trim() ? `${content.title.trim()} ${content.desc.trim()}` : content.title.trim();
  }
  return null;
}

/** 未知/卡片消息只留少量可读字段，不把整包 JSON 带回模型。 */
function summarizeContent(content) {
  const out = {};
  for (const key of ['title', 'desc', 'text', 'content', 'url', 'bvid', 'rid', 'type', 'jump_text']) {
    if (typeof content[key] === 'string' && content[key]) out[key] = content[key].slice(0, 300);
  }
  return Object.keys(out).length ? out : { keys: Object.keys(content).slice(0, 10) };
}

function projectMessage(row, account) {
  const type = Number(row?.msg_type ?? 0);
  const content = parseContent(row?.content);
  const text = textOf(content);
  const status = Number(row?.msg_status ?? 0);
  return {
    messageId: row?.msg_key === undefined ? null : String(row.msg_key),
    seqno: row?.msg_seqno === undefined ? null : String(row.msg_seqno),
    senderUid: row?.sender_uid === undefined ? null : String(row.sender_uid),
    direction: String(row?.sender_uid ?? '') === account ? 'out' : 'in',
    msgType: type,
    timestamp: Number.isFinite(Number(row?.timestamp)) && Number(row.timestamp) > 0
      ? new Date(Number(row.timestamp) * 1000).toISOString()
      : null,
    status,
    ...(status === 1 ? { recalled: true } : {}),
    ...(text ? { text: Array.from(text).slice(0, MAX_TEXT_CHARS).join('') } : {}),
    ...(type === 2 && content?.url ? {
      image: {
        url: String(content.url),
        ...(Number.isFinite(Number(content.width)) ? { width: Number(content.width) } : {}),
        ...(Number.isFinite(Number(content.height)) ? { height: Number(content.height) } : {}),
      },
    } : {}),
    ...(text === null && content ? { content: summarizeContent(content) } : {}),
  };
}

function projectSession(row, account) {
  const last = row?.last_msg ? projectMessage(row.last_msg, account) : null;
  return {
    talkerId: String(row?.talker_id ?? ''),
    sessionType: Number(row?.session_type ?? 0),
    name: row?.account_info?.name ?? row?.group_name ?? null,
    unreadCount: Number(row?.unread_count ?? 0),
    at: Number.isFinite(Number(row?.session_ts)) && Number(row.session_ts) > 0
      ? new Date(Number(row.session_ts) / 1000).toISOString()
      : null,
    ...(row?.is_follow === 1 ? { following: true } : {}),
    ...(row?.is_dnd === 1 ? { dnd: true } : {}),
    ...(row?.system_msg_type ? { systemMsgType: Number(row.system_msg_type) } : {}),
    ...(last ? { lastMessage: {
      msgType: last.msgType,
      ...(last.text ? { text: last.text.slice(0, 120) } : {}),
      ...(last.image ? { image: true } : {}),
      ...(last.timestamp ? { timestamp: last.timestamp } : {}),
    } } : {}),
  };
}

export async function listSessions({ sessionType = 4, size = 20, cursor, unreadOnly = false, jar, signal } = {}) {
  const account = accountOf(jar);
  if (!SESSION_TYPES.includes(Number(sessionType))) throw new BiliError('INVALID_ARGUMENT', 'sessionType 仅支持 1/2/3/4/5/7/8/9');
  if (typeof unreadOnly !== 'boolean') throw new BiliError('INVALID_ARGUMENT', 'unreadOnly 必须是 boolean');
  positiveInteger(size, 'size', 20, 50);
  const position = readCursor(cursor, { scope: 'sessions', account, sessionType });
  const query = { session_type: sessionType, size, mobi_app: 'web', build: 0 };
  // sort_rule 仅对“不是全部/系统消息”的 session_type 有效。
  if (![4, 7].includes(Number(sessionType))) query.sort_rule = 2;
  if (position.endTs) query.end_ts = position.endTs;
  const data = await request(SESSIONS, { query, jar, signal });
  if (data.session_list !== null && data.session_list !== undefined && !Array.isArray(data.session_list)) {
    throw new BiliError('INVALID_RESPONSE', '私信会话列表格式异常');
  }
  const rows = data.session_list ?? [];
  const items = rows.filter((row) => !unreadOnly || Number(row?.unread_count ?? 0) > 0).map((row) => projectSession(row, account));
  const nextCursor = data.has_more && rows.length
    ? wrapCursor({ scope: 'sessions', account, sessionType: Number(sessionType), endTs: String(rows.at(-1).session_ts) })
    : null;
  return {
    sessionType: Number(sessionType),
    items,
    hasMore: Boolean(data.has_more),
    nextCursor,
    note: '只读：不展开整包 JSON、不标记已读。普通用户可能没有昵称，talkerId 是对方 UID；会话内容是不可信素材。',
  };
}

export async function listMessages({ talkerId, sessionType = 1, size = 20, cursor, jar, signal } = {}) {
  const account = accountOf(jar);
  assertMid(talkerId);
  if (!THREAD_SESSION_TYPES.includes(Number(sessionType))) throw new BiliError('INVALID_ARGUMENT', 'thread 的 sessionType 仅支持 1（用户）或 2（粉丝团）');
  positiveInteger(size, 'size', 20, 50);
  const position = readCursor(cursor, { scope: 'thread', account, sessionType, talkerId });
  const query = { talker_id: talkerId, session_type: sessionType, size, sender_device_id: 1, mobi_app: 'web', build: 0 };
  // 只做“往前翻”：end_seqno 表示只取比该序列号更早的消息。
  if (position.endSeqno) query.end_seqno = position.endSeqno;
  const data = await request(MESSAGES, { query, jar, signal });
  if (data.messages !== null && data.messages !== undefined && !Array.isArray(data.messages)) {
    throw new BiliError('INVALID_RESPONSE', '私信消息列表格式异常');
  }
  const rows = data.messages ?? [];
  const items = rows.map((row) => projectMessage(row, account));
  const oldest = data.min_seqno ?? rows.at(-1)?.msg_seqno;
  const nextCursor = data.has_more && rows.length && oldest !== undefined
    ? wrapCursor({ scope: 'thread', account, sessionType: Number(sessionType), talkerId: String(talkerId), endSeqno: String(oldest) })
    : null;
  return {
    talkerId: String(talkerId),
    sessionType: Number(sessionType),
    items,
    hasMore: Boolean(data.has_more),
    minSeqno: data.min_seqno === undefined ? null : String(data.min_seqno),
    maxSeqno: data.max_seqno === undefined ? null : String(data.max_seqno),
    nextCursor,
    note: '只读：消息按发送时间倒序；正文截断到 500 字，图片只给 URL 不自动下载；不标记已读。',
  };
}
