import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAdaptiveInspection, normalizeInspectionSelection, normalizeTargets } from '../../lib/media/inspect.mjs';
import { apply } from '../../lib/index.js';

test('adaptive inspect validates exclusive modes before IO and retains targeted defaults', () => {
  assert.equal(normalizeInspectionSelection({}), null);
  assert.deepEqual(normalizeTargets({ timestampsMs: [100] }), [{ requestedMs: 100 }]);
  assert.equal(normalizeInspectionSelection({ selection: 'adaptive', durationMs: 10000 }).maxFrames, 9);
  for (const patch of [{ selection: 'bad' }, { range: {} }, { selection: 'adaptive', timestampsMs: [100] },
    { selection: 'adaptive', intervals: [{}] }, { selection: 'adaptive', subtitleWindow: {} },
    { selection: 'adaptive', source: 'bad' }, { selection: 'adaptive', maxFrames: 10 }]) {
    assert.throws(() => normalizeInspectionSelection({ durationMs: 10000, ...patch }), { code: 'INVALID_ARGUMENT' });
  }
});

const options = { video: { bvid: 'BVtest' }, cid: 1, durationMs: 10000, selection: 'adaptive',
  range: { startMs: 2000, endMs: 8000 }, maxFrames: 2 };
const picked = (source, at = [3000, 5000]) => ({ source, frames: at.map((atMs) => ({ atMs })),
  range: options.range, stopReason: 'frame-limit', candidateCount: 10 });
const rendered = (args) => ({ frames: args.targets, images: [{ source: 'test' }] });

test('adaptive inspect passes chosen absolute timestamps and budget to existing renderer', async () => {
  let received;
  const result = await buildAdaptiveInspection(options, {
    adaptiveFrames: async (args) => { assert.equal(args.maxFrames, 2); return picked('ffmpeg'); },
    buildRealFrames: async (args) => { received = args; return rendered(args); },
  });
  assert.deepEqual(received.targets.map((f) => f.requestedMs), [3000, 5000]);
  assert.equal(result.selection.selectedFrames, 2);
  assert.equal(result.selection.mode, 'adaptive');
});

test('render failure reselects within storyboard range, strict source and cancellation never fall back', async () => {
  let selections = 0;
  const deps = {
    adaptiveFrames: async (args) => { selections++; return picked(args.source === 'storyboard' ? 'storyboard' : 'ffmpeg', args.source === 'storyboard' ? [4000] : [3000]); },
    buildRealFrames: async () => { throw Object.assign(new Error('failed'), { code: 'TIMEOUT' }); },
    buildStoryboardFrames: async (args) => { assert.deepEqual(args.range, options.range); return rendered(args); },
  };
  const result = await buildAdaptiveInspection(options, deps);
  assert.equal(selections, 2);
  assert.deepEqual(result.frames.map((f) => f.requestedMs), [4000]);
  assert.equal(result.selection.source, 'storyboard');
  assert.equal(result.fallbackReason.code, 'TIMEOUT');
  await assert.rejects(buildAdaptiveInspection({ ...options, source: 'ffmpeg' }, deps), { code: 'TIMEOUT' });
  await assert.rejects(buildAdaptiveInspection(options, { ...deps, buildRealFrames: async () => {
    throw Object.assign(new Error('cancel'), { code: 'CANCELLED' });
  } }), { code: 'CANCELLED' });
});

test('empty adaptive selection returns metadata without rendering an empty sheet', async () => {
  const result = await buildAdaptiveInspection(options, {
    adaptiveFrames: async () => picked('storyboard', []),
    buildStoryboardFrames: async () => { throw new Error('must not render'); },
  });
  assert.deepEqual(result.images, []);
  assert.equal(result.selection.selectedFrames, 0);
});

test('adaptive total deadline reports timeout while user cancellation remains cancellation', async () => {
  const choose = async ({ signal }) => new Promise((resolve, reject) => {
    const abort = () => reject(Object.assign(new Error('cancel'), { code: 'CANCELLED' }));
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  });
  await assert.rejects(buildAdaptiveInspection({ ...options, budgetMs: 5 }, { adaptiveFrames: choose }), { code: 'TIMEOUT' });
  await assert.rejects(buildAdaptiveInspection({ ...options, signal: AbortSignal.abort() }, { adaptiveFrames: choose }), { code: 'CANCELLED' });
});

test('inspect tool exposes one adaptive mode, bounded count and window without registering another tool', () => {
  const tools = [];
  apply({ on() {}, tools: { register(tool) { tools.push(tool); } } });
  const inspect = tools.find((tool) => tool.name === 'bilibili_inspect');
  assert.deepEqual(inspect.parameters.properties.selection.enum, ['targeted', 'adaptive']);
  assert.equal(inspect.parameters.properties.maxFrames.maximum, 9);
  assert.deepEqual(inspect.parameters.properties.range.required, ['startMs', 'endMs']);
  assert.equal(tools.length, 27);
});
