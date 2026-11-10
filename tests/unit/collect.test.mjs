import '../helpers/http-isolation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { collect } from '../../lib/bili/collect.mjs';
import { CookieJar } from '../../lib/bili/http.mjs';

const jar = new CookieJar({ buvid3: 'fixture' });
async function network(handler, run) {
  const original = globalThis.fetch;
  globalThis.fetch = async (input, options) => {
    const url = new URL(input);
    if (url.pathname.endsWith('/nav')) return Response.json({ code: 0, data: { wbi_img: { img_url: 'https://i0.hdslb.com/7cd084941338484aae1ad9425b84077c.png', sub_url: 'https://i0.hdslb.com/4932caff0ff746eab6f01bf08b70ac45.png' } } });
    const data = await handler(url, options);
    return data instanceof Response ? data : Response.json({ code: 0, data });
  };
  try { return await run(); } finally { globalThis.fetch = original; }
}
const candidates = Array.from({ length: 3 }, (_, i) => ({ bvid: ['BV1GJ411x7h7', 'BV1VZWc6dECG', 'BV1KDNA6eEgr'][i], title: 'video' }));
test('collect hard bounds reject before any network; cancellation retains completed work', async () => {
  await assert.rejects(collect({ maxVideos: 11 }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(collect({ commentsPerVideo: 21 }), { code: 'INVALID_ARGUMENT' });
  const controller = new AbortController(); let replies = 0;
  await network(url => {
    if (url.pathname.endsWith('/search/type')) return { result: candidates, numResults: 3 };
    if (url.pathname.endsWith('/view')) return { bvid: candidates[0].bvid, aid: 1, pages: [] };
    assert.equal(url.pathname, '/x/v2/reply'); assert.equal(url.searchParams.get('ps'), '2');
    if (++replies === 2) controller.abort();
    return { replies: [], page: { count: 0 } };
  }, async () => {
    const result = await collect({ keyword: 'test', maxVideos: 3, commentsPerVideo: 2, subtitles: false, jar, signal: controller.signal });
    assert.equal(result.stopped, 'CANCELLED'); assert.equal(result.results.length, 2);
    assert.deepEqual(result.unprocessed, [candidates[2].bvid]); assert.equal(result.limits.nestedReplyRequests, 0);
  });
});

test('collect enforces aggregate output budget and lists unprocessed candidates', async () => {
  await network(url => {
    if (url.pathname.endsWith('/search/type')) return { result: candidates, numResults: 3 };
    if (url.pathname.endsWith('/view')) return { bvid: candidates[0].bvid, aid: 1, pages: [{ page: 1, cid: 2, duration: 300 }] };
    if (url.pathname === '/x/v2/reply') return { replies: [], page: { count: 0 } };
    if (url.pathname.endsWith('/wbi/v2')) return { subtitle: { subtitles: [{ lan: 'zh', subtitle_url: 'https://i0.hdslb.com/subtitle.json' }] } };
    if (url.pathname === '/subtitle.json') return Response.json({ body: Array.from({ length: 200 }, (_, i) => ({ from: i, to: i + 1, content: 'x'.repeat(1000) })) });
    throw Error('unexpected ' + url.pathname);
  }, async () => {
    const result = await collect({ keyword: 'test', maxVideos: 3, jar });
    assert.equal(result.stopped, 'OUTPUT_BUDGET'); assert.equal(result.results.length, 2);
    assert.deepEqual(result.unprocessed, [candidates[2].bvid]);
    assert.ok(Buffer.byteLength(JSON.stringify(result.results)) <= 512000);
  });
});

test('collect skips settings-disabled comments and subtitles without errors or partial results', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'collect-settings-'));
  const previous = process.env.BILI_DATA_DIR;
  try {
    process.env.BILI_DATA_DIR = dir;
    for (const extract of [
      { comments: false, subtitles: false },
      { comments: false, subtitles: true },
      { comments: true, subtitles: false },
    ]) {
      await writeFile(join(dir, 'config.json'), JSON.stringify({ extract }));
      const calls = [];
      await network(url => {
        calls.push(url.pathname);
        if (url.pathname.endsWith('/search/type')) return { result: candidates.slice(0, 1), numResults: 1 };
        if (url.pathname === '/x/v2/reply' && extract.comments) return { replies: [], page: { count: 0 } };
        if (url.pathname.endsWith('/view')) return { bvid: candidates[0].bvid, aid: 1, pages: [{ page: 1, cid: 2, duration: 60 }] };
        if (url.pathname.endsWith('/wbi/v2') && extract.subtitles) return { subtitle: { subtitles: [] } };
        assert.fail('unexpected request ' + url.pathname);
      }, async () => {
        const result = await collect({ keyword: 'test', maxVideos: 1, jar });
        assert.equal(result.partial, false, JSON.stringify(result));
        assert.deepEqual(result.unprocessed, []);
        assert.equal(result.stopped, null);
        const row = result.results[0];
        assert.deepEqual(row.errors, []);
        for (const source of ['comments', 'subtitles']) if (!extract[source]) {
          assert.deepEqual(row[source], { status: 'skipped', skippedBy: 'settings' });
        }
      });
      if (!extract.comments) assert.ok(!calls.includes('/x/v2/reply'));
      if (!extract.subtitles) assert.ok(!calls.some(p => p.endsWith('/wbi/v2')));
    }
  } finally {
    if (previous === undefined) delete process.env.BILI_DATA_DIR; else process.env.BILI_DATA_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
test('collect stops immediately on risk or expired login, retaining the incomplete current video', async () => {
  for (const code of [-352, -412, -101]) {
    let callsAfterFailure = 0, failed = false;
    await network(url => {
      if (failed) callsAfterFailure++;
      if (url.pathname.endsWith('/search/type')) return { result: candidates, numResults: 3 };
      if (url.pathname.endsWith('/view')) return { bvid: candidates[0].bvid, aid: 1, pages: [] };
      if (url.pathname === '/x/v2/reply') { failed = true; return Response.json({ code }); }
      throw Error('unexpected request ' + url.pathname);
    }, async () => {
      const result = await collect({ keyword: 'test', maxVideos: 3, jar });
      assert.equal(callsAfterFailure, 0);
      assert.equal(result.stopped, code === -352 ? 'RISK_CONTROLLED' : code === -412 ? 'RATE_LIMITED' : 'AUTH_REQUIRED');
      assert.equal(result.results.length, 1);
      assert.deepEqual(result.incomplete, [candidates[0].bvid]);
      assert.deepEqual(result.unprocessed, candidates.slice(1).map(v => v.bvid));
    });
  }
});

test('collect continues after ordinary per-video content errors', async () => {
  let replies = 0;
  await network(url => {
    if (url.pathname.endsWith('/search/type')) return { result: candidates, numResults: 3 };
    if (url.pathname.endsWith('/view')) return { bvid: candidates[0].bvid, aid: 1, pages: [] };
    if (url.pathname === '/x/v2/reply') { replies++; return Response.json({ code: -404 }); }
    throw Error('unexpected request');
  }, async () => {
    const result = await collect({ keyword: 'test', maxVideos: 3, subtitles: false, jar });
    assert.equal(replies, 3);
    assert.equal(result.stopped, null);
    assert.equal(result.results.length, 3);
  });
});
