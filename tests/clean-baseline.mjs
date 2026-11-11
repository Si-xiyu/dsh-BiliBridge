#!/usr/bin/env node
/**
 * 干净的 macOS 基线诊断（手工脚本，不属于单元测试）。
 *
 * 回答一个问题：一台“刚装好的 Mac”上，哪些安装步骤会失败、失败成什么样。
 * 只读探测：不联网、不调 B 站接口、不跑 ASR/OCR 推理、不编译 Vision 助手。
 *
 * 三个阶段（每个阶段重新解析一次，避免进程内缓存掩盖问题）：
 *   installed    当前 PATH/环境 + 空的数据目录（不碰 ~/.dsh/bilibili）
 *   no-homebrew  PATH 收缩到系统目录，清掉 FFMPEG_PATH / BILI_ASR_* / FFMPEG_CA_FILE
 *   no-tools     再注入不存在的 python/ffmpeg，记录解析器给出的确切错误码与消息
 *
 * 用法：
 *   node tests/clean-baseline.mjs            # 人类可读表格
 *   node tests/clean-baseline.mjs --json     # 机器可读
 *   node tests/clean-baseline.mjs --keep     # 保留临时数据目录（排查用）
 *
 * 永远是诊断脚本：任何检查失败都只记录，退出码始终为 0。
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { resetFfmpegCache, resolveToolchain } from '../lib/media/ffmpeg.mjs';
import { resetAsrCache, resolveAsr } from '../lib/media/asr.mjs';
import { ocrEngineFor } from '../lib/media/ocr.mjs';
import { visionBinaryPath } from '../lib/media/vision-ocr.mjs';
import { getSharp } from '../lib/media/frames.mjs';

/** 系统目录，模拟 GUI 进程/未装 Homebrew 的 PATH。 */
const SIMPLE_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
/** 保证任何解释器都解析不到，用于强制“没有 python”。 */
const NO_PYTHON_PATH = '/nonexistent-bin';
/** 只在这几个阶段清掉的环境变量。 */
const CLEARED_KEYS = ['FFMPEG_PATH', 'BILI_ASR_PYTHON', 'BILI_ASR_MODEL_DIR', 'FFMPEG_CA_FILE'];
const STAGES = ['installed', 'no-homebrew', 'no-tools'];

const rows = [];
const savedEnv = new Map();

function setEnv(key, value) {
  if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function restoreEnv() {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
}

function record(stage, check, outcome) {
  rows.push({
    stage,
    check,
    ok: outcome.ok === true,
    code: outcome.code ?? null,
    detail: outcome.detail === undefined ? null : String(outcome.detail),
  });
}

/** 跑一次探测；抛错时保留 BiliError.code（或 syscall 的 errno 名）。 */
async function capture(fn) {
  try {
    return { ok: true, code: 'OK', detail: await fn() };
  } catch (error) {
    const code = typeof error?.code === 'string' ? error.code : (error?.name ?? 'ERROR');
    return { ok: false, code, detail: error?.message ?? String(error) };
  }
}

/** 提示“这个二进制不在 PATH 上，是靠已知安装前缀兜底找到的”。 */
function pathNote(bin) {
  if (typeof bin !== 'string' || !bin.includes('/')) return '';
  const dir = dirname(bin);
  const onPath = (process.env.PATH ?? '').split(':').includes(dir);
  return onPath ? '' : ' [not on PATH]';
}

function firstLine(text) {
  return String(text ?? '').trim().split('\n')[0] ?? '';
}

function ffmpegVersionCheck(stage, resolved) {
  const target = resolved ?? 'ffmpeg';
  const res = spawnSync(target, ['-version'], { encoding: 'utf8', timeout: 15_000 });
  if (res.error) {
    record(stage, 'ffmpeg-version', {
      ok: false,
      code: typeof res.error.code === 'string' ? res.error.code : 'SPAWN_ERROR',
      detail: `${target}: ${res.error.message}`,
    });
    return;
  }
  const line = firstLine(res.stdout) || firstLine(res.stderr) || `exit=${res.status}`;
  record(stage, 'ffmpeg-version', {
    ok: res.status === 0,
    code: res.status === 0 ? 'OK' : `exit=${res.status}`,
    detail: `${line} @ ${target}`,
  });
}

function swiftcCheck(stage) {
  const res = spawnSync('swiftc', ['--version'], { encoding: 'utf8', timeout: 15_000 });
  if (res.error) {
    record(stage, 'swiftc', {
      ok: false,
      code: typeof res.error.code === 'string' ? res.error.code : 'SPAWN_ERROR',
      detail: res.error.message,
    });
    return;
  }
  record(stage, 'swiftc', {
    ok: res.status === 0,
    code: res.status === 0 ? 'OK' : `exit=${res.status}`,
    detail: firstLine(res.stdout) || firstLine(res.stderr) || `status=${res.status}`,
  });
}

function ocrEngineCheck(stage) {
  const engine = ocrEngineFor(process.platform);
  record(stage, 'ocr-engine', engine
    ? { ok: true, code: 'OK', detail: `${engine} (platform=${process.platform})` }
    : { ok: false, code: 'UNSUPPORTED', detail: `no engine for ${process.platform}` });
}

function visionBinaryCheck(stage) {
  const file = visionBinaryPath();
  record(stage, 'vision-binary', existsSync(file)
    ? { ok: true, code: 'OK', detail: file }
    : { ok: false, code: 'NOT_BUILT', detail: `${file} (空数据目录，未编译)` });
}

async function sharpCheck(stage) {
  const outcome = await capture(async () => {
    const sharp = await getSharp();
    const versions = sharp.versions ?? {};
    const jpeg = Boolean(sharp.format?.jpeg?.input?.buffer);
    return `sharp ${versions.sharp} libvips ${versions.vips} ${process.platform}/${process.arch} jpeg=${jpeg}`;
  });
  record(stage, 'sharp-load', outcome);
}

/** installed / no-homebrew 共用的探测顺序。 */
async function probeCommon(stage, { pathOnly = false } = {}) {
  let resolved = null;
  const toolchain = await capture(async () => {
    const { ffmpeg, caFile } = await resolveToolchain({ force: true });
    resolved = ffmpeg;
    return `ffmpeg=${ffmpeg} ca=${caFile ?? 'none'}${pathNote(ffmpeg)}`;
  });
  record(stage, 'ffmpeg-resolve', toolchain);
  if (pathOnly) {
    const strict = await capture(async () => {
      const { ffmpeg } = await resolveToolchain({ force: true, knownBinaries: [] });
      return `ffmpeg=${ffmpeg} (只靠 PATH/环境变量，不用已知安装前缀)`;
    });
    record(stage, 'ffmpeg-resolve-path-only', strict);
  }
  ffmpegVersionCheck(stage, resolved);
  const asr = await capture(async () => {
    const runtime = await resolveAsr({ force: true });
    return `python=${runtime.python} model=${runtime.model} modelDir=${runtime.modelDir}`;
  });
  record(stage, 'asr-resolve', asr);
  await sharpCheck(stage);
  ocrEngineCheck(stage);
  visionBinaryCheck(stage);
  swiftcCheck(stage);
}

async function stageInstalled() {
  await probeCommon('installed');
}

async function stageNoHomebrew() {
  setEnv('PATH', SIMPLE_PATH);
  for (const key of CLEARED_KEYS) setEnv(key, undefined);
  resetFfmpegCache();
  resetAsrCache();
  await probeCommon('no-homebrew', { pathOnly: true });
}

async function stageNoTools() {
  setEnv('BILI_ASR_PYTHON', '/nonexistent/python');
  setEnv('FFMPEG_PATH', '/nonexistent/ffmpeg');
  resetFfmpegCache();
  resetAsrCache();

  // 注入的路径会被 existsSync 否掉，于是回落到配置/PATH；这里记录实际落点。
  const toolchain = await capture(async () => {
    const { ffmpeg, caFile } = await resolveToolchain({ force: true });
    return `ffmpeg=${ffmpeg} ca=${caFile ?? 'none'}${pathNote(ffmpeg)} (env 指向 /nonexistent/ffmpeg，已被忽略)`;
  });
  record('no-tools', 'ffmpeg-resolve', toolchain);

  const forcedFfmpeg = await capture(async () => {
    const { ffmpeg } = await resolveToolchain({ force: true, knownBinaries: [] });
    return `ffmpeg=${ffmpeg}`;
  });
  record('no-tools', 'ffmpeg-missing-forced', forcedFfmpeg.ok
    ? { ok: false, code: 'UNEXPECTED_SUCCESS', detail: `仍然解析到 ${forcedFfmpeg.detail}，说明 PATH 里还有 ffmpeg` }
    : forcedFfmpeg);

  const asr = await capture(async () => {
    const runtime = await resolveAsr({ force: true });
    return runtime;
  });
  // 注入的 /nonexistent/python 会被 existsSync 否掉，解析器继续往 venv/PATH 找；
  // 找到了不是失败，只是说明“注入本身”不足以制造缺依赖。
  record('no-tools', 'asr-resolve', asr.ok
    ? {
      ok: true,
      code: 'ENV_IGNORED',
      detail: `env 注入被跳过，回落到 python=${asr.detail.python} model=${asr.detail.model}`,
    }
    : asr);

  // 有些机器系统 python 里恰好装了 faster_whisper，env 注入挡不住；把 PATH 也抽空拿确定错误。
  setEnv('PATH', NO_PYTHON_PATH);
  resetAsrCache();
  try {
    const forced = await capture(async () => {
      const runtime = await resolveAsr({ force: true });
      return `python=${runtime.python}`;
    });
    record('no-tools', 'asr-missing-forced', forced.ok
      ? { ok: false, code: 'UNEXPECTED_SUCCESS', detail: forced.detail }
      : forced);
  } finally {
    setEnv('PATH', SIMPLE_PATH);
    resetAsrCache();
  }
}

function clip(text, max) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function printTable({ dataDir, kept }) {
  const widths = { check: 26, result: 6, code: 22 };
  console.log('clean macOS baseline — manual diagnostic (no network, always exit 0)');
  console.log(`node ${process.versions.node} · ${process.platform}/${process.arch}`);
  console.log('');
  console.log(
    `${'stage'.padEnd(12)}${'check'.padEnd(widths.check)}` +
    `${'ok'.padEnd(widths.result)}${'code'.padEnd(widths.code)}detail`,
  );
  console.log('-'.repeat(150));
  for (const row of rows) {
    console.log(
      `${row.stage.padEnd(12)}${row.check.padEnd(widths.check)}` +
      `${(row.ok ? 'ok' : 'FAIL').padEnd(widths.result)}` +
      `${String(row.code).padEnd(widths.code)}${clip(row.detail, 88)}`,
    );
  }
  console.log('');
  for (const stage of STAGES) {
    const group = rows.filter((row) => row.stage === stage);
    const failed = group.filter((row) => !row.ok).length;
    console.log(`${stage}: ${group.length - failed}/${group.length} ok${failed ? `, ${failed} failed` : ''}`);
  }
  console.log(`data dir: ${dataDir} (${kept ? 'kept' : 'removed'})`);
  console.log('exit code is always 0 — this is a probe, not an assertion.');
}

function printJson({ dataDir, kept }) {
  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    node: process.versions.node,
    dataDir,
    dataDirKept: kept,
    records: rows,
  }, null, 2));
}

async function main() {
  const json = process.argv.includes('--json');
  const kept = process.argv.includes('--keep');
  const dataDir = await mkdtemp(join(tmpdir(), 'bili-baseline-'));
  setEnv('BILI_DATA_DIR', dataDir);
  try {
    await stageInstalled();
    await stageNoHomebrew();
    await stageNoTools();
  } finally {
    restoreEnv();
    if (!kept) await rm(dataDir, { recursive: true, force: true });
  }
  if (json) printJson({ dataDir, kept });
  else printTable({ dataDir, kept });
}

main().catch((error) => {
  // 诊断脚本不因自身异常改变退出码；把原因留在 stderr 即可。
  console.error('baseline probe crashed:', error);
  process.exitCode = 0;
});
