import '../helpers/http-isolation.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { collectPics, getDynamicDetail, originIndex, projectDynamic } from '../../lib/bili/dynamics.mjs';

const author = (mid, name, pubTs = 1700000000) => ({ module_author: { mid, name, pub_ts: pubTs } });

test('图文动态带出图片地址（draw），并去重', () => {
  const item = {
    id_str: '111',
    type: 'DYNAMIC_TYPE_DRAW',
    modules: {
      ...author(42, 'UP'),
      module_dynamic: {
        desc: { text: '两张图' },
        major: { draw: { items: [{ src: 'https://i0.hdslb.com/a.jpg' }, { src: 'https://i0.hdslb.com/b.jpg' }, { src: 'https://i0.hdslb.com/a.jpg' }] } },
      },
    },
  };
  const result = projectDynamic(item);
  assert.deepEqual(result.pics, ['https://i0.hdslb.com/a.jpg', 'https://i0.hdslb.com/b.jpg']);
  assert.equal(result.text, '两张图');
});

test('图文长文（opus）的图片同样收进来，且与 draw 合并去重', () => {
  const item = {
    id_str: '112',
    type: 'DYNAMIC_TYPE_OPUS',
    modules: {
      ...author(43, 'OPUS UP'),
      module_dynamic: {
        major: {
          opus: {
            title: '标题',
            summary: { text: '摘要' },
            pics: [{ url: 'https://i0.hdslb.com/c.jpg' }, { url: 'https://i0.hdslb.com/a.jpg' }],
          },
          draw: { items: [{ src: 'https://i0.hdslb.com/a.jpg' }] },
        },
      },
    },
  };
  const result = projectDynamic(item);
  assert.deepEqual(result.pics, ['https://i0.hdslb.com/a.jpg', 'https://i0.hdslb.com/c.jpg']);
  assert.equal(result.title, '标题');
});

test('没有图片时不出现 pics 字段（不塞空数组）', () => {
  const item = { id_str: '113', type: 'DYNAMIC_TYPE_WORD', modules: { ...author(44, '文字 UP'), module_dynamic: { desc: { text: '纯文字' } } } };
  const result = projectDynamic(item);
  assert.equal('pics' in result, false);
});

test('转发动态保留原动态索引，正文仍合并方便直接读', () => {
  const original = {
    id_str: '999',
    type: 'DYNAMIC_TYPE_AV',
    modules: {
      ...author(2, '原作者', 1700001000),
      module_dynamic: { desc: { text: '原动态正文' }, major: { archive: { bvid: 'BV1xx411c7mD', title: '原视频标题' } } },
    },
  };
  const item = {
    id_str: '222',
    type: 'DYNAMIC_TYPE_FORWARD',
    modules: { ...author(1, '转发者', 1700002000), module_dynamic: { desc: { text: '转发理由' } } },
    orig: original,
  };
  const result = projectDynamic(item);
  assert.deepEqual(result.origin, {
    dynamicId: '999',
    type: 'DYNAMIC_TYPE_AV',
    publishedAt: result.origin.publishedAt,
    author: { mid: '2', name: '原作者' },
    text: '原动态正文',
    title: '原视频标题',
    bvid: 'BV1xx411c7mD',
    url: 'https://t.bilibili.com/999',
  });
  assert.match(result.origin.publishedAt, /^20\d\d-/);
  assert.equal(result.bvid, 'BV1xx411c7mD');
  assert.equal(result.title, '原视频标题');
  assert.match(result.text, /转发理由/);
  assert.match(result.text, /原动态正文/);
});

test('普通动态没有 origin 字段', () => {
  const item = { id_str: '333', type: 'DYNAMIC_TYPE_WORD', modules: { ...author(45, 'UP'), module_dynamic: { desc: { text: 'x' } } } };
  assert.equal('origin' in projectDynamic(item), false);
});

test('collectPics / originIndex 的边界', () => {
  assert.deepEqual(collectPics(undefined), []);
  assert.deepEqual(collectPics({ draw: { items: [{ src: '' }, { src: 'https://x/1.jpg' }] } }), ['https://x/1.jpg']);
  assert.equal(originIndex(undefined), undefined);
  assert.deepEqual(originIndex({ dynamicId: '1' }), { dynamicId: '1', type: null, publishedAt: null, author: null });
});

test('转发的图文原动态把原图放进 origin.pics，不丢图', () => {
  const original = {
    id_str: '999', type: 'DYNAMIC_TYPE_DRAW',
    modules: {
      ...author(2, '原作者', 1700001000),
      module_dynamic: { desc: { text: '原图动态' }, major: { draw: { items: [{ src: 'https://i0.hdslb.com/o.jpg' }] } } },
    },
  };
  const item = { id_str: '222', type: 'DYNAMIC_TYPE_FORWARD', modules: author(1, '转发者'), orig: original };
  const result = projectDynamic(item);
  assert.equal(result.text, '原图动态');
  assert.deepEqual(result.origin.pics, ['https://i0.hdslb.com/o.jpg']);
  assert.equal(result.origin.url, 'https://t.bilibili.com/999');
});

test('按 dynamicId 读取详情并复用同一投影', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(input);
    assert.equal(url.pathname, '/x/polymer/web-dynamic/v1/detail');
    assert.equal(url.searchParams.get('id'), '222');
    return Response.json({ code: 0, data: { item: {
      id_str: '222', type: 'DYNAMIC_TYPE_DRAW', modules: {
        ...author(1, 'UP', 1700002000),
        module_dynamic: { desc: { text: '详情' }, major: { draw: { items: [{ src: 'https://i0.hdslb.com/d.jpg' }] } } },
      },
    } } });
  };
  try {
    const detail = await getDynamicDetail({ dynamicId: '222' });
    assert.equal(detail.dynamicId, '222');
    assert.equal(detail.text, '详情');
    assert.deepEqual(detail.pics, ['https://i0.hdslb.com/d.jpg']);
    assert.equal(detail.url, 'https://t.bilibili.com/222');
  } finally {
    globalThis.fetch = original;
  }
});
