/**
 * 弹幕：抓 XML、按时间桶采样，保留密度变化。
 */
import { inflateRawSync, inflateSync } from 'node:zlib';
import { fetchBuffer } from '../bili/http.mjs';
import { BiliError } from '../bili/errors.mjs';

export function validateDanmakuWindow(window, durationSeconds = Infinity) {
  if (window === undefined) return;
  if (!window || !Number.isFinite(window.startSeconds) || !Number.isFinite(window.endSeconds) || window.startSeconds < 0 || window.endSeconds <= window.startSeconds || window.endSeconds > durationSeconds) {
    throw new BiliError('INVALID_ARGUMENT', '弹幕窗口必须落在当前分 P 时长内');
  }
}

const DM_LIST = 'https://api.bilibili.com/x/v1/dm/list.so';
const MAX_DANMAKU_BYTES = 16 * 1024 * 1024;

function decodeXml(text) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function maybeInflate(buffer) {
  if (buffer.length > 2 && buffer[0] === 0x78) {
    try {
      return inflateSync(buffer).toString('utf8');
    } catch {
      // fall through
    }
  }
  try {
    return inflateRawSync(buffer).toString('utf8');
  } catch {
    return buffer.toString('utf8');
  }
}

export function parseDanmakuXml(xml) {
  const items = [];
  const re = /<d p="([^"]*)"[^>]*>([\s\S]*?)<\/d>/g;
  let match;
  while ((match = re.exec(xml)) !== null) {
    const parts = match[1].split(',');
    const timeSec = Number(parts[0]);
    if (!Number.isFinite(timeSec)) continue;
    const text = decodeXml(match[2].replace(/\s+/g, ' ').trim());
    if (!text) continue;
    items.push({ timeSec, text });
  }
  return items;
}

/**
 * 按 30s 分桶：返回密度 + 每桶代表性弹幕（取较长的，减少“前排”“哈哈哈”）。
 */
export function sampleDanmaku(items, { bucketSec = 30, limit = 60, perBucket = 2 } = {}) {
  const buckets = new Map();
  for (const item of items) {
    const key = Math.floor(item.timeSec / bucketSec);
    const list = buckets.get(key) ?? [];
    list.push(item);
    buckets.set(key, list);
  }

  const density = [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([key, list]) => ({
      startSec: key * bucketSec,
      endSec: (key + 1) * bucketSec,
      count: list.length,
    }));

  const samples = [];
  for (const [, list] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    const picked = [...list].sort((a, b) => b.text.length - a.text.length).slice(0, perBucket);
    for (const item of picked) {
      if (samples.length >= limit) break;
      samples.push({ timeSec: item.timeSec, text: item.text.slice(0, 120) });
    }
    if (samples.length >= limit) break;
  }

  return { total: items.length, density, samples };
}

export async function getDanmaku({ cid, bvid, signal, bucketSec = 30, limit = 60, danmakuWindow } = {}) {
  validateDanmakuWindow(danmakuWindow);
  const url = new URL(DM_LIST);
  url.searchParams.set('oid', String(cid));
  const { buffer } = await fetchBuffer(url, {
    referer: bvid ? `https://www.bilibili.com/video/${bvid}` : undefined,
    signal,
    timeoutMs: 20_000,
    maxBytes: MAX_DANMAKU_BYTES,
  });
  const xml = maybeInflate(buffer);
  const items = parseDanmakuXml(xml);
  const selected = danmakuWindow ? items.filter(i => i.timeSec >= danmakuWindow.startSeconds && i.timeSec < danmakuWindow.endSeconds) : items;
  return { status: selected.length ? 'ok' : 'empty', ...sampleDanmaku(selected, { bucketSec, limit }),
    availableTotal: items.length, window: danmakuWindow ?? null, note: '计数仅针对当前接口可获取集合，不是历史全量' };
}
