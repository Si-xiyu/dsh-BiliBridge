import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildOverview } from '../../lib/media/frames.mjs';

const video = { bvid: 'BVfixture' };
const grid = ({ cover }) => ({
  buffer: Buffer.from('grid'),
  mediaType: 'image/jpeg',
  layout: cover ? '3x3，左上第一格是封面（宣传图，不是视频截图）' : '3x3，每格左下角是故事板时间',
  note: cover ? '左上第一格为封面（非视频画面）；' : '',
  coverMerged: Boolean(cover),
  coverage: {}, spritesUsed: 0,
});

async function withTempDir(run) {
  const old = process.env.BILI_DATA_DIR;
  const dir = await mkdtemp(join(tmpdir(), 'bili-overview-cover-'));
  process.env.BILI_DATA_DIR = dir;
  try { return await run(dir); }
  finally {
    if (old === undefined) delete process.env.BILI_DATA_DIR; else process.env.BILI_DATA_DIR = old;
    await rm(dir, { recursive: true, force: true });
  }
}

test('封面并入故事板第一格：只输出一张图，不再是独立附件', async () => {
  await withTempDir(async () => {
    const result = await buildOverview({ video, cid: 1 }, {
      getCover: async () => ({ buffer: Buffer.from('cover'), mediaType: 'image/jpeg' }),
      getStoryboard: async () => ({ index: [0], images: [] }),
      composeStoryboardOverview: async (args) => grid(args),
    });
    assert.equal(result.images.length, 1, '封面不再单独占一张图');
    assert.equal(result.images[0].kind, 'storyboard');
    assert.equal(result.images[0].coverMerged, true);
    assert.match(result.images[0].note, /封面/);
    assert.match(result.images[0].layout, /封面/);
  });
});

test('封面获取失败时退回 9 格故事板，仍然只输出一张图', async () => {
  await withTempDir(async () => {
    const result = await buildOverview({ video, cid: 2 }, {
      getCover: async () => { throw Object.assign(new Error('boom'), { code: 'NETWORK_ERROR' }); },
      getStoryboard: async () => ({ index: [0], images: [] }),
      composeStoryboardOverview: async (args) => grid(args),
    });
    assert.equal(result.images.length, 1);
    assert.equal(result.images[0].coverMerged, false);
    assert.equal(result.warnings.some((w) => w.source === 'cover'), true);
  });
});
