import assert from 'node:assert/strict';
import test from 'node:test';
import { frameOcrEntries, normalizeInspectionOcr } from '../../lib/media/inspect.mjs';
import { mergeDuplicateOcrEntries, normalizeBandRatio, planSamples } from '../../lib/media/ocr.mjs';

const window = { durationMs: 10000, startMs: 2000, endMs: 7000 };
const invalid = (fn) => assert.throws(fn, { code: 'INVALID_ARGUMENT' });

test('窗口间隔采样使用绝对时间，右端不重复追加', () => {
  assert.deepEqual(planSamples({ ...window, intervalMs: 2000 }), [2000, 4000, 6000]);
  assert.deepEqual(planSamples({ ...window, intervalMs: 5000 }), [2000]);
  assert.equal(planSamples({ durationMs: 60000, startMs: 0, endMs: 60000, intervalMs: 1000 }).length, 60);
});

test('窗口 count 均匀覆盖两端，单点取起点；旧 ratio 仍限制 2–24 点', () => {
  assert.deepEqual(planSamples({ ...window, count: 3 }), [2000, 4500, 7000]);
  assert.deepEqual(planSamples({ ...window, count: 1 }), [2000]);
  assert.deepEqual(planSamples({ durationMs: 10000, count: 3 }), [300, 5000, 9700]);
  assert.equal(planSamples({ durationMs: 10000, count: 1 }).length, 2);
  assert.equal(planSamples({ durationMs: 10000, count: 99 }).length, 24);
});

test('窗口拒绝缺失边界、越界、倒序及非法采样参数', () => {
  for (const change of [
    { startMs: undefined }, { endMs: undefined }, { startMs: -1 }, { endMs: 10001 },
    { endMs: 2000 }, { intervalMs: 0 }, { intervalMs: Infinity }, { intervalMs: NaN },
    { count: 0 }, { count: 1.5 }, { count: 10001 }, { durationMs: 0 },
  ]) invalid(() => planSamples({ ...window, ...change }));
  invalid(() => planSamples({ durationMs: 20000, startMs: 0, endMs: 20000, intervalMs: 1 }));
});

test('字幕带默认比例与上下限，非数字明确报错', () => {
  assert.equal(normalizeBandRatio(), 0.22);
  assert.equal(normalizeBandRatio(0), 0.08);
  assert.equal(normalizeBandRatio(1), 0.5);
  assert.equal(normalizeBandRatio(0.08), 0.08);
  assert.equal(normalizeBandRatio(0.5), 0.5);
  for (const value of [NaN, Infinity, null, '0.22']) invalid(() => normalizeBandRatio(value));
});

test('OCR 参数只在启用时解析区域，窗口无需帧目标且模式互斥', () => {
  assert.equal(normalizeInspectionOcr({ ocrRegion: 'bad', bandRatio: NaN }), null);
  assert.deepEqual(normalizeInspectionOcr({ ocr: true, bandRatio: NaN }), { mode: 'frames', region: 'frame' });
  assert.equal(normalizeInspectionOcr({ ocr: true, ocrRegion: 'subtitle-band' }).bandRatio, 0.22);
  const options = { durationMs: 10000, subtitleWindow: { startMs: 2000, endMs: 7000 } };
  assert.equal(normalizeInspectionOcr(options).intervalMs, 2000);
  invalid(() => normalizeInspectionOcr({ ...options, ocr: true }));
  invalid(() => normalizeInspectionOcr({ ocr: true, ocrRegion: 'bad' }));
  invalid(() => normalizeInspectionOcr({ ocr: 'true' }));
  for (const subtitleWindow of [null, [], {}, { startMs: 0, endMs: 1, intervalSeconds: 0 }]) {
    invalid(() => normalizeInspectionOcr({ durationMs: 10000, subtitleWindow }));
  }
});

test('批量结果按文件序号映射，保留每帧及空文本，故事板使用实际时间', () => {
  const entries = frameOcrEntries(
    [{ requestedMs: 1000, actualMs: null }, { requestedMs: 2000, actualMs: 1800 }, { requestedMs: 3000 }],
    [{ file: 'row-001.jpg', lines: ['你 好'] }, { file: 'row-000.jpg', lines: ['你 好'] }, { file: 'bad.jpg', lines: ['忽略'] }],
    'frame',
  );
  assert.deepEqual(entries.map(({ atMs, text }) => [atMs, text]), [[1000, '你好'], [1800, '你好'], [3000, '']]);
  assert.ok(entries.every((entry) => entry.region === 'frame' && entry.source === 'ocr'));
  assert.deepEqual(JSON.parse(JSON.stringify(entries)), entries);
});

test('窗口字幕仅合并相邻重复，保留起止时间及命中数且不修改输入', () => {
  const entries = ['甲', '甲', '乙', '甲'].map((text, index) => ({ atMs: 2000 + index * 1000, text, region: 'subtitle-band', source: 'ocr' }));
  const snapshot = JSON.stringify(entries);
  const merged = mergeDuplicateOcrEntries(entries);
  assert.equal(merged.length, 3);
  assert.deepEqual([merged[0].atMs, merged[0].endAtMs, merged[0].hits], [2000, 3000, 2]);
  assert.equal(merged[2].atMs, 5000);
  assert.equal(JSON.stringify(entries), snapshot);
  assert.deepEqual(mergeDuplicateOcrEntries([]), []);
});
