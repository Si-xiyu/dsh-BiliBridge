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
import { fetchBuffer, request } from '../bili/http.mjs';
import { getWbiKeys, signQuery } from '../bili/wbi.mjs';
import { coverageRatio, normalizeCues } from './timeline.mjs';
import { createHash } from 'node:crypto';
import { BiliError } from '../bili/errors.mjs';

export function pageSubtitleCues(all, { bvid, cid, lan, maxCues = 800, subtitleCursor, durationMs = 0 }) {
  if (!Number.isInteger(maxCues) || maxCues < 1 || maxCues > 800) throw new BiliError('INVALID_ARGUMENT', '字幕每页 1–800 条');
  const fingerprint = createHash('sha256').update(JSON.stringify([bvid, String(cid), lan, all])).digest('hex');
  let offset = 0;
  if (subtitleCursor !== undefined) {
    let value;
    try {
      if (typeof subtitleCursor !== 'string' || subtitleCursor.length > 2048) throw new Error();
      value = JSON.parse(Buffer.from(subtitleCursor, 'base64url').toString());
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    } catch { throw new BiliError('INVALID_ARGUMENT', '字幕游标无效'); }
    if (value.bvid !== bvid || value.cid !== String(cid) || value.lan !== lan || value.fingerprint !== fingerprint) throw new BiliError('CURSOR_STALE', '字幕轨或视频已变化，请从第一页重新读取');
    if (!Number.isInteger(value.offset) || value.offset < 0 || value.offset >= all.length) throw new BiliError('INVALID_ARGUMENT', '字幕游标越界');
    offset = value.offset;
  }
  const cues = all.slice(offset, offset + maxCues);
  const end = offset + cues.length;
  const range = items => items.length ? { startMs: items[0].startMs, endMs: items.at(-1).endMs, ratio: durationMs > 0 ? Number(coverageRatio(items, durationMs).toFixed(3)) : null } : null;
  return { cues, nextCursor: end < all.length ? Buffer.from(JSON.stringify({ bvid, cid: String(cid), lan, fingerprint, offset: end })).toString('base64url') : null,
    returnedRange: range(cues), cumulativeRange: range(all.slice(0, end)), trackRange: range(all), offset };
}

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
export async function fetchSubtitle(url, { signal, bvid } = {}) {
  if (!url) return [];
  const { buffer } = await fetchBuffer(url, {
    referer: bvid ? `https://www.bilibili.com/video/${bvid}` : undefined,
    signal,
    timeoutMs: 20_000,
    maxBytes: MAX_SUBTITLE_BYTES,
  });
  const json = JSON.parse(buffer.toString('utf8'));
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
 *
 * 注意 `coverage` 是**完整字幕轨**的区间并集覆盖率（在切片之前算），
 * 而 `cues` 可能因为 `maxCues` 被截断 —— 两者不要混用。
 * @returns {Promise<{status:string, track?:object, tracks?:Array, cues?:Array,
 *   cuesTotal?:number, coverage?:number, truncated?:boolean}>}
 */
export async function getSubtitles({ bvid, aid, cid, jar, signal, maxCues = 800, durationMs = 0, subtitleCursor } = {}) {
  const tracks = await listSubtitleTracks({ bvid, aid, cid, jar, signal });
  if (tracks.length === 0) {
    if (subtitleCursor !== undefined) throw new BiliError('CURSOR_STALE', '字幕轨已不可用，请重新读取');
    return { status: 'empty', tracks: [], cues: [], cuesTotal: 0, coverage: 0 };
  }

  const track =
    tracks.find((item) => !item.isAi && /zh/i.test(item.lan ?? '')) ??
    tracks.find((item) => /zh/i.test(item.lan ?? '')) ??
    tracks[0];

  // 上游字幕轨可能是乱序或越界的，先规范化再算覆盖度。
  const all = normalizeCues(await fetchSubtitle(track.url, { signal, bvid }), durationMs);
  const coverage = durationMs > 0 ? coverageRatio(all, durationMs) : all.length ? 1 : 0;

  return {
    status: all.length ? 'ok' : 'empty',
    track,
    tracks,
    ...pageSubtitleCues(all, { bvid, cid, lan: track.lan, maxCues, subtitleCursor, durationMs }),
    cuesTotal: all.length,
    // 完整字幕轨的末端（切片前），用来区分“轨道本身没铺到尾”和“我们只返回了前 N 条”。
    lastEndMs: all.length ? all[all.length - 1].endMs : 0,
    coverage: Number(coverage.toFixed(3)),
    truncated: all.length > maxCues || subtitleCursor !== undefined,
  };
}
