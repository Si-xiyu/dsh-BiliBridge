import test from 'node:test';
import assert from 'node:assert/strict';
import { frameFeature, similarity, nearDuplicate, haarScores, temporalSegments, facilityGain, selectAdaptive, refineForSharpness } from '../../lib/media/adaptive-selection.mjs';

function solid(r, g, b) {
  return frameFeature(Buffer.from(Array.from({ length: 16 * 16 }, () => [r, g, b]).flat()), 16, 16);
}
const red = solid(255, 0, 0), green = solid(0, 255, 0), blue = solid(0, 0, 255);
const frame = (atMs, feature) => ({ atMs, feature });

test('RGB features are normalized, JSON-safe and distinguish solid colour states', () => {
  assert.ok(Math.abs(red.histogram.reduce((a, b) => a + b, 0) - 1) < 1e-9);
  assert.equal(red.hash.length, 63);
  assert.deepEqual(JSON.parse(JSON.stringify(red)), red);
  assert.equal(similarity(red, red), 1);
  assert.ok(similarity(red, blue) < 0.5);
  assert.equal(nearDuplicate(red, red), true);
  assert.equal(nearDuplicate(red, green), false);
  assert.throws(() => frameFeature(Buffer.alloc(3), 2, 2), /packed RGB/);
});

test('Haar reconstruction aligns pair details and preserves original signal length', () => {
  assert.deepEqual(haarScores([0, 1, 0, 0], 1), [0.5, 0.5, 0, 0]);
  assert.deepEqual(haarScores([1, 1, 1, 1, 1], 3), [0, 0, 0, 0, 0]);
  assert.deepEqual(haarScores([], 3), []);
});

test('temporal segments use absolute timestamps and partition the entire requested interval', () => {
  const frames = Array.from({ length: 12 }, (_, i) => frame(10000 + i * 1000, i < 6 ? red : blue));
  for (const waveletEnabled of [true, false]) {
    const segments = temporalSegments(frames, { startMs: 9500, endMs: 22500, waveletEnabled });
    assert.equal(segments[0].startMs, 9500);
    assert.equal(segments.at(-1).endMs, 22500);
    assert.ok(segments.some((segment) => segment.startMs === 16000));
    for (let i = 0; i < segments.length; i += 1) {
      assert.ok(segments[i].endMs > segments[i].startMs);
      assert.ok(segments[i].changeScore >= 0 && segments[i].changeScore <= 1);
      if (i) assert.equal(segments[i - 1].endMs, segments[i].startMs);
    }
  }
});

test('facility gain equals actual normalized objective increment and decreases with coverage', () => {
  const values = [0.2, 0.9, 0.4], covered = [0.6, 0.1, 0.4];
  const before = covered.reduce((a, b) => a + b, 0) / 3;
  const after = covered.reduce((sum, value, i) => sum + Math.max(value, values[i]), 0) / 3;
  assert.ok(Math.abs(facilityGain(values, covered) - (after - before)) < 1e-12);
  assert.ok(facilityGain(values, [0.8, 0.8, 0.8]) < facilityGain(values, covered));
});

test('already covered static video adds zero frames; distinct new states are selected chronologically', () => {
  const frames = Array.from({ length: 30 }, (_, i) => frame(i * 1000, red));
  const staticResult = selectAdaptive(frames, { references: [frames[0]], startMs: 0, endMs: 30000 });
  assert.equal(staticResult.frames.length, 0);
  assert.equal(staticResult.stopReason, 'near-duplicates-or-candidates-exhausted');
  frames[10] = frame(10000, blue);
  frames[20] = frame(20000, green);
  const result = selectAdaptive(frames, { references: [frames[0]], maxFrames: 9, startMs: 0, endMs: 30000 });
  assert.deepEqual(result.frames.map((f) => f.atMs), [10000, 20000]);
  assert.strictEqual(result.frames[0], frames[10]);
});

test('brief event survives candidate compression and duplicate timestamps are removed', () => {
  const frames = Array.from({ length: 300 }, (_, i) => frame(i * 1000, i === 137 ? blue : red));
  frames.push(frame(137000, blue));
  const result = selectAdaptive(frames, { references: [frames[0]], candidateBudget: 60, startMs: 0, endMs: 300000 });
  assert.equal(result.candidateCount <= 60, true);
  assert.deepEqual(result.frames.map((f) => f.atMs), [137000]);
});

test('invalid budgets rejected, empty input explicit, one-frame interval supported', () => {
  assert.throws(() => selectAdaptive([], { maxFrames: 10 }), /budget/);
  assert.throws(() => selectAdaptive([], { segmentCoverageTau: 0 }), /budget/);
  assert.deepEqual(selectAdaptive([]).frames, []);
  const malformed = { ...red, histogram: [...red.histogram] };
  malformed.histogram[0] = NaN;
  assert.deepEqual(selectAdaptive([frame(0, malformed)]).frames, []);
  assert.throws(() => selectAdaptive([], { references: [frame(0, malformed)] }), /reference/);
  const result = selectAdaptive([frame(500, red)], { startMs: 400, endMs: 600, maxFrames: 1 });
  assert.equal(result.frames.length, 1);
  assert.deepEqual(result.segments, [{ startMs: 400, endMs: 600, changeScore: 0 }]);
});

test('zero objective gain does not itself trigger early stopping', () => {
  const result = selectAdaptive([frame(0, red), frame(1000, blue)], {
    maxFrames: 2, facilityWeight: 0, segmentCoverageWeight: 0,
    startMs: 0, endMs: 2000,
  });
  assert.equal(result.frames.length, 2);
  assert.equal(result.stopReason, 'frame-limit');
});

test('明显黑屏候选：选得满时不占名额，选不满才放宽', () => {
  const black = solid(0, 0, 0);
  const frames = [frame(0, red), frame(1000, black), frame(2000, blue), frame(3000, green)];
  const result = selectAdaptive(frames, { references: [frames[0]], maxFrames: 2, startMs: 0, endMs: 4000, candidateBudget: 100 });
  assert.deepEqual(result.frames.map((f) => f.atMs), [2000, 3000], '黑屏不该挤掉有内容的画面');

  const only = [frame(0, red), frame(1000, black)];
  const relaxed = selectAdaptive(only, { references: [only[0]], maxFrames: 1, startMs: 0, endMs: 2000, candidateBudget: 100 });
  assert.equal(relaxed.frames.length, 1, '只有黑屏可选时应放宽，而不是选 0 帧');
});

test('refineForSharpness：同片段 1s 内换更清晰的帧，不跨片段', () => {
  const base = { atMs: 5000, feature: { ...red, quality: { brightness: 0.5, blackRatio: 0, sharpness: 0.05 } } };
  const sharper = { atMs: 5600, feature: { ...red, quality: { brightness: 0.5, blackRatio: 0, sharpness: 0.2 } } };
  const acrossSegment = { atMs: 7500, feature: { ...red, quality: { brightness: 0.5, blackRatio: 0, sharpness: 0.4 } } };
  const segmentOf = (f) => (f.atMs < 6000 ? 0 : 1);

  const picked = refineForSharpness([base, sharper, acrossSegment], [base], { segmentOf, shrinkWindowMs: 1500 });
  assert.equal(picked[0], sharper);

  const sameSegmentButFar = { atMs: 6300, feature: { ...red, quality: { brightness: 0.5, blackRatio: 0, sharpness: 0.4 } } };
  const kept = refineForSharpness([base, sameSegmentButFar, acrossSegment], [base], { segmentOf, shrinkWindowMs: 1500 });
  assert.equal(kept[0], base, '超过 1s 或跨片段都不替换');
});
