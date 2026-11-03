import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sendOnce, checkSend } from '../../lib/bili/send-ledger.mjs';
import { limitedWrite } from '../../lib/bili/write-rate.mjs';
import { CookieJar } from '../../lib/bili/http.mjs';

test('durable reservation blocks concurrent sends and survives new invocations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bili-ledger-'));
  try {
    let calls = 0;
    const args = { root, account: '123', kind: 'comment', target: { aid: '1' }, text: '正文', submit: async () => { calls++; return { id: '1' }; } };
    const results = await Promise.all([sendOnce(args), sendOnce(args)]);
    assert.equal(calls, 1);
    assert.deepEqual(results.map(r => r.status).sort(), ['DUPLICATE', 'SENT']);
    assert.equal((await sendOnce(args)).status, 'DUPLICATE');
    assert.equal((await sendOnce({ ...args, account: '124' })).status, 'SENT');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unknown send remains protected past five minutes; only positive readback settles', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bili-pending-'));
  try {
    let clock = Date.now() - 600000;
    const args = { root, account: '123', kind: 'message', target: '5', text: 'hello', now: () => clock, submit: async () => { throw new Error('timeout'); } };
    const first = await sendOnce(args);
    assert.equal(first.status, 'PENDING_CONFIRM');
    clock += 600000;
    assert.equal((await sendOnce(args)).status, 'DUPLICATE');
    const check = { root, account: '123', kind: 'message', operationId: first.operationId };
    assert.equal((await checkSend({ ...check, find: async () => null })).status, 'PENDING_CONFIRM');
    assert.equal((await checkSend({ ...check, find: async () => ({ id: '9' }) })).status, 'SENT');
    await assert.rejects(checkSend({ ...check, account: '999', find: async () => null }), { code: 'NOT_FOUND' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('account-wide rate pause persists and blocks other mutation types', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bili-rate-'));
  const jar = new CookieJar({ DedeUserID: '123' });
  const opts = { root, now: () => 1000 };
  try {
    await assert.rejects(limitedWrite(jar, async () => { throw Object.assign(new Error('risk'), { status: 429 }); }, opts));
    let called = false;
    await assert.rejects(limitedWrite(jar, async () => { called = true; }, opts), { code: 'WRITE_PAUSED' });
    assert.equal(called, false);
    assert.equal(await limitedWrite(new CookieJar({ DedeUserID: '124' }), async () => 'ok', opts), 'ok');
  } finally { await rm(root, { recursive: true, force: true }); }
});
