import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildOverviewWithAdaptive, composeAdaptiveOverview } from '../../lib/media/adaptive-overview.mjs';

const options = { video: { bvid: 'BVfixture' }, cid: 2, durationMs: 10000 };
const overview = () => ({ images: [{ kind: 'cover' }, { kind: 'storyboard' }], warnings: [] });

test('Stage1 automatically conditions on uniform frames and emits one adaptive 3x3 with accurate count', async () => {
  const old = process.env.BILI_DATA_DIR;
  const dir = await mkdtemp(join(tmpdir(), 'bili-overview-test-'));
  process.env.BILI_DATA_DIR = dir;
  try {
    const sharp = (await import('sharp')).default;
    const buffer = await sharp({ create: { width: 64, height: 36, channels: 3, background: '#f00' } }).png().toBuffer();
    const refs = [{ atMs: 0, feature: {} }];
    const result = await buildOverviewWithAdaptive(options, {
      buildOverview: async () => overview(), adaptiveConfig: async () => ({ adaptiveEnabled: true }),
      uniformReferences: async () => refs,
      buildAdaptiveInspection: async (args) => {
        assert.equal(args.maxFrames, 9); assert.equal(args.retainBuffers, true); assert.strictEqual(args.references, refs);
        return { frames: [{ requestedMs: 3000 }], _ocrFrames: [{ requestedMs: 3000, actualMs: null, buffer }], images: [],
          selection: { source: 'ffmpeg', selectedFrames: 1, stopReason: 'near-duplicates-or-candidates-exhausted' } };
      },
    });
    assert.deepEqual(result.images.map((image) => image.kind), ['cover', 'storyboard', 'adaptive']);
    assert.equal(result.adaptive.referenceCount, 1);
    assert.equal(result.adaptive.selectedFrames, 1);
    const image = result.images[2];
    await access(image.path);
    const meta = await sharp(image.buffer).metadata();
    assert.deepEqual([meta.width, meta.height], [1440, 810]);
    assert.equal(image.timeAccuracy, 'input-seek');
  } finally {
    if (old === undefined) delete process.env.BILI_DATA_DIR; else process.env.BILI_DATA_DIR = old;
    await rm(dir, { recursive: true, force: true });
  }
});

test('Stage1 empty, disabled and failed adaptive results preserve original overview; cancellation propagates', async () => {
  const deps = { buildOverview: async () => overview(), adaptiveConfig: async () => ({ adaptiveEnabled: true }),
    uniformReferences: async () => [], buildAdaptiveInspection: async () => ({ frames: [], images: [], selection: { source: 'storyboard', selectedFrames: 0 } }) };
  const empty = await buildOverviewWithAdaptive(options, deps);
  assert.equal(empty.images.length, 2);
  assert.equal(empty.adaptive.selectedFrames, 0);
  const disabled = await buildOverviewWithAdaptive(options, { ...deps, adaptiveConfig: async () => ({ adaptiveEnabled: false }) });
  assert.equal(disabled.adaptive.status, 'disabled');
  const failed = await buildOverviewWithAdaptive(options, { ...deps, buildAdaptiveInspection: async () => { throw new Error('decode'); } });
  assert.equal(failed.images.length, 2);
  assert.equal(failed.adaptive.status, 'failed');
  assert.equal(failed.warnings[0].source, 'adaptive');
  await assert.rejects(buildOverviewWithAdaptive(options, { ...deps, buildAdaptiveInspection: async () => {
    throw Object.assign(new Error('cancel'), { code: 'CANCELLED' });
  } }), { code: 'CANCELLED' });
});

test('Stage1 3x3 labels accept measured storyboard time and split-free nine frames', async () => {
  const sharp = (await import('sharp')).default;
  const buffer = await sharp({ create: { width: 20, height: 40, channels: 3, background: '#07f' } }).png().toBuffer();
  const grid = await composeAdaptiveOverview(Array.from({ length: 9 }, (_, i) => ({ buffer, requestedMs: i * 1000, actualMs: i * 1000 })));
  const meta = await sharp(grid).metadata();
  assert.deepEqual([meta.width, meta.height], [1440, 810]);
});

test('Stage1 deadline includes fetching uniform references and preserves existing images on timeout', async () => {
  const result = await buildOverviewWithAdaptive({ ...options, budgetMs: 5 }, {
    buildOverview: async () => overview(), adaptiveConfig: async () => ({ adaptiveEnabled: true }),
    uniformReferences: async ({ signal }) => new Promise((resolve, reject) => {
      const abort = () => reject(Object.assign(new Error('cancel'), { code: 'CANCELLED' }));
      if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
    }),
    buildAdaptiveInspection: async () => { throw new Error('must not start'); },
  });
  assert.equal(result.images.length, 2);
  assert.equal(result.adaptive.status, 'failed');
  assert.equal(result.warnings[0].code, 'TIMEOUT');
});

test('故事板降级时，最终 adaptive 图继承 maxErrorMs=null 与 matchOffsetMs', async () => {
  const old = process.env.BILI_DATA_DIR;
  const dir = await mkdtemp(join(tmpdir(), 'bili-overview-err-'));
  process.env.BILI_DATA_DIR = dir;
  try {
    const sharp = (await import('sharp')).default;
    const buffer = await sharp({ create: { width: 64, height: 36, channels: 3, background: '#0f0' } }).png().toBuffer();
    const result = await buildOverviewWithAdaptive(options, {
      buildOverview: async () => overview(), adaptiveConfig: async () => ({ adaptiveEnabled: true }),
      uniformReferences: async () => [],
      buildAdaptiveInspection: async () => ({
        frames: [{ requestedMs: 3000 }],
        _ocrFrames: [{ requestedMs: 3000, actualMs: 3000, buffer }],
        images: [{ accuracy: 'storyboard', maxErrorMs: null, matchOffsetMs: 0, typicalGapMs: 5000, path: null }],
        selection: { source: 'storyboard', selectedFrames: 1, stopReason: 'frame-limit' },
      }),
    });
    const image = result.images.find((item) => item.kind === 'adaptive');
    assert.ok(image, '应生成 adaptive 图');
    assert.equal(image.accuracy, 'storyboard');
    assert.equal(Object.hasOwn(image, 'maxErrorMs'), true, 'maxErrorMs 必须显式存在');
    assert.equal(image.maxErrorMs, null, '源帧误差未知必须是 null，而不是匹配偏差 0');
    assert.equal(image.matchOffsetMs, 0);
    assert.equal(image.typicalGapMs, 5000);
  } finally {
    if (old === undefined) delete process.env.BILI_DATA_DIR; else process.env.BILI_DATA_DIR = old;
    await rm(dir, { recursive: true, force: true });
  }
});
