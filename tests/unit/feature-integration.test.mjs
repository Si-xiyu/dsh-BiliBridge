import '../helpers/http-isolation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { registerExtractTools } from '../../lib/tools/extract.mjs';
import { createTrafficGuard, trafficGuard } from '../../lib/bili/traffic-guard.mjs';
import { collect } from '../../lib/bili/collect.mjs';
import { CookieJar, request } from '../../lib/bili/http.mjs';

const bvid = 'BV1GJ411x7h7';
const nextBvid = 'BV1VZWc6dECG';
const metadata = { bvid, aid: 1, title: 'Offline integration fixture', pic: 'https://i0.hdslb.com/cover.jpg', pages: [{ page: 1, cid: 2, duration: 60 }] };
async function fixture(t, handler) {
  const root = await mkdtemp(join(tmpdir(), 'bili-integrated-'));
  const previous = process.env.BILI_DATA_DIR;
  process.env.BILI_DATA_DIR = root;
  let clock = 1000000;
  const guard = createTrafficGuard({ root, now: () => clock, sleep: async ms => { clock += ms; } });
  t.mock.method(trafficGuard, 'run', guard.run);
  t.mock.method(trafficGuard, 'check', guard.check);
  const calls = [];
  t.mock.method(globalThis, 'fetch', async input => {
    const url = new URL(input); calls.push(url.pathname);
    return handler(url);
  });
  t.after(async () => {
    if (previous === undefined) delete process.env.BILI_DATA_DIR; else process.env.BILI_DATA_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });
  return { root, calls, guard, settings: value => writeFile(join(root, 'config.json'), JSON.stringify(value)) };
}
test('eco extract skips images; enabling frames extracts the storyboard under the real traffic guard', async t => {
  const jpeg = await sharp({ create: { width: 480, height: 270, channels: 3, background: '#448866' } }).jpeg().toBuffer();
  const f = await fixture(t, url => {
    if (url.pathname.endsWith('/view')) return Response.json({ code: 0, data: metadata });
    if (url.pathname.endsWith('/videoshot')) return Response.json({ code: 0, data: { image: ['https://i0.hdslb.com/sprite.jpg'], index: [0, 6, 12, 18, 24, 30, 36, 42, 48], img_x_len: 3, img_y_len: 3, img_x_size: 160, img_y_size: 90 } });
    if (['/cover.jpg', '/sprite.jpg'].includes(url.pathname)) return new Response(jpeg, { headers: { 'content-type': 'image/jpeg' } });
    if (url.pathname === '/x/risk') return Response.json({ code: -352 });
    assert.fail('unexpected source request ' + url.pathname);
  });
  const tools = [];
  registerExtractTools({ tools: { register(tool) { tools.push(tool); } } });
  const extract = tools.find(tool => tool.name === 'bilibili_extract');
  const exec = { agent: { session: { id: 'integration-session' } } };
  await f.settings({ extract: { subtitles: false, comments: false, danmaku: false, frames: false }, adaptive: { adaptiveEnabled: false } });
  const eco = await extract.execute({ bvid, include: { frames: true } }, exec);
  assert.deepEqual(eco.images, []);
  assert.deepEqual(f.calls, ['/x/web-interface/view']);
  await f.settings({ extract: { subtitles: false, comments: false, danmaku: false, frames: true }, adaptive: { adaptiveEnabled: false } });
  const normal = await extract.execute({ bvid }, exec);
  assert.equal(normal.status, 'ok'); assert.equal(normal.images.length, 1);
  assert.equal((await f.guard.status()).remaining.readDaily, 2997, 'metadata + metadata + videoshot; local/media images consume no API allowance');
  await assert.rejects(request('https://api.bilibili.com/x/risk'), { code: 'RISK_CONTROLLED' });
  const before = f.calls.length;
  await assert.rejects(extract.execute({ bvid }, exec), { code: 'TRAFFIC_PAUSED' });
  assert.equal(f.calls.length, before);
});

test('eco collect skips comments but still stops immediately when enabled subtitles hit platform risk', async t => {
  const f = await fixture(t, url => {
    if (url.pathname.endsWith('/nav')) return Response.json({ code: 0, data: { wbi_img: { img_url: 'https://i0.hdslb.com/7cd084941338484aae1ad9425b84077c.png', sub_url: 'https://i0.hdslb.com/4932caff0ff746eab6f01bf08b70ac45.png' } } });
    if (url.pathname.endsWith('/search/type')) return Response.json({ code: 0, data: { result: [bvid, nextBvid].map(bvid => ({ bvid, title: 'fixture' })), numResults: 2 } });
    if (url.pathname.endsWith('/view')) return Response.json({ code: 0, data: metadata });
    if (url.pathname.endsWith('/wbi/v2')) return new Response('restricted', { status: 412 });
    assert.fail('disabled source was requested: ' + url.pathname);
  });
  await f.settings({ extract: { comments: false, subtitles: true, frames: false, danmaku: false } });
  const result = await collect({ keyword: 'offline test', maxVideos: 2, jar: new CookieJar({ buvid3: 'fixture' }) });
  assert.equal(result.stopped, 'RATE_LIMITED');
  assert.deepEqual(result.results[0].comments, { status: 'skipped', skippedBy: 'settings' });
  assert.deepEqual(result.incomplete, [bvid]); assert.deepEqual(result.unprocessed, [nextBvid]);
  assert.equal(f.calls.at(-1), '/x/player/wbi/v2');
  assert.ok(!f.calls.includes('/x/v2/reply'));
  const before = f.calls.length;
  await assert.rejects(request('https://api.bilibili.com/x/test'), { code: 'TRAFFIC_PAUSED' });
  assert.equal(f.calls.length, before);
});
