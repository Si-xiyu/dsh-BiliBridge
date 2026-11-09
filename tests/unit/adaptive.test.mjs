import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adaptiveFrames, adaptiveRange, imageFeature } from '../../lib/media/adaptive.mjs';

test('adaptive range uses page duration, strict counts and absolute window boundaries', () => {
  assert.deepEqual(adaptiveRange({ durationMs: 10000 }), { startMs: 0, endMs: 10000, maxFrames: 9 });
  for (const change of [{ maxFrames: 0 }, { maxFrames: 10 }, { maxFrames: 1.2 },
    { range: null }, { range: {} }, { range: { startMs: null, endMs: 500 } }, { range: { startMs: -1, endMs: 500 } },
    { range: { startMs: 0.1, endMs: 0.4 } },
    { range: { startMs: 100, endMs: 10001 } }, { range: { startMs: 200, endMs: 100 } }]) {
    assert.throws(() => adaptiveRange({ durationMs: 10000, ...change }), { code: 'INVALID_ARGUMENT' });
  }
});

test('scan fallback, cancellation, source policy and persistent feature cache', async () => {
  const old = process.env.BILI_DATA_DIR;
  const dir = await mkdtemp(join(tmpdir(), 'bili-adaptive-test-'));
  process.env.BILI_DATA_DIR = dir;
  try {
    const sharp = (await import('sharp')).default;
    const feature = await imageFeature(await sharp({ create: { width: 32, height: 32, channels: 3, background: '#f00' } }).png().toBuffer());
    const options = { video: { bvid: 'BVtest' }, cid: 1, durationMs: 10000,
      range: { startMs: 2000, endMs: 8000 }, maxFrames: 3 };
    let real = 0, fallback = 0;
    const dependencies = {
      realScan: async () => { real++; throw Object.assign(new Error('fail'), { code: 'TIMEOUT' }); },
      storyboardScan: async () => { fallback++; return { frames: [{ atMs: 3000, feature }], source: 'storyboard' }; },
    };
    const result = await adaptiveFrames(options, dependencies);
    assert.equal(result.source, 'storyboard');
    assert.equal(result.fallbackReason.code, 'TIMEOUT');
    assert.ok(result.frames.every((frame) => frame.atMs >= 2000 && frame.atMs < 8000));
    await assert.rejects(adaptiveFrames({ ...options, source: 'ffmpeg' }, dependencies), { code: 'TIMEOUT' });
    assert.equal(fallback, 1);
    await assert.rejects(adaptiveFrames({ ...options, signal: AbortSignal.abort() }, dependencies), { code: 'CANCELLED' });
    assert.equal(real, 2);
    const success = { realScan: async () => { real++; return { frames: [{ atMs: 3000, feature }], source: 'ffmpeg' }; } };
    await adaptiveFrames(options, success);
    const hit = await adaptiveFrames({ ...options, maxFrames: 1 }, success);
    assert.equal(hit.cached, true);
    assert.equal(real, 3);
    await adaptiveFrames({ ...options, cid: 2 }, success);
    assert.equal(real, 4);
    const reused = await adaptiveFrames(options, { realScan: async () => { throw new Error('should use cache'); } });
    assert.equal(reused.cached, true);
    await adaptiveFrames({ ...options, cid: 3, range: undefined }, { realScan: async () => ({
      frames: [{ atMs: 1000, feature }, { atMs: 3000, feature }, { atMs: 9000, feature }], source: 'ffmpeg',
    }) });
    const windowHit = await adaptiveFrames({ ...options, cid: 3 }, { realScan: async () => { throw new Error('must reuse full scan'); } });
    assert.equal(windowHit.cached, true);
    assert.ok(windowHit.frames.every((frame) => frame.atMs >= 2000 && frame.atMs < 8000));
    for (const bad of [null, { atMs: 3000, feature: { ...feature, histogram: Array(96).fill(0) } }]) {
      const cacheDir = join(dir, 'cache', 'adaptive');
      for (const file of await readdir(cacheDir)) await writeFile(join(cacheDir, file), JSON.stringify({
        writtenAt: Date.now(), scan: { source: 'ffmpeg', frames: [bad] },
      }));
      assert.equal((await adaptiveFrames(options, success)).cached, false);
    }
  } finally {
    if (old === undefined) delete process.env.BILI_DATA_DIR; else process.env.BILI_DATA_DIR = old;
    await rm(dir, { recursive: true, force: true });
  }
});
