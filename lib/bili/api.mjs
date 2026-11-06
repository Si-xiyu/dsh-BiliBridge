/**
 * 只读能力：视频元数据、用户投稿、账号信息。
 */
import { BiliError } from './errors.mjs';
import { request } from './http.mjs';
import { getWbiKeys, signQuery } from './wbi.mjs';
import { ensureBuvid, navInfo } from './auth.mjs';
import { assertMid, positiveInteger } from './read.mjs';

const VIEW = 'https://api.bilibili.com/x/web-interface/view';
const SPACE_ARC = 'https://api.bilibili.com/x/space/wbi/arc/search';
const SPACE_INFO = 'https://api.bilibili.com/x/space/wbi/acc/info';

export function toIso(seconds) {
  if (!seconds) return undefined;
  return new Date(seconds * 1000).toISOString();
}

export function assertBvid(bvid) {
  if (!/^BV[0-9A-Za-z]{10}$/.test(bvid ?? '')) {
    throw new BiliError('INVALID_ARGUMENT', `不是合法的 BV 号：${bvid}`);
  }
}

/** 统一把 view 返回裁成模型需要的形状，避免整包 JSON 灌进上下文。 */
function projectVideo(data) {
  return {
    bvid: data.bvid,
    aid: data.aid,
    title: data.title,
    desc: data.desc,
    cover: data.pic,
    pubdate: data.pubdate,
    publishedAt: toIso(data.pubdate),
    duration: data.duration,
    owner: { mid: data.owner?.mid, name: data.owner?.name },
    stat: {
      view: data.stat?.view,
      danmaku: data.stat?.danmaku,
      reply: data.stat?.reply,
      favorite: data.stat?.favorite,
      coin: data.stat?.coin,
      share: data.stat?.share,
      like: data.stat?.like,
    },
    pages: (data.pages ?? []).map((p) => ({ cid: p.cid, page: p.page, part: p.part, duration: p.duration })),
    fetchedAt: new Date().toISOString(),
    statNote: 'B站统计有缓存，播放量可能滞后数分钟',
  };
}

/** 获取视频元数据与统计（无需登录）。 */
export async function getVideo(bvid, { jar, signal } = {}) {
  assertBvid(bvid);
  const data = await request(VIEW, { query: { bvid }, jar, signal });
  if (!data?.bvid) throw new BiliError('NOT_FOUND', `没有找到视频 ${bvid}`);
  return projectVideo(data);
}

/** 当前登录账号（未登录返回 null）。 */
export async function getCurrentUser({ jar } = {}) {
  const nav = await navInfo(jar);
  if (!nav.isLogin) return null;
  return {
    mid: String(nav.mid),
    uname: nav.uname,
    level: nav.level,
    vip: nav.vip,
    coin: nav.coin,
  };
}

/**
 * 用户投稿列表。
 * 注意：置顶会插队，按发布时间取“最新”时必须再按 created 排序。
 */
export async function listUserVideos(mid, { pn = 1, ps = 10, order = 'pubdate', keyword = '', jar, signal } = {}) {
  if (!mid) throw new BiliError('INVALID_ARGUMENT', '缺少 mid');
  assertMid(String(mid)); positiveInteger(pn, 'pn', 1); positiveInteger(ps, 'ps', 10, 50);
  if (!['pubdate', 'click', 'stow'].includes(order) || typeof keyword !== 'string' || keyword.length > 100) throw new BiliError('INVALID_ARGUMENT', '投稿排序或关键词无效');
  await ensureBuvid(jar);
  const keys = await getWbiKeys(jar);
  const query = signQuery(
    { mid, ps, pn, order, keyword, platform: 'web', web_location: 1550101, order_avoided: 'true' },
    keys.imgKey,
    keys.subKey,
  );
  const data = await request(`${SPACE_ARC}?${query}`, { jar, signal });
  const vlist = data?.list?.vlist ?? [];
  return {
    mid: String(mid),
    page: Number(data?.page?.pn ?? pn),
    pageSize: Number(data?.page?.ps ?? ps),
    total: Number(data?.page?.count ?? vlist.length),
    items: vlist.map((v) => ({
      bvid: v.bvid,
      aid: v.aid,
      title: v.title,
      created: v.created,
      createdAt: toIso(v.created),
      length: v.length,
      play: v.play,
      comment: v.comment,
      cover: v.pic,
    })),
  };
}

/**
 * “我最新投稿的视频”：nav 拿 mid → 投稿列表第一页 → 按 created 倒序（绕开置顶）。
 */
export async function getLatestOwnVideo({ jar, signal } = {}) {
  const nav = await navInfo(jar);
  if (!nav.isLogin || !nav.mid) throw new BiliError('AUTH_REQUIRED', '需要先登录才能读取“我的最新投稿”');
  const list = await listUserVideos(nav.mid, { pn: 1, ps: 10, order: 'pubdate', jar, signal });
  const items = [...list.items].sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
  if (items.length === 0) return { mid: String(nav.mid), latest: null };
  return { mid: String(nav.mid), latest: items[0] };
}

/** 用户主页公开信息（空间接口，需要登录 + 签名）。 */
export async function getUserProfile(mid, { jar, signal } = {}) {
  if (!mid) throw new BiliError('INVALID_ARGUMENT', '缺少 mid');
  await ensureBuvid(jar);
  const keys = await getWbiKeys(jar);
  const query = signQuery({ mid }, keys.imgKey, keys.subKey);
  const data = await request(`${SPACE_INFO}?${query}`, { jar, signal });
  return {
    mid: String(data.mid),
    name: data.name,
    sign: data.sign,
    level: data.level,
    face: data.face,
    fans: data.follower,
    following: data.friend,
  };
}
