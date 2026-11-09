/** Stage 1 keeps its uniform storyboard and adds at most one adaptive 3×3 sheet. */
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { dataDir } from '../bili/store.mjs';
import { adaptiveConfig, imageFeature } from './adaptive.mjs';
import { buildAdaptiveInspection } from './inspect.mjs';
import { buildOverview, cropStoryboardTile, getSharp, getStoryboard, loadStoryboardSprite, pickOverviewOrders, spriteIndexOfOrder } from './frames.mjs';

async function uniformReferences({ video, cid, signal }) {
  const meta = await getStoryboard({ bvid: video.bvid, cid, signal });
  const references = [];
  const sprites = new Map();
  for (const order of pickOverviewOrders(meta, 9)) {
    const index = spriteIndexOfOrder(meta, order);
    if (!sprites.has(index)) sprites.set(index, (await loadStoryboardSprite({ bvid: video.bvid, cid, meta, spriteIndex: index, signal })).buffer);
    const buffer = await cropStoryboardTile(sprites.get(index), meta, order);
    references.push({ atMs: Math.round(meta.index[order] * 1000), feature: await imageFeature(buffer) });
  }
  return references;
}

export async function composeAdaptiveOverview(frames) {
  const sharp = await getSharp();
  const composites = [], labels = [];
  for (const [i, frame] of frames.entries()) {
    const left = i % 3 * 480, top = Math.floor(i / 3) * 270;
    composites.push({ input: await sharp(frame.buffer).resize(480, 270, { fit: 'contain', background: '#000' }).jpeg().toBuffer(), left, top });
    const ms = frame.actualMs ?? frame.requestedMs;
    const seconds = Math.floor(ms / 1000);
    const time = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
    labels.push(`<text x="${left + 10}" y="${top + 258}" font-size="20" font-family="monospace" fill="white" stroke="black" stroke-width="3" paint-order="stroke">${frame.actualMs == null ? 'req ' : ''}${time}</text>`);
  }
  return sharp({ create: { width: 1440, height: 810, channels: 3, background: '#000' } })
    .composite([...composites, { input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="810">${labels.join('')}</svg>`), left: 0, top: 0 }]).jpeg({ quality: 85 }).toBuffer();
}

export async function buildOverviewWithAdaptive(options, dependencies = {}) {
  const started = Date.now();
  const overview = await (dependencies.buildOverview ?? buildOverview)(options);
  const config = await (dependencies.adaptiveConfig ?? adaptiveConfig)();
  if (!config.adaptiveEnabled) return { ...overview, adaptive: { status: 'disabled' } };
  const { video, cid, durationMs, signal: userSignal } = options;
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), Math.max(1, (options.budgetMs ?? 100000) - (Date.now() - started)));
  const signal = userSignal ? AbortSignal.any([userSignal, deadline.signal]) : deadline.signal;
  let references = [];
  try {
    // Only condition on frames actually present in the returned uniform sheet.
    if (overview.images.some((image) => image.kind === 'storyboard')) references = await (dependencies.uniformReferences ?? uniformReferences)({ ...options, signal });
    const result = await (dependencies.buildAdaptiveInspection ?? buildAdaptiveInspection)({ ...options, signal,
      selection: 'adaptive', maxFrames: 9, references, retainBuffers: true, config,
      budgetMs: Math.max(1, 100000 - (Date.now() - started)) });
    if (result.fallbackReason) overview.warnings.push({ source: 'adaptive', ...result.fallbackReason });
    const adaptive = { status: result.fallbackReason ? 'degraded' : 'ok', ...result.selection,
      frames: result.frames, referenceCount: references.length };
    if (!result.frames.length) return { ...overview, adaptive };
    let buffer;
    try { buffer = await composeAdaptiveOverview(result._ocrFrames); }
    finally {
      // Inspect sheets are internal intermediates here; only the final 3×3 is retained.
      for (const image of result.images) if (image.path) await rm(image.path, { force: true }).catch(() => {});
    }
    const dir = join(dataDir(), 'cache', video.bvid);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, `adaptive-${cid}-${randomUUID()}.jpg`);
    await writeFile(path, buffer, { mode: 0o600 });
    overview.images.push({ kind: 'adaptive', path, buffer, mediaType: 'image/jpeg', cached: false,
      source: result.selection.source, timeAccuracy: result.selection.source === 'storyboard' ? 'storyboard-index' : 'input-seek',
      layout: `3×3，按时间升序，实际 ${result.frames.length} 帧，其余格留空`,
      note: `自适应补充画面，分析当前分 P 的 0–${durationMs / 1000}s；来源 ${result.selection.source}。` +
        '传统视觉特征只衡量画面覆盖，不能保证语义重要性；req 表示请求时间，并非实测 PTS。' });
    return { ...overview, adaptive };
  } catch (error) {
    if (userSignal?.aborted || (error.code === 'CANCELLED' && !deadline.signal.aborted)) throw error;
    overview.warnings.push({ source: 'adaptive', code: deadline.signal.aborted ? 'TIMEOUT' : error.code ?? 'ERROR', message: '自适应选帧不可用，保留已有概览画面' });
    return { ...overview, adaptive: { status: 'failed', referenceCount: references.length } };
  } finally { clearTimeout(timer); }
}
