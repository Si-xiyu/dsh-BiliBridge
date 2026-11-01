import { ensureBuvid } from './auth.mjs';
import { BiliError } from './errors.mjs';
import { request } from './http.mjs';
import { getWbiKeys, signQuery } from './wbi.mjs';
import { isoTime, positiveInteger, requireArray } from './read.mjs';

export const SEARCH_ENDPOINT = 'https://api.bilibili.com/x/web-interface/wbi/search/type';

export function cleanSearchText(value) {
  // Strip highlight markup before decoding entities, keeping literal escaped text.
  return String(value ?? '').replace(/<[^>]*>/g, '').replace(/&(amp|lt|gt|quot|apos|nbsp|#\d+|#x[\da-f]+);/gi, (match, entity) => {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
    if (entity[0] !== '#') return named[entity.toLowerCase()];
    const hex = entity[1]?.toLowerCase() === 'x';
    const code = parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : match;
  });
}

export async function search({ keyword, type = 'video', page = 1, pageSize = 20, order, jar, signal } = {}) {
  if (typeof keyword !== 'string' || !keyword.trim()) throw new BiliError('INVALID_ARGUMENT', 'keyword 不能为空');
  if (!['video', 'user'].includes(type)) throw new BiliError('INVALID_ARGUMENT', 'type 只能是 video 或 user');
  if (order !== undefined && (type !== 'video' || !['totalrank', 'click', 'pubdate', 'dm'].includes(order))) {
    throw new BiliError('INVALID_ARGUMENT', 'order 仅支持视频的 totalrank/click/pubdate/dm');
  }
  positiveInteger(page, 'page', 1);
  positiveInteger(pageSize, 'pageSize', 20, 50);
  await ensureBuvid(jar);
  const keys = await getWbiKeys(jar);
  const query = signQuery({ keyword: keyword.trim(), search_type: type === 'video' ? 'video' : 'bili_user', page, page_size: pageSize,
    ...(type === 'video' ? { order: order ?? 'totalrank' } : {}) }, keys.imgKey, keys.subKey);
  const data = await request(`${SEARCH_ENDPOINT}?${query}`, { jar, signal });
  const rows = requireArray(data.result ?? (Number(data.numResults) === 0 ? [] : undefined), '搜索');
  const total = Number(data.numResults ?? rows.length);
  return { total, page: Number(data.page ?? page), pageSize: Number(data.pagesize ?? pageSize),
    hasMore: data.numPages !== undefined ? page < Number(data.numPages) : page * pageSize < total,
    items: rows.map((item) => type === 'video' ? {
      bvid: String(item.bvid), title: cleanSearchText(item.title), author: cleanSearchText(item.author),
      play: item.play, danmaku: item.video_review, description: cleanSearchText(item.description),
      pubdate: isoTime(item.pubdate), url: `https://www.bilibili.com/video/${item.bvid}`,
    } : { mid: String(item.mid), uname: cleanSearchText(item.uname), sign: cleanSearchText(item.usign),
      fans: item.fans, level: item.level, avatar: item.upic?.startsWith('//') ? `https:${item.upic}` : item.upic }),
  };
}
