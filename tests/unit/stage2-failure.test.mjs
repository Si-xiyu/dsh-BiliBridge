import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { setImmediate as tick } from 'node:timers/promises';
import { test } from 'node:test';
import { mkdtemp, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAsrClient } from '../../lib/media/asr_client.mjs';
import { beginAnalysis, charge, refund, snapshot } from '../../lib/media/budget.mjs';
import { readTranscribeCache, writeTranscribeCache } from '../../lib/media/cache.mjs';
import { validateTranscribeWindow } from '../../lib/tools/transcribe.mjs';
import { maxAbsDeltaMs, medianGapSeconds } from '../../lib/media/inspect.mjs';
import { locateStoryboardOrder } from '../../lib/media/frames.mjs';

// Same in-memory process fixture as asr-client.test.mjs; never launches Python.
function fixture({ failSpawn = false } = {}) {
  const children = [];
  let spawns = 0;
  const client = createAsrClient({
    resolveRuntime: async () => ({ python: 'fake', model: 'small', modelDir: 'models' }),
    spawnProcess() {
      spawns++;
      if (failSpawn) throw new Error('fixture startup failure');
      const child = new EventEmitter();
      child.requests = [];
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new Writable({ write(chunk, _, done) {
        child.requests.push(JSON.parse(chunk.toString()));
        done();
      } });
      child.kill = () => { child.killed = true; return true; };
      children.push(child);
      return child;
    },
  });
  return { ...client, children, get spawns() { return spawns; } };
}
function reply(child) {
  child.stdout.write(JSON.stringify({ id: child.requests.at(-1).id, ok: true, payload: { segments: [] } }) + '\n');
}
const submitted = (error) => {
  assert.equal(error.data?.submitted, true);
  assert.notEqual(error.data?.daemonFallback, true);
  return true;
};

test('idle exit restarts; repeated submitted crashes never replay or reuse dead children', async () => {
  const f = fixture();
  await f.getDaemon();
  f.children[0].emit('exit', 0);
  for (let i = 1; i <= 3; i++) {
    const job = f.transcribeViaDaemon({ wavPath: `window-${i}` });
    const rejected = assert.rejects(job, submitted);
    await tick();
    assert.equal(f.children.length, i + 1);
    f.children[i].emit('exit', 1);
    await rejected;
    assert.equal(f.children[i].requests.length, 1);
  }
  const recovery = f.transcribeViaDaemon();
  await tick();
  // A late event from an old child must not discard the replacement.
  f.children[1].emit('exit', 1);
  reply(f.children[4]);
  await recovery;
  assert.equal(f.spawns, 5);
});

test('pre-submit startup failure retries once and permits one-shot fallback', async () => {
  const f = fixture({ failSpawn: true });
  await assert.rejects(f.transcribeViaDaemon(), (error) => {
    assert.equal(error.data?.daemonFallback, true);
    assert.notEqual(error.data?.submitted, true);
    return true;
  });
  assert.equal(f.spawns, 2);
});

for (const [name, response] of [
  ['non JSON', 'not JSON\n'],
  ['mismatched id', '{"id":999,"ok":true,"payload":{"segments":[]}}\n'],
  ['missing segments', '{"id":1,"ok":true,"payload":{}}\n'],
  ['oversized response', 'x'.repeat(16 * 1024 * 1024 + 1)],
]) {
  test(`submitted protocol failure: ${name}`, async () => {
    const f = fixture();
    const job = f.transcribeViaDaemon();
    const rejected = assert.rejects(job, submitted);
    await tick();
    f.children[0].stdout.write(response);
    await rejected;
    assert.equal(f.spawns, 1);
    assert.equal(f.children[0].killed, true);
  });
}

test('queued cancellation leaves in-flight request and following request intact', async () => {
  const f = fixture();
  const active = f.transcribeViaDaemon({ wavPath: 'active' });
  const controller = new AbortController();
  const queued = assert.rejects(f.transcribeViaDaemon({ wavPath: 'cancelled', signal: controller.signal }), { code: 'CANCELLED' });
  const last = f.transcribeViaDaemon({ wavPath: 'last' });
  await tick();
  controller.abort();
  await queued;
  assert.notEqual(f.children[0].killed, true);
  reply(f.children[0]);
  await active;
  await tick();
  assert.deepEqual(f.children[0].requests.map(r => r.wav), ['active', 'last']);
  reply(f.children[0]);
  await last;
});

test('budget and cache failure boundaries with frozen time', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'stage2-failure-'));
  const previous = process.env.BILI_DATA_DIR;
  const previousUser = process.env.USERNAME;
  process.env.BILI_DATA_DIR = dir;
  // ACL hardening is outside this cache test; avoid changing temp-file ACLs.
  delete process.env.USERNAME;
  let now = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => now);
  try {
    await writeFile(join(dir, 'config.json'), JSON.stringify({ budget: { ttlMs: 100, roundsLimit: 2, audioSecondsLimit: 30 } }));
    const bundleId = beginAnalysis({ bvid: 'stage2-budget', cid: 1 });
    assert.equal(beginAnalysis({ bvid: 'stage2-budget', cid: 1 }), bundleId);
    assert.throws(() => beginAnalysis({ bvid: 'unknown', cid: 1, bundleId: 'invented' }), { code: 'INVALID_ARGUMENT' });
    assert.throws(() => beginAnalysis({ bvid: 'stage2-budget', cid: 2, bundleId }), { code: 'INVALID_ARGUMENT' });
    const outcomes = await Promise.allSettled([1, 2].map(() => Promise.resolve().then(() => charge({ bundleId, audioSeconds: 20 }))));
    assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(outcomes.find(r => r.status === 'rejected').reason.code, 'BUDGET_EXCEEDED');
    const reservationId = outcomes.find(r => r.status === 'fulfilled').value;
    refund({ bundleId, reservationId, audioSeconds: 20 });
    charge({ bundleId, audioSeconds: 30 });
    refund({ bundleId, reservationId, audioSeconds: 20 });
    assert.equal(snapshot({ bundleId }).audioSecondsUsed, 30);
    assert.throws(() => charge({ bundleId }), { code: 'BUDGET_EXCEEDED' });
    const expired = beginAnalysis({ bvid: 'stage2-expiry', cid: 1 });
    const reservation = charge({ bundleId: expired, audioSeconds: 15 });
    now += 100;
    assert.throws(() => charge({ bundleId: expired }), { code: 'BUDGET_EXCEEDED' });
    refund({ bundleId: expired, reservationId: reservation, audioSeconds: 15 });
    assert.equal(snapshot({ bundleId: expired }).expired, true);
    assert.equal(snapshot({ bundleId: expired }).audioSecondsUsed, 0);

    const key = { bvid: 'stage2-cache', cid: 1, model: 'small', language: 'auto', startSeconds: 0, durationSeconds: 30 };
    const payloads = Array.from({ length: 12 }, (_, i) => ({ segments: [{ start: 0, end: 1, text: String(i) }] }));
    await Promise.all(payloads.map(payload => writeTranscribeCache(key, payload)));
    assert.deepEqual(await readTranscribeCache(key), payloads.at(-1));
    const cacheDir = join(dir, 'cache', 'asr');
    const files = await readdir(cacheDir);
    assert.equal(files.length, 1, 'no orphaned temporary files');
    const file = join(cacheDir, files[0]);
    const record = JSON.parse(await readFile(file, 'utf8'));
    const hitBundle = beginAnalysis({ bvid: key.bvid, cid: key.cid });
    charge({ bundleId: hitBundle, audioSeconds: (await readTranscribeCache(key)) === null ? 30 : 0 });
    assert.equal(snapshot({ bundleId: hitBundle }).rounds, 1);
    assert.equal(snapshot({ bundleId: hitBundle }).audioSecondsUsed, 0);
    for (const content of [
      '{broken',
      JSON.stringify({ ...record, schemaVersion: 999 }),
      JSON.stringify({ ...record, writtenAt: 'invalid' }),
      JSON.stringify({ ...record, writtenAt: now + 1 }),
      JSON.stringify({ ...record, payload: { segments: [{ start: 0, end: 1 }] } }),
      JSON.stringify({ ...record, payload: { segments: [{ start: 2, end: 1, text: 'bad' }] } }),
    ]) {
      await writeFile(file, content);
      assert.equal(await readTranscribeCache(key), null);
    }
  } finally {
    if (previous === undefined) delete process.env.BILI_DATA_DIR;
    else process.env.BILI_DATA_DIR = previous;
    if (previousUser === undefined) delete process.env.USERNAME;
    else process.env.USERNAME = previousUser;
    await rm(dir, { recursive: true, force: true });
  }
});

test('invalid windows use current page duration, including fractional page rejection', () => {
  const video = { duration: 1000, pages: [{ page: 1, cid: 1, duration: 60 }] };
  const bvid = 'BV1xx411c7mD';
  for (const args of [{ startSeconds: -1 }, { durationSeconds: 0 }, { durationSeconds: -1 },
    { startSeconds: 59, durationSeconds: 2 }, { page: 1.5 }]) {
    assert.throws(() => validateTranscribeWindow(video, { bvid, ...args }), { code: 'INVALID_ARGUMENT' });
  }
  assert.equal(validateTranscribeWindow(video, { bvid, startSeconds: 59.5, durationSeconds: 0.5 }).cid, 1);
});

test('storyboard measured maximum differs from typical median spacing', () => {
  const index = [0, 2, 4, 6, 100];
  const meta = { index, images: ['fixture'], cols: 5, rows: 1 };
  const frames = [50, 100, 1].map(seconds => ({
    deltaMs: index[locateStoryboardOrder(meta, seconds)] * 1000 - seconds * 1000,
  }));
  assert.equal(maxAbsDeltaMs(frames), 44000);
  assert.equal(medianGapSeconds(index) * 1000, 2000);
  assert.equal(maxAbsDeltaMs([{ deltaMs: -200 }, { deltaMs: 800 }, { deltaMs: null }]), 800);
  assert.equal(maxAbsDeltaMs([]), null);
});

for (const mode of ['timeout', 'abort']) {
  test(`submitted ${mode} kills worker and retains consumed-budget marker`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture();
    const controller = new AbortController();
    const job = f.transcribeViaDaemon({ timeoutMs: 100, signal: controller.signal });
    const rejected = assert.rejects(job, (error) => {
      assert.equal(error.code, mode === 'timeout' ? 'TIMEOUT' : 'CANCELLED');
      return submitted(error);
    });
    await tick();
    assert.equal(f.children[0].requests.length, 1);
    if (mode === 'timeout') t.mock.timers.tick(100);
    else controller.abort();
    await rejected;
    assert.equal(f.children[0].killed, true);
  });
}
