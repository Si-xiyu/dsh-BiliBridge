/**
 * Stage 2 定向补帧。
 *
 * 两种来源，必须明确区分，不允许把兜底说成精确：
 * - `ffmpeg`：用 playurl 拿 DASH 流，按时间点精确抽帧（误差约一帧，≤100ms）。
 * - `storyboard`：裁 B站 预生成的雪碧图（格间距通常 6–8s，误差可达数秒）。
 *
 * ffmpeg 缺失 / playurl 失败时自动降级到故事板，并在返回值里写明 `source` 与 `maxErrorMs`。
 */
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BiliError } from '../bili/errors.mjs';
import { getPlayUrls } from '../bili/playurl.mjs';
import { dataDir } from '../bili/store.mjs';
import { extractFrame } from './ffmpeg.mjs';
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

/** 把时间点/区间展开成待抽帧的时间列表。 */
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

/** 故事板格间距：用来如实报告精度，而不是写死 ±1s。 */
export function medianGapSeconds(index) {
  const points = (index ?? []).filter((value) => Number.isFinite(value));
  if (points.length < 2) return null;
  const gaps = [];
  for (let i = 1; i < points.length; i += 1) gaps.push(points[i] - points[i - 1]);
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}

/** 统一拼图：每格左下角打标签。 */
async function composeGrid(frames, { columns, tileWidth, tileHeight, labelFor }) {  const sharp = await getSharp();
  const rowsOut = Math.ceil(frames.length / columns);
  const composites = [];
  const labels = [];

  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index];
    const tile = await sharp(frame.buffer).resize(tileWidth, tileHeight, { fit: 'fill' }).toBuffer();
    const left = (index % columns) * tileWidth;
    const top = Math.floor(index / columns) * tileHeight;
    composites.push({ input: tile, left, top });
    const label = labelFor(frame);
    labels.push(
      `<text x="${left + 10}" y="${top + tileHeight - 12}" font-size="22" font-family="monospace" fill="#fff" stroke="#000" stroke-width="3" paint-order="stroke">${label}</text>`,
    );
  }

  const overlay = Buffer.from(
    `<svg width="${tileWidth * columns}" height="${tileHeight * rowsOut}" xmlns="http://www.w3.org/2000/svg">${labels.join('')}</svg>`,
  );
  return sharp({
    create: { width: tileWidth * columns, height: tileHeight * rowsOut, channels: 3, background: '#000000' },
  })
    .composite([...composites, { input: overlay, left: 0, top: 0 }])
    .jpeg({ quality: 88 })
    .toBuffer();
}

/** 落盘一份，供“模型不支持图片”时给用户看路径。 */
async function persist(buffer, bvid, cid) {
  const dir = join(dataDir(), 'cache', bvid);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `inspect-${cid}-${Date.now()}.jpg`);
  await writeFile(file, buffer, { mode: 0o600 });
  return file;
}

/** 真实抽帧：playurl → ffmpeg 逐点抽帧。任一步失败都会抛错，由上层决定是否降级。 */
export async function buildRealFrames({ video, cid, targets, jar, signal }) {
  const play = await getPlayUrls({ bvid: video.bvid, cid, jar, signal, referer: videoReferer(video.bvid) });
  const dir = join(dataDir(), 'cache', video.bvid);
  await mkdir(dir, { recursive: true, mode: 0o700 });

  const frames = [];
  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index];
    const outFile = join(dir, `ffmpeg-${cid}-${target.requestedMs}-${Date.now()}-${index}.jpg`);
    try {
      const buffer = await extractFrame({
        url: play.videoUrl,
        atMs: target.requestedMs,
        outFile,
        referer: videoReferer(video.bvid),
        signal,
      });
      frames.push({
        buffer,
        requestedMs: target.requestedMs,
        // 输入侧 seek + 单帧输出，实际时间与请求时间之差在一帧之内。
        actualMs: target.requestedMs,
        deltaMs: 0,
        reason: target.reason,
      });
    } finally {
      // 帧已经读进内存，临时文件不留在磁盘上。
      await rm(outFile, { force: true }).catch(() => {});
    }
  }

  const image = await composeGrid(frames, {
    columns: frames.length > 1 ? 2 : 1,
    tileWidth: 640,
    tileHeight: 360,
    labelFor: (frame) => `req ${fmt(frame.requestedMs)}`,
  });

  return {
    frames: frames.map(({ buffer, ...rest }) => rest),
    image: {
      buffer: image,
      mediaType: 'image/jpeg',
      path: await persist(image, video.bvid, cid),
      layout: '每格标注 req=请求时间；ffmpeg 精确抽帧',
      accuracy: 'exact',
      maxErrorMs: 100,
      source: 'ffmpeg',
      quality: play.quality,
      note: `ffmpeg 按时间点抽帧（${play.quality.label}）；误差在一帧内。`,
      cached: false,
    },
  };
}

/** 故事板兜底：裁雪碧图最近格。 */
export async function buildStoryboardFrames({ video, cid, targets, signal }) {
  const dir = join(dataDir(), 'cache', video.bvid);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `storyboard-sprite-${cid}.jpg`);
  const meta = await getStoryboard({ bvid: video.bvid, cid, signal });
  const cached = await fresh(file);
  const sprite = cached ? await readFile(file) : (await downloadImage(meta.images[0], { signal, referer: videoReferer(video.bvid) })).buffer;
  if (!cached) await writeFile(file, sprite, { mode: 0o600 });

  const sharp = await getSharp();
  const info = await sharp(sprite).metadata();
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
    let bestOrder = -1;
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
    let reused = false;
    if (bestOrder < 0) {
      // 目标数超过有效格数：允许复用，但必须标出来，不能让模型以为是新画面。
      reused = true;
      bestDelta = Infinity;
      for (let order = 0; order < valid; order += 1) {
        const at = meta.index[order];
        if (!Number.isFinite(at)) continue;
        const delta = Math.abs(at - seconds);
        if (delta < bestDelta) {
          bestDelta = delta;
          bestOrder = order;
        }
      }
    }
    if (bestOrder < 0) bestOrder = 0;
    used.add(bestOrder);

    const buffer = await sharp(sprite)
      .extract({
        left: (bestOrder % cols) * tileWidth,
        top: Math.floor(bestOrder / cols) * tileHeight,
        width: tileWidth,
        height: tileHeight,
      })
      .jpeg({ quality: 92 })
      .toBuffer();

    frames.push({
      buffer,
      requestedMs: target.requestedMs,
      actualMs: Math.round((meta.index[bestOrder] ?? 0) * 1000),
      deltaMs: Math.round((meta.index[bestOrder] ?? seconds) * 1000 - target.requestedMs),
      reason: target.reason,
      order: bestOrder,
      reused,
    });
  }

  const gap = medianGapSeconds(meta.index);
  const maxErrorMs = gap ? Math.round((gap / 2) * 1000) : null;

  const image = await composeGrid(frames, {
    columns: frames.length > 1 ? 2 : 1,
    tileWidth: 640,
    tileHeight: 360,
    labelFor: (frame) => `req ${fmt(frame.requestedMs)} / got ${fmt(frame.actualMs)}${frame.reused ? ' (reused)' : ''}`,
  });

  return {
    frames: frames.map(({ buffer, ...rest }) => rest),
    image: {
      buffer: image,
      mediaType: 'image/jpeg',
      path: await persist(image, video.bvid, cid),
      layout: '每格标注 req=请求时间 / got=故事板实际时间',
      accuracy: 'storyboard',
      maxErrorMs,
      source: 'storyboard',
      tileGapMs: gap ? Math.round(gap * 1000) : null,
      note:
        maxErrorMs === null
          ? '故事板兜底：格间距未知，时间误差可能达数秒。'
          : `故事板兜底：格间距约 ${gap.toFixed(1)}s，时间误差最多约 ${(maxErrorMs / 1000).toFixed(1)}s；读小字需要 ffmpeg。`,
      cached,
    },
  };
}

/**
 * @param {{
 *   video: object, cid: string|number, timestampsMs?: number[], intervals?: object[],
 *   maxFrames?: number, signal?: AbortSignal, jar?: any, source?: 'auto'|'ffmpeg'|'storyboard',
 * }} options
 */
export async function buildInspection(options = {}) {
  const { video, cid, timestampsMs = [], intervals = [], maxFrames = 6, signal, jar, source = 'auto' } = options;
  const targets = normalizeTargets({ timestampsMs, intervals, maxFrames });

  let fallbackReason;
  if (source !== 'storyboard') {
    try {
      const result = await buildRealFrames({ video, cid, targets, jar, signal });
      return { ...result, fallbackReason: undefined };
    } catch (error) {
      if (source === 'ffmpeg') throw error;
      fallbackReason = { code: error?.code ?? 'ERROR', message: String(error?.message ?? error).slice(0, 200) };
    }
  }

  const result = await buildStoryboardFrames({ video, cid, targets, signal });
  return { ...result, fallbackReason };
}
