import assert from 'node:assert/strict';
import test from 'node:test';
import { apply } from '../../lib/index.js';
import { offsetTranscript, segmentsToEntries } from '../../lib/media/asr.mjs';
import { normalizeTranscribeArgs, validateTranscribeWindow } from '../../lib/tools/transcribe.mjs';

const bvid = 'BV1xx411c7mD';
const video = { duration: 1000, pages: [{ page: 1, cid: 1, duration: 60 }, { page: 2, cid: 2, duration: 400 }] };

test('转写参数默认值与非法参数', () => {
  assert.deepEqual(normalizeTranscribeArgs({ bvid }), { bvid, page: 1, startSeconds: 0, durationSeconds: 30, language: 'auto' });
  for (const args of [ { bvid: undefined }, { bvid: '' }, { page: 0 }, { page: 1.5 }, { page: '1' },
    { startSeconds: -1 }, { startSeconds: NaN }, { startSeconds: Infinity }, { startSeconds: null },
    { durationSeconds: 0 }, { durationSeconds: -1 }, { durationSeconds: 301 }, { durationSeconds: Infinity },
    { language: '' }, { language: null } ]) {
    assert.throws(() => normalizeTranscribeArgs({ bvid, ...args }), { code: 'INVALID_ARGUMENT' });
  }
});

test('转写窗口使用当前分 P 时长，允许边界与小数秒，拒绝越界', () => {
  assert.equal(validateTranscribeWindow(video, { bvid }).cid, 1);
  assert.equal(validateTranscribeWindow(video, { bvid, startSeconds: 59.5, durationSeconds: 0.5 }).cid, 1);
  assert.equal(validateTranscribeWindow(video, { bvid, page: 2, startSeconds: 100, durationSeconds: 300 }).cid, 2);
  for (const args of [{ page: 3 }, { startSeconds: 60 }, { startSeconds: 31 }, { durationSeconds: 61 }]) {
    assert.throws(() => validateTranscribeWindow(video, { bvid, ...args }), { code: 'INVALID_ARGUMENT' });
  }
  assert.throws(() => validateTranscribeWindow({ pages: [{ page: 1 }] }, { bvid }), { code: 'INVALID_ARGUMENT' });
});

test('offset 加回原始时间轴且不修改 worker 数据或时长', () => {
  const payload = { duration_sec: 30, segments: [{ start: 0.125, end: 1.75, text: ' 测试 ' }] };
  const snapshot = JSON.stringify(payload);
  const shifted = offsetTranscript(payload, 60.5);
  assert.deepEqual(segmentsToEntries(shifted), [{ atMs: 60625, endMs: 62250, text: '测试', source: 'asr' }]);
  assert.equal(shifted.duration_sec, 30);
  assert.equal(JSON.stringify(payload), snapshot);
  assert.deepEqual(offsetTranscript(payload, 0), payload);
  assert.deepEqual(offsetTranscript({ segments: [] }, 30).segments, []);
  for (const offset of [-1, NaN, Infinity, null]) {
    assert.throws(() => offsetTranscript(payload, offset), { code: 'INVALID_ARGUMENT' });
  }
});

test('插件注册 25 个唯一工具，转写工具只注册一次', () => {
  const tools = [];
  apply({ on() {}, tools: { register(tool) { tools.push(tool); } } });
  assert.equal(tools.length, 25);
  assert.equal(new Set(tools.map((tool) => tool.name)).size, 25);
  assert.equal(tools.filter((tool) => tool.name === 'bilibili_transcribe').length, 1);
});
