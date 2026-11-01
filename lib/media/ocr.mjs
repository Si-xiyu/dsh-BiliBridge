/**
 * 硬字幕（烧在画面里的字幕）抽取。
 *
 * 只做「取图 + 拼长图」这一步：把底部字幕带按时间采样，竖拼成一张长图。
 * **不做识别** —— 识别引擎（Tesseract / RapidOCR / PaddleOCR）由调用方接入，
 * 这样换引擎不影响这条管线，也不会把“OCR 能力”偷偷绑进依赖里。
 *
 * 之所以按时间点逐个 seek 而不是整片解码：`-ss` 输入侧定位只解码目标附近关键帧，
 * 对一小时的视频也只要几秒；整片解码则要等到采样点之后的每一帧。
 */
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { BiliError } from '../bili/errors.mjs';
import { getPlayUrls } from '../bili/playurl.mjs';
import { dataDir } from '../bili/store.mjs';
import { extractFrame } from './ffmpeg.mjs';
import { getSharp, videoReferer } from './frames.mjs';

/** 底部多少比例算字幕带。0.22 覆盖绝大多数硬字幕，又不至于把画面主体切进来。 */
export const DEFAULT_BAND_RATIO = 0.22;
export const MIN_BAND_PX = 48;
const MAX_STRIP_WIDTH = 1280;
const LABEL_WIDTH = 88;

/**
 * 规划采样时间点：均匀覆盖 [startRatio, endRatio]。
 * 两端各留一点，避免片头片尾的纯黑帧。
 * @param {{durationMs:number, count?:number, startRatio?:number, endRatio?:number}} options
 */
export function planSamples({ durationMs, count = 12, startRatio = 0.03, endRatio = 0.97 } = {}) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new BiliError('INVALID_ARGUMENT', 'planSamples 需要有效的 durationMs');
  }
  const total = Math.max(2, Math.min(24, Math.round(count)));
  const start = durationMs * startRatio;
  const end = durationMs * endRatio;
  const step = (end - start) / (total - 1);
  return Array.from({ length: total }, (_, index) => Math.round(start + step * index));
}

function fmt(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const mm = String(Math.floor(total / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

/**
 * 取字幕带并拼成一张长图。
 *
 * @param {{video:object, cid:string|number, jar?:any, signal?:AbortSignal,
 *   samples?:number, bandRatio?:number}} options
 * @returns {Promise<{buffer:Buffer, mediaType:string, width:number, height:number,
 *   samples:Array<{atMs:number, ok:boolean}>, band:{ratio:number, topPx:number|null, heightPx:number|null},
 *   quality:object|null, note:string}>}
 */
export async function buildSubtitleStrip({ video, cid, jar, signal, samples = 12, bandRatio = DEFAULT_BAND_RATIO } = {}) {
  const durationMs = (video?.duration ?? 0) * 1000;
  if (!video?.bvid || !cid) throw new BiliError('INVALID_ARGUMENT', 'buildSubtitleStrip 需要 video 与 cid');

  const play = await getPlayUrls({ bvid: video.bvid, cid, jar, signal, referer: videoReferer(video.bvid) });
  const times = planSamples({ durationMs, count: samples });

  const ratio = Math.min(0.5, Math.max(0.08, Number(bandRatio) || DEFAULT_BAND_RATIO));
  const vf = `crop=iw:ih*${ratio}:0:ih*${1 - ratio}`;
  const dir = join(dataDir(), 'cache', video.bvid);
  await mkdir(dir, { recursive: true, mode: 0o700 });

  const rows = [];
  for (const atMs of times) {
    const outFile = join(dir, `ocr-${cid}-${atMs}.jpg`);
    try {
      const buffer = await extractFrame({
        url: play.videoUrl,
        atMs,
        outFile,
        referer: videoReferer(video.bvid),
        signal,
        vf,
        timeoutMs: 30_000,
      });
      rows.push({ atMs, buffer, ok: true });
    } catch (error) {
      // 单点失败不致命：字幕带是“抽样证据”，少一行比整条链路失败好。
      rows.push({ atMs, buffer: null, ok: false, error: error?.message });
    } finally {
      await rm(outFile, { force: true }).catch(() => {});
    }
  }

  const usable = rows.filter((row) => row.ok);
  if (!usable.length) throw new BiliError('UPSTREAM_ERROR', '所有采样点都没有抽到画面');

  const sharp = await getSharp();
  const meta = await sharp(usable[0].buffer).metadata();
  const srcWidth = meta.width ?? 1920;
  const srcHeight = meta.height ?? 108;
  const targetWidth = Math.min(MAX_STRIP_WIDTH, srcWidth);
  const rowHeight = Math.max(1, Math.round((targetWidth * srcHeight) / srcWidth));

  const composites = [];
  const labels = [];
  for (let index = 0; index < usable.length; index += 1) {
    const row = usable[index];
    const top = index * rowHeight;
    composites.push({
      input: await sharp(row.buffer).resize(targetWidth, rowHeight, { fit: 'fill' }).toBuffer(),
      left: LABEL_WIDTH,
      top,
    });
    labels.push(
      `<text x="8" y="${top + rowHeight / 2 + 7}" font-size="18" font-family="monospace" fill="#fff">${fmt(row.atMs)}</text>`,
    );
  }

  const width = LABEL_WIDTH + targetWidth;
  const height = rowHeight * usable.length;
  const overlay = Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">${labels.join('')}</svg>`,
  );

  const strip = await sharp({ create: { width, height, channels: 3, background: '#000000' } })
    .composite([...composites, { input: overlay, left: 0, top: 0 }])
    .jpeg({ quality: 90 })
    .toBuffer();

  return {
    buffer: strip,
    mediaType: 'image/jpeg',
    width,
    height,
    samples: rows.map((row) => ({ atMs: row.atMs, ok: row.ok })),
    band: {
      ratio,
      // 只有裁后的高度，按比例反推原始画面高度，便于判断字幕带位置是否合理。
      originalHeightPx: Math.round(srcHeight / ratio),
      topPx: Math.round(srcHeight / ratio) - srcHeight,
      heightPx: srcHeight,
      note: `每条画面只保留底部 ${(ratio * 100).toFixed(0)}%，裁后 ${srcWidth}×${srcHeight}px`,
    },
    quality: play.quality ?? null,
    note: '这是一张“字幕带长图”，只用于让 OCR/模型读文字；时间在左侧标注，时间点是抽样不是连续帧。',
  };
}
