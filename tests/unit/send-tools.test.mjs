import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { CookieJar } from '../../lib/bili/http.mjs';
import { commentSend, messageSend } from '../../lib/bili/send.mjs';
import { dynamicPublish } from '../../lib/bili/publish.mjs';
import { apply } from '../../lib/index.js';

const jar = new CookieJar({ SESSDATA: 'fixture', DedeUserID: '123', bili_jct: 'fixture', buvid3: 'fixture' });
const bvid = 'BV1GJ411x7h7';
async function isolated(run) {
  const root = await mkdtemp(join(tmpdir(), 'bili-send-tool-'));
  const beforeDir = process.env.BILI_DATA_DIR, original = globalThis.fetch;
  process.env.BILI_DATA_DIR = root;
  let mutation = async () => { throw new Error('unexpected mutation'); };
  const posts = [];
  globalThis.fetch = async (input, options) => {
    const url = new URL(input);
    let data;
    if (options.method === 'POST') { posts.push({ url, options }); data = await mutation(url, options); }
    else if (url.pathname.endsWith('/nav')) data = { isLogin: true, mid: 123 };
    else if (url.pathname.endsWith('/view')) data = { bvid, aid: 1, title: 'test', pages: [{ page: 1, cid: 2, duration: 10 }] };
    else if (url.pathname.endsWith('/reply')) data = { replies: [{ rpid_str: '9007199254740999', member: { mid: 123 }, content: { message: 'test text' }, parent_str: '11', ctime: Math.floor(Date.now() / 1000) }] };
    else throw Error('unexpected GET ' + url.pathname);
    return Response.json({ code: 0, data });
  };
  try { await run({ root, posts, onPost(fn) { mutation = fn; } }); }
  finally { globalThis.fetch = original; if (beforeDir === undefined) delete process.env.BILI_DATA_DIR; else process.env.BILI_DATA_DIR = beforeDir; await rm(root, { recursive: true, force: true }); }
}

test('comment preview binds exact reply target and text; apply reserves and preserves returned ID', async () => isolated(async ({ posts, onPost }) => {
  const args = { jar, bvid, text: 'test text', rpid: '11' };
  const preview = await commentSend(args); assert.equal(posts.length, 0);
  await assert.rejects(commentSend({ ...args, text: 'changed', intent: 'apply', previewToken: preview.previewToken }), { code: 'PREVIEW_REQUIRED' });
  onPost((_url, options) => {
    const body = new URLSearchParams(options.body);
    assert.equal(body.get('root'), '11'); assert.equal(body.get('parent'), '11');
    return { rpid_str: '9007199254740999' };
  });
  const sent = await commentSend({ ...args, intent: 'apply', previewToken: preview.previewToken });
  assert.equal(sent.status, 'SENT'); assert.equal(sent.result.rpid, '9007199254740999');
  assert.equal((await commentSend({ ...args, intent: 'apply', previewToken: preview.previewToken })).status, 'DUPLICATE');
  assert.equal(posts.length, 1);
}));

test('comment timeout is reconciled using author, target, time and full text without resending', async () => isolated(async ({ posts, onPost }) => {
  const args = { jar, bvid, text: 'test text', rpid: '11' };
  const preview = await commentSend(args);
  onPost(() => { throw new DOMException('timeout', 'TimeoutError'); });
  const sent = await commentSend({ ...args, intent: 'apply', previewToken: preview.previewToken });
  assert.equal(sent.status, 'PENDING_CONFIRM');
  const checked = await commentSend({ jar, intent: 'check', operationId: sent.operationId });
  assert.equal(checked.status, 'SENT'); assert.equal(posts.length, 1);
}));

test('message byte limit rejects before submission and no preview performs a POST', async () => isolated(async ({ posts }) => {
  await assert.rejects(messageSend({ jar, receiverMid: '5', text: '中'.repeat(900) }), { code: 'INVALID_ARGUMENT' });
  assert.equal((await messageSend({ jar, receiverMid: '5', text: 'hello' })).status, 'PREVIEW');
  assert.equal(posts.length, 0);
}));

test('dynamic image change invalidates preview; multipart upload precedes JSON publication', async () => isolated(async ({ root, posts, onPost }) => {
  const image = join(root, 'image.png');
  const buffer = await sharp({ create: { width: 4, height: 4, channels: 3, background: 'red' } }).png().toBuffer();
  await writeFile(image, buffer);
  const args = { jar, text: 'image test', images: [image] };
  const first = await dynamicPublish(args); assert.equal(posts.length, 0);
  await writeFile(image, await sharp(buffer).resize(8, 8).png().toBuffer());
  await assert.rejects(dynamicPublish({ ...args, intent: 'apply', previewToken: first.previewToken }), { code: 'PREVIEW_REQUIRED' });
  await writeFile(image, buffer);
  onPost((url, options) => {
    if (url.pathname.endsWith('upload_bfs')) {
      assert.ok(options.body instanceof FormData); assert.equal(options.headers['content-type'], undefined);
      return { image_url: 'https://i0.hdslb.com/image.png', image_width: 4, image_height: 4, img_size: 1 };
    }
    assert.equal(options.headers['content-type'], 'application/json');
    assert.equal(JSON.parse(options.body).dyn_req.pics.length, 1);
    return { dyn_id_str: '9007199254740999' };
  });
  const result = await dynamicPublish({ ...args, intent: 'apply', previewToken: first.previewToken });
  assert.equal(result.status, 'SENT'); assert.equal(posts.length, 2);
}));

test('all six mutations require apply approval; reconciliation is read-only and tool budget stays 25', async () => {
  const hooks = [], tools = [];
  apply({ on(name, fn) { if (name === 'tools/pre-execute') hooks.push(fn); }, tools: { register(tool) { tools.push(tool); } } });
  assert.equal(tools.length, 25);
  const gate = hooks[0];
  for (const name of ['bilibili_comment_send', 'bilibili_message_send', 'bilibili_dynamic_publish', 'bilibili_video_like_set', 'bilibili_favorite_set', 'bilibili_watch_later_set']) {
    assert.equal(await gate({ name, args: {} }, () => 'next'), 'next');
    assert.equal((await gate({ name, args: { intent: 'apply', text: 'visible text' } }, () => 'next')).kind, 'ask');
  }
  assert.equal(await gate({ name: 'bilibili_comment_send', args: { intent: 'check' } }, () => 'next'), 'next');
  const bytes = Buffer.byteLength(JSON.stringify(tools.map(({ name, description, parameters }) => ({ name, description, parameters }))));
  assert.ok(bytes < 20000, `schema budget exceeded: ${bytes}`);
});

test('image upload failure never publishes a text-only fallback', async () => isolated(async ({ root, posts, onPost }) => {
  const image = join(root, 'image.png');
  await writeFile(image, await sharp({ create: { width: 4, height: 4, channels: 3, background: 'red' } }).png().toBuffer());
  const args = { jar, text: 'stop on image error', images: [image] };
  const preview = await dynamicPublish(args);
  onPost(() => { throw new Error('image upload disconnected'); });
  const result = await dynamicPublish({ ...args, intent: 'apply', previewToken: preview.previewToken });
  assert.equal(result.status, 'FAILED'); assert.equal(posts.length, 1); assert.ok(posts[0].url.pathname.endsWith('upload_bfs'));
}));

test('scheduled dynamic uses a platform draft, never an in-process timer', async () => isolated(async ({ posts, onPost }) => {
  const args = { jar, text: 'scheduled text', scheduleTime: Math.floor(Date.now() / 1000) + 3600 };
  const preview = await dynamicPublish(args);
  onPost((url, options) => {
    assert.ok(url.pathname.endsWith('/add_draft'));
    const body = new URLSearchParams(options.body);
    assert.equal(body.get('type'), '2'); assert.equal(JSON.parse(body.get('request')).content, args.text);
    return { draft_id: '12345' };
  });
  const result = await dynamicPublish({ ...args, intent: 'apply', previewToken: preview.previewToken });
  assert.equal(result.result.draftId, '12345'); assert.equal(posts.length, 1);
}));
