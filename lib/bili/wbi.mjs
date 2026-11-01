/**
 * WBI 签名。
 *
 * B站大部分 web 接口要求 w_rid + wts；密钥来自 nav 的 wbi_img（每天轮换），
 * 进程内缓存 1 小时即可，失败时由调用方强制刷新。
 */
import { createHash } from 'node:crypto';
import { request } from './http.mjs';

/** 官方 mixinKeyEncTab。 */
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12,
  38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62,
  11, 36, 20, 34, 44, 52,
];

function md5(text) {
  return createHash('md5').update(text).digest('hex');
}

export function mixinKey(imgKey, subKey) {
  const raw = `${imgKey}${subKey}`;
  return MIXIN_KEY_ENC_TAB.map((i) => raw[i] ?? '').join('').slice(0, 32);
}

/** 把 params 签成 `k=v&...&w_rid=...`（已按 key 排序、已编码）。 */
export function signQuery(params, imgKey, subKey, now = Date.now()) {
  const mixin = mixinKey(imgKey, subKey);
  const entries = { ...params, wts: Math.round(now / 1000) };
  const query = Object.keys(entries)
    .filter((k) => entries[k] !== undefined && entries[k] !== null)
    .sort()
    .map((k) => {
      const value = String(entries[k]).replace(/[!'()*]/g, '');
      return `${encodeURIComponent(k)}=${encodeURIComponent(value)}`;
    })
    .join('&');
  return `${query}&w_rid=${md5(query + mixin)}`;
}

let cachedKeys = null;

/**
 * 读取 WBI 密钥。nav 在未登录时返回 -101，但响应仍带 wbi_img。
 * @param {import('./http.mjs').CookieJar} [jar]
 * @param {{force?: boolean}} [options]
 */
export async function getWbiKeys(jar, options = {}) {
  if (!options.force && cachedKeys && Date.now() - cachedKeys.at < 3600_000) return cachedKeys.keys;
  const data = await request('https://api.bilibili.com/x/web-interface/nav', {
    jar,
    acceptCodes: [-101],
  });
  const imgUrl = data?.wbi_img?.img_url ?? '';
  const subUrl = data?.wbi_img?.sub_url ?? '';
  const pick = (url) => url.split('/').pop()?.split('.')[0] ?? '';
  const keys = { imgKey: pick(imgUrl), subKey: pick(subUrl) };
  if (!keys.imgKey || !keys.subKey) throw new Error('无法从 nav 读取 WBI 密钥');
  cachedKeys = { keys, at: Date.now() };
  return keys;
}
