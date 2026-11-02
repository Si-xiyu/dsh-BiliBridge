import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeCache, assembleStatus, readStatus, registerSettingsRoutes } from '../../lib/settings-api.mjs';
import { listAnalyses } from '../../lib/media/budget.mjs';

test('缓存按真实文件名归类（asr / storyboard / cover / inspect / avatar / 其它）', () => {
  assert.equal(summarizeCache().totalFiles, 0);
  const files = [
    { path: 'asr/abc.json', bytes: 3 },
    { path: 'BV1/storyboard-v2-123.jpg', bytes: 3 },
    { path: 'BV1/sprite-123-0.jpg', bytes: 3 },
    { path: 'BV1/cover.img', bytes: 3 },
    { path: 'BV1/inspect-123-1.jpg', bytes: 3 },
    { path: 'avatar-1.img', bytes: 3 },
    { path: 'BV1/whatever.bin', bytes: 3 },
  ];
  const result = summarizeCache(files);
  assert.equal(result.totalBytes, 21);
  assert.deepEqual(result.buckets.map((b) => [b.name, b.files]), [
    ['asr', 1], ['storyboard', 2], ['cover', 1], ['inspect', 1], ['avatar', 1], ['其它', 1],
  ]);
});

test('status 读取器与纯组装：运行时失败给错误码，账号失败仍可渲染', async () => {
  const result = await readStatus({
    account: () => { throw new Error('no login'); },
    toolchain: () => ({ ffmpeg: 'fake' }),
    asr: () => { throw new Error(); },
    budget: () => [],
    cache: () => summarizeCache(),
    ocr: () => ({ available: false }),
    now: () => 'now',
  });
  assert.equal(result.runtime.asr.code, 'INTERNAL_ERROR');
  assert.equal(result.account.loggedIn, false);
  assert.equal(result.account.ok, false);
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

test('懒注册 exact 路由：账号读取失败不炸连接，非 GET 回 405', async () => {
  const routes = [];
  registerSettingsRoutes({
    inject(names, callback) {
      assert.deepEqual(names, ['webServer', 'loader']);
      callback({ webServer: { register(route) { routes.push(route); return () => {}; } } });
    },
  }, { account: () => { throw new Error('secret'); } });

  assert.deepEqual(routes.map((r) => [r.kind, r.path]), [
    ['exact', '/bilibili-bridge/api/status'], ['exact', '/bilibili-bridge/api/avatar'],
  ]);

  let code;
  let body;
  const res = { writeHead(c) { code = c; }, end(b) { body = JSON.parse(b); } };
  await routes[0].handler({ method: 'GET' }, res);
  // 账号读取失败属于“页面能显示但状态未知”，不应把整页打成 500。
  assert.equal(code, 200);
  assert.equal(body.ok, true);
  assert.equal(body.account.loggedIn, false);

  await routes[1].handler({ method: 'POST' }, res);
  assert.equal(code, 405);
});
