import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CookieJar } from '../../lib/bili/http.mjs';
import { deleteComment, deleteDynamic, deleteDraft, listDrafts, publishDraftNow } from '../../lib/bili/manage.mjs';

const jar = new CookieJar({ SESSDATA: 'fixture', DedeUserID: '123', bili_jct: 'fixture' });
const bvid = 'BV1GJ411x7h7';

async function isolated(run) {
  const root = await mkdtemp(join(tmpdir(), 'bili-manage-'));
  const beforeDir = process.env.BILI_DATA_DIR;
  const original = globalThis.fetch;
  process.env.BILI_DATA_DIR = root;
  const posts = [];
  let mutation = async () => { throw new Error('unexpected mutation'); };
  let draftRequest = JSON.stringify({ content: '草稿正文' });
  let commentMid = 123;
  let detailResult = async () => ({ code: 0, data: { item: {
    id_str: '555', type: 'DYNAMIC_TYPE_WORD', modules: {
      module_author: { mid: 123, name: 'me', pub_ts: 1700000000 },
      module_dynamic: { desc: { text: '要删除的动态' } },
    },
  } } });
  globalThis.fetch = async (input, options) => {
    const url = new URL(input);
    if (options.method === 'POST') { posts.push({ url, options }); return Response.json(await mutation(url, options)); }
    if (url.pathname.endsWith('/nav')) return Response.json({ code: 0, data: { isLogin: true, mid: 123 } });
    if (url.pathname.endsWith('/view')) return Response.json({ code: 0, data: { bvid, aid: 1, title: 'test', pages: [{ page: 1, cid: 2, duration: 10 }] } });
    if (url.pathname.endsWith('/polymer/web-dynamic/v1/detail')) return Response.json(await detailResult());
    if (url.pathname.endsWith('/x/v2/reply/reply')) return Response.json({ code: 0, data: { root: {
      rpid_str: '42', member: { mid: commentMid }, content: { message: '我的评论' },
    }, replies: [] } });
    if (url.pathname.endsWith('/x/v2/reply')) return Response.json({ code: 0, data: { page: { pn: 1, ps: 20, count: 0 }, replies: [] } });
    if (url.pathname.endsWith('/get_drafts')) return Response.json({ code: 0, data: { drafts: [
      { draft_id: 777, type: 2, publish_time: 1700003600, request: draftRequest },
    ] } });
    throw new Error('unexpected GET ' + url.pathname);
  };
  try { await run({ root, posts, onPost(fn) { mutation = fn; }, onDetail(fn) { detailResult = fn; }, setCommentMid(fn) { commentMid = fn(commentMid); }, setDraftRequest(fn) { draftRequest = fn(draftRequest); } }); }
  finally {
    globalThis.fetch = original;
    if (beforeDir === undefined) delete process.env.BILI_DATA_DIR; else process.env.BILI_DATA_DIR = beforeDir;
    await rm(root, { recursive: true, force: true });
  }
}

test('删除评论：preview 不发写请求，apply 校验 token 后删除', async () => isolated(async ({ posts, onPost }) => {
  const args = { jar, bvid, rpid: '42' };
  const preview = await deleteComment(args);
  assert.equal(posts.length, 0);
  assert.equal(preview.status, 'PREVIEW');
  await assert.rejects(deleteComment({ ...args, rpid: '43', intent: 'apply', previewToken: preview.previewToken }), { code: 'PREVIEW_REQUIRED' });
  onPost((url) => { assert.ok(url.pathname.endsWith('/x/v2/reply/del')); return { code: 0, data: {} }; });
  const result = await deleteComment({ ...args, intent: 'apply', previewToken: preview.previewToken });
  assert.equal(result.status, 'DELETED');
  assert.equal(posts.length, 1);
  const body = new URLSearchParams(posts[0].options.body);
  assert.equal(body.get('oid'), '1');
  assert.equal(body.get('rpid'), '42');
  assert.equal(body.get('type'), '1');
}));

test('删除评论：12022 视为已删除，不重试', async () => isolated(async ({ onPost }) => {
  const preview = await deleteComment({ jar, bvid, rpid: '42' });
  onPost(() => ({ code: 12022, message: '已经被删除了' }));
  const result = await deleteComment({ jar, bvid, rpid: '42', intent: 'apply', previewToken: preview.previewToken });
  assert.equal(result.status, 'DELETED');
  assert.equal(result.alreadyDeleted, true);
}));

test('删除动态：只允许自己的动态，apply 走 rm_dynamic', async () => isolated(async ({ posts, onPost }) => {
  const preview = await deleteDynamic({ jar, dynamicId: '555' });
  assert.equal(preview.status, 'PREVIEW');
  assert.equal(preview.detail.text, '要删除的动态');
  assert.equal(posts.length, 0);
  onPost((url) => { assert.ok(url.pathname.endsWith('/rm_dynamic')); return { code: 0, data: {} }; });
  const result = await deleteDynamic({ jar, dynamicId: '555', intent: 'apply', previewToken: preview.previewToken });
  assert.equal(result.status, 'DELETED');
  assert.equal(result.dynamicId, '555');
  assert.equal(posts.length, 1);
}));

test('删除动态：删除请求返回 500404 视为已删除', async () => isolated(async ({ posts, onPost }) => {
  const preview = await deleteDynamic({ jar, dynamicId: '555' });
  onPost(() => ({ code: 500404, message: '已经删除过该动态' }));
  const result = await deleteDynamic({ jar, dynamicId: '555', intent: 'apply', previewToken: preview.previewToken });
  assert.equal(result.status, 'DELETED');
  assert.equal(result.alreadyDeleted, true);
  assert.equal(posts.length, 1);
}));

test('删除动态：删除请求返回 4101152 不能伪装成 DELETED', async () => isolated(async ({ posts, onPost }) => {
  const preview = await deleteDynamic({ jar, dynamicId: '555' });
  onPost(() => ({ code: 4101152, message: '动态不可见' }));
  await assert.rejects(
    deleteDynamic({ jar, dynamicId: '555', intent: 'apply', previewToken: preview.previewToken }),
    { code: 'NOT_FOUND' },
  );
  assert.equal(posts.length, 1);
}));

test('删除评论：拒绝删除他人的评论', async () => isolated(async ({ posts, setCommentMid }) => {
  setCommentMid(() => 999);
  await assert.rejects(deleteComment({ jar, bvid, rpid: '42' }), { code: 'PERMISSION_DENIED' });
  assert.equal(posts.length, 0);
}));

test('删除动态：非自己的动态在 preview 阶段拒绝', async () => isolated(async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (input, options) => {
    const url = new URL(input);
    if (url.pathname.endsWith('/nav')) return Response.json({ code: 0, data: { isLogin: true, mid: 123 } });
    if (url.pathname.endsWith('/polymer/web-dynamic/v1/detail')) return Response.json({ code: 0, data: { item: {
      id_str: '555', type: 'DYNAMIC_TYPE_WORD', modules: {
        module_author: { mid: 999, name: 'other', pub_ts: 1700000000 },
        module_dynamic: { desc: { text: '别人的动态' } },
      },
    } } });
    throw new Error('unexpected ' + url.pathname);
  };
  try {
    await assert.rejects(deleteDynamic({ jar, dynamicId: '555' }), { code: 'PERMISSION_DENIED' });
  } finally { globalThis.fetch = original; }
}));

test('定时草稿：列表只读，删除/立即发布需要 preview', async () => isolated(async ({ posts, onPost }) => {
  const list = await listDrafts({ jar });
  assert.equal(list.count, 1);
  assert.equal(list.items[0].draftId, '777');
  assert.equal(list.items[0].text, '草稿正文');
  assert.equal(posts.length, 0);
  const preview = await deleteDraft({ jar, draftId: '777' });
  assert.equal(preview.status, 'PREVIEW');
  onPost((url) => { assert.ok(url.pathname.endsWith('/rm_draft')); return { code: 0, data: {} }; });
  assert.equal((await deleteDraft({ jar, draftId: '777', intent: 'apply', previewToken: preview.previewToken })).status, 'DELETED');
  const publishPreview = await publishDraftNow({ jar, draftId: '777' });
  assert.equal(publishPreview.status, 'PREVIEW');
  onPost((url) => { assert.ok(url.pathname.endsWith('/publish_now')); return { code: 0, data: {} }; });
  assert.equal((await publishDraftNow({ jar, draftId: '777', intent: 'apply', previewToken: publishPreview.previewToken })).status, 'PUBLISHED');
}));

test('publish_draft_now 绑定草稿内容：预览后修改草稿必须重新预览', async () => isolated(async ({ posts, onPost, setDraftRequest }) => {
  const preview = await publishDraftNow({ jar, draftId: '777' });
  assert.equal(preview.draft.text, '草稿正文');
  assert.ok(preview.previewToken);
  setDraftRequest(() => JSON.stringify({ content: '被改过的草稿' }));
  await assert.rejects(
    publishDraftNow({ jar, draftId: '777', intent: 'apply', previewToken: preview.previewToken }),
    { code: 'PREVIEW_REQUIRED' },
  );
  assert.equal(posts.length, 0);
  setDraftRequest(() => JSON.stringify({ content: '草稿正文' }));
  onPost((url) => { assert.ok(url.pathname.endsWith('/publish_now')); return { code: 0, data: {} }; });
  const result = await publishDraftNow({ jar, draftId: '777', intent: 'apply', previewToken: preview.previewToken });
  assert.equal(result.status, 'PUBLISHED');
  assert.equal(result.draft.text, '草稿正文');
  assert.equal(posts.length, 1);
}));

test('内容管理不接受 check，也不会在缺少目标时发请求', async () => isolated(async () => {
  await assert.rejects(deleteComment({ jar, bvid, rpid: '42', intent: 'check' }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(deleteDraft({ jar, intent: 'preview' }), { code: 'INVALID_ARGUMENT' });
}));
