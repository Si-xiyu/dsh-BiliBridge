import test from 'node:test';
import assert from 'node:assert/strict';
import { attachRemoteImages } from '../../lib/tools/images.mjs';

const item = { url: 'https://i0.hdslb.com/a.jpg' };

test('附件服务不可用时只返回 URL，不下载图片', async () => {
  const original = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = async () => { fetched += 1; throw new Error('must not fetch'); };
  try {
    const result = await attachRemoteImages({ get: () => undefined }, {}, [item], { maxImages: 3 });
    assert.equal(fetched, 0);
    assert.equal(result.imageChannel, 'attachments_service_unavailable');
    assert.equal(result.images[0].url, item.url);
    assert.equal(result.imageAttached, false);
  } finally {
    globalThis.fetch = original;
  }
});

test('纯文本模型不下载图片；有图片能力时才进入下载路径', async () => {
  const original = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = async () => {
    fetched += 1;
    return new Response(Buffer.from([1, 2, 3]), { headers: { 'content-type': 'image/jpeg' } });
  };
  const exec = { agent: { options: { provider: 'p', model: 'm' } } };
  const attachments = { imageLimits: { maxImageBytes: 1024 }, saveImage: async () => ({ id: 'att-1' }) };
  const textOnly = { get: (name) => name === 'attachments' ? attachments : { resolveModelInfo: async () => ({ inputModalities: ['text'] }) } };
  try {
    const skipped = await attachRemoteImages(textOnly, exec, [item], { maxImages: 1 });
    assert.equal(fetched, 0);
    assert.equal(skipped.imageChannel, 'model_text_only');
    const imageModel = { get: (name) => name === 'attachments' ? attachments : { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) } };
    const attached = await attachRemoteImages(imageModel, exec, [item], { maxImages: 1 });
    assert.equal(fetched, 1);
    assert.equal(attached.imageAttached, true);
    assert.equal(attached.imageChannel, 'attached');
  } finally {
    globalThis.fetch = original;
  }
});
