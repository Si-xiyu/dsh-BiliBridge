import { request } from './http.mjs';
import { BiliError } from './errors.mjs';
import { positiveInteger, requireArray } from './read.mjs';
import { cleanSearchText } from './search.mjs';

const API = 'https://api.bilibili.com';
export const RANK_CATEGORIES = { all: 0, douga: 1, music: 3, dance: 129, game: 4, knowledge: 36, technology: 188, sports: 234, car: 223, life: 160, food: 211, animal: 217, fashion: 155, ent: 5, cinephile: 181, original: 0, rookie: 0 };
function video(item) {
  return { bvid: item.bvid, title: cleanSearchText(item.title), author: item.owner?.name,
    duration: item.duration, stat: item.stat, category: item.tname, url: `https://www.bilibili.com/video/${item.bvid}` };
}
export async function discover({ scope = 'popular', page = 1, pageSize = 20, week, category = 'all', jar, signal } = {}) {
  positiveInteger(page, 'page', 1); positiveInteger(pageSize, 'pageSize', 20, 50);
  let data;
  if (scope === 'popular') {
    data = await request(`${API}/x/web-interface/popular`, { query: { pn: page, ps: pageSize }, jar, signal });
    const rows = requireArray(data.list, '热门');
    return { scope, page, items: rows.slice(0, pageSize).map(video), hasMore: data.no_more === undefined ? rows.length >= pageSize : !Boolean(data.no_more) };
  }
  if (scope === 'hotwords') {
    data = await request(`${API}/x/web-interface/search/square`, { query: { limit: 50 }, jar, signal });
    const rows = requireArray(data.trending?.list, '热搜');
    return { scope, page, items: rows.slice((page - 1) * pageSize, page * pageSize).map(r => ({ keyword: r.keyword, showName: r.show_name, icon: r.icon })), hasMore: page * pageSize < rows.length };
  }
  if (scope === 'weekly') {
    if (week !== undefined && week !== 0) positiveInteger(week, 'week', 1);
    data = await request(`${API}/x/web-interface/popular/series/${week ? 'one' : 'list'}`, { query: week ? { number: week } : {}, jar, signal });
    const rows = requireArray(data.list, '每周必看');
    return { scope, week: week ?? 0, items: rows.slice((page - 1) * pageSize, page * pageSize).map(r => week ? video(r) : { number: r.number, name: r.name, subject: r.subject }), hasMore: page * pageSize < rows.length };
  }
  if (scope === 'rank') {
    if (!Object.hasOwn(RANK_CATEGORIES, category)) throw new BiliError('INVALID_ARGUMENT', '不支持的榜单分区');
    data = await request(`${API}/x/web-interface/ranking/v2`, { query: { rid: RANK_CATEGORIES[category], type: { original: 'origin', rookie: 'rokkie' }[category] ?? 'all' }, jar, signal });
    const rows = requireArray(data.list, '排行榜');
    return { scope, category, note: '当前榜单快照；不伪造三日/七日历史维度', items: rows.slice((page - 1) * pageSize, page * pageSize).map(video), hasMore: page * pageSize < rows.length };
  }
  throw new BiliError('INVALID_ARGUMENT', 'scope 仅支持 popular/hotwords/weekly/rank');
}
