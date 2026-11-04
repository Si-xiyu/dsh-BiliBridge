import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { asrCandidates, isPathLike } from '../../lib/media/asr.mjs';
import { ocrEngineFor } from '../../lib/media/ocr.mjs';
import { visionBinaryPath } from '../../lib/media/vision-ocr.mjs';

// 平台分派以前写死在 Windows 上，这几条用例锁住“换平台不改调用方”的约定。

test('OCR 按平台选引擎，未知平台明确返回 null', () => {
  assert.equal(ocrEngineFor('win32'), 'windows-media-ocr');
  assert.equal(ocrEngineFor('darwin'), 'apple-vision');
  assert.equal(ocrEngineFor('linux'), null);
  assert.equal(ocrEngineFor('freebsd'), null);
});

test('ASR 候选顺序：环境变量 → 配置 → 数据目录 venv → PATH，配置优先于缺省', () => {
  const previous = process.env.BILI_DATA_DIR;
  process.env.BILI_DATA_DIR = join('/tmp', 'bili-platform-test');
  try {
    const list = asrCandidates({
      env: { BILI_ASR_PYTHON: '/opt/custom/python' },
      config: { asrPython: '/opt/config/python' },
      platform: 'darwin',
    });
    assert.deepEqual(list.slice(0, 3), ['/opt/custom/python', '/opt/config/python', join('/tmp', 'bili-platform-test', 'asr-venv', 'bin', 'python')]);
    assert.equal(list.at(-1), 'python3', '裸命令名必须留作 PATH 兜底');

    const win = asrCandidates({ env: {}, config: null, platform: 'win32' });
    assert.ok(win.includes(join('/tmp', 'bili-platform-test', 'asr-venv', 'Scripts', 'python.exe')));
    assert.ok(win.includes('D:/tools/asr/.venv/Scripts/python.exe'), 'Windows 历史路径仍要兼容');
    assert.equal(win.at(-1), 'python');
  } finally {
    if (previous === undefined) delete process.env.BILI_DATA_DIR;
    else process.env.BILI_DATA_DIR = previous;
  }
});

test('ASR 候选去重，空值被忽略', () => {
  const list = asrCandidates({
    env: { BILI_ASR_PYTHON: '   ' },
    config: { asrPython: '/opt/config/python' },
    platform: 'darwin',
  });
  assert.equal(new Set(list).size, list.length);
  assert.ok(!list.includes(''));
});

test('裸命令名不算路径，必须交给 PATH 解析', () => {
  assert.equal(isPathLike('python3'), false);
  assert.equal(isPathLike('python'), false);
  assert.equal(isPathLike('/usr/bin/python3'), true);
  assert.equal(isPathLike('D:/tools/asr/.venv/Scripts/python.exe'), true);
  assert.equal(isPathLike('C:\\Python312\\python.exe'), true);
});

test('Vision 助手落在数据目录内，不污染仓库', () => {
  const previous = process.env.BILI_DATA_DIR;
  process.env.BILI_DATA_DIR = join('/tmp', 'bili-platform-test');
  try {
    assert.equal(visionBinaryPath(), join('/tmp', 'bili-platform-test', 'bin', 'bili-ocr-vision'));
  } finally {
    if (previous === undefined) delete process.env.BILI_DATA_DIR;
    else process.env.BILI_DATA_DIR = previous;
  }
});
