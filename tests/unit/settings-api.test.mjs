import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeCache, assembleStatus, readStatus, registerSettingsRoutes } from '../../lib/settings-api.mjs';
import { listAnalyses } from '../../lib/media/budget.mjs';
test('缓存分类与空统计', () => {
  assert.equal(summarizeCache().totalFiles, 0);
  const result = summarizeCache(['asr/a','storyboard/b','cover/c','avatar.img'].map(path => ({ path, bytes: 3 })));
  assert.equal(result.totalBytes, 12);
  assert.deepEqual(result.buckets.map(b => b.files), [1,1,1,1]);
});
test('status 读取器与纯组装', async () => {
  const result = await readStatus({ account: () => ({ loggedIn: false }), toolchain: () => ({ ffmpeg: 'fake' }),
    asr: () => { throw new Error(); }, budget: () => [], cache: () => summarizeCache(), ocr: () => ({ available: false }), now: () => 'now' });
  assert.equal(result.runtime.asr.code, 'INTERNAL_ERROR');
  assert.equal(result.generatedAt, 'now');
  assert.deepEqual(assembleStatus(result), result);
});
test('账本解析与过期过滤', () => {
  const base = { bundleId: 'x', key: '["BV1","2"]', expiresAt: 10, rounds: 1, roundsLimit: 6, audioSecondsUsed: 2, audioSecondsLimit: 5 };
  const result = listAnalyses([base, { ...base, key: 'bad' }, { ...base, expiresAt: 1 }], 2);
  assert.equal(result.length, 1);
  assert.equal(result[0].cid, '2');
  assert.equal(result[0].remainingSeconds, 3);
});
test('懒注册 exact 路由与错误编排', async () => {
  const routes = [];
  registerSettingsRoutes({ inject(names, callback) {
    assert.deepEqual(names, ['webServer', 'loader']);
    callback({ webServer: { register(route) { routes.push(route); return () => {}; } } });
  } }, { account: () => { throw new Error('secret'); } });
  assert.deepEqual(routes.map(r => [r.kind, r.path]), [
    ['exact','/bilibili-bridge/api/status'], ['exact','/bilibili-bridge/api/avatar']]);
  let code, body;
  const res = { writeHead(c) { code=c; }, end(b) { body=JSON.parse(b); } };
  await routes[0].handler({ method: 'GET' }, res);
  assert.equal(code, 500); assert.deepEqual(body, { ok: false, error: 'INTERNAL_ERROR' });
  await routes[1].handler({ method: 'POST' }, res);
  assert.equal(code, 405);
});
