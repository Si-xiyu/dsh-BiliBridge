import test from 'node:test';
import assert from 'node:assert/strict';
import { recordImage, listImages, clearImages } from '../../lib/imagelog.mjs';

test('图片登记：去重、最新优先、limit 生效', () => {
  clearImages();
  recordImage({ path: 'C:/cache/BV1/a.jpg', bvid: 'BV1', kind: 'storyboard', at: 1 });
  recordImage({ path: 'C:/cache/BV1/b.jpg', bvid: 'BV1', kind: 'adaptive', at: 2 });
  // 同路径重复登记：应移到最前（list 是倒序），不产生重复项
  recordImage({ path: 'C:/cache/BV1/a.jpg', bvid: 'BV1', kind: 'storyboard', at: 3 });
  const items = listImages({ limit: 10 });
  assert.equal(items.length, 2);
  assert.equal(items[0].path, 'C:/cache/BV1/a.jpg', '重复登记应移到最新');
  assert.equal(items[1].path, 'C:/cache/BV1/b.jpg');
  assert.equal(listImages({ limit: 1 }).length, 1);
});

test('图片登记：缺少路径或 bvid 直接忽略', () => {
  clearImages();
  assert.equal(recordImage({ bvid: 'BV1' }), null);
  assert.equal(recordImage({ path: '/x.jpg' }), null);
  assert.equal(listImages().length, 0);
});

test('图片登记：超过上限后保留最近的', () => {
  clearImages();
  for (let i = 0; i < 70; i += 1) recordImage({ path: `/x/${i}.jpg`, bvid: 'BV1', at: i });
  const items = listImages({ limit: 100 });
  assert.equal(items.length, 60);
  assert.equal(items[0].path, '/x/69.jpg');
});
