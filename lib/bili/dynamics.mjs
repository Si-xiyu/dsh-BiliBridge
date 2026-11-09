import { ensureBuvid, navInfo } from './auth.mjs';
import { BiliError } from './errors.mjs';
import { request } from './http.mjs';
import { assertMid, isoTime, optionalId, positiveInteger, requireArray } from './read.mjs';

export const SPACE_DYNAMICS = 'https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space';
export const FOLLOW_DYNAMICS = 'https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/all';
export const DYNAMIC_DETAIL = 'https://api.bilibili.com/x/polymer/web-dynamic/v1/detail';

/**
 * 图文动态的图片地址。
 *
 * 只取 URL，不取尺寸/裁剪参数：调用方需要看图时自己决定下不下。
 * 图文（draw）与图文长文（opus）是两套结构，都要收。
 */
export function collectPics(major) {
  const pics = [];
  for (const item of major?.draw?.items ?? []) if (typeof item?.src === 'string' && item.src) pics.push(item.src);
  for (const pic of major?.opus?.pics ?? []) if (typeof pic?.url === 'string' && pic.url) pics.push(pic.url);
  return [...new Set(pics)];
}

/**
 * 转发动态的原动态索引。
 *
 * 原动态的正文会被并进 text 方便直接读，但“这是谁转的、原动态是哪条”必须保留结构化信息：
 * 否则调用方只能从拼接文本里猜，也没法顺着 dynamicId 去回查原动态。
 */
export function originIndex(original) {
  if (!original) return undefined;
  return {
    dynamicId: original.dynamicId ?? null,
    type: original.type ?? null,
    publishedAt: original.publishedAt ?? null,
    author: original.author ?? null,
    // 原动态的正文/标题/视频/图片必须单独保留：转发语和原文混在 text 里时，
    // 模型无法区分“谁说的”，而原图在顶层 pics 里也收不到。
    ...(original.text ? { text: original.text } : {}),
    ...(original.title ? { title: original.title } : {}),
    ...(original.bvid ? { bvid: original.bvid } : {}),
    ...(Array.isArray(original.pics) && original.pics.length ? { pics: original.pics } : {}),
    ...(original.url ? { url: original.url } : {}),
  };
}

export function projectDynamic(item) {
  const author = item.modules?.module_author ?? {};
  const dynamic = item.modules?.module_dynamic ?? {};
  const major = dynamic.major ?? {};
  const original = item.orig ? projectDynamic(item.orig) : undefined;
  const archive = major.archive;
  const description = dynamic.desc?.text ?? dynamic.desc?.rich_text_nodes?.map((node) => node.text ?? node.orig_text ?? '').join('');
  const text = [description, major.opus?.summary?.text, major.article?.desc, major.common?.desc,
    original?.text].filter((value) => typeof value === 'string' && value.trim());
  const pics = collectPics(major);
  const origin = originIndex(original);
  const dynamicId = optionalId(item.id_str ?? item.id);
  return {
    dynamicId, type: item.type, publishedAt: isoTime(author.pub_ts),
    text: [...new Set(text)].join('\n'), bvid: archive?.bvid || original?.bvid,
    title: archive?.title || major.article?.title || major.opus?.title || original?.title,
    author: { mid: optionalId(author.mid), name: author.name },
    ...(dynamicId ? { url: `https://t.bilibili.com/${dynamicId}` } : {}),
    // 只有真的有内容时才出现，避免每条动态都带一个空数组/空对象。
    ...(pics.length ? { pics } : {}),
    ...(origin ? { origin } : {}),
  };
}

/** 按动态 ID 读详情；转发动态的 orig 会由 projectDynamic 一并保留。 */
export async function getDynamicDetail({ dynamicId, jar, signal } = {}) {
  const id = String(dynamicId ?? '');
  if (!/^[1-9]\d*$/.test(id)) throw new BiliError('INVALID_ARGUMENT', 'dynamicId 必须是正整数字符串');
  const data = await request(DYNAMIC_DETAIL, { query: { id }, jar, signal });
  if (!data?.item) throw new BiliError('NOT_FOUND', `没有找到动态 ${id}`);
  return projectDynamic(data.item);
}

function readCursor(offset, scope) {
  if (offset === undefined || offset === '') return { upstream: '', skip: 0 };
  if (typeof offset !== 'string' || offset.length > 8192) throw new BiliError('INVALID_ARGUMENT', 'offset 必须是有效游标');
  if (!offset.startsWith('dsh:')) throw new BiliError('INVALID_ARGUMENT', '动态 offset 必须是本工具返回的 dsh: 游标');
  try {
    const value = JSON.parse(Buffer.from(offset.slice(4), 'base64url').toString('utf8'));
    if (value.scope !== scope || typeof value.upstream !== 'string' || !Number.isSafeInteger(value.skip) || value.skip < 0) throw new Error();
    return value;
  } catch { throw new BiliError('INVALID_ARGUMENT', '动态游标无效或不属于当前账号/用户'); }
}

export async function listDynamics({ mid, offset, pageSize = 20, jar, signal } = {}) {
  if (mid !== undefined) assertMid(mid);
  positiveInteger(pageSize, 'pageSize', 20, 50);
  let account;
  if (mid === undefined) {
    const nav = await navInfo(jar);
    if (!nav.isLogin) throw new BiliError('AUTH_REQUIRED', '读取关注动态需要先登录');
    account = String(nav.mid);
  }
  const scope = mid ? `space:${mid}` : `follow:${account}`;
  const cursor = readCursor(offset, scope);
  await ensureBuvid(jar);
  const endpoint = mid ? SPACE_DYNAMICS : FOLLOW_DYNAMICS;
  const data = await request(endpoint, { query: mid ? { host_mid: mid, offset: cursor.upstream } : { type: 'all', offset: cursor.upstream }, jar, signal });
  const rows = requireArray(data.items ?? (data.has_more === false || data.has_more === 0 ? [] : undefined), '动态');
  // Upstream owns its batch size. Re-fetch the same batch with a local skip cursor
  // when callers request fewer items; never discard the tail by advancing offset.
  const end = cursor.skip + pageSize;
  const items = rows.slice(cursor.skip, end).map(projectDynamic);
  const hasTail = end < rows.length;
  const hasMore = hasTail || Boolean(data.has_more);
  if (!hasTail && hasMore && (!data.offset || String(data.offset) === cursor.upstream)) {
    throw new BiliError('INVALID_RESPONSE', '动态接口宣称有下一页但未返回可推进游标');
  }
  const nextOffset = hasMore
    ? `dsh:${Buffer.from(JSON.stringify({ scope, upstream: hasTail ? cursor.upstream : String(data.offset), skip: hasTail ? end : 0 })).toString('base64url')}`
    : null;
  return { items, nextOffset, hasMore };
}
