/**
 * 画面证据：封面 + 故事板（含多雪碧图）。
 *
 * B站 的故事板对不同长度的视频会返回 **多张雪碧图**（`images[]`），
 * `index[i]` 是**跨雪碧图连续编号**的第 i 格对应秒数：
 *   spriteIndex = floor(i / (cols*rows))，tileIndex = i % (cols*rows)
 * 长视频若只看 `images[0]`，只能覆盖全片前 1/N（55 分钟视频实测只有前 816s）。
 *
 * 没有 ffmpeg 时这是唯一的画面来源；分辨率有限，只适合看结构，不适合读小字。
 * 所有下载都限制协议、大小和超时；缓存 24h。
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BiliError } from '../bili/errors.mjs';
import { fetchBuffer, request } from '../bili/http.mjs';
import { dataDir } from '../bili/store.mjs';

/** 懒加载 sharp：即使原生模块加载失败，也只影响画面功能，不拖垮整个插件。 */
export async function getSharp() {
  const module = await import('sharp');
  return module.default;
}

const VIDEOHOT = 'https://api.bilibili.com/x/player/videoshot';
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const CACHE_TTL_MS = 24 * 3600 * 1000;

function cacheDir(bvid) {
  return join(dataDir(), 'cache', bvid);
}

async function freshFile(file) {
  try {
    const info = await stat(file);
    return Date.now() - info.mtimeMs < CACHE_TTL_MS;
  } catch {
    return false;
  }
}

function mediaTypeOf(contentType, url) {
  const type = String(contentType ?? '').split(';')[0].trim().toLowerCase();
  if (type === 'image/png' || type === 'image/jpeg' || type === 'image/webp' || type === 'image/gif') return type;
  if (url.endsWith('.png')) return 'image/png';
  if (url.endsWith('.webp')) return 'image/webp';
  if (url.endsWith('.gif')) return 'image/gif';
  return 'image/jpeg';
}

/** 视频页 Referer：CDN 与图片服务用它做防盗链校验。 */
export function videoReferer(bvid) {
  return `https://www.bilibili.com/video/${bvid}`;
}

/**
 * 下载一张图片，限制大小；只接受 B站 域名（见 http.mjs 的白名单）。
 * 走 fetchBuffer 而不是裸 fetch：媒体请求必须和接口用同一套 UA/Referer。
 */
export async function downloadImage(url, { signal, timeoutMs = 20_000, referer } = {}) {
  const image = await fetchBuffer(url, { referer, signal, timeoutMs, maxBytes: MAX_IMAGE_BYTES });
  return { buffer: image.buffer, mediaType: mediaTypeOf(image.contentType, new URL(image.url).pathname) };
}

/** 读取/下载封面，带 24h 磁盘缓存。 */
export async function getCover(video, { signal } = {}) {
  if (!video?.cover) return null;
  const dir = cacheDir(video.bvid);
  const file = join(dir, 'cover.img');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (await freshFile(file)) {
    return { buffer: await readFile(file), mediaType: 'image/jpeg', cached: true };
  }
  const image = await downloadImage(video.cover, { signal, referer: videoReferer(video.bvid) });
  await writeFile(file, image.buffer, { mode: 0o600 });
  return { ...image, cached: false };
}

/** 故事板元信息（可能不可用）。 */
export async function getStoryboard({ bvid, cid, signal } = {}) {
  let data;
  try {
    data = await request(VIDEOHOT, {
      query: { bvid, cid, index: 1 },
      referer: videoReferer(bvid),
      signal,
      timeoutMs: 20_000,
    });
  } catch (error) {
    // 没有雪碧图的视频会返回 -404：这属于“没有画面证据”，不是上游故障。
    if (error?.code === 'NOT_FOUND') throw new BiliError('CONTENT_UNAVAILABLE', '该视频没有可用的故事板');
    throw error;
  }
  if (!data?.image?.length) throw new BiliError('CONTENT_UNAVAILABLE', '该视频没有可用的故事板');
  return {
    images: data.image,
    index: (data.index ?? []).map(Number),
    cols: Number(data.img_x_len) || 10,
    rows: Number(data.img_y_len) || 10,
    tileWidth: Number(data.img_x_size) || 160,
    tileHeight: Number(data.img_y_size) || 90,
  };
}

/** 每张雪碧图有多少格。 */
export function tilesPerSprite(meta) {
  return meta.cols * meta.rows;
}

/**
 * index 里真正可用的格数。
 *
 * 注意：`index` 可能为空（上游只给了图、没给时间轴），这时**不能**当成“有 1 格” ——
 * 否则会裁出一个没有时间标签的虚构 tile，把“故事板不可用”伪装成可用。
 */
export function validTileCount(meta) {
  const index = Array.isArray(meta?.index) ? meta.index : [];
  const images = Array.isArray(meta?.images) ? meta.images : [];
  const capacity = images.length * tilesPerSprite(meta);
  let count = 0;
  while (count < index.length && count < capacity && Number.isFinite(index[count])) count += 1;
  return count;
}

/** 第 order 格 → 第几张雪碧图。 */
export function spriteIndexOfOrder(meta, order) {
  return Math.floor(order / tilesPerSprite(meta));
}

/** 第 order 格 → 这张图里的第几格（行优先）。 */
export function tileIndexOfOrder(meta, order) {
  return order % tilesPerSprite(meta);
}

/**
 * 找离 seconds 最近的一格（index 升序，二分 + 邻域比较）。
 * @returns {number} order
 */
export function locateStoryboardOrder(meta, seconds) {
  const count = validTileCount(meta);
  const index = meta.index;
  // -1 表示“这张故事板没有时间索引”，调用方必须显式处理，不能当成第 0 格。
  if (count === 0) return -1;
  if (count === 1) return 0;

  let lo = 0;
  let hi = count - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const value = index[mid];
    if (!Number.isFinite(value)) {
      hi = mid - 1;
      continue;
    }
    if (value === seconds) return mid;
    if (value < seconds) lo = mid + 1;
    else hi = mid - 1;
  }

  let best = 0;
  let bestDelta = Infinity;
  for (const candidate of [lo - 1, lo]) {
    if (candidate < 0 || candidate >= count) continue;
    const value = index[candidate];
    if (!Number.isFinite(value)) continue;
    const delta = Math.abs(value - seconds);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = candidate;
    }
  }
  return best;
}

/**
 * 读取一张雪碧图（24h 磁盘缓存）。
 * @param {{bvid:string, cid:string|number, meta:object, spriteIndex:number, signal?:AbortSignal}} options
 */
export async function loadStoryboardSprite({ bvid, cid, meta, spriteIndex, signal }) {
  const dir = cacheDir(bvid);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `sprite-${cid}-${spriteIndex}.jpg`);
  if (await freshFile(file)) return { buffer: await readFile(file), cached: true };

  const url = meta.images[spriteIndex];
  if (!url) throw new BiliError('CONTENT_UNAVAILABLE', `故事板没有第 ${spriteIndex + 1} 张图`);
  const image = await downloadImage(url, { signal, referer: videoReferer(bvid) });
  await writeFile(file, image.buffer, { mode: 0o600 });
  return { buffer: image.buffer, cached: false };
}

/**
 * 从某张雪碧图里裁出一格。
 * @returns {Promise<Buffer>} JPEG
 */
export async function cropStoryboardTile(spriteBuffer, meta, order) {
  const sharp = await getSharp();
  const info = await sharp(spriteBuffer).metadata();
  const tileWidth = Math.floor((info.width ?? meta.cols * meta.tileWidth) / meta.cols);
  const tileHeight = Math.floor((info.height ?? meta.rows * meta.tileHeight) / meta.rows);
  if (!tileWidth || !tileHeight) throw new BiliError('UPSTREAM_ERROR', '故事板尺寸异常');

  const tileIndex = tileIndexOfOrder(meta, order);
  const x = tileIndex % meta.cols;
  const y = Math.floor(tileIndex / meta.cols);
  return sharp(spriteBuffer)
    .extract({ left: x * tileWidth, top: y * tileHeight, width: tileWidth, height: tileHeight })
    .jpeg({ quality: 92 })
    .toBuffer();
}

/** 概览要取哪 9 格：跨**全部** index 均匀分布，而不是只取第一张图。 */
export function pickOverviewOrders(meta, count = 9) {
  const total = validTileCount(meta);
  if (total <= 0) return [];
  const slots = Math.max(1, Math.min(count, total));
  const orders = [];
  for (let slot = 0; slot < slots; slot += 1) {
    const order = slots === 1 ? 0 : Math.round((slot * (total - 1)) / (slots - 1));
    if (!orders.includes(order)) orders.push(order);
  }
  return orders;
}

/**
 * 拼 3×3 概览图：跨全部雪碧图取帧，每格标注 index 给的时间。
 *
 * 传入 `cover`（Buffer）时，**左上第一格换成封面**并标注「封面」，
 * 目的：封面不再单独占一个图片附件额度，一次 extract 少发一张图。
 *
 * @returns {Promise<{buffer:Buffer, mediaType:string, layout:string, timeAccuracy:string,
 *   note:string, coverage:{firstSec:number|null, lastSec:number|null}, spritesUsed:number, coverMerged:boolean}>}
 */
export async function composeStoryboardOverview({ bvid, cid, meta, signal, cover = null } = {}) {
  const sharp = await getSharp();
  const orders = pickOverviewOrders(meta, 9);
  if (!orders.length) throw new BiliError('CONTENT_UNAVAILABLE', '故事板没有时间索引，无法生成概览');

  const outTileW = 480;
  const outTileH = 270;
  const composites = [];
  const labels = [];
  const spriteCache = new Map();

  for (let slot = 0; slot < orders.length; slot += 1) {
    const order = orders[slot];
    const left = (slot % 3) * outTileW;
    const top = Math.floor(slot / 3) * outTileH;
    // 第一格放封面：封面是宣传图，不是视频截图，必须明确标注，避免被当成 00:00 的画面。
    if (slot === 0 && cover) {
      composites.push({ input: await sharp(cover).resize(outTileW, outTileH, { fit: 'cover' }).toBuffer(), left, top });
      labels.push(`<text x="${left + 10}" y="${top + outTileH - 12}" font-size="20" font-family="monospace" fill="#fff" stroke="#000" stroke-width="3" paint-order="stroke">封面</text>`);
      continue;
    }
    const spriteIndex = spriteIndexOfOrder(meta, order);
    let sprite = spriteCache.get(spriteIndex);
    if (!sprite) {
      sprite = (await loadStoryboardSprite({ bvid, cid, meta, spriteIndex, signal })).buffer;
      spriteCache.set(spriteIndex, sprite);
    }
    const tile = await cropStoryboardTile(sprite, meta, order);
    const resized = await sharp(tile).resize(outTileW, outTileH, { fit: 'fill' }).toBuffer();
    composites.push({ input: resized, left, top });

    const seconds = meta.index[order];
    if (Number.isFinite(seconds)) {
      const mm = String(Math.floor(seconds / 60)).padStart(2, '0');
      const ss = String(Math.floor(seconds % 60)).padStart(2, '0');
      labels.push(
        `<text x="${left + 10}" y="${top + outTileH - 12}" font-size="20" font-family="monospace" fill="#fff" stroke="#000" stroke-width="3" paint-order="stroke">${mm}:${ss}</text>`,
      );
    }
  }

  const overlay = Buffer.from(
    `<svg width="${outTileW * 3}" height="${outTileH * 3}" xmlns="http://www.w3.org/2000/svg">${labels.join('')}</svg>`,
  );

  const grid = await sharp({
    create: { width: outTileW * 3, height: outTileH * 3, channels: 3, background: '#000000' },
  })
    .composite([...composites, { input: overlay, left: 0, top: 0 }])
    .jpeg({ quality: 85 })
    .toBuffer();

  const total = validTileCount(meta);
  const coverMerged = Boolean(cover);
  return {
    buffer: grid,
    mediaType: 'image/jpeg',
    layout: coverMerged
      ? '3x3，从左到右、从上到下；左上第一格是封面（宣传图，不是视频截图），其余格左下角是故事板给出的时间（mm:ss）'
      : '3x3，从左到右、从上到下；每格左下角是故事板给出的时间（mm:ss）',
    timeAccuracy: 'approx-1s',
    note:
      (coverMerged ? '左上第一格为封面（非视频画面）；' : '') +
      `时间来自 B站故事板 index（约 ±1s）；本片共 ${meta.images.length} 张雪碧图、` +
      `${total} 格可用，概览跨全部雪碧图均匀取样。`,
    coverMerged,
    coverage: { firstSec: meta.index[0] ?? null, lastSec: meta.index[total - 1] ?? null },
    spritesUsed: spriteCache.size,
  };
}

/**
 * Stage 1 概览画面：封面已并入故事板九宫格的左上第一格，因此只产出**一张**图。
 *
 * 背景：封面单独发一张会占掉一个图片附件额度（每次 extract 只保留少量图片），
 * 而封面本身信息量有限。并进九宫格后附件从 3 张降到 2 张。
 * 封面获取失败时网格退回 9 格故事板，不会失败。
 *
 * `dependencies` 仅用于测试注入（getCover / getStoryboard / composeStoryboardOverview）。
 */
export async function buildOverview({ video, cid, signal } = {}, dependencies = {}) {
  const warnings = [];
  const images = [];
  const readCover = dependencies.getCover ?? getCover;
  const readStoryboard = dependencies.getStoryboard ?? getStoryboard;
  const compose = dependencies.composeStoryboardOverview ?? composeStoryboardOverview;

  let cover = null;
  try { cover = await readCover(video, { signal }); }
  catch (error) {
    warnings.push({ source: 'cover', code: error?.code ?? 'ERROR', message: String(error?.message ?? error) });
  }

  try {
    const dir = cacheDir(video.bvid);
    // v3：封面并入第一格，旧 v2 缓存不能复用（否则会拿到 9 格纯故事板）。
    const file = join(dir, `storyboard-v3-${cid}${cover?.buffer ? '-c' : '-n'}.jpg`);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    if (await freshFile(file)) {
      images.push({
        kind: 'storyboard',
        path: file,
        buffer: await readFile(file),
        mediaType: 'image/jpeg',
        cached: true,
        layout: cover?.buffer
          ? '3x3，左上第一格是封面（宣传图，不是视频截图），其余格左下角是故事板时间（mm:ss）'
          : '3x3，每格左下角是故事板给出的时间（mm:ss）',
        timeAccuracy: 'approx-1s',
        note: (cover?.buffer ? '左上第一格为封面（非视频画面）；' : '') +
          '时间来自 B站故事板的 index，约 ±1s；分辨率取决于平台，可能偏糊。',
      });
    } else {
      const meta = await readStoryboard({ bvid: video.bvid, cid, signal });
      const grid = await compose({ bvid: video.bvid, cid, meta, signal,
        cover: cover?.buffer ?? null });
      await writeFile(file, grid.buffer, { mode: 0o600 });
      images.push({ kind: 'storyboard', path: file, ...grid, cached: false });
    }
  } catch (error) {
    warnings.push({ source: 'storyboard', code: error?.code ?? 'ERROR', message: String(error?.message ?? error) });
  }

  return { images, warnings };
}
