import assert from 'node:assert/strict';
import test from 'node:test';
import { guardedWrite, validateWrite, writeDecision } from '../../lib/bili/write-guard.mjs';
import { getFavoriteState, getLikeState, getWatchLaterState } from '../../lib/bili/state.mjs';
const state = value => ({ state: value, evidence: 'api' });
const target = { bvid: 'BVfixture', aid: 1 };

test('only definite pre-submission failure permits one retry', async () => {
  const error = { submission: 'not-submitted', retryable: true };
  assert.equal(writeDecision({ error }), 'retry');
  assert.equal(writeDecision({ error, attempt: 1 }), 'error');
  for (const code of ['TIMEOUT', 'NETWORK_ERROR', 'UPSTREAM_ERROR']) assert.equal(writeDecision({ error: { code, retryable: true } }), 'read');
  let writes = 0;
  const result = await guardedWrite({ intent: 'apply', desired: true, target, read: async () => state(writes > 1), write: async () => { if (++writes === 1) throw error; } });
  assert.equal(writes, 2); assert.equal(result.verified, true);
});

test('uncertain submission reconciles by reading, never resubmits', async () => {
  let writes = 0, reads = 0;
  const result = await guardedWrite({ intent: 'apply', desired: true, target, read: async () => state(++reads > 1), write: async () => { writes++; throw new Error('timeout'); } });
  assert.equal(result.reconciled, true); assert.equal(result.applied, true);
  assert.equal(writes, 1); assert.equal(reads, 2);
});

test('failed or mismatched readback reports uncertainty without retry', async () => {
  for (const value of ['unknown', false]) {
    let writes = 0;
    await assert.rejects(guardedWrite({ intent: 'apply', desired: true, target, read: async () => state(value), write: async () => { writes++; throw new Error('timeout'); } }), { code: 'WRITE_UNVERIFIED', retryable: false });
    assert.equal(writes, 1);
  }
  let reads = 0;
  await assert.rejects(guardedWrite({ intent: 'apply', desired: false, target, read: async () => { if (++reads > 1) throw Error('read failed'); return state(true); }, write: async () => {} }), { code: 'WRITE_UNVERIFIED' });
});

test('omitted intent and preview never call write', async () => {
  for (const intent of [undefined, 'preview']) {
    const result = await guardedWrite({ intent, desired: true, target, read: async () => state(false), write: async () => assert.fail('must not write') });
    assert.equal(result.dryRun, true); assert.equal(result.wouldApply, true); assert.equal(result.after, null);
  }
  assert.throws(() => validateWrite({ intent: 'yes', desired: true }), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => validateWrite({ desired: 'false' }), { code: 'INVALID_ARGUMENT' });
});

test('favorite requires one explicit visible folder, no default or multi-target guessing', () => {
  const folders = { items: [{ mediaId: 12 }] };
  for (const mediaId of [undefined, '', '0', '13', '12,13', '12.0']) assert.throws(() => validateWrite({ desired: true, mediaId, folders }), { code: 'INVALID_ARGUMENT' });
  validateWrite({ desired: false, mediaId: '12', folders });
});

async function mockFetch(handler, fn) {
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, options) => { assert.notEqual(options.method, 'POST'); return Response.json({ code: 0, data: handler(new URL(url)) }); };
  try { await fn(); } finally { globalThis.fetch = previous; }
}
test('state reads paginate folder membership and preserve unknown responses', async () => {
  await mockFetch(url => {
    if (url.pathname.endsWith('has/like')) return 0;
    if (url.pathname.endsWith('toview')) return { list: [] };
    return url.searchParams.get('pn') === '1' ? { medias: [{ id: 2, type: 2 }], has_more: true } : { medias: [{ id: 1, type: 2 }], has_more: false };
  }, async () => {
    assert.equal((await getFavoriteState({ aid: 1, mediaId: 12 })).state, true);
    assert.equal((await getWatchLaterState({ aid: 1 })).state, false);
    assert.equal((await getLikeState({ aid: 1 })).state, false);
  });
  await mockFetch(() => ({}), async () => {
    for (const read of [getFavoriteState, getWatchLaterState, getLikeState]) assert.equal((await read({ aid: 1, mediaId: 12 })).state, 'unknown');
  });
});

test('registered write tools default to GET-only preview and reject invisible folders', async () => {
  const { registerCollectionTools } = await import('../../lib/tools/collection.mjs');
  const definitions = [];
  registerCollectionTools({ tools: { register: def => definitions.push(def) } });
  const old = process.env.BILI_DATA_DIR;
  process.env.BILI_DATA_DIR = '/tmp/bili-write-unit-nonexistent';
  try {
    await mockFetch(url => {
      switch (url.pathname) {
        case '/x/web-interface/view': return { aid: 1, bvid: 'BV1VZWc6dECG', pages: [] };
        case '/x/web-interface/nav': return { isLogin: true, mid: 123 };
        case '/x/v2/history/toview': return { list: [] };
        case '/x/web-interface/archive/has/like': return 0;
        case '/x/v3/fav/folder/created/list-all': return { list: [{ id: 12 }] };
        case '/x/v3/fav/resource/list': return { medias: [], has_more: false };
        default: assert.fail('unexpected request ' + url.pathname);
      }
    }, async () => {
      for (const name of ['bilibili_watch_later_set', 'bilibili_favorite_set', 'bilibili_video_like_set']) {
        const tool = definitions.find(d => d.name === name);
        const args = { bvid: 'BV1VZWc6dECG', mediaId: '12', added: true, liked: true };
        const result = await tool.execute(args);
        assert.equal(result.data.dryRun, true);
        assert.equal(result.data.wouldApply, true);
        if (name === 'bilibili_favorite_set') await assert.rejects(tool.execute({ ...args, mediaId: '13', intent: 'apply' }), /INVALID_ARGUMENT/);
      }
    });
  } finally { if (old === undefined) delete process.env.BILI_DATA_DIR; else process.env.BILI_DATA_DIR = old; }
});
test('eventual consistency: readback polls until the target state appears', async () => {
  let reads = 0;
  const result = await guardedWrite({
    intent: 'apply', desired: true, target,
    read: async () => state(++reads >= 3),
    write: async () => {},
    sleep: async () => {},
  });
  assert.equal(result.verified, true);
  assert.equal(reads, 3, '写后立刻读到旧值时应继续轮询，而不是直接报未验证');
});