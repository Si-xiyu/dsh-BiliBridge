import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { setImmediate as tick } from 'node:timers/promises';
import { test } from 'node:test';
import { createAsrClient } from '../../lib/media/asr_client.mjs';
import { BiliError } from '../../lib/bili/errors.mjs';

function fixture(onWrite, resolveRuntime = async () => ({ python: 'fake', model: 'small', modelDir: 'models' })) {
  const children = [];
  const client = createAsrClient({
    resolveRuntime,
    spawnProcess() {
      const child = new EventEmitter();
      child.requests = [];
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new Writable({ write(chunk, _, done) {
        const request = JSON.parse(chunk.toString());
        child.requests.push(request);
        onWrite?.(child, request);
        done();
      } });
      child.kill = () => { child.killed = true; return true; };
      children.push(child);
      return child;
    },
  });
  return { ...client, children };
}
const reply = (child, payload = { segments: [] }) => child.stdout.write(`${JSON.stringify({
  id: child.requests.at(-1).id, ok: true, payload,
})}\n`);
const code = (expected) => (error) => error instanceof BiliError && error.code === expected;

test('lazy startup, shared startup, serial queue and increasing request ids', async () => {
  const f = fixture();
  assert.equal(f.children.length, 0);
  const [first, second] = await Promise.all([f.getDaemon(), f.getDaemon()]);
  assert.equal(first, second);
  const a = f.transcribeViaDaemon({ wavPath: 'a' });
  const b = f.transcribeViaDaemon({ wavPath: 'b', model: 'tiny' });
  await tick();
  const child = f.children[0];
  assert.equal(child.requests.length, 1);
  reply(child, { segments: [], language: 'zh' });
  assert.equal((await a).language, 'zh');
  await tick();
  assert.deepEqual(child.requests.map(r => [r.id, r.wav, r.model]), [[1, 'a', 'small'], [2, 'b', 'tiny']]);
  reply(child);
  await b;
});

test('timeout kills state without retry; next request starts fresh', async () => {
  const f = fixture();
  await assert.rejects(f.transcribeViaDaemon({ timeoutMs: 10 }), code('TIMEOUT'));
  assert.equal(f.children.length, 1);
  assert.equal(f.children[0].killed, true);
  const next = f.transcribeViaDaemon();
  await tick();
  // Late exit from the old process must not clear its replacement.
  f.children[0].emit('exit', 1);
  reply(f.children[1]);
  await next;
  assert.equal(f.children.length, 2);
});

test('active abort kills worker; queued abort does not interrupt another request', async () => {
  const f = fixture();
  const active = new AbortController();
  const queued = new AbortController();
  const a = f.transcribeViaDaemon({ signal: active.signal });
  const rejectedA = assert.rejects(a, code('CANCELLED'));
  const b = f.transcribeViaDaemon({ signal: queued.signal });
  const rejectedB = assert.rejects(b, code('CANCELLED'));
  await tick();
  queued.abort();
  await rejectedB;
  assert.equal(f.children[0].killed, undefined);
  active.abort();
  await rejectedA;
  await tick();
  assert.equal(f.children[0].killed, true);
  assert.equal(f.children[0].requests.length, 1);
});

test('pre-aborted signal never starts a worker', async () => {
  const f = fixture();
  await assert.rejects(f.transcribeViaDaemon({ signal: AbortSignal.abort() }), code('CANCELLED'));
  assert.equal(f.children.length, 0);
});

test('崩溃发生在请求已提交之后：不重放、不回退，下一次调用重新拉起 worker', async () => {
  const f = fixture();
  const job = f.transcribeViaDaemon();
  await tick();
  f.children[0].emit('exit', 1);
  // 请求已经写进 daemon，重试会让同一段音频被算两次；只能如实报错。
  await assert.rejects(job, (error) => code('UPSTREAM_ERROR')(error) && !error.data?.daemonFallback);
  // submitted 标记告诉上层“这段音频可能真的被算过”，不能退款。
  await assert.rejects(f.transcribeViaDaemon({ signal: AbortSignal.abort() }), code('CANCELLED'));
  assert.equal(f.children.length, 1);

  // 下一次调用应重新启动 daemon，而不是复用已死的进程。
  const next = f.transcribeViaDaemon();
  await tick();
  assert.equal(f.children.length, 2);
  reply(f.children[1]);
  await next;
});

test('协议异常发生在请求已提交之后：只报错，不重试也不回退', async () => {
  for (const response of ['not json\n', '{"id":999,"ok":true,"payload":{"segments":[]}}\n',
    '{"id":1,"ok":true,"payload":{}}\n']) {
    const f = fixture(child => queueMicrotask(() => child.stdout.write(response)));
    await assert.rejects(f.transcribeViaDaemon(), (error) => code('UPSTREAM_ERROR')(error) && !error.data?.daemonFallback);
    assert.equal(f.children.length, 1);
    assert.ok(f.children.every(child => child.killed));
  }
});

test('spawn errors retry once and expose BiliError with fallback marker', async () => {
  let attempts = 0;
  const f = createAsrClient({ resolveRuntime: async () => ({}), spawnProcess() {
    attempts++;
    throw new Error('missing executable');
  } });
  await assert.rejects(f.transcribeViaDaemon(), error => code('UPSTREAM_ERROR')(error) && error.data.daemonFallback);
  assert.equal(attempts, 2);
});

test('daemon error code mapping preserves known codes; unknown maps to upstream', async () => {
  for (const errorCode of ['INVALID_ARGUMENT', 'DEPENDENCY_MISSING', 'UPSTREAM_ERROR', 'TIMEOUT', 'CANCELLED', 'INTERNAL']) {
    const f = fixture((child, request) => queueMicrotask(() => child.stdout.write(`${JSON.stringify({
      id: request.id, ok: false, code: errorCode, message: 'failure',
    })}\n`)));
    await assert.rejects(f.transcribeViaDaemon(), error => {
      assert.equal(error.code, errorCode === 'INTERNAL' ? 'UPSTREAM_ERROR' : errorCode);
      assert.equal(error.data, undefined);
      return error instanceof BiliError;
    });
    assert.equal(f.children.length, 1);
  }
});

test('UTF-8 response split across chunks is decoded and correlated', async () => {
  const f = fixture();
  const job = f.transcribeViaDaemon();
  await tick();
  const bytes = Buffer.from(JSON.stringify({ id: 1, ok: true, payload: { segments: [], text: '中文' } }) + '\n');
  for (const byte of bytes) f.children[0].stdout.write(Buffer.from([byte]));
  assert.equal((await job).text, '中文');
});

test('abort during runtime resolution cannot later write or kill the next request', async () => {
  let resolveRuntime;
  const runtime = new Promise(resolve => { resolveRuntime = resolve; });
  const f = fixture(undefined, () => runtime);
  const controller = new AbortController();
  const a = f.transcribeViaDaemon({ signal: controller.signal });
  const rejected = assert.rejects(a, code('CANCELLED'));
  await tick();
  controller.abort();
  await rejected;
  const b = f.transcribeViaDaemon();
  resolveRuntime({ python: 'fake', model: 'small', modelDir: 'models' });
  await tick();
  assert.equal(f.children[0].requests.length, 1);
  assert.equal(f.children[0].killed, undefined);
  reply(f.children[0]);
  await b;
  assert.equal(f.children[0].killed, undefined);
});
