/**
 * 硬字幕（烧在画面里的字幕）：抽取字幕带 → 拼长图 → OCR。
 *
 * 两部分能力：
 * - 抽取/拼图（平台无关，只依赖 ffmpeg + sharp）：`buildSubtitleStrip`
 * - 识别（当前走 Windows 自带的 Windows.Media.Ocr，零安装）：`recognizeImageDir` / `buildSubtitleTranscript`
 *
 * 之所以按时间点逐个 seek 而不是整片解码：`-ss` 输入侧定位只解码目标附近关键帧，
 * 对一小时的视频也只要几秒；整片解码则要等到采样点之后的每一帧。
 *
 * 时间戳来自**采样点**，不是 OCR 的边界框（WinRT 的 BoundingRect 经 PS 5.1 投影后不可信），
 * 所以转写是“抽样对齐”，不是逐句对齐。
 */
import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
const OCR_SCRIPT = fileURLToPath(new URL('./win-ocr.ps1', import.meta.url));

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
export async function buildSubtitleStrip({
  video,
  cid,
  jar,
  signal,
  samples = 12,
  bandRatio = DEFAULT_BAND_RATIO,
  rowsDir,
  durationMs: durationOverride,
} = {}) {
  if (!video?.bvid || !cid) throw new BiliError('INVALID_ARGUMENT', 'buildSubtitleStrip 需要 video 与 cid');
  // 多 P 视频必须用“当前分 P 的时长”，否则采样点会跑到这一 P 结束之后。
  const durationMs = Number(durationOverride) || (video?.duration ?? 0) * 1000;

  const play = await getPlayUrls({ bvid: video.bvid, cid, jar, signal, referer: videoReferer(video.bvid) });
  const times = planSamples({ durationMs, count: samples });

  const ratio = Math.min(0.5, Math.max(0.08, Number(bandRatio) || DEFAULT_BAND_RATIO));
  const vf = `crop=iw:ih*${ratio}:0:ih*${1 - ratio}`;
  const dir = join(dataDir(), 'cache', video.bvid);
  await mkdir(dir, { recursive: true, mode: 0o700 });

  const rows = [];
  const failed = [];
  if (rowsDir) await mkdir(rowsDir, { recursive: true }).catch(() => {});
  for (let index = 0; index < times.length; index += 1) {
    const atMs = times[index];
    // 临时文件名带 pid + 时间戳：同一视频并发抽取时不会互相删对方的文件。
    const outFile = join(dir, `ocr-${cid}-${atMs}-${process.pid}-${Date.now()}-${index}.jpg`);
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
      // 逐行落盘给 OCR：文件名带序号，调用方据此把文本映射回采样时间。
      if (rowsDir) {
        await writeFile(join(rowsDir, `row-${String(index).padStart(3, '0')}.jpg`), buffer).catch(() => {});
      }
    } catch (error) {
      // 单点失败不致命：字幕带是“抽样证据”，少一行比整条链路失败好。
      // 但必须记下来：上层要如实报告“计划 N 个点、实际拿到 M 个”。
      failed.push({ atMs, code: error?.code ?? 'ERROR', message: String(error?.message ?? error).slice(0, 160) });
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
    plannedSamples: times.length,
    extractedSamples: usable.length,
    failedSamples: failed,
    band: {
      ratio,
      // 只有裁后的高度，按比例反推原始画面高度，便于判断字幕带位置是否合理。
      originalHeightPx: Math.round(srcHeight / ratio),
      topPx: Math.round(srcHeight / ratio) - srcHeight,
      heightPx: srcHeight,
      note: `每条画面只保留底部 ${(ratio * 100).toFixed(0)}%，裁后 ${srcWidth}×${srcHeight}px`,
    },
    quality: play.quality ?? null,
    rowTimes: rows.map((row) => row.atMs),
    note: '这是一张“字幕带长图”，只用于让 OCR/模型读文字；时间在左侧标注，时间点是抽样不是连续帧。',
  };
}

/**
 * 调 Windows 自带 OCR 识别一个目录下的 row-*.jpg。
 * 只用系统组件，不需要安装 Tesseract/PaddleOCR。
 * @param {{dir:string, language?:string, signal?:AbortSignal, timeoutMs?:number}} options
 * @returns {Promise<{language:string, results:Array<{file:string, lines:string[]}>}>}
 */
export async function recognizeImageDir({ dir, language = 'zh-Hans', signal, timeoutMs = 180_000 } = {}) {
  if (process.platform !== 'win32') {
    throw new BiliError('UNSUPPORTED', '当前 OCR 走 Windows.Media.Ocr，只在 Windows 上可用');
  }
  if (!dir) throw new BiliError('INVALID_ARGUMENT', 'recognizeImageDir 需要 dir');

  const outFile = join(tmpdir(), `bili-ocr-${process.pid}-${Date.now()}.json`);
  try {
    await runPowerShell(
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', OCR_SCRIPT, '-Dir', dir, '-Out', outFile, '-Language', language],
      { timeoutMs, signal },
    );
    const raw = await readFile(outFile, 'utf8');
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
    return { language: parsed.language ?? language, results: parsed.results ?? [] };
  } finally {
    await rm(outFile, { force: true }).catch(() => {});
  }
}

/** 把 OCR 出来的行整理成“时间 → 文本”。中文之间的空格要清掉，否则会变成“这 被 称 为”。 */
export function normalizeOcrText(text) {
  return String(text ?? '')
    .replace(/\u3000/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/(?<=[\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/g, '')
    .trim();
}

/**
 * 合并同一句字幕被连续采到多次的情况。
 * 时间轴上“同一条字幕”会落在相邻采样点里，文本相同就只保留最早那次，
 * 并记录 endAtMs（最后一次被采到的时间）作为粗略持续时间。
 * @param {Array<{atMs:number, text:string}>} entries
 */
export function mergeDuplicateOcrEntries(entries) {
  const merged = [];
  for (const entry of entries) {
    const previous = merged[merged.length - 1];
    if (previous && previous.text === entry.text) {
      previous.endAtMs = entry.atMs;
      previous.hits += 1;
      continue;
    }
    merged.push({ ...entry, endAtMs: entry.atMs, hits: 1 });
  }
  return merged;
}

/**
 * 字幕带长图 → OCR → 带时间戳的转写。
 *
 * 时间来自**采样点**而不是 OCR 的边界框（WinRT 的 BoundingRect 在 PS 5.1 里不可靠），
 * 所以每行文本对应的是“这个采样点附近的字幕”，不是逐句对齐。
 * 每条记录都带 `region`（取自画面哪个区域）和 `source`，便于和平台字幕/ASR 区分。
 *
 * @param {{video:object, cid:string|number, jar?:any, signal?:AbortSignal,
 *   samples?:number, bandRatio?:number, language?:string, region?:string}} options
 */
export async function buildSubtitleTranscript({
  video,
  cid,
  jar,
  signal,
  samples = 12,
  bandRatio,
  language = 'zh-Hans',
  region = 'subtitle-band',
  durationMs,
} = {}) {
  if (!video?.bvid || !cid) throw new BiliError('INVALID_ARGUMENT', 'buildSubtitleTranscript 需要 video 与 cid');

  const dir = join(tmpdir(), `bili-ocr-${video.bvid}-${cid}-${Date.now()}`);
  await mkdir(dir, { recursive: true });

  try {
    const strip = await buildSubtitleStrip({ video, cid, jar, signal, samples, bandRatio, rowsDir: dir, durationMs });
    const ocr = await recognizeImageDir({ dir, language, signal });

    const raw = [];
    for (const item of ocr.results) {
      const match = /row-(\d+)\.jpg$/i.exec(item.file ?? '');
      const index = match ? Number(match[1]) : 0;
      const atMs = strip.rowTimes[index] ?? 0;
      const text = normalizeOcrText((item.lines ?? []).join(' '));
      if (text) raw.push({ atMs, text, region, source: 'ocr' });
    }
    raw.sort((a, b) => a.atMs - b.atMs);
    const entries = mergeDuplicateOcrEntries(raw);

    // 状态必须反映“有缺口的抽样”：计划 10 个点只拿到 8 个，就不是完整证据。
    const partial = strip.extractedSamples < strip.plannedSamples;
    const status = entries.length === 0 ? 'empty' : partial ? 'partial' : 'ok';

    return {
      origin: 'ocr',
      status,
      language: ocr.language,
      entries,
      plannedSamples: strip.plannedSamples,
      extractedSamples: strip.extractedSamples,
      failedSamples: strip.failedSamples,
      sampled: strip.plannedSamples,
      rawLines: raw.length,
      recognized: entries.length,
      quality: strip.quality,
      strip,
      note: 'OCR 抽样：每行对应一个采样点，连续重复的字幕已合并；不是逐句对齐，missing 的点见 failedSamples。',
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** 跑一次 PowerShell，stdout 丢弃、stderr 落文件（不依赖管道）。 */
async function runPowerShell(args, { timeoutMs = 180_000, signal } = {}) {
  const logDir = join(tmpdir(), 'bili-ocr');
  await mkdir(logDir, { recursive: true }).catch(() => {});
  const logFile = join(logDir, `ps-${process.pid}-${Date.now()}.log`);
  const fd = openSync(logFile, 'w');
  try {
    await new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn('powershell.exe', args, { stdio: ['ignore', 'ignore', fd], windowsHide: true });
      } catch (error) {
        reject(new BiliError('UNSUPPORTED', `无法启动 powershell：${error?.message ?? error}`));
        return;
      }
      let settled = false;
      let timer;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', onAbort);
        fn(value);
      };
      const onAbort = () => {
        child.kill('SIGKILL');
        finish(reject, new BiliError('CANCELLED', 'OCR 已被取消'));
      };
      timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(reject, new BiliError('TIMEOUT', `OCR 超过 ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener?.('abort', onAbort, { once: true });
      }
      child.on('error', (error) => finish(reject, new BiliError('UNSUPPORTED', `无法启动 powershell：${error?.message ?? error}`)));
      child.on('exit', (code) => {
        if (code === 0) finish(resolve, undefined);
        else finish(reject, new BiliError('UPSTREAM_ERROR', `OCR 进程退出码 ${code}`));
      });
    });
  } catch (error) {
    const tail = await readFile(logFile, 'utf8').catch(() => '');
    const lines = tail.trim().split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 400);
    if (lines) error.message = `${error.message}：${lines}`;
    throw error;
  } finally {
    try {
      closeSync(fd);
    } catch {}
    await rm(logFile, { force: true }).catch(() => {});
  }
}
