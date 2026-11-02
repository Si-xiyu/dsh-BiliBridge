/**
 * Stage 2 定向补帧。
 *
 * 两种来源，必须明确区分，不允许把兜底说成精确：
 * - `ffmpeg`：用 playurl 拿 DASH 流，按时间点精确抽帧（误差约一帧，≤100ms）。
 * - `storyboard`：裁 B站 预生成的雪碧图（格间距通常 6–8s，误差可达数秒）。
 *
 * ffmpeg 缺失 / playurl 失败时自动降级到故事板，并在返回值里写明 `source` 与 `maxErrorMs`。
 */
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BiliError } from '../bili/errors.mjs';
import { getPlayUrls } from '../bili/playurl.mjs';
import { dataDir } from '../bili/store.mjs';
import { extractFrame } from './ffmpeg.mjs';
import {
  cropStoryboardTile,
  getSharp,
  getStoryboard,
  loadStoryboardSprite,
  locateStoryboardOrder,
  spriteIndexOfOrder,
  videoReferer,
} from './frames.mjs';
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
export function normalizeTargets({ timestampsMs = [], intervals = [], maxFrames = 6, durationMs } = {}) {
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

  // 时间点必须落在当前分 P 内：越界时故事板会默默映射到最后一格，
  // ffmpeg 则可能直接失败——两种都不该被当成“请求时间的画面”。
  const limit = Number(durationMs) || 0;
  if (limit > 0) {
    const outOfRange = targets.find((target) => target.requestedMs > limit);
    if (outOfRange) {
      throw new BiliError(
        'INVALID_ARGUMENT',
        `时间点 ${outOfRange.requestedMs}ms 超出当前分 P 时长 ${limit}ms；请改用该分 P 内的时间`,
      );
    }
  }

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
async function composeGrid(frames, { columns, tileWidth, tileHeight, labelFor }) {
  const sharp = await getSharp();
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
        // 我们没有读实际 PTS（ffmpeg 只给单帧 JPEG），所以不能声称“实际时间就是请求时间”。
        // 保留 null，并在 image.maxErrorMs 里给一个理论上界，让模型知道这是“按时间点 seek”，不是测量值。
        actualMs: null,
        deltaMs: null,
        timeSource: 'input-seek',
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
      layout: '每格标注 req=请求时间；ffmpeg 按时间点 seek 抽帧',
      accuracy: 'bounded',
      maxErrorMs: 100,
      source: 'ffmpeg',
      quality: play.quality,
      note:
        `ffmpeg 用输入侧 -ss 在请求时间抽帧（${play.quality.label}），` +
        '没有读取实际 PTS，所以只给“误差上限约一帧”的界，不声称精确到毫秒。',
      cached: false,
    },
  };
}

/** 故事板兜底：裁雪碧图最近格（跨多张雪碧图定位，长视频也能落到正确位置）。 */
export async function buildStoryboardFrames({ video, cid, targets, signal }) {
  const meta = await getStoryboard({ bvid: video.bvid, cid, signal });
  const spriteCache = new Map();
  let anyCached = false;

  const used = new Set();
  const frames = [];
  for (const target of targets) {
    const seconds = target.requestedMs / 1000;
    // 先在全部 index 里定位；-1 表示这张故事板没有时间索引，不能瞎猜一格。
    const order = locateStoryboardOrder(meta, seconds);
    if (order < 0) throw new BiliError('CONTENT_UNAVAILABLE', '故事板没有时间索引，无法按时间定位');
    let reused = false;
    if (used.has(order)) {
      reused = true;
    }
    used.add(order);

    const spriteIndex = spriteIndexOfOrder(meta, order);
    let sprite = spriteCache.get(spriteIndex);
    if (!sprite) {
      const loaded = await loadStoryboardSprite({ bvid: video.bvid, cid, meta, spriteIndex, signal });
      sprite = loaded.buffer;
      anyCached = anyCached || loaded.cached;
      spriteCache.set(spriteIndex, sprite);
    }

    const buffer = await cropStoryboardTile(sprite, meta, order);
    const actualSec = meta.index[order] ?? seconds;

    frames.push({
      buffer,
      requestedMs: target.requestedMs,
      actualMs: Math.round(actualSec * 1000),
      deltaMs: Math.round(actualSec * 1000 - target.requestedMs),
      reason: target.reason,
      order,
      spriteIndex,
      reused,
    });
  }
  const cached = anyCached;
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
 *   durationMs?: number,
 * }} options `durationMs` 是**当前分 P** 的时长，用来拒绝越界时间点
 */
export async function buildInspection(options = {}) {
  const {
    video,
    cid,
    timestampsMs = [],
    intervals = [],
    maxFrames = 6,
    signal,
    jar,
    source = 'auto',
    durationMs,
  } = options;
  const targets = normalizeTargets({ timestampsMs, intervals, maxFrames, durationMs });

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
