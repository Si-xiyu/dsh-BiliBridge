import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { segmentsToEntries } from '../../lib/media/asr.mjs';
import { decodeHints } from '../../lib/media/asr_client.mjs';

const MEDIA = fileURLToPath(new URL('../../lib/media/', import.meta.url));
const python = ['python3', 'python'].find((cmd) => spawnSync(cmd, ['--version']).status === 0);

function py(code) {
  const result = spawnSync(python, ['-c', `import sys, json; sys.path.insert(0, ${JSON.stringify(MEDIA)}); from asr_worker import *\n${code}`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('decode_options：默认保留上文条件；中文缺省简体引导句；提示与热词可覆盖', { skip: !python && '没有 python' }, () => {
  const zh = py("print(json.dumps(decode_options('zh')))");
  assert.equal(zh.condition_on_previous_text, undefined);
  assert.equal(zh.language, 'zh');
  assert.equal(zh.initial_prompt, '以下是普通话的句子，用简体中文书写。');
  assert.equal(zh.hotwords, undefined);
  const custom = py("print(json.dumps(decode_options('zh', '自定义提示', 'Git, rebase')))");
  assert.equal(custom.initial_prompt, '自定义提示');
  assert.equal(custom.hotwords, 'Git, rebase');
  const auto = py("print(json.dumps(decode_options('auto', None, '  ')))");
  assert.equal(auto.language, null);
  assert.equal(auto.initial_prompt, undefined);
  assert.equal(auto.hotwords, undefined);
});

test('is_low_confidence：logprob、压缩比、无语音概率任一越界即低置信', { skip: !python && '没有 python' }, () => {
  const flags = py("print(json.dumps([is_low_confidence(-0.3, 1.5, 0.1), is_low_confidence(-1.2, 1.5, 0.1), is_low_confidence(-0.3, 2.8, 0.1), is_low_confidence(-0.3, 1.5, 0.7)]))");
  assert.deepEqual(flags, [false, true, true, true]);
});

test('decodeHints：只发送非空字段', () => {
  assert.deepEqual(decodeHints({}), {});
  assert.deepEqual(decodeHints({ prompt: ' ', hotwords: 'Git' }), { hotwords: 'Git' });
});

test('segmentsToEntries：新载荷带 lowConfidence，旧缓存保持原形状', () => {
  assert.deepEqual(segmentsToEntries({ segments: [{ start: 1, end: 2, text: '甲', low_confidence: true }] }),
    [{ atMs: 1000, endMs: 2000, text: '甲', source: 'asr', lowConfidence: true }]);
  assert.deepEqual(segmentsToEntries({ segments: [{ start: 1, end: 2, text: '乙' }] }),
    [{ atMs: 1000, endMs: 2000, text: '乙', source: 'asr' }]);
});
