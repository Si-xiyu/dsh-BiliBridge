/**
 * ffmpeg 调用层：定位二进制与 CA 证书、抽真实视频帧、抽音频。
 *
 * 设计约束：
 * - 不假设 ffmpeg 在 PATH 里。查找顺序：`FFMPEG_PATH` → `~/.dsh/bilibili/config.json` 的
 *   `ffmpegPath` → PATH。找不到就抛 `DEPENDENCY_MISSING`，调用方降级到故事板。
 * - **Windows 上必须给 CA**：gyan 的 gnutls 构建没有系统证书库，直连 B站 CDN 会报
 *   `Peer certificate failed verification`。所以支持 `FFMPEG_CA_FILE` /
 *   `config.json#ffmpegCaFile` / `<数据目录>/cacert.pem` 三处查找，找到就传 `-ca_file`。
 * - **不用管道**：子进程 stdout/stderr 直接重定向到文件，图像走临时文件。
 *   这样在无法开命名管道的受限环境里也能跑，也不会因为大图打爆内存。
 * - 每次调用都有超时与取消，避免留下孤儿进程。
 */
import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync } from 'node:fs';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { BiliError } from '../bili/errors.mjs';
import { headersFor, USER_AGENT } from '../bili/http.mjs';
import { dataDir, readJson } from '../bili/store.mjs';

let toolchain;

/** 试跑一次 `-version`，只看退出码（不读管道）。 */
function probeBinary(bin) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, ['-version'], { stdio: 'ignore', windowsHide: true });
    } catch {
      resolve(false);
      return;
    }
    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(code === 0));
  });
}

/** 找 CA 证书文件；找不到返回 null（Linux/macOS 上 ffmpeg 通常自带系统信任链）。 */
async function resolveCaFile(config) {
  const candidates = [
    process.env.FFMPEG_CA_FILE,
    config?.ffmpegCaFile,
    join(dataDir(), 'cacert.pem'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * 解析一次工具链（二进制 + CA），进程内缓存。
 * @param {{force?: boolean}} [options]
 * @returns {Promise<{ffmpeg: string, caFile: string|null}>}
 */
export async function resolveToolchain({ force = false } = {}) {
  if (toolchain && !force) return toolchain;

  const config = await readJson(join(dataDir(), 'config.json'), null).catch(() => null);
  const candidates = [process.env.FFMPEG_PATH, config?.ffmpegPath, 'ffmpeg'].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate !== 'ffmpeg' && !existsSync(candidate)) continue;
    if (await probeBinary(candidate)) {
      toolchain = { ffmpeg: candidate, caFile: await resolveCaFile(config) };
      return toolchain;
    }
  }
  throw new BiliError(
    'DEPENDENCY_MISSING',
    '没有找到 ffmpeg：设置环境变量 FFMPEG_PATH，或在 ~/.dsh/bilibili/config.json 里写 ffmpegPath',
  );
}

/** 只要可执行文件路径。 */
export async function resolveFfmpeg(options) {
  return (await resolveToolchain(options)).ffmpeg;
}

/** 仅供测试：清掉缓存的工具链。 */
export function resetFfmpegCache() {
  toolchain = undefined;
}

/** TLS/请求头参数：协议层选项必须出现在 -i 之前。 */
async function inputOptions(referer) {
  const { caFile } = await resolveToolchain();
  const args = [];
  if (caFile) args.push('-ca_file', caFile);
  // 只在明确要求时才关校验：画面是模型判断的依据，关掉校验等于允许中途改画面。
  if (process.env.FFMPEG_INSECURE_TLS === '1') args.push('-tls_verify', '0');
  const headers = headersFor(referer);
  const block = [`referer: ${headers.referer}`, `user-agent: ${USER_AGENT}`, `origin: ${headers.origin}`]
    .map((line) => `${line}\r\n`)
    .join('');
  args.push('-headers', block);
  return args;
}

/**
 * 跑一次 ffmpeg。stdout 丢弃、stderr 写文件（失败时回读最后几行）。
 * @param {string[]} args
 * @param {{timeoutMs?: number, signal?: AbortSignal}} [options]
 */
export async function runFfmpeg(args, { timeoutMs = 60_000, signal } = {}) {
  const { ffmpeg } = await resolveToolchain();
  const logDir = join(tmpdir(), 'bili-ffmpeg');
  await mkdir(logDir, { recursive: true }).catch(() => {});
  const logFile = join(logDir, `run-${process.pid}-${Date.now()}.log`);
  const fd = openSync(logFile, 'w');

  try {
    await new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', fd], windowsHide: true });
      } catch (error) {
        reject(new BiliError('DEPENDENCY_MISSING', `无法启动 ffmpeg：${error?.message ?? error}`));
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
        finish(reject, new BiliError('CANCELLED', 'ffmpeg 已被取消'));
      };
      timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(reject, new BiliError('TIMEOUT', `ffmpeg 超过 ${Math.round(timeoutMs / 1000)}s 未完成`));
      }, timeoutMs);
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener?.('abort', onAbort, { once: true });
      }
      child.on('error', (error) =>
        finish(reject, new BiliError('DEPENDENCY_MISSING', `无法启动 ffmpeg：${error?.message ?? error}`)),
      );
      child.on('exit', (code, sig) => {
        if (code === 0) finish(resolve, undefined);
        else finish(reject, new BiliError('UPSTREAM_ERROR', `ffmpeg 退出码 ${code ?? sig}`));
      });
    });
  } catch (error) {
    // 失败时把 stderr 尾巴带上，否则没法排查（URL 过期、403、证书、编码不支持）。
    const tail = await readFile(logFile, 'utf8').catch(() => '');
    const lines = tail.trim().split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 400);
    if (lines) {
      error.message = `${error.message}：${lines}`;
      if (/Peer certificate failed verification/i.test(lines)) {
        error.code = 'DEPENDENCY_MISSING';
        error.message += '（需要 CA 包：设置 FFMPEG_CA_FILE 或把 cacert.pem 放到数据目录）';
      }
    }
    throw error;
  } finally {
    try {
      closeSync(fd);
    } catch {}
    await rm(logFile, { force: true }).catch(() => {});
  }
}

/**
 * 在指定时间点抽一帧。
 *
 * `-ss` 放在 `-i` 前是输入侧定位，只解码目标附近的关键帧，比输出侧快一个量级。
 *
 * @param {{url:string, atMs:number, outFile:string, referer?:string, signal?:AbortSignal,
 *   timeoutMs?:number, vf?:string}} options `vf` 用来裁字幕带（例如 `crop=iw:ih*0.2:0:ih*0.8`）
 * @returns {Promise<Buffer>} JPEG
 */
export async function extractFrame({ url, atMs, outFile, referer, signal, timeoutMs = 25_000, vf }) {
  const seconds = Math.max(0, Math.round(Number(atMs) || 0)) / 1000;
  await mkdir(dirname(outFile), { recursive: true, mode: 0o700 }).catch(() => {});
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    ...(await inputOptions(referer)),
    '-ss',
    seconds.toFixed(3),
    '-i',
    url,
    ...(vf ? ['-vf', vf] : []),
    '-frames:v',
    '1',
    '-q:v',
    '2',
    '-y',
    outFile,
  ];
  await runFfmpeg(args, { timeoutMs, signal });
  const buffer = await readFile(outFile).catch(() => null);
  if (!buffer?.byteLength) throw new BiliError('UPSTREAM_ERROR', 'ffmpeg 没有产出画面（可能已过播放地址有效期）');
  return buffer;
}

/** 抽一段音频转成 16k 单声道 wav，给 ASR 用。 */
export async function extractAudio({ url, outFile, referer, signal, timeoutMs = 300_000, maxSeconds }) {
  await mkdir(dirname(outFile), { recursive: true, mode: 0o700 }).catch(() => {});
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    ...(await inputOptions(referer)),
    '-i',
    url,
    ...(maxSeconds ? ['-t', String(Math.max(1, Math.round(maxSeconds)))] : []),
    '-vn',
    '-ac',
    '1',
    '-ar',
    '16000',
    '-c:a',
    'pcm_s16le',
    '-y',
    outFile,
  ];
  await runFfmpeg(args, { timeoutMs, signal });
  return outFile;
}
