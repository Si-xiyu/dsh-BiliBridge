import assert from 'node:assert/strict';
import test from 'node:test';
import { apply } from '../../lib/index.js';
import { CookieJar } from '../../lib/bili/http.mjs';
import { cleanSearchText, search } from '../../lib/bili/search.mjs';
import { listComments, projectComment } from '../../lib/bili/comments.mjs';
import { listDynamics, projectDynamic } from '../../lib/bili/dynamics.mjs';
import { userProfile } from '../../lib/bili/user.mjs';
import { positiveInteger } from '../../lib/bili/read.mjs';

const jar = () => new CookieJar({ buvid3: 'fixture' });
const nav = { isLogin: true, mid: 123, wbi_img: { img_url: 'https://example.test/7cd084941338484aae1ad9425b84077c.png', sub_url: 'https://example.test/4932caff0ff746eab6f01bf08b70ac45.png' } };
const video = { bvid: 'BV1VZWc6dECG', aid: 1, pages: [] };

async function mockFetch(routes, fn) {
  const previous = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const target = new URL(url);
    calls.push({ url: target, options });
    const handler = routes[target.pathname];
    if (!handler && target.pathname === '/x/web-interface/nav') return Response.json({ code: 0, data: nav });
    assert.ok(handler, `unexpected request ${target.pathname}`);
    const body = typeof handler === 'function' ? handler(target, options) : handler;
    return Response.json(body);
  };
  try { return await fn(calls); } finally { globalThis.fetch = previous; }
}

test('search removes markup and decodes named/numeric entities safely', () => {
  assert.equal(cleanSearchText('<em class="keyword">编程</em>&amp;&#x4e2d;&#25991;&nbsp;'), '编程&中文 ');
  assert.equal(cleanSearchText('&#99999999;'), '&#99999999;');
});

test('pagination rejects out-of-range, fractional and nonnumeric values', async () => {
  for (const value of [0, -1, 1.5, '2', NaN, Infinity, 51]) assert.throws(() => positiveInteger(value, 'pageSize', 20, 50), { code: 'INVALID_ARGUMENT' });
  assert.equal(positiveInteger(undefined, 'pageSize', 20, 50), 20);
  await assert.rejects(search({ keyword: 'a', type: 'user', order: 'click' }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(listComments({ bvid: video.bvid, pageSize: 21 }), { code: 'INVALID_ARGUMENT' });
});

test('search signs video/user queries and projects fields and empty results', async () => {
  await mockFetch({ '/x/web-interface/wbi/search/type': (url) => {
    assert.ok(url.searchParams.has('w_rid'));
    return { code: 0, data: url.searchParams.get('search_type') === 'video'
      ? { result: [{ bvid: video.bvid, title: '<em>test</em>', author: 'UP', pubdate: 1, video_review: 3 }], numResults: 21, numPages: 2, page: 1, pagesize: 20 }
      : { result: [{ mid: 123, uname: 'user', usign: 'sign', upic: '//i.example/avatar' }], numResults: 1 } };
  } }, async () => {
    const videos = await search({ keyword: 'test', jar: jar() });
    assert.equal(videos.items[0].title, 'test');
    assert.equal(videos.items[0].pubdate, '1970-01-01T00:00:01.000Z');
    assert.equal(videos.hasMore, true);
    const users = await search({ keyword: 'test', type: 'user', jar: jar() });
    assert.equal(users.items[0].mid, '123');
    assert.equal(users.items[0].avatar, 'https://i.example/avatar');
  });
  await mockFetch({ '/x/web-interface/wbi/search/type': { code: 0, data: { numResults: 0 } } }, async () => {
    const result = await search({ keyword: 'empty', jar: jar() });
    assert.deepEqual(result.items, []); assert.equal(result.hasMore, false);
  });
});

test('comments truncate Unicode characters and disable nested replies', () => {
  const result = projectComment({ rpid_str: '123456789123456789', content: { message: '😀'.repeat(601) }, member: { mid: 5 }, ctime: 1, replies: [{ rpid: 2 }] }, false);
  assert.equal(Array.from(result.message).length, 600);
  assert.equal(result.rpid, '123456789123456789');
  assert.equal(result.uid, '5');
  assert.deepEqual(result.replies, []);
});

test('comments fetch child endpoint when previews are incomplete', async () => {
  await mockFetch({
    '/x/web-interface/view': { code: 0, data: video },
    '/x/v2/reply': { code: 0, data: { page: { count: 21 }, replies: [{ rpid: 10, rcount: 4 }] } },
    '/x/v2/reply/reply': { code: 0, data: { replies: [1, 2, 3, 4].map(rpid => ({ rpid })) } },
  }, async (calls) => {
    const data = await listComments({ bvid: video.bvid, jar: jar() });
    assert.equal(data.items[0].replies.length, 3);
    assert.equal(data.hasMore, true);
    assert.equal(calls.at(-1).url.searchParams.get('root'), '10');
  });
});

test('comments WBI fallback is explicit and does not pretend to support pn', async () => {
  await mockFetch({
    '/x/web-interface/view': { code: 0, data: video }, '/x/v2/reply': { code: -400 },
    '/x/v2/reply/wbi/main': { code: 0, data: { replies: [], cursor: { all_count: 0, is_end: true } } },
  }, async () => {
    const data = await listComments({ bvid: video.bvid, jar: jar() });
    assert.deepEqual(data.items, []); assert.match(data.endpoint, /wbi/);
    await assert.rejects(listComments({ bvid: video.bvid, page: 2, jar: jar() }), { code: 'UNSUPPORTED' });
  });
});

test('dynamics project video, opus and repost without leaking modules', () => {
  const original = { id_str: '1', type: 'DYNAMIC_TYPE_AV', modules: { module_author: { mid: 2, name: 'UP', pub_ts: 1 }, module_dynamic: { desc: { text: '原文' }, major: { archive: { bvid: video.bvid, title: '标题' } } } } };
  const repost = projectDynamic({ id_str: '3', modules: { module_dynamic: { desc: { text: '转发' } } }, orig: original });
  assert.equal(repost.text, '转发\n原文'); assert.equal(repost.bvid, video.bvid);
  const opus = projectDynamic({ id_str: '4', modules: { module_dynamic: { major: { opus: { summary: { text: '图文' } } } } } });
  assert.equal(opus.text, '图文'); assert.ok(!('modules' in opus));
  assert.equal(projectDynamic(original).author.mid, '2');
});

test('dynamics small page preserves upstream tail and validates cursor scope', async () => {
  await mockFetch({ '/x/polymer/web-dynamic/v1/feed/space': { code: 0, data: { items: [1, 2, 3].map(id => ({ id_str: String(id) })), has_more: false } } }, async () => {
    const first = await listDynamics({ mid: '123', pageSize: 2, jar: jar() });
    assert.deepEqual(first.items.map(i => i.dynamicId), ['1', '2']);
    const second = await listDynamics({ mid: '123', pageSize: 2, offset: first.nextOffset, jar: jar() });
    assert.deepEqual(second.items.map(i => i.dynamicId), ['3']); assert.equal(second.hasMore, false);
    await assert.rejects(listDynamics({ mid: '456', offset: first.nextOffset, jar: jar() }), { code: 'INVALID_ARGUMENT' });
  });
});

test('empty dynamics and unauthenticated follow feed are distinct', async () => {
  await mockFetch({ '/x/polymer/web-dynamic/v1/feed/space': { code: 0, data: { has_more: false } }, '/x/web-interface/nav': { code: -101, data: { isLogin: false } } }, async () => {
    assert.deepEqual(await listDynamics({ mid: '123', jar: jar() }), { items: [], hasMore: false, nextOffset: null });
    await assert.rejects(listDynamics({ jar: jar() }), { code: 'AUTH_REQUIRED' });
  });
});

test('profile takes relation counts from stat and optional archive count from search', async () => {
  await mockFetch({
    '/x/space/wbi/acc/info': { code: 0, data: { mid: 123, name: 'UP', follower: 999 } },
    '/x/relation/stat': { code: 0, data: { follower: 8, following: 9 } },
    '/x/space/wbi/arc/search': { code: 0, data: { page: { count: 10 }, list: { vlist: [] } } },
  }, async () => { const data = await userProfile({ mid: '123', jar: jar() }); assert.equal(data.fans, 8); assert.equal(data.following, 9); assert.equal(data.archiveCount, 10); });
});

test('risk and rate errors propagate without fallback or empty success', async () => {
  for (const [code, expected] of [[-352, 'RISK_CONTROLLED'], [-412, 'RATE_LIMITED'], [-101, 'AUTH_REQUIRED']]) {
    await mockFetch({ '/x/web-interface/wbi/search/type': { code }, '/x/web-interface/view': { code: 0, data: video }, '/x/v2/reply': { code }, '/x/polymer/web-dynamic/v1/feed/space': { code } }, async () => {
      await assert.rejects(search({ keyword: 'test', jar: jar() }), { code: expected });
      await assert.rejects(listComments({ bvid: video.bvid, jar: jar() }), { code: expected });
      await assert.rejects(listDynamics({ mid: '123', jar: jar() }), { code: expected });
    });
  }
});

test('HTTP 412 remains RATE_LIMITED and is not retried', async () => {
  const previous = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return new Response('', { status: 412 }); };
  try {
    await assert.rejects(listDynamics({ mid: '123', jar: jar() }), { code: 'RATE_LIMITED' });
    assert.equal(calls, 1);
  } finally { globalThis.fetch = previous; }
});

test('optional archive count never swallows space risk control', async () => {
  await mockFetch({
    '/x/space/wbi/acc/info': { code: 0, data: { mid: 123 } },
    '/x/relation/stat': { code: 0, data: { follower: 8, following: 9 } },
    '/x/space/wbi/arc/search': { code: -352 },
  }, async () => { await assert.rejects(userProfile({ mid: '123', jar: jar() }), { code: 'RISK_CONTROLLED' }); });
});

test('malformed upstream success cannot become an empty result', async () => {
  await mockFetch({ '/x/web-interface/wbi/search/type': { code: 0, data: {} }, '/x/polymer/web-dynamic/v1/feed/space': { code: 0, data: {} } }, async () => {
    await assert.rejects(search({ keyword: 'x', jar: jar() }), { code: 'INVALID_RESPONSE' });
    await assert.rejects(listDynamics({ mid: '123', jar: jar() }), { code: 'INVALID_RESPONSE' });
  });
});

test('plugin registers 18 unique tools, with lossless new tool results', async () => {
  const definitions = [];
  apply({ tools: { register: def => definitions.push(def) }, on() {} });
  assert.equal(definitions.length, 18); assert.equal(new Set(definitions.map(d => d.name)).size, 18);
  await mockFetch({ '/x/frontend/finger/spi': { code: 0, data: { b_3: 'fixture' } }, '/x/web-interface/wbi/search/type': { code: 0, data: { result: [{ mid: 1 }], numResults: 1 } } }, async () => {
    // Empty credential path, never real credential content.
    const old = process.env.BILI_DATA_DIR; process.env.BILI_DATA_DIR = '/tmp/bili-unit-nonexistent';
    try {
      const result = await definitions.find(d => d.name === 'bilibili_search').execute({ keyword: 'x', type: 'user' });
      assert.deepEqual(result, JSON.parse(JSON.stringify(result)));
    } finally { if (old === undefined) delete process.env.BILI_DATA_DIR; else process.env.BILI_DATA_DIR = old; }
  });
});
