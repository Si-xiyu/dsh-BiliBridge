/** Adaptive scan orchestration. No new services: FFmpeg, sharp and the existing cache store. */
import { createHash } from 'node:crypto';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BiliError } from '../bili/errors.mjs';
import { dataDir, readJson, writeJsonAtomic } from '../bili/store.mjs';
import { getPlayUrls } from '../bili/playurl.mjs';
import { analysisConfig } from './analysis-config.mjs';
import { scanVideo } from './ffmpeg.mjs';
import { cropStoryboardTile, getSharp, getStoryboard, loadStoryboardSprite, spriteIndexOfOrder, validTileCount, videoReferer } from './frames.mjs';
import { frameFeature, selectAdaptive } from './adaptive-selection.mjs';

export const ADAPTIVE_DEFAULTS = Object.freeze({ adaptiveEnabled: true, scanWidth: 160,
  candidateBudget: 180, waveletEnabled: true, waveletLevel: 3,
  facilityWeight: 1, segmentCoverageWeight: 0.2, segmentCoverageTau: 1,
  // 选中的时间点允许在 ±sharpenWindowMs 内换一帧更清晰的（不跨片段）；
  // minGapMs 是"软间隔"：优先选离已选帧足够远的，候选不够时才放宽。
  sharpenWindowMs: 1500, minGapMs: 5000, timeoutMs: 60000 });

export async function adaptiveConfig() {
  const raw = (await readJson(join(dataDir(), 'config.json')))?.adaptive ?? {};
  const result = { ...ADAPTIVE_DEFAULTS };
  for (const key of ['adaptiveEnabled', 'waveletEnabled']) if (typeof raw[key] === 'boolean') result[key] = raw[key];
  const ranges = { scanFps: [0.1, 4], scanWidth: [64, 320], candidateBudget: [60, 300],
    waveletLevel: [1, 6], facilityWeight: [0, 10], segmentCoverageWeight: [0, 10],
    segmentCoverageTau: [0.1, 10], sharpenWindowMs: [0, 5000], minGapMs: [0, 60000], timeoutMs: [1000, 60000] };
  for (const [key, [min, max]] of Object.entries(ranges)) {
    if (Number.isFinite(raw[key]) && raw[key] >= min && raw[key] <= max &&
      (!['scanWidth', 'candidateBudget', 'waveletLevel', 'sharpenWindowMs', 'minGapMs', 'timeoutMs'].includes(key) || Number.isInteger(raw[key]))) result[key] = raw[key];
  }
  return result;
}

export function adaptiveRange({ durationMs, range, maxFrames = 9 }) {
  if (!Number.isInteger(maxFrames) || maxFrames < 1 || maxFrames > 9) {
    throw new BiliError('INVALID_ARGUMENT', `maxFrames 必须是 1–9 的整数（收到 ${String(maxFrames)}）`);
  }
  if (range !== undefined && (!range || typeof range !== 'object' || Array.isArray(range))) {
    throw new BiliError('INVALID_ARGUMENT', 'range 必须是 { startMs, endMs } 对象');
  }
  const startMs = range === undefined ? 0 : range.startMs;
  const endMs = range === undefined ? durationMs : range.endMs;
  if (!Number.isInteger(startMs) || !Number.isInteger(endMs)) {
    throw new BiliError('INVALID_ARGUMENT', 'range.startMs / range.endMs 必须是整数毫秒');
  }
  if (startMs < 0 || endMs > durationMs) {
    throw new BiliError('INVALID_ARGUMENT', `range 超出当前分 P（允许 0–${durationMs}ms，收到 ${startMs}–${endMs}ms）`);
  }
  if (startMs >= endMs) {
    throw new BiliError('INVALID_ARGUMENT', `range 需要 startMs < endMs（收到 ${startMs}–${endMs}ms）`);
  }
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new BiliError('INVALID_ARGUMENT', '当前分 P 时长无效，无法做自适应选帧');
  }
  return { startMs, endMs, maxFrames };
}

function checkAbort(signal) {
  if (signal?.aborted) throw new BiliError('CANCELLED', '自适应选帧已取消');
}

export async function imageFeature(buffer) {
  const sharp = await getSharp();
  const rgb = await sharp(buffer).resize(32, 32, { fit: 'fill' }).removeAlpha().toColourspace('srgb').raw().toBuffer();
  return frameFeature(rgb, 32, 32);
}

// A bounded raw file avoids pipes and thousands of intermediate JPEGs. Read one frame at a time.
async function realScan({ video, cid, jar, signal, startMs, endMs, config }) {
  const seconds = (endMs - startMs) / 1000;
  const fps = Math.min(config.scanFps ?? (seconds <= 300 ? 2 : seconds <= 900 ? 1.5 : 1), 3600 / seconds);
  const play = await getPlayUrls({ bvid: video.bvid, cid, jar, signal, qn: 16 });
  checkAbort(signal);
  const dir = await mkdtemp(join(tmpdir(), 'bili-adaptive-'));
  try {
    const file = join(dir, 'scan.rgb');
    const width = config.scanWidth, height = Math.round(width * 9 / 16);
    await scanVideo({ url: play.videoUrl, outFile: file, startMs, endMs, fps, width, height,
      referer: videoReferer(video.bvid), signal, timeoutMs: config.timeoutMs });
    const handle = await open(file, 'r');
    const frames = [];
    try {
      const size = width * height * 3;
      const count = Math.floor((await handle.stat()).size / size);
      if (count > 3601) throw new BiliError('INVALID_RESPONSE', '扫描帧数超出预算');
      const sharp = await getSharp();
      for (let index = 0; index < count; index++) {
        checkAbort(signal);
        const rgb = Buffer.alloc(size);
        const { bytesRead } = await handle.read(rgb, 0, size, index * size);
        if (bytesRead !== size) throw new BiliError('INVALID_RESPONSE', '扫描帧数据不完整');
        const atMs = Math.round(startMs + index * 1000 / fps);
        if (atMs >= endMs) break;
        const small = await sharp(rgb, { raw: { width, height, channels: 3 } }).resize(32, 32, { fit: 'fill' }).raw().toBuffer();
        frames.push({ atMs: Math.round(atMs), feature: frameFeature(small, 32, 32) });
      }
    } finally { await handle.close(); }
    if (!frames.length) throw new BiliError('CONTENT_UNAVAILABLE', '扫描没有得到可用帧');
    return { frames, source: 'ffmpeg', timeSource: 'fps-grid', scanFps: fps };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

export async function storyboardScan({ video, cid, signal, startMs, endMs }) {
  const meta = await getStoryboard({ bvid: video.bvid, cid, signal });
  const orders = Array.from({ length: validTileCount(meta) }, (_, order) => order)
    .filter((order) => meta.index[order] * 1000 >= startMs && meta.index[order] * 1000 < endMs);
  // Keep at most 3600 evenly distributed tiles, including both ends.
  const sample = orders.length <= 3600 ? orders : Array.from({ length: 3600 }, (_, i) => orders[Math.round(i * (orders.length - 1) / 3599)]);
  const frames = [];
  let spriteIndex = -1, sprite;
  for (const order of sample) {
    checkAbort(signal);
    const next = spriteIndexOfOrder(meta, order);
    if (next !== spriteIndex) {
      sprite = (await loadStoryboardSprite({ bvid: video.bvid, cid, meta, spriteIndex: next, signal })).buffer;
      spriteIndex = next;
    }
    const buffer = await cropStoryboardTile(sprite, meta, order);
    frames.push({ atMs: Math.round(meta.index[order] * 1000), feature: await imageFeature(buffer) });
  }
  if (!frames.length) throw new BiliError('CONTENT_UNAVAILABLE', '所选区间没有可用故事板帧');
  return { frames, source: 'storyboard', timeSource: 'storyboard-index' };
}

function validScan(value, startMs, endMs) {
  return value && ['ffmpeg', 'storyboard'].includes(value.source) && Array.isArray(value.frames) && value.frames.length > 0 && value.frames.length <= 3601 &&
    value.frames.every((f) => f && Number.isFinite(f.atMs) && f.atMs >= startMs && f.atMs < endMs &&
      Array.isArray(f.feature?.histogram) && f.feature.histogram.length === 96 && f.feature.histogram.every((v) => Number.isFinite(v) && v >= 0) &&
      Math.abs(f.feature.histogram.reduce((sum, v) => sum + v, 0) - 1) < 1e-6 &&
      Array.isArray(f.feature.hash) && f.feature.hash.length === 63 && f.feature.hash.every((v) => v === 0 || v === 1));
}

export async function adaptiveFrames(options, dependencies = {}) {
  const { video, cid, jar, signal, references = [], source = 'auto' } = options;
  const range = adaptiveRange(options);
  const config = { ...await adaptiveConfig(), ...options.config };
  const cacheConfig = analysisConfig().cache;
  const pathFor = (startMs, endMs) => join(dataDir(), 'cache', 'adaptive', `${createHash('sha256')
    .update(JSON.stringify([2, video.bvid, String(cid), startMs, endMs, source, config])).digest('hex')}.json`);
  const file = pathFor(range.startMs, range.endMs);
  checkAbort(signal);
  const record = cacheConfig.enabled ? await readJson(file) : null;
  let scan = record && record.writtenAt <= Date.now() && Date.now() - record.writtenAt < cacheConfig.ttlMs &&
    validScan(record.scan, range.startMs, range.endMs) ? record.scan : null;
  if (!scan && cacheConfig.enabled && (range.startMs !== 0 || range.endMs !== options.durationMs)) {
    const full = await readJson(pathFor(0, options.durationMs));
    if (full && full.writtenAt <= Date.now() && Date.now() - full.writtenAt < cacheConfig.ttlMs && validScan(full.scan, 0, options.durationMs)) {
      const frames = full.scan.frames.filter((frame) => frame.atMs >= range.startMs && frame.atMs < range.endMs);
      if (frames.length) scan = { ...full.scan, frames };
    }
  }
  const cached = Boolean(scan);
  if (!scan) {
    const scanOptions = { video, cid, jar, signal, ...range, config };
    if (source === 'storyboard') scan = await (dependencies.storyboardScan ?? storyboardScan)(scanOptions);
    else {
      try { scan = await (dependencies.realScan ?? realScan)(scanOptions); }
      catch (error) {
        checkAbort(signal);
        if (error.code === 'CANCELLED' || source === 'ffmpeg') throw error;
        scan = await (dependencies.storyboardScan ?? storyboardScan)(scanOptions);
        scan.fallbackReason = { code: error.code ?? 'ERROR', message: '低分辨率扫描失败，已使用平台故事板' };
      }
    }
    checkAbort(signal);
    // Do not retain transient fallbacks for the full cache TTL: next invocation can retry FFmpeg.
    if (cacheConfig.enabled && !scan.fallbackReason) await writeJsonAtomic(file, { writtenAt: Date.now(), scan }).catch(() => {});
  }
  // Uniform 参考帧必须和扫描帧用**同一条特征管线**：故事板格是低清压缩图，
  // 直接拿它的特征和视频扫描帧比，同一时刻相似度实测只有 0.17–0.68，
  // 会让"与 Uniform 互补"这项算错。所以允许传时间点，就地映射到最近的扫描帧。
  const referenceFeatures = references.map((reference) => {
    const atMs = Number.isFinite(reference) ? reference : (Number.isFinite(reference?.atMs) ? reference.atMs : null);
    if (atMs === null) return reference;
    if (reference?.feature) return reference;
    const nearest = scan.frames.reduce((best, frame) => (Math.abs(frame.atMs - atMs) < Math.abs(best.atMs - atMs) ? frame : best), scan.frames[0]);
    return nearest ? nearest.feature : null;
  }).filter(Boolean);
  const selected = selectAdaptive(scan.frames, { ...config, ...range, references: referenceFeatures });
  return { ...selected, source: scan.source, timeSource: scan.timeSource, scanFps: scan.scanFps,
    fallbackReason: scan.fallbackReason, cached, range: { startMs: range.startMs, endMs: range.endMs } };
}
