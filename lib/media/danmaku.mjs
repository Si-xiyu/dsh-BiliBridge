/**
 * 弹幕：抓 XML、按时间桶采样，保留密度变化。
 */
import { inflateRawSync, inflateSync } from 'node:zlib';

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

export async function getDanmaku({ cid, signal, bucketSec = 30, limit = 60 } = {}) {
  const url = new URL(DM_LIST);
  url.searchParams.set('oid', String(cid));
  const signals = [AbortSignal.timeout(20_000)];
  if (signal) signals.push(signal);
  const response = await fetch(url, {
    headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://www.bilibili.com/' },
    signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0],
  });
  if (!response.ok) throw new Error(`弹幕下载失败：HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > MAX_DANMAKU_BYTES) throw new Error('弹幕超过 16MB 限制');
  const xml = maybeInflate(buffer);
  const items = parseDanmakuXml(xml);
  return { status: items.length ? 'ok' : 'empty', ...sampleDanmaku(items, { bucketSec, limit }) };
}
