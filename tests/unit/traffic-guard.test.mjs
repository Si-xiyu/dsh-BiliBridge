import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createTrafficGuard, trafficIdentity, trafficKind } from '../../lib/bili/traffic-guard.mjs';

const jar = (id = '123', session = 'fixture') => ({ get: key => ({ DedeUserID: id, SESSDATA: session })[key] });
const options = { url: 'https://api.bilibili.com/x/test', jar: jar() };
const result = (code = 0, status = 200, headers = {}, data = {}) => ({ response: new Response('', { status, headers }), payload: { code, data } });
async function fixture(t, policy = {}) {
  const root = await mkdtemp(join(tmpdir(), 'bili-traffic-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let clock = 1000000;
  const opts = { root, now: () => clock, sleep: async ms => { clock += ms; }, policy };
  return { root, opts, guard: createTrafficGuard(opts), advance: ms => { clock += ms; }, time: () => clock };
}

test('durable API gaps and quotas survive a new guard; accounts retain separate counters', async t => {
  const f = await fixture(t, { readHourly: 2 });
  const starts = [];
  const send = async () => { starts.push(f.time()); return result(); };
  await f.guard.run(options, send);
  await createTrafficGuard(f.opts).run(options, send);
  assert.equal(starts[1] - starts[0], 1500);
  await assert.rejects(f.guard.run(options, send), e => e.code === 'TRAFFIC_BUDGET_EXCEEDED' && e.submission === 'not-submitted' && e.data.resumeAt > f.time());
  await f.guard.run({ ...options, jar: jar('124') }, send);
  assert.equal(starts.length, 3);
  f.advance(3600000);
  await f.guard.run(options, send);
});

test('risk blocks queued reads and writes, observes Retry-After and escalates to 30 minutes', async t => {
  const f = await fixture(t);
  let release;
  const gate = new Promise(r => { release = r; });
  let entered;
  const started = new Promise(r => { entered = r; });
  const first = f.guard.run(options, async () => { entered(); await gate; return result(-352); });
  await started;
  let calls = 0;
  const queued = f.guard.run(options, async () => { calls++; return result(); });
  release(); await first;
  await assert.rejects(queued, { code: 'TRAFFIC_PAUSED' });
  await assert.rejects(f.guard.run({ ...options, method: 'POST' }, async () => { calls++; return result(); }), { code: 'TRAFFIC_PAUSED' });
  assert.equal(calls, 0);
  assert.equal((await f.guard.status(jar())).resumeAt - f.time(), 300000);
  f.advance(300000);
  await f.guard.run(options, async () => result(0, 429, { 'retry-after': '900' }));
  assert.equal((await f.guard.status(jar())).resumeAt - f.time(), 900000);
  f.advance(900000);
  const date = new Date(f.time() + 2000000).toUTCString();
  await f.guard.run(options, async () => result(-412, 200, { 'retry-after': date }));
  assert.equal((await f.guard.status(jar())).resumeAt, Date.parse(date));
  f.advance(2000000);
  await f.guard.run(options, async () => result(-509));
  assert.equal((await f.guard.status(jar())).resumeAt - f.time(), 1800000);
});

test('message quota remains local for 24h; manual resume never removes budgets or pauses', async t => {
  const f = await fixture(t);
  await f.guard.run({ ...options, method: 'POST', kind: 'message' }, async () => result(21046));
  f.advance(3000);
  await f.guard.run(options, async () => result());
  await f.guard.run({ ...options, method: 'POST', kind: 'write' }, async () => result());
  await assert.rejects(f.guard.run({ ...options, method: 'POST', kind: 'message' }, async () => result()), { code: 'TRAFFIC_PAUSED' });
  await f.guard.resume(jar());
  assert.ok((await f.guard.status(jar())).localResumeAt.message > f.time() + 86000000);
});

test('captcha and expired login need explicit recovery; fresh nav cannot reset platform pause', async t => {
  const f = await fixture(t);
  await f.guard.run(options, async () => result(12015));
  await assert.rejects(f.guard.run(options, async () => result()), { code: 'TRAFFIC_MANUAL_REQUIRED' });
  await f.guard.resume(jar());
  await f.guard.run(options, async () => result(-101));
  await assert.rejects(f.guard.resume(jar()), { code: 'TRAFFIC_MANUAL_REQUIRED' });
  const nav = { ...options, url: 'https://api.bilibili.com/x/web-interface/nav' };
  await f.guard.run(nav, async () => result(0, 200, {}, { isLogin: true, mid: 123 }));
  assert.equal((await f.guard.status(jar())).manual, 'auth');
  await f.guard.run({ ...nav, jar: jar('123', 'new-session') }, async () => result(0, 200, {}, { isLogin: true, mid: 123 }));
  assert.equal((await f.guard.status(jar())).manual, null);
  await f.guard.run(options, async () => result(-352));
  const before = await f.guard.status(jar());
  await f.guard.resume(jar());
  const after = await f.guard.status(jar());
  assert.equal(before.resumeAt, after.resumeAt);
  assert.deepEqual(before.remaining, after.remaining);
  await f.guard.run({ url: 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate' }, async () => result());
  await f.guard.run(nav, async () => result(0, 200, {}, { isLogin: true, mid: 123 }));
  await assert.rejects(f.guard.run(options, async () => result()), { code: 'TRAFFIC_PAUSED' });
});

test('legacy pauses and malformed state fail closed; rollback does not refresh quota', async t => {
  const f = await fixture(t, { readHourly: 1 });
  await writeFile(join(f.root, 'write-rate-123.json'), JSON.stringify({ nextAt: f.time() + 60000 }));
  await assert.rejects(f.guard.run({ ...options, method: 'POST' }, async () => result()), { code: 'WRITE_PAUSED' });
  await writeFile(join(f.root, 'write-rate-123.json'), '{bad');
  await assert.rejects(f.guard.run({ ...options, method: 'POST' }, async () => result()), { code: 'TRAFFIC_STATE_CORRUPT' });
  await f.guard.run(options, async () => result()); f.advance(-3600000);
  await assert.rejects(f.guard.run(options, async () => result()), { code: 'TRAFFIC_BUDGET_EXCEEDED' });
  for (const bad of ['null', '[]', '{}', '{"version":1,"clock":0,"nextAt":"bad","global":{},"accounts":{}}']) {
    await writeFile(join(f.root, 'traffic-state.json'), bad);
    await assert.rejects(f.guard.run(options, async () => { throw Error('must not send'); }), { code: 'TRAFFIC_STATE_CORRUPT' });
  }
});

test('cancelled queued work consumes no quota; failed writes consume quota and preserve uncertainty', async t => {
  const f = await fixture(t);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.guard.run({ ...options, signal: controller.signal }, async () => result()));
  assert.equal((await f.guard.status(jar())).remaining.readDaily, 3000);
  const failure = new Error('network failure');
  await assert.rejects(f.guard.run({ ...options, method: 'POST' }, async () => { throw failure; }), e => e === failure && e.submission !== 'not-submitted');
  assert.equal((await f.guard.status(jar())).remaining.writeDaily, 29);
  await assert.rejects(f.guard.run({ ...options, method: 'POST' }, async () => result()), e => e.code === 'WRITE_PAUSED' && e.submission === 'not-submitted');
});

test('media has no API quota, honors pause; secrets never appear in state', async t => {
  const f = await fixture(t, { readHourly: 1 });
  const fallback = { get: key => key === 'SESSDATA' ? 'super-secret' : undefined };
  assert.match(trafficIdentity(fallback), /^session-[a-f0-9]{64}$/);
  await f.guard.run(options, async () => result());
  await f.guard.run({ ...options, jar: fallback, media: true }, async () => result());
  await f.guard.run({ ...options, media: true }, async () => result(-352));
  await assert.rejects(f.guard.check(options), { code: 'TRAFFIC_PAUSED' });
  assert.ok(!(await readFile(join(f.root, 'traffic-state.json'), 'utf8')).includes('super-secret'));
});

test('publish and private messages share the stricter cooldown; uploads use low-impact gap', async t => {
  const f = await fixture(t);
  await f.guard.run({ ...options, method: 'POST', kind: 'publish' }, async () => result());
  f.advance(60000);
  await assert.rejects(f.guard.run({ ...options, method: 'POST', kind: 'message' }, async () => result()), { code: 'WRITE_PAUSED' });
  await f.guard.run({ ...options, method: 'POST', kind: 'write' }, async () => result());
  f.advance(60000);
  await f.guard.run({ ...options, method: 'POST', kind: 'message' }, async () => result());
  assert.equal(trafficKind('https://api.bilibili.com/x/dynamic/feed/create/dyn', 'POST'), 'publish');
  assert.equal(trafficKind('https://api.vc.bilibili.com/dynamic_draft/v1/dynamic_draft/publish_now', 'POST'), 'publish');
  assert.equal(trafficKind('https://api.bilibili.com/x/dynamic/feed/draw/upload_bfs', 'POST'), 'write');
});

test('independent processes serialize actual dispatch and cannot overspend the last quota', async t => {
  const f = await fixture(t);
  const worker = fileURLToPath(new URL('../helpers/traffic-worker.mjs', import.meta.url));
  const children = await Promise.all(Array.from({ length: 3 }, () => promisify(execFile)(process.execPath, [worker, f.root], { windowsHide: true })));
  const messages = children.flatMap(c => c.stdout.trim().split('\n').map(JSON.parse));
  const dispatched = messages.filter(m => m.dispatchedAt).sort((a, b) => a.dispatchedAt - b.dispatchedAt);
  assert.equal(dispatched.length, 2);
  assert.ok(dispatched[1].dispatchedAt - dispatched[0].dispatchedAt >= 80);
  assert.equal(messages.find(m => m.code)?.code, 'TRAFFIC_BUDGET_EXCEEDED');
});

test('cancellation while waiting for another process lock is prompt and does not dispatch', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'traffic-state.json.lock'), 'held');
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 60);
  const started = Date.now();
  await assert.rejects(f.guard.run({ ...options, signal: controller.signal }, async () => { throw Error('must not run'); }), e => e.submission === 'not-submitted');
  assert.ok(Date.now() - started < 1000);
});

test('process exit after durable admission leaves an interruption barrier until explicit acknowledgement', async t => {
  const f = await fixture(t);
  const worker = fileURLToPath(new URL('../helpers/traffic-worker.mjs', import.meta.url));
  await assert.rejects(promisify(execFile)(process.execPath, [worker, f.root, 'crash'], { windowsHide: true }), e => e.code === 23);
  const old = new Date(Date.now() - 181000);
  await utimes(join(f.root, 'traffic-state.json.lock'), old, old);
  await assert.rejects(f.guard.run(options, async () => { throw Error('must not run'); }), e => e.code === 'TRAFFIC_MANUAL_REQUIRED' && e.data.reason === 'interrupted-request');
  const before = await f.guard.status();
  assert.ok(before.interrupted);
  await f.guard.resume();
  const after = await f.guard.status();
  assert.equal(after.interrupted, null);
  assert.deepEqual(before.remaining, after.remaining);
});

test('spent normal read quota does not strand login recovery; recovery itself remains bounded', async t => {
  const f = await fixture(t, { readHourly: 1 });
  await f.guard.run(options, async () => result());
  await assert.rejects(f.guard.run(options, async () => result()), { code: 'TRAFFIC_BUDGET_EXCEEDED' });
  const nav = { ...options, url: 'https://api.bilibili.com/x/web-interface/nav' };
  await f.guard.run(nav, async () => result(0, 200, {}, { isLogin: true, mid: 123 }));
  await assert.rejects(f.guard.run(nav, async () => result()), e => e.code === 'TRAFFIC_BUDGET_EXCEEDED' && e.data.scope === 'login-recovery');
});

test('daily quota resets at Shanghai midnight without resetting the current hourly allowance', async t => {
  const f = await fixture(t, { readDaily: 1, readHourly: 10 });
  f.advance(57540000 - f.time()); // 1970-01-01 23:59 Asia/Shanghai.
  await f.guard.run(options, async () => result());
  await assert.rejects(f.guard.run(options, async () => result()), { code: 'TRAFFIC_BUDGET_EXCEEDED' });
  f.advance(60000);
  await f.guard.run(options, async () => result());
  const status = await f.guard.status(jar());
  assert.equal(status.remaining.readDaily, 0);
  assert.equal(status.remaining.readHourly, 8);
});
