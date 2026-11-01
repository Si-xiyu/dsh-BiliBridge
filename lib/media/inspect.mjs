/**
 * Stage 2 定向补帧（无 ffmpeg 时的故事板方案）。
 *
 * 故事板 index 给出每格对应的秒数，因此可以按请求时间找最近格；
 * 精度约 ±1s，分辨率取决于平台（常见 480×270/格）。
 * ffmpeg 可用时应优先走真实抽帧；本模块明确标注 accuracy。
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BiliError } from '../bili/errors.mjs';
import { dataDir } from '../bili/store.mjs';
import { downloadImage, getSharp, getStoryboard, videoReferer } from './frames.mjs';

const CACHE_TTL_MS = 24 * 3600 * 1000;

async function fresh(file) {
  try {
    const info = await stat(file);
    return Date.now() - info.mtimeMs < CACHE_TTL_MS;
  } catch {
    return false;
  }
}

function fmt(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const mm = String(Math.floor(total / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

export function normalizeTargets({ timestampsMs = [], intervals = [], maxFrames = 6 } = {}) {
  const targets = [];
  for (const value of timestampsMs) {
    const ms = Number(value);
    if (!Number.isFinite(ms) || ms < 0) throw new BiliError('INVALID_ARGUMENT', `时间点不合法：${value}`);
    targets.push({ requestedMs: Math.round(ms) });
  }
  for (const interval of intervals) {
    const start = Number(interval?.startMs);
    const end = Number(interval?.endMs);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      throw new BiliError('INVALID_ARGUMENT', '区间需要 startMs < endMs');
    }
    const length = end - start;
    const count = Math.min(3, Math.max(2, Math.round(length / 8000)));
    for (let index = 0; index < count; index += 1) {
      const at = count === 1 ? start : start + (length * index) / (count - 1);
      targets.push({ requestedMs: Math.round(at), reason: interval.reason });
    }
  }
  if (targets.length === 0) throw new BiliError('INVALID_ARGUMENT', '需要 timestampsMs 或 intervals');
  const cap = Math.min(Math.max(Number(maxFrames) || 6, 1), 9);
  return targets.slice(0, cap);
}

async function loadSprite({ bvid, cid, signal }) {
  const dir = join(dataDir(), 'cache', bvid);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `storyboard-sprite-${cid}.jpg`);
  const meta = await getStoryboard({ bvid, cid, signal });
  if (await fresh(file)) return { meta, buffer: await readFile(file), cached: true };
  const sprite = await downloadImage(meta.images[0], { signal, referer: videoReferer(bvid) });
  await writeFile(file, sprite.buffer, { mode: 0o600 });
  return { meta, buffer: sprite.buffer, cached: false };
}

/**
 * @param {{video:object, cid:string|number, timestampsMs?:number[], intervals?:object[], maxFrames?:number, signal?:AbortSignal}} options
 */
export async function buildInspection({ video, cid, timestampsMs = [], intervals = [], maxFrames = 6, signal } = {}) {
  const targets = normalizeTargets({ timestampsMs, intervals, maxFrames });
  const { meta, buffer, cached } = await loadSprite({ bvid: video.bvid, cid, signal });
  const sharp = await getSharp();

  const info = await sharp(buffer).metadata();
  const cols = meta.cols;
  const rows = meta.rows;
  const tileWidth = Math.floor((info.width ?? cols * meta.tileWidth) / cols);
  const tileHeight = Math.floor((info.height ?? rows * meta.tileHeight) / rows);
  const total = cols * rows;
  const valid = Math.max(1, Math.min(meta.index.length || total, total));

  const used = new Set();
  const frames = [];
  for (const target of targets) {
    const seconds = target.requestedMs / 1000;
    let bestOrder = 0;
    let bestDelta = Infinity;
    for (let order = 0; order < valid; order += 1) {
      const at = meta.index[order];
      if (!Number.isFinite(at)) continue;
      const delta = Math.abs(at - seconds);
      if (delta < bestDelta && !used.has(order)) {
        bestDelta = delta;
        bestOrder = order;
      }
    }
    used.add(bestOrder);
    const actualSec = meta.index[bestOrder] ?? 0;
    frames.push({
      requestedMs: target.requestedMs,
      actualMs: Math.round(actualSec * 1000),
      deltaMs: Math.round((actualSec - seconds) * 1000),
      order: bestOrder,
      reason: target.reason,
      x: bestOrder % cols,
      y: Math.floor(bestOrder / cols),
    });
  }

  const outTileW = 640;
  const outTileH = 360;
  const columns = frames.length > 1 ? 2 : 1;
  const rowsOut = Math.ceil(frames.length / columns);
  const composites = [];
  const labels = [];

  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index];
    const tile = await sharp(buffer)
      .extract({ left: frame.x * tileWidth, top: frame.y * tileHeight, width: tileWidth, height: tileHeight })
      .resize(outTileW, outTileH, { fit: 'fill' })
      .toBuffer();
    const left = (index % columns) * outTileW;
    const top = Math.floor(index / columns) * outTileH;
    composites.push({ input: tile, left, top });
    const label = `req ${fmt(frame.requestedMs)} / got ${fmt(frame.actualMs)}`;
    labels.push(
      `<text x="${left + 10}" y="${top + outTileH - 12}" font-size="22" font-family="monospace" fill="#fff" stroke="#000" stroke-width="3" paint-order="stroke">${label}</text>`,
    );
  }

  const overlay = Buffer.from(
    `<svg width="${outTileW * columns}" height="${outTileH * rowsOut}" xmlns="http://www.w3.org/2000/svg">${labels.join('')}</svg>`,
  );
  const image = await sharp({
    create: { width: outTileW * columns, height: outTileH * rowsOut, channels: 3, background: '#000000' },
  })
    .composite([...composites, { input: overlay, left: 0, top: 0 }])
    .jpeg({ quality: 88 })
    .toBuffer();

  // 落盘一份，供“模型不支持图片”时直接给用户看路径。
  const dir = join(dataDir(), 'cache', video.bvid);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `inspect-${cid}-${Date.now()}.jpg`);
  await writeFile(file, image, { mode: 0o600 });

  return {
    frames,
    image: {
      buffer: image,
      mediaType: 'image/jpeg',
      path: file,
      layout: '每格标注 req=请求时间 / got=故事板实际时间',
      accuracy: 'approx-2s',
      note: '故事板 index 是秒级抽样，目标时间与最近格可能差 1–2 秒；只用于确认画面内容。',
      source: 'storyboard',
      cached,
    },
  };
}
