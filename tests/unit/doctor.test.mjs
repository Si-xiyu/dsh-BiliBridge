import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { collectDiagnostics, isAsrModelReady } from '../../lib/diagnostics.mjs';
import { readStatus } from '../../lib/settings-api.mjs';
import { BiliError } from '../../lib/bili/errors.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** 注入式 readers：默认全部可用，单测不碰真实安装。 */
function makeReaders(overrides = {}) {
  return {
    identity: async () => ({ version: '9.9.9', modulePath: '/repo', toolCount: 27 }),
    toolchain: async () => ({ ffmpeg: '/opt/ffmpeg', caFile: null }),
    ffmpegVersion: () => 'ffmpeg version 9.9',
    asr: async () => ({ python: '/opt/python', model: 'small', modelDir: '/models' }),
    modelReady: async () => ({ ready: true, detail: '1 个权重文件' }),
    sharpVersions: async () => ({ sharp: '0.35.5', vips: '8.18.7' }),
    ocrEngine: () => 'windows-media-ocr',
    visionBinaryPath: () => '/bin/bili-ocr-vision',
    visionState: async () => ({ binary: '/bin/bili-ocr-vision', compiled: true, stale: false }),
    swiftc: () => ({ ok: true, version: 'Apple Swift 6' }),
    ...overrides,
  };
}

async function withTempDir(t, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'bili-doctor-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return fn(dir);
}

const byId = (result, id) => result.sections.find((item) => item.id === id);

test('doctor 全绿时 ok=true，七项齐全', async (t) => {
  await withTempDir(t, async (dir) => {
    const result = await collectDiagnostics({ env: { BILI_DATA_DIR: dir }, platform: 'darwin', readers: makeReaders() });
    assert.equal(result.sections.length, 7);
    assert.equal(result.ok, true);
    assert.equal(result.summary.requiredFailed, 0);
    assert.equal(byId(result, 'runtime').detail.includes('27 个工具'), true);
    assert.equal(byId(result, 'storage').ok, true);
  });
});

test('可选依赖缺失只标失败，不阻断安装', async (t) => {
  await withTempDir(t, async (dir) => {
    const readers = makeReaders({
      toolchain: async () => { throw new BiliError('DEPENDENCY_MISSING', '没有 ffmpeg'); },
      asr: async () => { throw new BiliError('DEPENDENCY_MISSING', '没有 faster-whisper'); },
      sharpVersions: async () => { throw new BiliError('DEPENDENCY_MISSING', '没有 sharp'); },
      ocrEngine: () => null,
    });
    const result = await collectDiagnostics({ env: { BILI_DATA_DIR: dir }, platform: 'linux', readers });
    assert.equal(result.ok, true, '必需项都通过时 doctor 应通过');
    assert.equal(result.summary.fail, 4);
    assert.equal(result.summary.requiredFailed, 0);
    assert.equal(byId(result, 'ffmpeg').required, false);
    assert.equal(byId(result, 'ocr').code, 'UNSUPPORTED');
  });
});

test('存储目录不可写属于必需项失败', async (t) => {
  await withTempDir(t, async (dir) => {
    const file = join(dir, 'not-a-dir');
    await writeFile(file, 'x');
    const result = await collectDiagnostics({ env: { BILI_DATA_DIR: file }, platform: 'darwin', readers: makeReaders() });
    assert.equal(result.ok, false);
    assert.equal(result.summary.requiredFailed, 1);
    assert.equal(byId(result, 'storage').code, 'DIR_UNWRITABLE');
  });
});

test('Windows 上跳过 POSIX 0600 检查并计入 skipped', async (t) => {
  await withTempDir(t, async (dir) => {
    await writeFile(join(dir, 'credentials.json'), '{}', { mode: 0o600 });
    const result = await collectDiagnostics({ env: { BILI_DATA_DIR: dir }, platform: 'win32', readers: makeReaders() });
    assert.equal(result.ok, true);
    assert.equal(result.summary.skipped, 1);
    const storage = byId(result, 'storage');
    assert.equal(storage.checks.some((item) => item.code === 'SKIPPED'), true);
  });
});

test('凭据权限过宽会被发现（POSIX）', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX 0600 语义，Windows 用 ACL');
  await withTempDir(t, async (dir) => {
    const file = join(dir, 'credentials.json');
    await writeFile(file, '{}', { mode: 0o600 });
    await chmod(file, 0o644);
    const result = await collectDiagnostics({ env: { BILI_DATA_DIR: dir }, platform: 'darwin', readers: makeReaders() });
    assert.equal(result.ok, false);
    assert.equal(byId(result, 'storage').code, 'CREDENTIALS_PERMISSIONS');
  });
});

test('身份采集失败不拖垮必需项，只标注未知', async (t) => {
  await withTempDir(t, async (dir) => {
    const readers = makeReaders({ identity: async () => { throw new Error('boom'); } });
    const result = await collectDiagnostics({ env: { BILI_DATA_DIR: dir }, platform: 'darwin', readers });
    assert.equal(result.ok, true, 'sharp 缺失导致的入口导入失败不应让安装自检失败');
    assert.equal(result.sections.length, 7);
    assert.equal(byId(result, 'runtime').ok, true);
    assert.equal(byId(result, 'runtime').code, 'IDENTITY_UNKNOWN');
    assert.equal(result.identity, null);
  });
});

test('readStatus 暴露 identity，采集失败时降级为 null 而不是 500', async () => {
  const baseReaders = {
    account: async () => ({ loggedIn: false }),
    toolchain: async () => ({ ffmpeg: '/opt/ffmpeg', caFile: null }),
    asr: async () => ({ python: '/opt/python', model: 'small' }),
    ocr: async () => ({ platform: 'darwin', available: false }),
    budget: async () => [],
    cache: async () => ({ totalBytes: 0, totalFiles: 0, buckets: [] }),
    now: () => '2026-11-11T00:00:00.000Z',
  };
  const ok = await readStatus({ ...baseReaders, identity: async () => ({ version: '1.2.3', modulePath: '/repo', toolCount: 27 }) });
  assert.equal(ok.identity.version, '1.2.3');
  assert.equal(ok.identity.toolCount, 27);

  const broken = await readStatus({ ...baseReaders, identity: async () => { throw new Error('boom'); } });
  assert.equal(broken.identity.version, null);
  assert.equal(broken.identity.toolCount, 0);
});

test('CLI：doctor --json 可运行且只依赖必需项退出码', async (t) => {
  await withTempDir(t, async (dir) => {
    const result = spawnSync(process.execPath, [join(ROOT, 'bin/bili.mjs'), 'doctor', '--json'], {
      cwd: ROOT,
      env: { ...process.env, BILI_DATA_DIR: dir },
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(result.error, undefined, String(result.error));
    const parsed = JSON.parse(result.stdout);
    assert.equal(Array.isArray(parsed.sections), true);
    assert.equal(parsed.sections.length, 7);
    assert.equal(parsed.identity?.toolCount > 0, true);
    assert.equal(typeof parsed.identity?.modulePath, 'string');
    assert.equal(parsed.ok, true, result.stdout);
    assert.equal(result.status, 0);
  });
});

test('ASR 只认当前配置的模型，缓存了别的模型不算就绪', async (t) => {
  await withTempDir(t, async (dir) => {
    const modelDir = join(dir, 'models');
    const tiny = join(modelDir, 'models--Systran--faster-whisper-tiny', 'snapshots', 'abc');
    await mkdir(tiny, { recursive: true });
    await writeFile(join(tiny, 'model.bin'), 'w');
    const readers = makeReaders({
      asr: async () => ({ python: '/opt/python', model: 'small', modelDir }),
      modelReady: undefined, // 用真实的按模型名匹配
    });
    delete readers.modelReady;
    const result = await collectDiagnostics({ env: { BILI_DATA_DIR: join(dir, 'data') }, platform: 'darwin', readers });
    const asr = byId(result, 'asr');
    assert.equal(asr.ok, false);
    assert.equal(asr.code, 'MODEL_MISSING');
    assert.match(asr.detail, /未就绪/);
  });
});

test('ASR 缓存里有当前模型时才算就绪', async (t) => {
  await withTempDir(t, async (dir) => {
    const modelDir = join(dir, 'models');
    const small = join(modelDir, 'models--Systran--faster-whisper-small', 'snapshots', 'abc');
    await mkdir(small, { recursive: true });
    await writeFile(join(small, 'model.bin'), 'w');
    const readers = makeReaders({
      asr: async () => ({ python: '/opt/python', model: 'small', modelDir }),
      modelReady: undefined,
    });
    delete readers.modelReady;
    const result = await collectDiagnostics({ env: { BILI_DATA_DIR: join(dir, 'data') }, platform: 'darwin', readers });
    const asr = byId(result, 'asr');
    assert.equal(asr.ok, true);
    assert.match(asr.detail, /1 个权重文件/);
  });
});

test('Vision 助手 stamp 过期且没有 swiftc 时不能算就绪', async (t) => {
  await withTempDir(t, async (dir) => {
    const readers = makeReaders({
      visionState: async () => ({ binary: '/bin/bili-ocr-vision', compiled: false, stale: true }),
      swiftc: () => ({ ok: false, version: null }),
    });
    const result = await collectDiagnostics({ env: { BILI_DATA_DIR: dir }, platform: 'darwin', readers });
    const ocr = byId(result, 'ocr');
    assert.equal(ocr.ok, false);
    assert.equal(ocr.code, 'DEPENDENCY_MISSING');
    assert.match(ocr.detail, /stamp/);
  });
});

test('Vision 助手 stamp 匹配时不需要 swiftc', async (t) => {
  await withTempDir(t, async (dir) => {
    const readers = makeReaders({
      visionState: async () => ({ binary: '/bin/bili-ocr-vision', compiled: true, stale: false }),
      swiftc: () => ({ ok: false, version: null }),
    });
    const result = await collectDiagnostics({ env: { BILI_DATA_DIR: dir }, platform: 'darwin', readers });
    assert.equal(byId(result, 'ocr').ok, true);
  });
});

test('ASR 支持 HF 仓库 ID 形式，并能映射到缓存目录', async (t) => {
  await withTempDir(t, async (dir) => {
    const modelDir = join(dir, 'models');
    const snapshot = join(modelDir, 'models--Systran--faster-whisper-small', 'snapshots', 'abc');
    await mkdir(snapshot, { recursive: true });
    await writeFile(join(snapshot, 'model.bin'), 'w');
    const readers = makeReaders({
      asr: async () => ({ python: '/opt/python', model: 'Systran/faster-whisper-small', modelDir }),
      modelReady: undefined,
    });
    delete readers.modelReady;
    const result = await collectDiagnostics({ env: { BILI_DATA_DIR: join(dir, 'data') }, platform: 'darwin', readers });
    assert.equal(byId(result, 'asr').ok, true, byId(result, 'asr').detail);
  });
});

test('ASR 不把悬空的 model.bin 符号链接算作已下载', async (t) => {
  if (process.platform === 'win32') return t.skip('Windows 创建符号链接需要额外权限');
  await withTempDir(t, async (dir) => {
    const modelDir = join(dir, 'models');
    const snapshot = join(modelDir, 'models--Systran--faster-whisper-small', 'snapshots', 'abc');
    await mkdir(snapshot, { recursive: true });
    await symlink(join(modelDir, 'models--Systran--faster-whisper-small', 'blobs', 'missing'), join(snapshot, 'model.bin'));
    const readers = makeReaders({
      asr: async () => ({ python: '/opt/python', model: 'small', modelDir }),
      modelReady: undefined,
    });
    delete readers.modelReady;
    const result = await collectDiagnostics({ env: { BILI_DATA_DIR: join(dir, 'data') }, platform: 'darwin', readers });
    assert.equal(byId(result, 'asr').ok, false);
    assert.equal(byId(result, 'asr').code, 'MODEL_MISSING');
  });
});

test('ASR 别名 large 映射到 faster-whisper-large-v3 缓存', async (t) => {
  await withTempDir(t, async (dir) => {
    const modelDir = join(dir, 'models');
    const snapshot = join(modelDir, 'models--Systran--faster-whisper-large-v3', 'snapshots', 'abc');
    await mkdir(snapshot, { recursive: true });
    await writeFile(join(snapshot, 'model.bin'), 'w');
    const readers = makeReaders({ asr: async () => ({ python: '/opt/python', model: 'large', modelDir }), modelReady: undefined });
    delete readers.modelReady;
    const result = await collectDiagnostics({ env: { BILI_DATA_DIR: join(dir, 'data') }, platform: 'darwin', readers });
    assert.equal(byId(result, 'asr').ok, true, byId(result, 'asr').detail);
  });
});

test('ASR 别名 distil-small.en 映射到 distil 仓库缓存', async (t) => {
  await withTempDir(t, async (dir) => {
    const modelDir = join(dir, 'models');
    const snapshot = join(modelDir, 'models--Systran--faster-distil-whisper-small.en', 'snapshots', 'abc');
    await mkdir(snapshot, { recursive: true });
    await writeFile(join(snapshot, 'model.bin'), 'w');
    const readers = makeReaders({ asr: async () => ({ python: '/opt/python', model: 'distil-small.en', modelDir }), modelReady: undefined });
    delete readers.modelReady;
    const result = await collectDiagnostics({ env: { BILI_DATA_DIR: join(dir, 'data') }, platform: 'darwin', readers });
    assert.equal(byId(result, 'asr').ok, true, byId(result, 'asr').detail);
  });
});

test('Windows OCR 缺 powershell 时不能报可用', async (t) => {
  await withTempDir(t, async (dir) => {
    const readers = makeReaders({
      ocrAvailability: async () => ({ available: false, reason: '找不到 powershell.exe' }),
    });
    const result = await collectDiagnostics({ env: { BILI_DATA_DIR: dir }, platform: 'win32', readers });
    const ocr = byId(result, 'ocr');
    assert.equal(ocr.ok, false);
    assert.equal(ocr.code, 'DEPENDENCY_MISSING');
    assert.match(ocr.detail, /powershell/);
  });
});

test('ASR 支持已存在的本地相对模型目录', async (t) => {
  await withTempDir(t, async (dir) => {
    const local = join(dir, 'custom-whisper');
    await mkdir(local, { recursive: true });
    await writeFile(join(local, 'model.bin'), 'w');
    const state = await isAsrModelReady({ model: 'custom-whisper', modelDir: join(dir, 'cache'), cwd: dir });
    assert.equal(state.ready, true, state.detail);
  });
});

test('Windows 上 ffmpeg 缺 CA 要标出来', async (t) => {
  await withTempDir(t, async (dir) => {
    const result = await collectDiagnostics({ env: { BILI_DATA_DIR: dir }, platform: 'win32', readers: makeReaders() });
    const ffmpeg = byId(result, 'ffmpeg');
    assert.equal(ffmpeg.ok, false);
    assert.equal(ffmpeg.code, 'CA_MISSING');
    assert.match(ffmpeg.detail, /ffmpegCaFile/);
  });
});
