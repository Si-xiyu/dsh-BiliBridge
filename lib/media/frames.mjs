/**
 * 画面证据：封面 + 故事板九宫格。
 *
 * 没有 ffmpeg 时，这是唯一的“画面”来源；分辨率有限，只适合看结构，不适合读小字。
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
    index: data.index ?? [],
    cols: Number(data.img_x_len) || 10,
    rows: Number(data.img_y_len) || 10,
    tileWidth: Number(data.img_x_size) || 160,
    tileHeight: Number(data.img_y_size) || 90,
  };
}

/**
 * 从故事板雪碧图拼一张 3×3 概览图。
 * 以 index 数组为准：它给出每格对应的时间（秒），尾部可能是空白格。
 */
export async function composeStoryboardGrid(spriteBuffer, meta, { signal } = {}) {
  const sharp = await getSharp();
  const info = await sharp(spriteBuffer).metadata();
  const cols = meta.cols;
  const rows = meta.rows;
  const tileWidth = Math.floor((info.width ?? cols * meta.tileWidth) / cols);
  const tileHeight = Math.floor((info.height ?? rows * meta.tileHeight) / rows);
  if (!tileWidth || !tileHeight) throw new BiliError('UPSTREAM_ERROR', '故事板尺寸异常');

  const total = cols * rows;
  const index = Array.isArray(meta.index) ? meta.index : [];
  // index 可能只覆盖前 N 格；不要取到尾部空白格。
  const valid = Math.max(1, Math.min(index.length || total, total));
  const outTileW = 480;
  const outTileH = 270;
  const composites = [];
  const labels = [];

  for (let slot = 0; slot < 9; slot += 1) {
    const order = valid === 1 ? 0 : Math.round((slot * (valid - 1)) / 8);
    const x = order % cols;
    const y = Math.floor(order / cols);
    const tile = await sharp(spriteBuffer)
      .extract({ left: x * tileWidth, top: y * tileHeight, width: tileWidth, height: tileHeight })
      .resize(outTileW, outTileH, { fit: 'fill' })
      .toBuffer();
    composites.push({
      input: tile,
      left: (slot % 3) * outTileW,
      top: Math.floor(slot / 3) * outTileH,
    });

    const seconds = index[order];
    if (Number.isFinite(seconds)) {
      const mm = String(Math.floor(seconds / 60)).padStart(2, '0');
      const ss = String(Math.floor(seconds % 60)).padStart(2, '0');
      const lx = (slot % 3) * outTileW + 10;
      const ly = Math.floor(slot / 3) * outTileH + outTileH - 12;
      labels.push(
        `<text x="${lx}" y="${ly}" font-size="20" font-family="monospace" fill="#fff" stroke="#000" stroke-width="3" paint-order="stroke">${mm}:${ss}</text>`,
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

  return {
    buffer: grid,
    mediaType: 'image/jpeg',
    layout: '3x3，从左到右、从上到下；每格左下角是故事板给出的时间（约 mm:ss）',
    timeAccuracy: 'approx-1s',
    note: '时间来自 B站故事板的 index，约 ±1s；分辨率取决于平台，可能偏糊。',
  };
}

/**
 * Stage 1 概览画面：封面 + 故事板九宫格。
 * 单张失败不影响另一张。
 */
export async function buildOverview({ video, cid, signal } = {}) {
  const warnings = [];
  const images = [];

  try {
    const cover = await getCover(video, { signal });
    // 带上落盘路径：工具的附件层据此决定名字，模型看不了图时也能给用户路径。
    if (cover) images.push({ kind: 'cover', path: join(cacheDir(video.bvid), 'cover.img'), ...cover });
  } catch (error) {
    warnings.push({ source: 'cover', code: error?.code ?? 'ERROR', message: String(error?.message ?? error) });
  }

  try {
    const dir = cacheDir(video.bvid);
    const file = join(dir, `storyboard-${cid}.jpg`);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    if (await freshFile(file)) {
      images.push({
        kind: 'storyboard',
        path: file,
        buffer: await readFile(file),
        mediaType: 'image/jpeg',
        cached: true,
        layout: '3x3，从左到右、从上到下；每格左下角是故事板给出的时间（约 mm:ss）',
        timeAccuracy: 'approx-1s',
        note: '时间来自 B站故事板的 index，约 ±1s；分辨率取决于平台，可能偏糊。',
      });
    } else {
      const meta = await getStoryboard({ bvid: video.bvid, cid, signal });
      const sprite = await downloadImage(meta.images[0], { signal, referer: videoReferer(video.bvid) });
      const grid = await composeStoryboardGrid(sprite.buffer, meta, { signal });
      await writeFile(file, grid.buffer, { mode: 0o600 });
      images.push({ kind: 'storyboard', path: file, ...grid, cached: false });
    }
  } catch (error) {
    warnings.push({ source: 'storyboard', code: error?.code ?? 'ERROR', message: String(error?.message ?? error) });
  }

  return { images, warnings };
}
