import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as tick } from 'node:timers/promises';
import { asrCandidates, resetAsrCache, resolveAsr } from '../../lib/media/asr.mjs';
import { caFileCandidates, ffmpegCandidates, resetFfmpegCache, resolveToolchain } from '../../lib/media/ffmpeg.mjs';
import { runtimePath } from '../../lib/media/settings-merge.mjs';

// 保存设置时可能正有一次探测在跑：reset 之后完成的探测不能再把旧结果写回缓存。
async function withTempDataDir(run) {
  const previous = process.env.BILI_DATA_DIR;
  const dir = await mkdtemp(join(tmpdir(), 'bili-runtime-gen-'));
  process.env.BILI_DATA_DIR = dir;
  try { return await run(dir); }
  finally {
    if (previous === undefined) delete process.env.BILI_DATA_DIR;
    else process.env.BILI_DATA_DIR = previous;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function until(predicate) {
  for (let i = 0; i < 200 && !predicate(); i += 1) await tick();
  assert.ok(predicate(), '等待探测开始超时');
}

test('resolveAsr：reset 期间完成的探测不写回缓存，下一次重新探测', async () => {
  await withTempDataDir(async () => {
    resetAsrCache();
    let calls = 0;
    let release;
    try {
      const first = resolveAsr({ probe: () => { calls += 1; return new Promise((resolve) => { release = () => resolve(true); }); } });
      await until(() => calls === 1);
      resetAsrCache(); // 模拟设置保存
      release();
      const resolved = await first;
      assert.ok(resolved.python, '在途探测的结果仍要返回给当前调用方');

      const again = await resolveAsr({ probe: async () => { calls += 1; return true; } });
      assert.ok(again.python);
      assert.equal(calls, 2, 'reset 后必须重新探测，而不是命中旧缓存');
    } finally { resetAsrCache(); }
  });
});

test('resolveToolchain：reset 期间完成的探测不写回缓存，下一次重新探测', async () => {
  await withTempDataDir(async () => {
    resetFfmpegCache();
    let calls = 0;
    let release;
    try {
      const first = resolveToolchain({ knownBinaries: [], probe: () => { calls += 1; return new Promise((resolve) => { release = () => resolve(true); }); } });
      await until(() => calls === 1);
      resetFfmpegCache(); // 模拟设置保存
      release();
      const resolved = await first;
      assert.ok(resolved.ffmpeg, '在途探测的结果仍要返回给当前调用方');

      const again = await resolveToolchain({ knownBinaries: [], probe: async () => { calls += 1; return true; } });
      assert.ok(again.ffmpeg);
      assert.equal(calls, 2, 'reset 后必须重新探测，而不是命中旧缓存');
    } finally { resetFfmpegCache(); }
  });
});

test('runtimePath：runtime 段优先于旧版平铺键，空串=自动且不回落到旧键', () => {
  assert.equal(runtimePath({ runtime: { asrPython: '/nested/python' }, asrPython: '/legacy/python' }, 'asrPython'), '/nested/python');
  assert.equal(runtimePath({ runtime: { asrPython: '  /nested/python  ' } }, 'asrPython'), '/nested/python');
  // 旧版平铺键在 runtime 段缺这个键时继续生效
  assert.equal(runtimePath({ asrPython: ' /legacy/python ' }, 'asrPython'), '/legacy/python');
  assert.equal(runtimePath({ runtime: {} , asrPython: '/legacy/python' }, 'asrPython'), '/legacy/python');
  assert.equal(runtimePath({}, 'asrPython'), null);
  assert.equal(runtimePath(null, 'asrPython'), null);
  assert.equal(runtimePath({ runtime: null, asrPython: 42 }, 'asrPython'), null);
  // 显式空串：不再回落到同名旧键，表示“自动/缺省”
  assert.equal(runtimePath({ runtime: { asrPython: '' }, asrPython: '/legacy/python' }, 'asrPython'), null);
});

test('ffmpeg 候选顺序：FFMPEG_PATH > runtime.ffmpegPath > 旧版 ffmpegPath > 平台候选 > PATH', () => {
  const knownBinaries = ['/known/bin/ffmpeg'];
  const nested = { ffmpegPath: '/legacy/ffmpeg', runtime: { ffmpegPath: '/nested/ffmpeg' } };
  assert.deepEqual(ffmpegCandidates({ config: nested, env: {}, knownBinaries }), ['/nested/ffmpeg', '/known/bin/ffmpeg', 'ffmpeg']);
  assert.deepEqual(ffmpegCandidates({ config: { ffmpegPath: '/legacy/ffmpeg' }, env: {}, knownBinaries }), ['/legacy/ffmpeg', '/known/bin/ffmpeg', 'ffmpeg']);
  assert.deepEqual(
    ffmpegCandidates({ config: nested, env: { FFMPEG_PATH: '/env/ffmpeg' }, knownBinaries }),
    ['/env/ffmpeg', '/nested/ffmpeg', '/known/bin/ffmpeg', 'ffmpeg'],
  );
  // 空串/空环境变量不占位
  assert.deepEqual(ffmpegCandidates({ config: { runtime: { ffmpegPath: '' } }, env: { FFMPEG_PATH: '' }, knownBinaries }), ['/known/bin/ffmpeg', 'ffmpeg']);
});

test('CA 候选顺序：FFMPEG_CA_FILE > runtime.ffmpegCaFile > 旧版 > cacert.pem > 系统 CA', () => {
  const root = join('/tmp', 'bili-runtime-settings');
  const nested = { ffmpegCaFile: '/legacy/ca.pem', runtime: { ffmpegCaFile: '/nested/ca.pem' } };
  assert.deepEqual(caFileCandidates({ config: nested, env: {}, root, platform: 'darwin' }).slice(0, 3),
    ['/nested/ca.pem', join(root, 'cacert.pem'), '/etc/ssl/cert.pem']);
  assert.deepEqual(caFileCandidates({ config: { ffmpegCaFile: '/legacy/ca.pem' }, env: {}, root, platform: 'linux' }).slice(0, 2),
    ['/legacy/ca.pem', join(root, 'cacert.pem')]);
  assert.equal(caFileCandidates({ config: nested, env: { FFMPEG_CA_FILE: '/env/ca.pem' }, root, platform: 'linux' })[0], '/env/ca.pem');
  // Windows 没有系统 CA 包概念，不追加
  assert.equal(caFileCandidates({ config: {}, env: {}, root, platform: 'win32' }).includes('/etc/ssl/cert.pem'), false);
  // runtime 空串表示自动：不回落旧键，直接进数据目录/系统 CA
  assert.deepEqual(caFileCandidates({ config: { ffmpegCaFile: '/legacy/ca.pem', runtime: { ffmpegCaFile: '' } }, env: {}, root, platform: 'win32' }).slice(0, 1),
    [join(root, 'cacert.pem')]);
});

test('ASR 候选顺序：BILI_ASR_PYTHON > runtime.asrPython > 旧版 asrPython > 数据目录 venv > PATH', () => {
  const previous = process.env.BILI_DATA_DIR;
  process.env.BILI_DATA_DIR = join('/tmp', 'bili-runtime-settings');
  const venv = join('/tmp', 'bili-runtime-settings', 'asr-venv', 'bin', 'python');
  try {
    const nested = { asrPython: '/legacy/python', runtime: { asrPython: '/nested/python' } };
    assert.deepEqual(asrCandidates({ config: nested, env: {}, platform: 'darwin' }).slice(0, 2), ['/nested/python', venv]);
    // 环境变量仍然最高优先级（与改动前一致）
    assert.deepEqual(asrCandidates({ config: nested, env: { BILI_ASR_PYTHON: '/env/python' }, platform: 'darwin' }).slice(0, 3),
      ['/env/python', '/nested/python', venv]);
    // 没有 runtime 段时旧版平铺键仍生效
    assert.equal(asrCandidates({ config: { asrPython: '/legacy/python' }, env: {}, platform: 'darwin' })[0], '/legacy/python');
    // 空串=自动：不回落旧键，直接走缺省
    assert.equal(asrCandidates({ config: { asrPython: '/legacy/python', runtime: { asrPython: '' } }, env: {}, platform: 'darwin' })[0], venv);
    assert.equal(asrCandidates({ config: nested, env: {}, platform: 'darwin' }).at(-1), 'python3');
  } finally {
    if (previous === undefined) delete process.env.BILI_DATA_DIR;
    else process.env.BILI_DATA_DIR = previous;
  }
});
