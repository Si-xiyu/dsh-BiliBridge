/**
 * Stage 2 定向补帧。
 *
 * 两种来源，必须明确区分，不允许把兜底说成精确：
 * - `ffmpeg`：用 playurl 拿 DASH 流，按时间点精确抽帧（误差约一帧，≤100ms）。
 * - `storyboard`：裁 B站 预生成的雪碧图（格间距通常 6–8s，误差可达数秒）。
 *
 * ffmpeg 缺失 / playurl 失败时自动降级到故事板，并在返回值里写明 `source` 与 `maxErrorMs`。
 */
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BiliError } from '../bili/errors.mjs';
import { getPlayUrls } from '../bili/playurl.mjs';
import { dataDir } from '../bili/store.mjs';
import { extractFrame } from './ffmpeg.mjs';
import { buildSubtitleTranscript, normalizeBandRatio, normalizeOcrText, planSamples, recognizeImageDir } from './ocr.mjs';
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

/**
 * 每张拼图最多 6 格（2×3）。
 *
 * 宿主会把整张图缩进自己的视觉预算，格子越多 → 整图越高 → 每格被压得越狠。
 * 2×3 的 1280×1080 已经接近常见 1.15MP 上限，再往上加行只会让每格更糊。
 */
export const TILES_PER_SHEET = 6;
const SHEET_COLUMNS = 2;

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

/**
 * 把帧切成若干张图，每张最多 `perSheet` 格。
 *
 * 按“张数”均分而不是贪婪切满：7 帧是 4+3，不是 6+1——尾图只剩一格既浪费一张附件，
 * 又会让那张图画布很矮、和其他图比例不一致。
 */
export function planSheets(frameCount, perSheet = TILES_PER_SHEET) {
  const total = Math.max(0, Math.floor(Number(frameCount) || 0));
  const size = Math.max(1, Math.floor(Number(perSheet) || TILES_PER_SHEET));
  if (total === 0) return [];
  const sheetCount = Math.ceil(total / size);
  const base = Math.floor(total / sheetCount);
  const extra = total % sheetCount;
  const sheets = [];
  let start = 0;
  for (let index = 0; index < sheetCount; index += 1) {
    const count = base + (index < extra ? 1 : 0);
    sheets.push({ start, count });
    start += count;
  }
  return sheets;
}

/** 拼一张或多张图：单张时 1 列，多帧时 2 列，超过 6 格自动分图。 */
export async function composeSheets(frames, options) {
  const sheets = [];
  for (const [index, plan] of planSheets(frames.length).entries()) {
    const slice = frames.slice(plan.start, plan.start + plan.count);
    sheets.push({
      sheet: index + 1,
      start: plan.start,
      count: plan.count,
      buffer: await composeGrid(slice, { ...options, columns: slice.length > 1 ? SHEET_COLUMNS : 1 }),
    });
  }
  return sheets;
}

/** 落盘一份，供“模型不支持图片”时给用户看路径；sheet 后缀保证多图不互相覆盖。 */
async function persist(buffer, bvid, cid, sheet) {
  const dir = join(dataDir(), 'cache', bvid);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `inspect-${cid}-${Date.now()}-${sheet}.jpg`);
  await writeFile(file, buffer, { mode: 0o600 });
  return file;
}

/** 拼图落盘并生成附件元数据；每张图一条，调用方按数组返回。 */
async function buildImageEntries(sheets, { bvid, cid, layout, ...meta }) {
  const images = [];
  for (const sheet of sheets) {
    images.push({
      ...meta,
      buffer: sheet.buffer,
      mediaType: 'image/jpeg',
      path: await persist(sheet.buffer, bvid, cid, sheet.sheet),
      sheet: sheet.sheet,
      sheetCount: sheets.length,
      frameStart: sheet.start,
      frameCount: sheet.count,
      layout: `第 ${sheet.sheet}/${sheets.length} 张：${layout}`,
    });
  }
  return images;
}

/** 真实抽帧：playurl → ffmpeg 逐点抽帧。任一步失败都会抛错，由上层决定是否降级。 */
export async function buildRealFrames({ video, cid, targets, jar, signal, retainBuffers = false }) {
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
        // 保留 null，并在 images[].maxErrorMs 里给一个理论上界，让模型知道这是“按时间点 seek”，不是测量值。
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

  const sheets = await composeSheets(frames, {
    tileWidth: 640,
    tileHeight: 360,
    labelFor: (frame) => `req ${fmt(frame.requestedMs)}`,
  });
  const images = await buildImageEntries(sheets, {
    bvid: video.bvid,
    cid,
    layout: '每格标注 req=请求时间；ffmpeg 按时间点 seek 抽帧（每张最多 2×3）',
    accuracy: 'frame-level',
    // 没有读 PTS，也没有 fps 信息：给不出可验证的毫秒上界，就不编一个数字。
    maxErrorMs: null,
    source: 'ffmpeg',
    quality: play.quality,
    note:
      `ffmpeg 用输入侧 -ss 在请求时间抽帧（${play.quality.label}），` +
      '误差大约一帧（24–30fps 约 33–42ms），但没有读取实际 PTS，因此不声明毫秒上界；' +
      `每张最多 ${TILES_PER_SHEET} 格，超出会拆成多张图；` +
      '需要精确到帧时请以画面内容为准，不要引用毫秒级说法。',
    cached: false,
  });

  return {
    ...(retainBuffers ? { _ocrFrames: frames } : {}),
    frames: frames.map(({ buffer, ...rest }) => rest),
    images,
  };
}

/**
 * 故事板匹配的实际最大偏差（毫秒）。
 *
 * 不能拿“格间距中位数的一半”当上界：格间距不均匀时（例如 [0,2,4,6,100]），
 * 请求 50s 会匹配到 6s（偏差 44s），而中位间距的一半只有 1s。
 */
export function maxAbsDeltaMs(frames) {
  let worst = null;
  for (const frame of frames ?? []) {
    // Number(null) 是 0，会冒充“零偏差”，所以显式跳过空值。
    if (frame?.deltaMs === null || frame?.deltaMs === undefined) continue;
    const delta = Math.abs(Number(frame.deltaMs));
    if (Number.isFinite(delta) && (worst === null || delta > worst)) worst = delta;
  }
  return worst;
}

/** 故事板兜底：裁雪碧图最近格（跨多张雪碧图定位，长视频也能落到正确位置）。 */
export async function buildStoryboardFrames({ video, cid, targets, signal, retainBuffers = false }) {
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
  // 每帧都有实测的 deltaMs，直接用它的最大值当误差上界；
  // 中位格间距只是“典型间隔”，格间距不均匀时（例如尾部有大空洞）不能当上界用。
  const worstDeltaMs = maxAbsDeltaMs(frames);

  const sheets = await composeSheets(frames, {
    tileWidth: 640,
    tileHeight: 360,
    labelFor: (frame) => `req ${fmt(frame.requestedMs)} / got ${fmt(frame.actualMs)}${frame.reused ? ' (reused)' : ''}`,
  });
  const note =
    worstDeltaMs === null
      ? '故事板兜底：没有可用的匹配偏差，时间误差未知。'
      : `故事板兜底：本次匹配的最大偏差 ${(worstDeltaMs / 1000).toFixed(1)}s（按每帧 deltaMs 实测）；` +
        `格间距中位数约 ${gap ? gap.toFixed(1) : '?'}s，是典型值而不是误差上界；读小字需要 ffmpeg。`;
  const images = await buildImageEntries(sheets, {
    bvid: video.bvid,
    cid,
    layout: '每格标注 req=请求时间 / got=故事板实际时间（每张最多 2×3）',
    accuracy: 'storyboard',
    maxErrorMs: worstDeltaMs,
    source: 'storyboard',
    typicalGapMs: gap ? Math.round(gap * 1000) : null,
    note,
    cached,
  });

  return {
    ...(retainBuffers ? { _ocrFrames: frames } : {}),
    frames: frames.map(({ buffer, ...rest }) => rest),
    images,
  };
}

/** 先校验再取流，避免无效参数产生网络或进程开销。 */
export function normalizeInspectionOcr({ ocr, ocrRegion = 'frame', bandRatio, subtitleWindow, durationMs } = {}) {
  if (ocr !== undefined && typeof ocr !== 'boolean') throw new BiliError('INVALID_ARGUMENT', 'ocr 必须是布尔值');
  if (subtitleWindow !== undefined) {
    if (!subtitleWindow || typeof subtitleWindow !== 'object' || Array.isArray(subtitleWindow)) throw new BiliError('INVALID_ARGUMENT', 'subtitleWindow 必须是窗口对象');
    if (ocr) throw new BiliError('INVALID_ARGUMENT', '两种 OCR 模式不能同时开启');
    const { startMs, endMs, intervalSeconds = 2 } = subtitleWindow;
    if (typeof intervalSeconds !== 'number') throw new BiliError('INVALID_ARGUMENT', 'intervalSeconds 必须是数字');
    const intervalMs = intervalSeconds * 1000;
    planSamples({ durationMs, startMs, endMs, intervalMs });
    return { mode: 'subtitle-window', startMs, endMs, intervalMs, bandRatio: normalizeBandRatio(subtitleWindow.bandRatio) };
  }
  if (!ocr) return null;
  if (!['frame', 'subtitle-band'].includes(ocrRegion)) throw new BiliError('INVALID_ARGUMENT', 'ocrRegion 必须是 frame 或 subtitle-band');
  return { mode: 'frames', region: ocrRegion, ...(ocrRegion === 'subtitle-band' ? { bandRatio: normalizeBandRatio(bandRatio) } : {}) };
}

/** 文件序号对应返回帧顺序；故事板必须使用实际时间。 */
export function frameOcrEntries(frames, results, region) {
  const texts = new Map();
  for (const item of results) {
    const match = /row-(\d+)\.jpg$/i.exec(item.file ?? '');
    if (match) texts.set(Number(match[1]), normalizeOcrText((item.lines ?? []).join(' ')));
  }
  return frames.map((frame, index) => ({ atMs: frame.actualMs ?? frame.requestedMs, text: texts.get(index) ?? '', region, source: 'ocr' }));
}

async function recognizeFrames(frames, config, { video, signal }) {
  const parent = join(dataDir(), 'cache', video.bvid);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const dir = await mkdtemp(join(parent, 'inspect-ocr-'));
  try {
    const sharp = config.region === 'subtitle-band' ? await getSharp() : null;
    for (let index = 0; index < frames.length; index += 1) {
      let buffer = frames[index].buffer;
      if (sharp) {
        const { width, height } = await sharp(buffer).metadata();
        const bandHeight = Math.max(1, Math.round(height * config.bandRatio));
        buffer = await sharp(buffer).extract({ left: 0, top: height - bandHeight, width, height: bandHeight }).jpeg().toBuffer();
      }
      await writeFile(join(dir, 'row-' + String(index).padStart(3, '0') + '.jpg'), buffer, { mode: 0o600 });
    }
    const result = await recognizeImageDir({ dir, signal });
    return { mode: 'frames', language: result.language, entries: frameOcrEntries(frames, result.results, config.region) };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * @param {{
 *   video: object, cid: string|number, timestampsMs?: number[], intervals?: object[],
 *   maxFrames?: number, signal?: AbortSignal, jar?: any, source?: 'auto'|'ffmpeg'|'storyboard',
 *   durationMs?: number,
 *   ocr?: boolean, ocrRegion?: 'frame'|'subtitle-band', bandRatio?: number,
 *   subtitleWindow?: {startMs:number, endMs:number, intervalSeconds?:number, bandRatio?:number},
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
  const config = normalizeInspectionOcr({ ...options, durationMs: durationMs ?? (video?.duration ?? 0) * 1000 });
  if (config?.mode === 'subtitle-window') {
    const transcript = await buildSubtitleTranscript({ video, cid, jar, signal, durationMs, ...config });
    // 不把字幕长图 buffer 塞入 OCR 返回值，保持结构可直接序列化。
    const { strip, ...details } = transcript;
    return { ocr: { ...details, mode: 'subtitle-window' } };
  }
  const targets = normalizeTargets({ timestampsMs, intervals, maxFrames, durationMs });
  let result;

  let fallbackReason;
  if (source !== 'storyboard') {
    try {
      result = await buildRealFrames({ video, cid, targets, jar, signal, retainBuffers: Boolean(config) });
    } catch (error) {
      if (source === 'ffmpeg') throw error;
      fallbackReason = { code: error?.code ?? 'ERROR', message: String(error?.message ?? error).slice(0, 200) };
    }
  }

  if (!result) result = await buildStoryboardFrames({ video, cid, targets, signal, retainBuffers: Boolean(config) });
  if (!config) return { ...result, fallbackReason };
  const { _ocrFrames, ...inspection } = result;
  // OCR 失败不能被当作取帧失败而触发故事板降级。
  const ocr = await recognizeFrames(_ocrFrames, config, { video, signal });
  return { ...inspection, fallbackReason, ocr };
}
