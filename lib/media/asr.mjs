/**
 * 本地 ASR 适配层（faster-whisper）。
 *
 * 定位：**没有平台字幕时的主要信息来源**。OCR 只是可选兜底。
 *
 * 与 dsh-bili-scroll 的取舍一致：
 * - CPU + int8，默认 `small`（≈484MB），可用配置降到 `base`/`tiny`；
 * - 模型缓存在插件自己的目录（不放 `~/.cache`），HF 走国内镜像；
 * - 音频走 ffmpeg 抽成 16k 单声道 wav，转完即删。
 *
 * 运行时位置不写死：解释器按「环境变量 → config.json#asrPython → 数据目录 venv → PATH」解析，
 * 所以装在 venv、uv tool、独立发行版还是系统 python 都只是换一个配置值（见 `asrCandidates`）。
 *
 * 失败语义：找不到运行时 → `DEPENDENCY_MISSING`；转写失败 → `UPSTREAM_ERROR`；
 * 超时 → `TIMEOUT`。上层据此标 `unsupported` / `failed`，不允许伪装成“没有字幕”。
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, openSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BiliError } from '../bili/errors.mjs';
import { dataDir, readJson } from '../bili/store.mjs';
import { extractAudio } from './ffmpeg.mjs';
import { transcribeViaDaemon } from './asr_client.mjs';

const WORKER = fileURLToPath(new URL('./asr_worker.py', import.meta.url));

/**
 * 缺省运行时位置：跟着数据目录走，不写死盘符。
 * POSIX venv 是 `bin/python`，Windows 是 `Scripts\\python.exe`。
 */
function defaultPython(platform = process.platform) {
  return platform === 'win32'
    ? join(dataDir(), 'asr-venv', 'Scripts', 'python.exe')
    : join(dataDir(), 'asr-venv', 'bin', 'python');
}

/**
 * 缺省模型目录：优先数据目录内的 `models`。
 * Windows 老机器把模型放在 `D:/tools/asr/models`，那里已有文件就继续用，避免重复下载。
 */
function defaultModelDir(platform = process.platform) {
  const preferred = join(dataDir(), 'models');
  const legacy = 'D:/tools/asr/models';
  if (platform === 'win32' && !existsSync(preferred) && existsSync(legacy)) return legacy;
  return preferred;
}

/**
 * 候选解释器列表（纯函数，便于单测）：环境变量 → 配置 → 数据目录 venv → 历史路径 → PATH 里的 python。
 * 只做去重，不判断存在性；存在性交给调用方，因为裸命令名要走 PATH 解析。
 */
export function asrCandidates({ config = null, env = process.env, platform = process.platform } = {}) {
  const list = [];
  const push = (value) => {
    const text = typeof value === 'string' ? value.trim() : '';
    if (text && !list.includes(text)) list.push(text);
  };
  push(env.BILI_ASR_PYTHON);
  push(config?.asrPython);
  push(defaultPython(platform));
  if (platform === 'win32') push('D:/tools/asr/.venv/Scripts/python.exe');
  push(platform === 'win32' ? 'python' : 'python3');
  return list;
}

/** 带路径分隔符或盘符的候选必须用 existsSync 预检；裸名交给 PATH。 */
export function isPathLike(value) {
  return typeof value === 'string' && (value.includes('/') || value.includes('\\'));
}

let cached;

/** 试跑一次 `import faster_whisper`，只看退出码。带超时，避免探测卡死拖住整个调用。 */
function probePython(python, { timeoutMs = 20_000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(python, ['-c', 'import faster_whisper'], { stdio: 'ignore', windowsHide: true });
    } catch {
      resolve(false);
      return;
    }
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
      finish(false);
    }, timeoutMs);
    child.on('error', () => finish(false));
    child.on('exit', (code) => finish(code === 0));
  });
}

/**
 * 解析 ASR 运行时：`BILI_ASR_PYTHON` → config.json#asrPython → 本机缺省路径。
 * @param {{force?: boolean}} [options]
 * @returns {Promise<{python:string, model:string, modelDir:string}>}
 */
export async function resolveAsr({ force = false } = {}) {
  if (cached && !force) return cached;

  const config = await readJson(join(dataDir(), 'config.json'), null).catch(() => null);

  for (const python of asrCandidates({ config })) {
    // 裸命令名（python3）不在文件系统里，必须交给 PATH 解析，不能先被 existsSync 否掉。
    if (isPathLike(python) && !existsSync(python)) continue;
    if (!(await probePython(python))) continue;
    cached = {
      python,
      model: config?.asrModel || process.env.BILI_ASR_MODEL || 'small',
      modelDir: config?.asrModelDir || process.env.BILI_ASR_MODEL_DIR || defaultModelDir(),
    };
    return cached;
  }

  throw new BiliError(
    'DEPENDENCY_MISSING',
    `没有可用的 faster-whisper 运行时：设置 BILI_ASR_PYTHON，或在 ${join(dataDir(), 'config.json')} 里写 asrPython（缺省候选中包含 ${defaultPython()} 与 PATH 里的 python3）`,
  );
}

/** 仅供测试：清掉缓存的运行时。 */
export function resetAsrCache() {
  cached = undefined;
}

/**
 * 把一段 wav 转成带时间戳的段落。
 * @param {{wavPath:string, offsetSeconds?:number, model?:string, language?:string, signal?:AbortSignal, timeoutMs?:number}} options
 */
export async function transcribeFile({ wavPath, offsetSeconds = 0, model, language = 'auto', signal, timeoutMs = 600_000 } = {}) {
  validateOffset(offsetSeconds);
  const asr = await resolveAsr();
  try {
    const payload = await transcribeViaDaemon({ wavPath, model: model || asr.model, language, signal, timeoutMs });
    return offsetTranscript(payload, offsetSeconds);
  } catch (error) {
    if (!error.data?.daemonFallback) throw error;
    if (signal?.aborted) throw new BiliError('CANCELLED', 'ASR cancelled');
  }
  const outFile = join(tmpdir(), `bili-asr-${randomUUID()}.json`);
  try {
    await runPython(
      asr.python,
      [
        WORKER,
        '--audio',
        wavPath,
        '--out',
        outFile,
        '--model',
        model || asr.model,
        '--model-dir',
        asr.modelDir,
        '--language',
        language,
      ],
      { timeoutMs, signal },
    );
    const raw = await readFile(outFile, 'utf8');
    return offsetTranscript(JSON.parse(raw.replace(/^\uFEFF/, '')), offsetSeconds);
  } finally {
    await rm(outFile, { force: true }).catch(() => {});
  }
}

/**
 * 从播放地址抽音频并转写。音频临时文件在结束时删除。
 * @param {{audioUrl:string, referer?:string, startSeconds?:number, durationSeconds?:number, maxSeconds?:number, model?:string, language?:string,
 *   signal?:AbortSignal, timeoutMs?:number}} options
 */
export async function transcribeUrl({
  audioUrl,
  referer,
  maxSeconds,
  startSeconds = 0,
  durationSeconds = maxSeconds,
  model,
  // 默认自动检测语言：B站有大量英文/中英混排视频，强制 zh 会把英文旁白解码成乱码。
  language = 'auto',
  signal,
  timeoutMs = 900_000,
} = {}) {
  if (!audioUrl) throw new BiliError('CONTENT_UNAVAILABLE', '这个视频没有独立的音频流，无法转写');
  const dir = join(tmpdir(), `bili-asr-audio-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  const wavPath = join(dir, 'audio.wav');
  try {
    // durationSeconds 优先；旧调用仍可用 maxSeconds 表示从起点抽取的时长。
    await extractAudio({ url: audioUrl, outFile: wavPath, referer, startSeconds, maxSeconds: durationSeconds, signal, timeoutMs });
    return await transcribeFile({ wavPath, offsetSeconds: startSeconds, model, language, signal, timeoutMs });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** worker 时间相对于音频片段；只平移段落，音频时长仍代表本次成本。 */
function validateOffset(offsetSeconds) {
  if (!Number.isFinite(offsetSeconds) || offsetSeconds < 0) {
    throw new BiliError('INVALID_ARGUMENT', 'offsetSeconds 必须是非负的有限秒数');
  }
}

export function offsetTranscript(payload, offsetSeconds = 0) {
  validateOffset(offsetSeconds);
  return {
    ...payload,
    segments: (payload?.segments ?? []).map((segment) => ({
      ...segment,
      start: Number(segment.start) + offsetSeconds,
      end: Number(segment.end) + offsetSeconds,
    })),
  };
}

/** faster-whisper 段落 → 统一证据条目。 */
export function segmentsToEntries(payload, { source = 'asr' } = {}) {
  const segments = payload?.segments ?? [];
  return segments.map((segment) => ({
    atMs: Math.round(Number(segment.start) * 1000),
    endMs: Math.round(Number(segment.end) * 1000),
    text: String(segment.text ?? '').trim(),
    source,
  })).filter((entry) => entry.text);
}

/**
 * 置信度判定：不替模型下结论，只给可复核的信号。
 * faster-whisper 的 `avg_logprob` 低于 -1 或`no_speech_prob` 高的段落占比超过 40%，
 * 基本可以认定“这段音频不适合转写”（纯音乐/无人声/极差音质）。
 */
export function judgeTranscript(payload) {
  const confidence = payload?.confidence ?? {};
  const avg = confidence.avg_logprob;
  const lowRatio = confidence.low_confidence_ratio;
  const segments = payload?.segments?.length ?? 0;
  if (!segments) return { usable: false, level: 'empty', reason: '没有识别出任何段落' };
  if (typeof lowRatio === 'number' && lowRatio >= 0.4) {
    return { usable: false, level: 'low', reason: `低置信段落占比 ${(lowRatio * 100).toFixed(0)}%` };
  }
  if (typeof avg === 'number' && avg < -1) {
    return { usable: false, level: 'low', reason: `平均 logprob ${avg.toFixed(2)}` };
  }
  return { usable: true, level: 'ok', reason: null };
}

/** 跑一次 Python worker：stdout 丢弃、stderr 落文件（不依赖管道）。 */
async function runPython(python, args, { timeoutMs = 600_000, signal } = {}) {
  const logDir = join(tmpdir(), 'bili-asr');
  await mkdir(logDir, { recursive: true }).catch(() => {});
  const logFile = join(logDir, `asr-${randomUUID()}.log`);
  const fd = openSync(logFile, 'w');
  try {
    await new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(python, args, { stdio: ['ignore', 'ignore', fd], windowsHide: true });
      } catch (error) {
        reject(new BiliError('DEPENDENCY_MISSING', `无法启动 ASR 运行时：${error?.message ?? error}`));
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
        finish(reject, new BiliError('CANCELLED', 'ASR 已被取消'));
      };
      timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(reject, new BiliError('TIMEOUT', `ASR 超过 ${Math.round(timeoutMs / 1000)}s 未完成`));
      }, timeoutMs);
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener?.('abort', onAbort, { once: true });
      }
      child.on('error', (error) =>
        finish(reject, new BiliError('DEPENDENCY_MISSING', `无法启动 ASR 运行时：${error?.message ?? error}`)),
      );
      child.on('exit', (code) => {
        if (code === 0) finish(resolve, undefined);
        else finish(reject, new BiliError('UPSTREAM_ERROR', `ASR 进程退出码 ${code}`));
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
