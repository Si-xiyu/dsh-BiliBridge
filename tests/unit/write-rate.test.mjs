import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { limitedWrite } from '../../lib/bili/write-rate.mjs';

function jar(id = '215407733') {
  return { get: (name) => (name === 'DedeUserID' ? id : undefined) };
}

test('抢锁超时：请求根本没发出去，必须标 not-submitted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rate-'));
  const account = '215407733';
  // 预先占用锁，且 mtime 是新的（不是 stale），limitedWrite 会在 1s 后超时
  await writeFile(join(root, `write-rate-${account}.json.lock`), '', { mode: 0o600 });
  const before = Date.now();
  await assert.rejects(
    limitedWrite(jar(account), async () => { throw new Error('绝不该执行'); }, { root }),
    (error) => {
      assert.equal(error.code, 'WRITE_BUSY');
      assert.equal(error.submission, 'not-submitted');
      return true;
    },
  );
  assert.ok(Date.now() - before >= 900, '应当等满锁超时');
});

test('已进入发送的失败不能被标成 not-submitted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rate-'));
  const failure = Object.assign(new Error('network'), { code: 'NETWORK_ERROR' });
  await assert.rejects(
    limitedWrite(jar(), async () => { throw failure; }, { root }),
    (error) => {
      assert.equal(error, failure, '原错误要原样抛出');
      assert.notEqual(error.submission, 'not-submitted', '已提交的失败不能当成未提交');
      return true;
    },
  );
});

test('未登录直接拒绝，不进入发送', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rate-'));
  let ran = false;
  await assert.rejects(
    limitedWrite({ get: () => undefined }, async () => { ran = true; }, { root }),
    (error) => error.code === 'AUTH_REQUIRED',
  );
  assert.equal(ran, false);
});
test('状态文件损坏：拒绝发送，且标成未提交', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rate-'));
  await writeFile(join(root, 'write-rate-215407733.json'), '{ broken', { mode: 0o600 });
  let ran = false;
  await assert.rejects(
    limitedWrite(jar(), async () => { ran = true; }, { root }),
    (error) => {
      assert.equal(error.code, 'WRITE_STATE_CORRUPT');
      assert.equal(error.submission, 'not-submitted');
      return true;
    },
  );
  assert.equal(ran, false, '状态损坏时绝不能真的发请求');
});