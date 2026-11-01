/**
 * 平台字幕（官方 / AI）。
 *
 * 关键：必须使用 **WBI 签名** 的 `/x/player/wbi/v2`。
 * 不带签名的 `/x/player/v2` 会返回与当前视频无关的 AI 字幕（随机的别人视频），
 * 这是接口选择错误，不是 B站数据缺失；真实播放页用的就是 wbi/v2。
 *
 * 实测：
 * - BV1pTx76QE8J：wbi/v2 返回 0 条（页面也没有字幕），不会误报；
 * - BV1VZWc6dECG：ai-zh/ai-en/ai-ja 3 条，1576 cues，覆盖 1.0；
 * - BV1GJ411x7h7：12 条官方翻译，47 cues，覆盖 0.99。
 */
import { request } from '../bili/http.mjs';
import { getWbiKeys, signQuery } from '../bili/wbi.mjs';

const PLAYER_WBI = 'https://api.bilibili.com/x/player/wbi/v2';
const MAX_SUBTITLE_BYTES = 2 * 1024 * 1024;

function normalizeUrl(url) {
  if (!url) return null;
  if (url.startsWith('//')) return `https:${url}`;
  return url;
}

/**
 * 字幕轨道列表。aid 必填：wbi/v2 用 aid + cid 绑定视频。
 */
export async function listSubtitleTracks({ bvid, aid, cid, jar, signal } = {}) {
  if (!aid || !cid) throw new Error('字幕轨道需要 aid 与 cid');
  const keys = await getWbiKeys(jar);
  const query = signQuery({ aid, cid, bvid }, keys.imgKey, keys.subKey);
  const data = await request(`${PLAYER_WBI}?${query}`, { jar, signal });
  const list = data?.subtitle?.subtitles ?? [];
  return list
    .map((item) => ({
      lan: item.lan,
      lanDoc: item.lan_doc,
      url: normalizeUrl(item.subtitle_url),
      isAi: /^ai-/i.test(item.lan ?? ''),
    }))
    .filter((item) => item.url);
}

/** 拉取一条字幕轨的字幕体，统一成毫秒时间轴。 */
export async function fetchSubtitle(url, { signal } = {}) {
  if (!url) return [];
  const signals = [AbortSignal.timeout(20_000)];
  if (signal) signals.push(signal);
  const response = await fetch(url, { signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0] });
  if (!response.ok) throw new Error(`字幕下载失败：HTTP ${response.status}`);
  const text = await response.text();
  if (text.length > MAX_SUBTITLE_BYTES) throw new Error('字幕超过 2MB 限制');
  const json = JSON.parse(text);
  const body = Array.isArray(json.body) ? json.body : [];
  return body.map((line, index) => ({
    id: `cue-${index + 1}`,
    startMs: Math.round(Number(line.from) * 1000),
    endMs: Math.round(Number(line.to) * 1000),
    text: String(line.content ?? '').trim(),
  }));
}

/**
 * 取字幕：优先中文官方轨，其次中文 AI 轨，最后任意轨。
 * @returns {Promise<{status:string, track?:object, tracks?:Array, cues?:Array, coverage?:number}>}
 */
export async function getSubtitles({ bvid, aid, cid, jar, signal, maxCues = 800, durationMs = 0 } = {}) {
  const tracks = await listSubtitleTracks({ bvid, aid, cid, jar, signal });
  if (tracks.length === 0) return { status: 'empty', tracks: [], cues: [] };

  const track =
    tracks.find((item) => !item.isAi && /zh/i.test(item.lan ?? '')) ??
    tracks.find((item) => /zh/i.test(item.lan ?? '')) ??
    tracks[0];

  const cues = await fetchSubtitle(track.url, { signal });
  const lastEnd = cues.length ? cues[cues.length - 1].endMs : 0;
  const coverage = durationMs > 0 ? lastEnd / durationMs : cues.length ? 1 : 0;

  return {
    status: cues.length ? 'ok' : 'empty',
    track,
    tracks,
    cues: cues.slice(0, maxCues),
    coverage: Number(coverage.toFixed(3)),
    truncated: cues.length > maxCues,
  };
}
