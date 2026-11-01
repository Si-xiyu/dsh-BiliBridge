/**
 * 取播放地址（DASH）。
 *
 * 用途：给 ffmpeg 一条能解码的流，用来抽真实帧 / 抽音频。
 *
 * 注意：
 * - 这是 WBI 签名的接口，且 CDN 链接**有时效、通常与 IP 绑定**，所以只放在内存里，
 *   绝不出现在工具返回值中（模型只需要帧，不需要 URL）。
 * - 未登录通常只能拿到 360P/480P；1080P 需要登录 + fourk。
 * - 拿不到的画质不要假装：返回 acceptQuality，让调用方知道实际拿到什么。
 */
import { BiliError } from './errors.mjs';
import { request } from './http.mjs';
import { getWbiKeys, signQuery } from './wbi.mjs';

const PLAYURL = 'https://api.bilibili.com/x/player/wbi/playurl';

/** CDN 链接约 2 小时过期；给足余量，避免拿着快过期的地址抽帧。 */
const URL_TTL_MS = 20 * 60 * 1000;

export const QUALITY_LABEL = {
  127: '8K',
  126: '杜比视界',
  125: 'HDR',
  120: '4K',
  116: '1080P60',
  112: '1080P+',
  80: '1080P',
  74: '720P60',
  64: '720P',
  32: '480P',
  16: '360P',
  6: '240P',
};

/** 进程内缓存：同一视频多次补帧不必重复签名。key 不含账号——同一进程按账号隔离并不现实，故不做跨账号缓存。 */
const cache = new Map();

function absolute(url) {
  if (!url) return null;
  return url.startsWith('//') ? `https:${url}` : url;
}

/**
 * @param {{bvid:string, cid:string|number, qn?:number, jar?:any, signal?:AbortSignal, referer?:string}} options
 */
export async function getPlayUrls({ bvid, cid, qn = 80, jar, signal, referer } = {}) {
  if (!bvid || !cid) throw new BiliError('INVALID_ARGUMENT', 'playurl 需要 bvid 与 cid');

  const key = `${bvid}:${cid}:${qn}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < URL_TTL_MS) return { ...hit.value, cached: true };

  const keys = await getWbiKeys(jar);
  const query = signQuery({ bvid, cid, qn, fnval: 4048, fourk: 1, platform: 'pc' }, keys.imgKey, keys.subKey);
  const data = await request(`${PLAYURL}?${query}`, {
    jar,
    signal,
    referer: referer ?? `https://www.bilibili.com/video/${bvid}`,
  });

  const dash = data?.dash;
  const durl = data?.durl;
  const acceptQuality = (data?.accept_quality ?? data?.accept_description ?? []).slice(0, 12);

  if (dash?.video?.length) {
    // 画质降级是常态：按 id 从高到低挑不超过请求值的最高档；
    // 请求值比所有可用档都低时，给最低档（而不是意外地给最高档）。
    const videos = [...dash.video]
      .map((item) => ({ ...item, id: Number(item.id) }))
      .sort((a, b) => b.id - a.id);
    const video = videos.find((item) => item.id <= qn) ?? videos[videos.length - 1];
    const audios = [...(dash.audio ?? [])].sort((a, b) => Number(b.bandwidth) - Number(a.bandwidth));
    const value = {
      bvid,
      cid: String(cid),
      format: 'dash',
      quality: { id: video.id, label: QUALITY_LABEL[video.id] ?? String(video.id) },
      requestedQuality: qn,
      acceptQuality,
      videoUrl: absolute(video.baseUrl ?? video.base_url ?? video.baseURL),
      audioUrl: absolute(audios[0]?.baseUrl ?? audios[0]?.base_url),
      backupVideoUrl: absolute(video.backupUrl?.[0] ?? video.backup_url?.[0]),
      cached: false,
    };
    if (!value.videoUrl) throw new BiliError('INVALID_RESPONSE', 'playurl 没有返回可用的视频流');
    cache.set(key, { at: Date.now(), value });
    return value;
  }

  if (durl?.length) {
    // 老接口（mp4/flv 整段）：同样可以抽帧。
    const value = {
      bvid,
      cid: String(cid),
      format: 'durl',
      quality: { id: Number(data.quality), label: QUALITY_LABEL[Number(data.quality)] ?? String(data.quality) },
      requestedQuality: qn,
      acceptQuality,
      videoUrl: absolute(durl[0].url),
      audioUrl: null,
      backupVideoUrl: absolute(durl[0].backup_url?.[0]),
      cached: false,
    };
    if (!value.videoUrl) throw new BiliError('INVALID_RESPONSE', 'playurl 没有返回可用的视频流');
    cache.set(key, { at: Date.now(), value });
    return value;
  }

  throw new BiliError('CONTENT_UNAVAILABLE', '这个视频没有可用的播放地址（可能需要登录、会员或已下架）');
}

/** 测试/调试用：清掉进程内 URL 缓存。 */
export function clearPlayUrlCache() {
  cache.clear();
}
