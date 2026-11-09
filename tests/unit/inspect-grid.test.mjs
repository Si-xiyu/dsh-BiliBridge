import assert from 'node:assert/strict';
import test from 'node:test';
import { composeSheets, planSheets, TILES_PER_SHEET } from '../../lib/media/inspect.mjs';

const tile = { tileWidth: 320, tileHeight: 180 };

test('每张最多 6 格（2×3），按张数均分而不是贪婪切满', () => {
  assert.equal(TILES_PER_SHEET, 6);
  assert.deepEqual(planSheets(0), []);
  assert.deepEqual(planSheets(1), [{ start: 0, count: 1 }]);
  assert.deepEqual(planSheets(6), [{ start: 0, count: 6 }]);
  // 7 帧不能切成 6+1：尾图只剩一格既浪费一张附件，比例也难看。
  assert.deepEqual(planSheets(7), [{ start: 0, count: 4 }, { start: 4, count: 3 }]);
  assert.deepEqual(planSheets(8), [{ start: 0, count: 4 }, { start: 4, count: 4 }]);
  assert.deepEqual(planSheets(9), [{ start: 0, count: 5 }, { start: 5, count: 4 }]);
  assert.deepEqual(planSheets(12), [{ start: 0, count: 6 }, { start: 6, count: 6 }]);
  assert.deepEqual(planSheets(13).map((sheet) => sheet.count), [5, 4, 4]);
  // 每张都不超上限，且起点连续覆盖全部帧。
  for (const total of [1, 2, 5, 6, 7, 9, 11, 13, 18]) {
    const sheets = planSheets(total);
    assert.ok(sheets.every((sheet) => sheet.count >= 1 && sheet.count <= TILES_PER_SHEET));
    let next = 0;
    for (const sheet of sheets) {
      assert.equal(sheet.start, next);
      next += sheet.count;
    }
    assert.equal(next, total);
  }
});

test('非数字与负数按无帧处理，perSheet 可覆盖', () => {
  assert.deepEqual(planSheets(NaN), []);
  assert.deepEqual(planSheets(-3), []);
  assert.deepEqual(planSheets(4, 2), [{ start: 0, count: 2 }, { start: 2, count: 2 }]);
});

test('多帧拆图：每张 2 列，帧顺序跨图连续，末图不超 3 行', async () => {
  const sharp = (await import('sharp')).default;
  const colors = ['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#ff00ff', '#00ffff', '#888888'];
  const frames = await Promise.all(colors.map(async (background, index) => ({
    buffer: await sharp({ create: { width: 32, height: 18, channels: 3, background } }).jpeg().toBuffer(),
    requestedMs: index * 1000,
  })));

  const sheets = await composeSheets(frames, { ...tile, labelFor: (frame) => `req ${frame.requestedMs}` });
  assert.deepEqual(sheets.map((sheet) => [sheet.sheet, sheet.start, sheet.count]), [[1, 0, 4], [2, 4, 3]]);

  for (const sheet of sheets) {
    const meta = await sharp(sheet.buffer).metadata();
    assert.equal(meta.format, 'jpeg');
    // 4 帧和 3 帧都是 2 列 2 行，画布一样大，每格不会因为第二张而变小。
    assert.deepEqual([meta.width, meta.height], [640, 360]);
  }
});

test('单帧退化为 1 列，不拼黑边', async () => {
  const sharp = (await import('sharp')).default;
  const buffer = await sharp({ create: { width: 32, height: 18, channels: 3, background: '#123456' } }).jpeg().toBuffer();
  const sheets = await composeSheets([{ buffer, requestedMs: 5000 }], { ...tile, labelFor: () => 'req 00:05' });
  assert.equal(sheets.length, 1);
  const meta = await sharp(sheets[0].buffer).metadata();
  assert.deepEqual([meta.width, meta.height], [320, 180]);
});
