/**
 * 硬字幕（烧在画面里的字幕）：抽取字幕带 → 拼长图 → OCR。
 *
 * 两部分能力：
 * - 抽取/拼图（平台无关，只依赖 ffmpeg + sharp）：`buildSubtitleStrip`
 * - 识别（Windows 走 Windows.Media.Ocr，macOS 走 Apple Vision，均零运行时依赖）：
 *   `recognizeImageDir` / `buildSubtitleTranscript`
 *
 * 之所以按时间点逐个 seek 而不是整片解码：`-ss` 输入侧定位只解码目标附近关键帧，
 * 对一小时的视频也只要几秒；整片解码则要等到采样点之后的每一帧。
 *
 * 时间戳来自**采样点**，不是 OCR 的边界框（WinRT 的 BoundingRect 经 PS 5.1 投影后不可信，
 * Vision 那边同样只取文本），所以转写是“抽样对齐”，不是逐句对齐。
 */
import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync } from 'node:fs';
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
 * 绝对窗口优先：intervalMs 覆盖 [startMs, endMs)，count 则均匀覆盖两端。
 * @param {{durationMs:number, count?:number, startRatio?:number, endRatio?:number,
 *   startMs?:number, endMs?:number, intervalMs?:number}} options
 */
export function planSamples({ durationMs, count = 12, startRatio = 0.03, endRatio = 0.97, startMs, endMs, intervalMs } = {}) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new BiliError('INVALID_ARGUMENT', 'planSamples 需要有效的 durationMs');
  }
  if (startMs !== undefined || endMs !== undefined || intervalMs !== undefined) {
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || endMs <= startMs || endMs > durationMs) {
      throw new BiliError('INVALID_ARGUMENT', '窗口需要 0 <= startMs < endMs <= durationMs');
    }
    // 固定间隔不能被旧的 24 点上限稀释，否则会漏掉窗口中的字幕。
    if (intervalMs !== undefined) {
      if (!Number.isFinite(intervalMs) || intervalMs < 1) throw new BiliError('INVALID_ARGUMENT', 'intervalMs 必须至少为 1ms');
      const total = Math.ceil((endMs - startMs) / intervalMs);
      if (total > 10000) throw new BiliError('INVALID_ARGUMENT', '窗口采样点不能超过 10000 个');
      return Array.from({ length: total }, (_, index) => Math.round(startMs + index * intervalMs));
    }
    if (!Number.isInteger(count) || count < 1 || count > 10000) throw new BiliError('INVALID_ARGUMENT', '窗口 count 必须是 1 到 10000 的整数');
    return Array.from({ length: count }, (_, index) => Math.round(startMs + (count === 1 ? 0 : (endMs - startMs) * index / (count - 1))));
  }
  const total = Math.max(2, Math.min(24, Math.round(count)));
  const start = durationMs * startRatio;
  const end = durationMs * endRatio;
  const step = (end - start) / (total - 1);
  return Array.from({ length: total }, (_, index) => Math.round(start + step * index));
}

/** 沿用字幕带裁剪范围，避免读入过多画面主体。 */
export function normalizeBandRatio(value = DEFAULT_BAND_RATIO) {
  if (!Number.isFinite(value)) throw new BiliError('INVALID_ARGUMENT', 'bandRatio 必须是有限数字');
  return Math.min(0.5, Math.max(0.08, value));
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
 *   samples?:number, count?:number, bandRatio?:number, durationMs?:number,
 *   startMs?:number, endMs?:number, intervalMs?:number, startRatio?:number, endRatio?:number,
 *   rowsDir?:string}} options
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
  startMs,
  endMs,
  intervalMs,
  count,
  startRatio,
  endRatio,
  // 窗口 OCR 只需要逐帧文件，不必把几百行拼成一张可能超限的长图。
  composeStrip = true,
} = {}) {
  if (!video?.bvid || !cid) throw new BiliError('INVALID_ARGUMENT', 'buildSubtitleStrip 需要 video 与 cid');
  // 多 P 视频必须用“当前分 P 的时长”，否则采样点会跑到这一 P 结束之后。
  const durationMs = Number(durationOverride) || (video?.duration ?? 0) * 1000;

  const times = planSamples({ durationMs, count: count ?? samples, startMs, endMs, intervalMs, startRatio, endRatio });
  const ratio = normalizeBandRatio(bandRatio);
  const play = await getPlayUrls({ bvid: video.bvid, cid, jar, signal, referer: videoReferer(video.bvid) });
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

  // 长窗口拼接出来的长图可能超过 JPEG 的高度上限（例如 450 行 × 约 150px）。
  // 窗口 OCR 只需要逐帧文件和采样元数据，因此允许调用方跳过拼图。
  let stripBuffer = null;
  let width = null;
  let height = null;

  if (composeStrip) {
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

    width = LABEL_WIDTH + targetWidth;
    height = rowHeight * usable.length;
    const overlay = Buffer.from(
      `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">${labels.join('')}</svg>`,
    );

    stripBuffer = await sharp({ create: { width, height, channels: 3, background: '#000000' } })
      .composite([...composites, { input: overlay, left: 0, top: 0 }])
      .jpeg({ quality: 90 })
      .toBuffer();
  }

  return {
    buffer: stripBuffer,
    mediaType: stripBuffer ? 'image/jpeg' : null,
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
 * 平台 → 识别引擎。抽成纯函数，单测不用改 `process.platform` 就能覆盖分派。
 * @param {string} [platform]
 * @returns {'windows-media-ocr'|'apple-vision'|null}
 */
export function ocrEngineFor(platform = process.platform) {
  if (platform === 'win32') return 'windows-media-ocr';
  if (platform === 'darwin') return 'apple-vision';
  return null;
}

/**
 * 识别引擎按平台分派：
 * - Windows：Windows.Media.Ocr（`win-ocr.ps1`，零安装）
 * - macOS：Apple Vision（`vision-ocr.swift` 编译的助手，零运行时依赖）
 * - 其它：`UNSUPPORTED`，调用方据此降级
 *
 * 对外只承诺“给一个目录，回 {language, results[]}”，两条实现都不返回坐标。
 * @param {{dir:string, language?:string, signal?:AbortSignal, timeoutMs?:number}} options
 * @returns {Promise<{language:string, results:Array<{file:string, lines:string[]}>}>}
 */
export async function recognizeImageDir(options = {}) {
  const { dir, language = 'zh-Hans', signal, timeoutMs = 180_000 } = options;
  if (!dir) throw new BiliError('INVALID_ARGUMENT', 'recognizeImageDir 需要 dir');

  const engine = ocrEngineFor();
  if (engine === 'windows-media-ocr') return recognizeImageDirWindows({ dir, language, signal, timeoutMs });
  if (engine === 'apple-vision') {
    const { recognizeImageDirVision } = await import('./vision-ocr.mjs');
    return recognizeImageDirVision({ dir, language, signal, timeoutMs });
  }
  throw new BiliError('UNSUPPORTED', `当前平台（${process.platform}）没有接入 OCR 引擎`);
}

/** Windows 路径：调 Windows.Media.Ocr 识别一个目录下的 row-*.jpg。 */
async function recognizeImageDirWindows({ dir, language, signal, timeoutMs }) {
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

/**
 * 当前平台能不能做 OCR——给设置页和工具做**提前**判断，不要等到拼完长图才失败。
 * `available` 为 false 时 `reason` 说明缺什么。
 * @returns {Promise<{platform:string, engine:string|null, available:boolean, reason:string|null}>}
 */
export async function ocrAvailability() {
  const platform = process.platform;
  if (platform === 'win32') {
    const shell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    return existsSync(shell)
      ? { platform, engine: 'windows-media-ocr', available: true, reason: null }
      : { platform, engine: 'windows-media-ocr', available: false, reason: '找不到 powershell.exe' };
  }
  if (platform === 'darwin') {
    const { hasSwiftc, ensureVisionBinary } = await import('./vision-ocr.mjs');
    if (!(await hasSwiftc())) {
      return { platform, engine: 'apple-vision', available: false, reason: '缺少 swiftc（xcode-select --install）' };
    }
    try {
      await ensureVisionBinary();
      return { platform, engine: 'apple-vision', available: true, reason: null };
    } catch (error) {
      return { platform, engine: 'apple-vision', available: false, reason: error?.message ?? String(error) };
    }
  }
  return { platform, engine: null, available: false, reason: `未适配平台 ${platform}` };
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
 *   samples?:number, count?:number, bandRatio?:number, language?:string, region?:string,
 *   durationMs?:number, startMs?:number, endMs?:number, intervalMs?:number,
 *   startRatio?:number, endRatio?:number}} options
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
  startMs,
  endMs,
  intervalMs,
  count,
  startRatio,
  endRatio,
  // 窗口模式默认不拼长图：几百行拼起来可能超过 JPEG 高度上限，而 OCR 只需要逐帧文件。
  composeStrip = false,
} = {}) {
  if (!video?.bvid || !cid) throw new BiliError('INVALID_ARGUMENT', 'buildSubtitleTranscript 需要 video 与 cid');

  const dir = join(tmpdir(), `bili-ocr-${video.bvid}-${cid}-${Date.now()}`);
  await mkdir(dir, { recursive: true });

  try {
    const strip = await buildSubtitleStrip({ video, cid, jar, signal, samples, bandRatio, rowsDir: dir, durationMs, startMs, endMs, intervalMs, count, startRatio, endRatio, composeStrip });
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
