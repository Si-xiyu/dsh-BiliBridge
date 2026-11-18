import '../helpers/http-isolation.mjs';
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
  let draftList = () => { throw new Error('unexpected draft list'); };
  let timingList = () => ({ items: [], count: 0 });
  let dynamicRead = () => { throw new Error('unexpected dynamic read'); };
  const posts = [];
  globalThis.fetch = async (input, options) => {
    const url = new URL(input);
    let data;
    if (options.method === 'POST') {
      posts.push({ url, options });
      const result = await mutation(url, options);
      // 测试需要模拟业务错误时返回 { __response: {...} }，其余按成功 data 包一层。
      if (result?.__response) return Response.json(result.__response);
      data = result;
    }
    else if (url.pathname.endsWith('/nav')) data = { isLogin: true, mid: 123 };
    else if (url.pathname.endsWith('/view')) data = { bvid, aid: 1, title: 'test', pages: [{ page: 1, cid: 2, duration: 10 }] };
    else if (url.pathname.endsWith('/reply')) data = { replies: [{ rpid_str: '9007199254740999', member: { mid: 123 }, content: { message: 'test text' }, parent_str: '11', ctime: Math.floor(Date.now() / 1000) }] };
    else if (url.pathname.endsWith('/get_drafts')) data = draftList();
    else if (url.pathname.endsWith('/timing/draft/list')) data = timingList();
    else if (url.pathname.includes('/web-dynamic/')) data = dynamicRead(url);
    else throw Error('unexpected GET ' + url.pathname);
    return Response.json({ code: 0, data });
  };
  try { await run({ root, posts, onPost(fn) { mutation = fn; }, onDraftList(fn) { draftList = fn; }, onTimingList(fn) { timingList = fn; }, onDynamicRead(fn) { dynamicRead = fn; } }); }
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

test('21047 保留平台原话并标记不可重试；check 也能看到原因', async () => isolated(async ({ posts, onPost }) => {
  const args = { jar, receiverMid: '5', text: 'hello' };
  const preview = await messageSend(args);
  onPost(() => ({ __response: { code: 21047, message: '对方主动回复或关注你前，最多发送1条消息~' } }));
  const sent = await messageSend({ ...args, intent: 'apply', previewToken: preview.previewToken });
  assert.equal(sent.status, 'FAILED');
  assert.equal(sent.error, 'DM_RESTRICTED');
  assert.equal(sent.biliCode, 21047);
  assert.match(sent.errorMessage, /最多发送1条消息/);
  assert.match(sent.hint, /最多发送 1 条/);
  assert.equal(sent.retryable, undefined);
  const checked = await messageSend({ jar, intent: 'check', operationId: sent.operationId });
  assert.equal(checked.status, 'FAILED');
  assert.equal(checked.biliCode, 21047);
  assert.match(checked.errorMessage, /最多发送1条消息/);
  assert.equal(posts.length, 1);
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

test('all seven write tools require apply approval; reconciliation is read-only and tool budget stays 27', async () => {
  const hooks = [], tools = [];
  apply({ on(name, fn) { if (name === 'tools/pre-execute') hooks.push(fn); }, tools: { register(tool) { tools.push(tool); } } });
  assert.equal(tools.length, 27);
  const gate = hooks[0];
  for (const name of ['bilibili_comment_send', 'bilibili_message_send', 'bilibili_dynamic_publish', 'bilibili_video_like_set', 'bilibili_favorite_set', 'bilibili_watch_later_set']) {
    assert.equal(await gate({ name, args: {} }, () => 'next'), 'next');
    assert.equal((await gate({ name, args: { intent: 'apply', text: 'visible text' } }, () => 'next')).kind, 'ask');
  }
  assert.equal(await gate({ name: 'bilibili_comment_send', args: { intent: 'check' } }, () => 'next'), 'next');
  assert.equal((await gate({ name: 'bilibili_content_manage', args: { action: 'delete_comment', intent: 'apply' } }, () => 'next')).kind, 'ask');
  assert.equal(await gate({ name: 'bilibili_content_manage', args: { action: 'list_drafts' } }, () => 'next'), 'next');
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

test('scheduled dynamic uses a platform draft, never an in-process timer', async () => isolated(async ({ posts, onPost, onDraftList }) => {
  const args = { jar, text: 'scheduled text', scheduleTime: Math.floor(Date.now() / 1000) + 3600 };
  onDraftList(() => ({ drafts: [] }));
  const preview = await dynamicPublish(args);
  onPost((url, options) => {
    assert.equal(url.pathname, '/x/dynamic/feed/create/dyn');
    const { dyn_req: request } = JSON.parse(options.body);
    assert.equal(request.scene, 1);
    assert.equal(request.content.contents[0].raw_text, args.text);
    assert.equal(request.option.timer_pub_time, args.scheduleTime);
    return { draft_id: '12345' };
  });
  const result = await dynamicPublish({ ...args, intent: 'apply', previewToken: preview.previewToken });
  assert.equal(result.result.draftId, '12345'); assert.equal(posts.length, 1);
}));

test('scheduled dynamic cannot report success from a regular dynamic id alone', async () => isolated(async ({ posts, onPost, onDraftList }) => {
  const args = { jar, text: 'scheduled text', scheduleTime: Math.floor(Date.now() / 1000) + 3600 };
  onDraftList(() => ({ drafts: [] }));
  const preview = await dynamicPublish(args);
  onPost(() => ({ dyn_id_str: '9007199254740999' }));
  const result = await dynamicPublish({ ...args, intent: 'apply', previewToken: preview.previewToken });
  assert.equal(result.status, 'PENDING_CONFIRM');
  assert.equal(posts.length, 1);
}));

test('dynamic check reads Opus detail when the feed omits the text and never resends', async () => isolated(async ({ posts, onPost, onDynamicRead }) => {
  const args = { jar, text: 'missing from feed' };
  const preview = await dynamicPublish(args);
  onPost(() => { throw new DOMException('timeout', 'TimeoutError'); });
  const pending = await dynamicPublish({ ...args, intent: 'apply', previewToken: preview.previewToken });
  assert.equal(pending.status, 'PENDING_CONFIRM');
  const item = { id_str: '9007199254740999', modules: {
    module_author: { mid: 123, pub_ts: Math.floor(Date.now() / 1000) }, module_dynamic: { desc: null },
  } };
  onDynamicRead(url => {
    if (url.pathname.endsWith('/feed/space')) return { items: [item], has_more: false };
    assert.equal(url.searchParams.get('features'), 'itemOpusStyle');
    return { item: { ...item, modules: { ...item.modules, module_dynamic: {
      desc: null, major: { opus: { summary: { text: args.text } } },
    } } } };
  });
  const checked = await dynamicPublish({ jar, intent: 'check', operationId: pending.operationId });
  assert.equal(checked.status, 'SENT');
  assert.equal(checked.result.dynamicId, item.id_str);
  assert.equal(posts.length, 1);
}));

test('scheduled dynamic check uses get_drafts and only confirms a unique matching draft without resending', async () => isolated(async ({ posts, onPost, onDraftList }) => {
  const args = { jar, text: 'scheduled text', scheduleTime: Math.floor(Date.now() / 1000) + 3600 };
  onDraftList(() => ({ drafts: [] }));
  const preview = await dynamicPublish(args);
  onPost(() => { throw new DOMException('timeout', 'TimeoutError'); });
  const pending = await dynamicPublish({ ...args, intent: 'apply', previewToken: preview.previewToken });
  assert.equal(pending.status, 'PENDING_CONFIRM');

  const matching = { draft_id: '9007199254740999', publish_time: args.scheduleTime, request: JSON.stringify({ content: args.text }) };
  const check = () => dynamicPublish({ jar, intent: 'check', operationId: pending.operationId });
  onDraftList(() => ({ drafts: [matching, { ...matching, draft_id: '12345' }] }));
  assert.equal((await check()).status, 'PENDING_CONFIRM');
  onDraftList(() => ({ list: [
    null,
    { ...matching, draft_id: undefined },
    { ...matching, request: 'null' },
    { ...matching, request: JSON.stringify({ content: args.text, pictures: '{}' }) },
    { ...matching, publish_time: args.scheduleTime + 1 },
    { ...matching, request: JSON.stringify({ dyn_req: { content: { contents: [{ type: 1, raw_text: args.text }] }, pics: [] } }) },
  ] }));
  const checked = await check();
  assert.equal(checked.status, 'SENT');
  assert.equal(checked.reconciled, true);
  assert.deepEqual(checked.result, { draftId: matching.draft_id, scheduleTime: args.scheduleTime });
  assert.equal(posts.length, 1);
}));

test('scheduled dynamic check never confirms a draft that existed before submission', async () => isolated(async ({ posts, onPost, onDraftList }) => {
  const args = { jar, text: 'scheduled text', scheduleTime: Math.floor(Date.now() / 1000) + 3600 };
  const matching = { draft_id: '9007199254740999', publish_time: args.scheduleTime, request: JSON.stringify({ content: args.text }) };
  onDraftList(() => ({ drafts: [matching] }));
  const preview = await dynamicPublish(args);
  onPost(() => { throw new DOMException('timeout', 'TimeoutError'); });
  const pending = await dynamicPublish({ ...args, intent: 'apply', previewToken: preview.previewToken });
  assert.equal(pending.status, 'PENDING_CONFIRM');
  onDraftList(() => ({ drafts: [matching] }));
  const checked = await dynamicPublish({ jar, intent: 'check', operationId: pending.operationId });
  assert.equal(checked.status, 'PENDING_CONFIRM');
  assert.equal(posts.length, 1);
}));

test('draft apply approval includes the bound content and source', async () => isolated(async ({ onDraftList, onTimingList }) => {
  onDraftList(() => ({ drafts: [{ draft_id: 777, type: 2, publish_time: 1700003600, request: JSON.stringify({ content: '草稿正文' }) }] }));
  onTimingList(() => ({ count: 1, items: [{
    id_str: '9007199254740999', author: { pub_ts: 1795014000 },
    content: { title: 'test', summary: { text: 'test' }, pics: [] },
  }] }));
  const hooks = [];
  apply({ on(name, fn) { if (name === 'tools/pre-execute') hooks.push(fn); }, tools: { register() {} } });
  const gate = hooks[0];
  const legacy = await gate({ name: 'bilibili_content_manage', args: { action: 'publish_draft_now', draftId: '777', intent: 'apply', previewToken: 'x' } }, () => 'next');
  assert.equal(legacy.kind, 'ask');
  assert.match(legacy.reason, /草稿正文/);
  assert.match(legacy.reason, /legacy/);
  assert.doesNotMatch(legacy.reason, /previewToken/);
  const timing = await gate({ name: 'bilibili_content_manage', args: { action: 'delete_draft', draftId: '9007199254740999', intent: 'apply' } }, () => 'next');
  assert.equal(timing.kind, 'ask');
  assert.match(timing.reason, /"text":"test"/);
  assert.match(timing.reason, /timing/);
}));

test('旧账本行没有发送前基线时不会自动确认定时草稿', async () => isolated(async ({ onDraftList }) => {
  const { ledgerUpdate } = await import('../../lib/bili/send-ledger.mjs');
  const { textHash } = await import('../../lib/bili/send-ledger.mjs');
  const scheduleTime = Math.floor(Date.now() / 1000) + 3600;
  const text = 'legacy pending';
  const operationId = '00000000-0000-4000-8000-000000000001';
  await ledgerUpdate('123', () => ({ value: null, event: {
    operationId, key: 'fixture', kind: 'dynamic', target: { account: '123', topicId: null, scheduleTime, images: [] },
    textHash: textHash(text), fingerprint: '', status: 'PENDING_CONFIRM', createdAt: Date.now() - 200_000,
  } }));
  onDraftList(() => ({ drafts: [{ draft_id: '9007199254740999', publish_time: scheduleTime, request: JSON.stringify({ content: text }) }] }));
  const checked = await dynamicPublish({ jar, intent: 'check', operationId });
  assert.equal(checked.status, 'PENDING_CONFIRM');
}));
