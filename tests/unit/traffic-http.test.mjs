import '../helpers/http-isolation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { createTrafficGuard, trafficGuard } from '../../lib/bili/traffic-guard.mjs';
import { CookieJar, request, fetchBuffer, postForm } from '../../lib/bili/http.mjs';
import { sendOnce, checkSend } from '../../lib/bili/send-ledger.mjs';
import { dynamicPublish } from '../../lib/bili/publish.mjs';
import { saveLoginFromPoll } from '../../lib/bili/auth.mjs';
import { asToolError } from '../../lib/tools/helpers.mjs';
import { collect } from '../../lib/bili/collect.mjs';
import { runFfmpeg } from '../../lib/media/ffmpeg.mjs';

const jar = () => new CookieJar({ DedeUserID: '123', SESSDATA: 'fixture', bili_jct: 'fixture', buvid3: 'fixture' });
const url = 'https://api.bilibili.com/x/test';
async function fixture(t, handler, policy = {}) {
  const root = await mkdtemp(join(tmpdir(), 'bili-http-'));
  const original = process.env.BILI_DATA_DIR;
  process.env.BILI_DATA_DIR = root;
  let clock = 1000000;
  const guard = createTrafficGuard({ root, now: () => clock, sleep: async ms => { clock += ms; }, policy });
  for (const key of ['run', 'check', 'status', 'resume']) t.mock.method(trafficGuard, key, guard[key]);
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    calls.push({ url: new URL(input), options });
    return handler(new URL(input), options, calls.length);
  });
  t.after(async () => {
    if (original === undefined) delete process.env.BILI_DATA_DIR; else process.env.BILI_DATA_DIR = original;
    await rm(root, { recursive: true, force: true });
  });
  return { guard, calls, root, advance: ms => { clock += ms; }, time: () => clock };
}

test('real HTTP guard blocks all later tools and media after a business risk response', async t => {
  const f = await fixture(t, () => Response.json({ code: -352, message: '平台要求验证' }));
  await assert.rejects(request(url, { jar: jar() }), e => {
    assert.equal(e.code, 'RISK_CONTROLLED'); assert.equal(e.biliMessage, '平台要求验证');
    assert.equal(e.retryable, false); assert.equal(e.data.resumeAt, f.time() + 300000);
    assert.throws(() => asToolError(e), wrapped => wrapped.data.scope === 'global' && /恢复时间/.test(wrapped.message));
    return true;
  });
  await assert.rejects(request(url, { jar: jar(), method: 'POST' }), { code: 'TRAFFIC_PAUSED', submission: 'not-submitted' });
  await assert.rejects(request('https://api.bilibili.com/x/web-interface/nav', { jar: jar() }), { code: 'TRAFFIC_PAUSED' });
  await assert.rejects(fetchBuffer('https://i0.hdslb.com/image.png'), { code: 'TRAFFIC_PAUSED' });
  await assert.rejects(runFfmpeg(['-i', 'https://cdn.bilivideo.com/test.mp4']), { code: 'TRAFFIC_PAUSED' });
  assert.equal(f.calls.length, 1);
});

test('HTTP 429 HTML records Retry-After before mapping the error', async t => {
  const f = await fixture(t, () => new Response('<html>restricted</html>', { status: 429, headers: { 'retry-after': '3600' } }));
  await assert.rejects(request(url), e => e.code === 'RATE_LIMITED' && e.data.resumeAt === f.time() + 3600000);
  await assert.rejects(request(url), { code: 'TRAFFIC_PAUSED' });
  assert.equal(f.calls.length, 1);
});

test('local message limits preserve other reads, and failed HTTP attempts consume write quota', async t => {
  const f = await fixture(t, u => Response.json({ code: u.pathname.endsWith('/send_msg') ? 21046 : 0, data: {} }));
  const dm = 'https://api.vc.bilibili.com/web_im/v1/web_im/send_msg';
  await assert.rejects(postForm(dm, { jar: jar(), fields: { text: 'test' } }), e => e.code === 'RATE_LIMITED' && e.data.scope === 'message' && e.data.resumeAt === f.time() + 86400000);
  await request(url, { jar: jar() });
  await assert.rejects(postForm(dm, { jar: jar() }), { code: 'TRAFFIC_PAUSED' });
  assert.equal((await f.guard.status(jar())).remaining.writeDaily, 29);
  assert.equal(f.calls.length, 2);
});

test('budget admission failure is FAILED rather than pending; timeout remains pending across blocked checks', async t => {
  const f = await fixture(t, () => { throw new DOMException('timeout', 'TimeoutError'); }, { writeHourly: 1 });
  const send = text => sendOnce({ root: f.root, account: '123', kind: 'comment', target: '1', text,
    submit: () => request(url, { jar: jar(), method: 'post' }) });
  const uncertain = await send('first');
  assert.equal(uncertain.status, 'PENDING_CONFIRM');
  f.advance(6000);
  const rejected = await send('second');
  assert.equal(rejected.status, 'FAILED'); assert.equal(rejected.error, 'TRAFFIC_BUDGET_EXCEEDED');
  assert.ok(rejected.resumeAt > f.time()); assert.equal(rejected.scope, 'account-write');
  assert.equal(f.calls.length, 1);
  // Reading during a platform pause must leave an unknown send unsettled.
  t.mock.method(globalThis, 'fetch', async () => Response.json({ code: -352 }));
  await assert.rejects(request(url, { jar: jar() }), { code: 'RISK_CONTROLLED' });
  const check = { root: f.root, account: '123', kind: 'comment', operationId: uncertain.operationId, find: () => request(url, { jar: jar() }) };
  await assert.rejects(checkSend(check), { code: 'TRAFFIC_PAUSED' });
  const ledger = (await readFile(join(f.root, 'sends-123.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(ledger.filter(r => r.operationId === uncertain.operationId).at(-1).status, 'PENDING_CONFIRM');
});

test('image upload and final dynamic publication both pass the real guard and consume separate quotas', async t => {
  const f = await fixture(t, u => Response.json({ code: 0, data: u.pathname.endsWith('/nav') ? { isLogin: true, mid: 123 } : u.pathname.endsWith('upload_bfs')
    ? { image_url: 'https://i0.hdslb.com/image.png', image_width: 4, image_height: 4, img_size: 1 }
    : { dyn_id_str: '12345' } }));
  const image = join(f.root, 'image.png');
  await writeFile(image, await sharp({ create: { width: 4, height: 4, channels: 3, background: 'red' } }).png().toBuffer());
  const args = { jar: jar(), text: 'offline test', images: [image] };
  const preview = await dynamicPublish(args);
  const result = await dynamicPublish({ ...args, intent: 'apply', previewToken: preview.previewToken });
  assert.equal(result.status, 'SENT'); assert.equal(f.calls.filter(c => c.options.method === 'POST').length, 2);
  assert.equal((await f.guard.status(jar())).remaining.writeDaily, 28);
  await assert.rejects(request('https://api.bilibili.com/x/v2/reply/add', { jar: jar(), method: 'POST' }), { code: 'WRITE_PAUSED' });
  assert.equal(f.calls.filter(c => c.options.method === 'POST').length, 2);
});

test('collect retains partial work and does not fetch subtitles or another video after risk', async t => {
  const ids = ['BV1GJ411x7h7', 'BV1VZWc6dECG'];
  const f = await fixture(t, u => {
    if (u.pathname.endsWith('/nav')) return Response.json({ code: 0, data: { wbi_img: { img_url: 'https://i0.hdslb.com/7cd084941338484aae1ad9425b84077c.png', sub_url: 'https://i0.hdslb.com/4932caff0ff746eab6f01bf08b70ac45.png' } } });
    if (u.pathname.endsWith('/search/type')) return Response.json({ code: 0, data: { result: ids.map(bvid => ({ bvid, title: 'video' })), numResults: 2 } });
    if (u.pathname.endsWith('/view')) return Response.json({ code: 0, data: { bvid: ids[0], aid: 1, pages: [] } });
    if (u.pathname === '/x/v2/reply') return Response.json({ code: -352 });
    throw Error('must not continue ' + u.pathname);
  });
  const result = await collect({ keyword: 'test', maxVideos: 2, jar: jar() });
  assert.equal(result.stopped, 'RISK_CONTROLLED'); assert.ok(result.stopDetails.resumeAt > f.time());
  assert.deepEqual(result.incomplete, [ids[0]]); assert.deepEqual(result.unprocessed, [ids[1]]);
  assert.equal(f.calls.at(-1).url.pathname, '/x/v2/reply');
});

test('fresh QR credentials must pass nav before save, and only expired-login blocking is cleared', async t => {
  const f = await fixture(t, u => Response.json({ code: u.pathname.endsWith('/nav') ? 0 : -101, data: { isLogin: true, mid: 123, uname: 'fixture' } }));
  await assert.rejects(request(url, { jar: jar() }), { code: 'AUTH_REQUIRED' });
  const loginJar = jar();
  await saveLoginFromPoll({ url: 'https://www.bilibili.com/?SESSDATA=new-session&DedeUserID=123&bili_jct=fixture' }, loginJar);
  assert.equal((await f.guard.status(loginJar)).manual, null);
  assert.equal(JSON.parse(await readFile(join(f.root, 'credentials.json'), 'utf8')).cookies.SESSDATA, 'new-session');
  t.mock.method(globalThis, 'fetch', async () => Response.json({ code: 0, data: { isLogin: false } }));
  await assert.rejects(saveLoginFromPoll({ url: 'https://www.bilibili.com/?SESSDATA=bad-session&DedeUserID=123' }, loginJar), { code: 'AUTH_REQUIRED' });
  assert.equal(JSON.parse(await readFile(join(f.root, 'credentials.json'), 'utf8')).cookies.SESSDATA, 'new-session');
});

test('CLI status is offline and resume cannot reset quota or platform pause', async t => {
  const f = await fixture(t, () => Response.json({ code: -352 }));
  await assert.rejects(request(url), { code: 'RISK_CONTROLLED' });
  const cli = fileURLToPath(new URL('../../bin/bili.mjs', import.meta.url));
  const exec = promisify(execFile);
  const run = args => exec(process.execPath, [cli, 'traffic', ...args], { windowsHide: true, env: { ...process.env, BILI_DATA_DIR: f.root } });
  const before = JSON.parse((await run(['status'])).stdout);
  await run(['resume', '--go']);
  const after = JSON.parse((await run(['status'])).stdout);
  assert.equal(before.resumeAt, after.resumeAt);
  assert.deepEqual(before.remaining, after.remaining);
  assert.equal(f.calls.length, 1);
});

test('unexpected successful HTML pauses further API requests without pretending the response was usable', async t => {
  const f = await fixture(t, () => new Response('<html>请验证</html>', { headers: { 'content-type': 'text/html' } }));
  await assert.rejects(request(url), e => e.code === 'INVALID_RESPONSE' && e.data.resumeAt > f.time());
  await assert.rejects(request(url), { code: 'TRAFFIC_PAUSED' });
  assert.equal(f.calls.length, 1);
});
