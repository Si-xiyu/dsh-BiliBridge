import test from 'node:test';
import assert from 'node:assert/strict';
import { CookieJar, request } from '../../lib/bili/http.mjs';
import { discover } from '../../lib/bili/discover.mjs';
import { notifications } from '../../lib/bili/notifications.mjs';
import { listUserVideos } from '../../lib/bili/api.mjs';
import { listFavoriteItems } from '../../lib/bili/collections.mjs';
import { pageSubtitleCues } from '../../lib/media/subtitles.mjs';
import { validateDanmakuWindow } from '../../lib/media/danmaku.mjs';

const jar = new CookieJar({ SESSDATA: 'fixture', DedeUserID: '123', buvid3: 'fixture' });
async function mock(fn, run) { const original = globalThis.fetch; globalThis.fetch = async (url, options) => Response.json({ code: 0, data: await fn(new URL(url), options) }); try { return await run(); } finally { globalThis.fetch = original; } }

test('discovery bounds pages, handles list versus week and never invents unsupported scopes', async () => {
  await mock(url => {
    if (url.pathname.endsWith('/series/list')) return { list: [{ number: 1, name: 'week' }] };
    if (url.pathname.endsWith('/square')) return { trending: { list: [{ keyword: 'a' }, { keyword: 'b' }] } };
    assert.equal(url.searchParams.get('rid'), '188'); return { list: [{ bvid: 'BV1GJ411x7h7', title: '<em>x</em>', stat: { view: 1 } }] };
  }, async () => {
    assert.equal((await discover({ scope: 'rank', category: 'technology' })).items[0].title, 'x');
    assert.equal((await discover({ scope: 'weekly' })).items[0].number, 1);
    assert.equal((await discover({ scope: 'hotwords', pageSize: 1, page: 2 })).items[0].keyword, 'b');
  });
  await assert.rejects(discover({ pageSize: 51 }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(discover({ scope: 'unknown' }), { code: 'INVALID_ARGUMENT' });
});

test('notification pagination retains upstream tail and rejects cross-account cursors', async () => {
  await mock(url => ({ items: [{ id: '100', item: { source_id: '9007199254740995' } }, { id: '101' }, { id: '102' }], cursor: { is_end: true } }), async () => {
    const a = await notifications({ scope: 'replies', pageSize: 2, jar });
    const b = await notifications({ scope: 'replies', pageSize: 2, jar, cursor: a.nextCursor });
    assert.deepEqual([...a.items, ...b.items].map(i => i.id), ['100', '101', '102']);
    assert.equal(b.nextCursor, null);
    await assert.rejects(notifications({ scope: 'at', jar, cursor: a.nextCursor }), { code: 'INVALID_ARGUMENT' });
    await assert.rejects(notifications({ scope: 'replies', jar: new CookieJar({ SESSDATA: 'fixture', DedeUserID: '456' }), cursor: a.nextCursor }), { code: 'INVALID_ARGUMENT' });
  });
});

test('private session summaries exclude message bodies and never acknowledge messages', async () => {
  await mock((url, options) => {
    assert.equal(options.method, 'GET');
    return { session_list: [{ talker_id: '456', session_ts: 1000000, unread_count: 2, last_msg: { content: 'secret' } }], has_more: false };
  }, async () => {
    const result = await notifications({ scope: 'messages', jar });
    assert.equal(result.items[0].talkerId, '456'); assert.equal(JSON.stringify(result).includes('secret'), false);
  });
});

test('JSON transport preserves large numeric IDs before projection', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('{"code":0,"data":{"id":9007199254740993123}}');
  try { assert.equal((await request('https://api.bilibili.com/x/test')).id, '9007199254740993123'); } finally { globalThis.fetch = original; }
});

test('upload and favorite filters reach their upstream endpoints without changing write membership queries', async () => {
  await mock(url => {
    if (url.pathname.endsWith('/nav')) return { isLogin: true, mid: 123, wbi_img: { img_url: 'https://i0.hdslb.com/7cd084941338484aae1ad9425b84077c.png', sub_url: 'https://i0.hdslb.com/4932caff0ff746eab6f01bf08b70ac45.png' } };
    if (url.pathname.endsWith('/arc/search')) {
      assert.equal(url.searchParams.get('keyword'), 'alpha'); assert.equal(url.searchParams.get('order'), 'stow');
      return { list: { vlist: [] }, page: { count: 0 } };
    }
    assert.equal(url.pathname, '/x/v3/fav/resource/list');
    assert.equal(url.searchParams.get('keyword'), 'alpha'); assert.equal(url.searchParams.get('order'), 'view');
    return { medias: [], has_more: false };
  }, async () => {
    assert.equal((await listUserVideos('123', { jar, order: 'stow', keyword: 'alpha' })).total, 0);
    assert.equal((await listFavoriteItems({ jar, mediaId: '456', keyword: 'alpha', order: 'view' })).hasMore, false);
  });
  await assert.rejects(listFavoriteItems({ jar, mediaId: '456', order: 'bogus' }), { code: 'INVALID_ARGUMENT' });
});

test('subtitle cursor covers all cues exactly once and detects changes or cross-page reuse', () => {
  const cues = Array.from({ length: 1601 }, (_, i) => ({ id: `cue-${i}`, startMs: i * 1000, endMs: i * 1000 + 900, text: `${i}` }));
  const args = { bvid: 'BV1GJ411x7h7', cid: 1, lan: 'zh', durationMs: 1601000 };
  const first = pageSubtitleCues(cues, args);
  const second = pageSubtitleCues(cues, { ...args, subtitleCursor: first.nextCursor });
  const third = pageSubtitleCues(cues, { ...args, subtitleCursor: second.nextCursor });
  assert.equal(first.cues.length, 800); assert.equal(second.cues[0].text, '800'); assert.equal(third.cues[0].text, '1600'); assert.equal(third.nextCursor, null);
  assert.deepEqual(first.trackRange, third.trackRange); assert.equal(third.cumulativeRange.endMs, 1600900);
  assert.throws(() => pageSubtitleCues(cues, { ...args, cid: 2, subtitleCursor: first.nextCursor }), { code: 'CURSOR_STALE' });
  assert.throws(() => pageSubtitleCues([...cues, cues[0]], { ...args, subtitleCursor: first.nextCursor }), { code: 'CURSOR_STALE' });
  assert.throws(() => validateDanmakuWindow({ startSeconds: 1, endSeconds: 6 }, 5), { code: 'INVALID_ARGUMENT' });
});
