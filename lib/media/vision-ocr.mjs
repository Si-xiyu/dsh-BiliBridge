/**
 * macOS 的 OCR 引擎：Apple Vision（VNRecognizeTextRequest）。
 *
 * 做法与 Windows 版一致——**不引入任何运行时依赖**，只借用系统框架。
 * 区别是 Vision 只能从 Swift/ObjC 调用，所以 `vision-ocr.swift` 需要在首次使用时
 * 用 `swiftc -O` 编译成数据目录里的可执行文件，之后按源码 hash 复用。
 *
 * 为什么编译而不是 `swift run`/解释执行：编译后冷启动约 30ms，解释执行每次要 1s+，
 * 而 OCR 是一张图一次调用的高频路径。编译只需要 Xcode Command Line Tools，
 * 缺失时这里返回不可用，调用方按 `UNSUPPORTED` 降级，不影响其它能力。
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync } from 'node:fs';
import { mkdir, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BiliError } from '../bili/errors.mjs';
import { dataDir } from '../bili/store.mjs';

const SOURCE = fileURLToPath(new URL('./vision-ocr.swift', import.meta.url));

/** 编好的可执行文件放在数据目录，跟着 `BILI_DATA_DIR` 走。 */
export function visionBinaryPath() {
  return join(dataDir(), 'bin', 'bili-ocr-vision');
}

function stampPath() {
  return `${visionBinaryPath()}.stamp`;
}

/** 源码 hash：改了 Swift 就自动重编，没改就直接用现成的。 */
async function sourceHash() {
  const text = await readFile(SOURCE);
  return createHash('sha256').update(text).digest('hex');
}

/** `swiftc` 是否可用（只需 Command Line Tools）。 */
export function hasSwiftc() {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('swiftc', ['--version'], { stdio: 'ignore', windowsHide: true });
    } catch {
      resolve(false);
      return;
    }
    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(code === 0));
  });
}

let building;

/**
 * 返回可用的 Vision 助手路径，必要时编译一次（并发调用共享同一次编译）。
 * @returns {Promise<string>}
 */
export async function ensureVisionBinary({ timeoutMs = 180_000 } = {}) {
  if (process.platform !== 'darwin') {
    throw new BiliError('UNSUPPORTED', 'Apple Vision OCR 只在 macOS 上可用');
  }
  const binary = visionBinaryPath();
  const hash = await sourceHash();

  if (existsSync(binary)) {
    const stamp = await readFile(stampPath(), 'utf8').catch(() => '');
    if (stamp.trim() === hash) return binary;
  }

  if (building) return building;
  building = (async () => {
    if (!(await hasSwiftc())) {
      throw new BiliError(
        'DEPENDENCY_MISSING',
        '没有 swiftc，无法编译 Vision OCR 助手：安装 Xcode Command Line Tools（xcode-select --install）',
      );
    }
    await mkdir(join(dataDir(), 'bin'), { recursive: true });
    // 先编到临时文件再 rename，避免并发/中断留下半截二进制。
    const tmp = `${binary}.${process.pid}.tmp`;
    try {
      await runSwiftc(['-O', '-o', tmp, SOURCE], { timeoutMs });
      await rename(tmp, binary);
      await mkdir(dataDir(), { recursive: true });
      const { writeFile } = await import('node:fs/promises');
      await writeFile(stampPath(), `${hash}\n`, 'utf8');
      return binary;
    } finally {
      await rm(tmp, { force: true }).catch(() => {});
    }
  })();
  try {
    return await building;
  } finally {
    building = undefined;
  }
}

function runSwiftc(args, { timeoutMs }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn('swiftc', args, { stdio: 'ignore', windowsHide: true });
    } catch (error) {
      reject(new BiliError('DEPENDENCY_MISSING', `无法启动 swiftc：${error?.message ?? error}`));
      return;
    }
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(reject, new BiliError('TIMEOUT', '编译 Vision OCR 助手超时'));
    }, timeoutMs);
    child.on('error', (error) => finish(reject, new BiliError('DEPENDENCY_MISSING', `无法启动 swiftc：${error?.message ?? error}`)));
    child.on('exit', (code) => {
      if (code === 0) finish(resolve, undefined);
      else finish(reject, new BiliError('UPSTREAM_ERROR', `swiftc 退出码 ${code}`));
    });
  });
}

/**
 * 识别目录下的 row-*.jpg，输出形状与 Windows 版完全一致。
 * @param {{dir:string, language?:string, signal?:AbortSignal, timeoutMs?:number}} options
 */
export async function recognizeImageDirVision({ dir, language = 'zh-Hans', signal, timeoutMs = 180_000 } = {}) {
  if (!dir) throw new BiliError('INVALID_ARGUMENT', 'recognizeImageDir 需要 dir');
  const binary = await ensureVisionBinary();

  const outFile = join(tmpdir(), `bili-ocr-${process.pid}-${Date.now()}.json`);
  try {
    await runBinary(binary, ['-Dir', dir, '-Out', outFile, '-Language', language], { timeoutMs, signal });
    const raw = await readFile(outFile, 'utf8');
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
    return { language: parsed.language ?? language, results: parsed.results ?? [] };
  } finally {
    await rm(outFile, { force: true }).catch(() => {});
  }
}

/** 跑一次助手：stdout 丢弃、stderr 落文件（与 PowerShell 那条路同样的取舍）。 */
async function runBinary(binary, args, { timeoutMs = 180_000, signal } = {}) {
  const logDir = join(tmpdir(), 'bili-ocr');
  await mkdir(logDir, { recursive: true }).catch(() => {});
  const logFile = join(logDir, `vision-${process.pid}-${Date.now()}.log`);
  const fd = openSync(logFile, 'w');
  try {
    await new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(binary, args, { stdio: ['ignore', 'ignore', fd], windowsHide: true });
      } catch (error) {
        reject(new BiliError('UNSUPPORTED', `无法启动 Vision OCR：${error?.message ?? error}`));
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
      child.on('error', (error) => finish(reject, new BiliError('UNSUPPORTED', `无法启动 Vision OCR：${error?.message ?? error}`)));
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
