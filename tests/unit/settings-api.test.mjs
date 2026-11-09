import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeCache, assembleStatus, readStatus, registerSettingsRoutes, selectForCleanup } from '../../lib/settings-api.mjs';
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

test('缓存清理认得旧拼图名与分张后的 -sheet 后缀', () => {
  // 旧布局：inspect-<cid>-<ts>.jpg；新布局：inspect-<cid>-<ts>-<sheet>.jpg
  assert.equal(selectForCleanup('BV1KDNA6eEgr/inspect-123-1750000000000.jpg', 'media'), true);
  assert.equal(selectForCleanup('BV1KDNA6eEgr/inspect-123-1750000000000-2.jpg', 'media'), true);
  // 多一层后缀只允许在 inspect 上；不认识的命名不能被误删。
  assert.equal(selectForCleanup('BV1KDNA6eEgr/inspect-123-1750000000000-2-3.jpg', 'media'), false);
  assert.equal(selectForCleanup('BV1KDNA6eEgr/whatever-1-2.jpg', 'media'), false);
  assert.equal(selectForCleanup('../inspect-1-2-3.jpg', 'media'), false);
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
  assert.equal(result.budget.ok, true);
  assert.deepEqual(result.budget.items, []);
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
    ['exact', '/bilibili-bridge/api/status'], ['exact', '/bilibili-bridge/api/avatar'], ['exact', '/bilibili-bridge/api/settings'], ['exact', '/bilibili-bridge/api/settings/reset'],
    ...['cache/clear', 'account/logout', 'account/qr/start', 'account/qr/poll', 'history', 'dev/log', 'dev/clear'].map(name => ['exact', '/bilibili-bridge/api/' + name]),
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

const TRUST = { host: '127.0.0.1:1983', origin: 'http://127.0.0.1:1983' };

function operationRoutes(readers = {}) {
  const routes = new Map();
  registerSettingsRoutes({ inject(_names, callback) {
    callback({ webServer: { register(route) { routes.set(route.path.split('/api/')[1], route.handler); return () => {}; } } });
  } }, readers);
  return routes;
}

test('P3 POST routes share trust validation, body validation and sanitized errors', async () => {
  const routes = operationRoutes({ auth: { logout() { throw new Error('secret upstream'); } } });
  for (const name of ['cache/clear', 'account/logout', 'account/qr/start', 'account/qr/poll']) {
    const handler = routes.get(name);
    assert.equal((await call(handler, { method: 'GET' })).code, 405);
    for (const options of [{ headers: {} }, { remote: '10.0.0.1' }, { headers: { ...TRUST, origin: 'http://evil' } }]) {
      assert.equal((await call(handler, { method: 'POST', body: '{}', ...options })).code, 403);
    }
    for (const body of ['bad', 'null', '[]', 'x'.repeat(65537)]) {
      assert.equal((await call(handler, { method: 'POST', body })).code, 400);
    }
  }
  assert.equal((await call(routes.get('cache/clear'), { method: 'POST', body: '{"scope":"other"}' })).code, 400);
  assert.equal((await call(routes.get('account/qr/poll'), { method: 'POST', body: '{}' })).code, 400);
  const failure = await call(routes.get('account/logout'), { method: 'POST' });
  assert.deepEqual(failure, { code: 500, result: { ok: false, error: 'INTERNAL_ERROR' } });
});

test('cache clear：只删已知布局、跳过近期文件、保留头像、拒绝符号链接根', async () => {
  const now = 200000;
  const hash = 'a'.repeat(64);
  const files = [
    { path: `asr/${hash}.json`, bytes: 10, mtimeMs: 0 },
    { path: `asr/${'b'.repeat(64)}.json`, bytes: 20, mtimeMs: now - 1000 },
    { path: 'BV1KDNA6eEgr/cover.img', bytes: 30, mtimeMs: 0 },
    { path: 'BV1KDNA6eEgr/inspect-1-2.jpg', bytes: 40, mtimeMs: now - 60000 },
    { path: 'BV1KDNA6eEgr/secret.bin', bytes: 55, mtimeMs: 0 },
    { path: 'avatar-1.img', bytes: 50, mtimeMs: 0 },
    { path: 'other/file.json', bytes: 60, mtimeMs: 0 },
  ];
  const deleted = [];
  const base = {
    listCacheFiles: async () => files,
    cacheNow: () => now,
    lstat: async () => ({ isSymbolicLink: () => false }),
    // 删除前的复核读到与扫描时一致的元数据
    stat: async (path) => {
      const normalized = String(path).replaceAll('\\', '/');
      const file = files.find((item) => normalized.endsWith(item.path));
      return { mtimeMs: file?.mtimeMs ?? 0, size: file?.bytes ?? 0 };
    },
    unlink: async (path) => deleted.push(path),
  };
  const routes = operationRoutes(base);

  const cases = [
    ['asr', 10, 1, 1],
    ['media', 30, 1, 1],
    // all 只清已知布局：asr 的 json + BV 目录图片；不认识的文件（other/secret.bin）一律不碰
    ['all', 40, 2, 2],
  ];
  for (const [scope, freedBytes, removedFiles, skipped] of cases) {
    deleted.length = 0;
    const response = await call(routes.get('cache/clear'), { method: 'POST', body: JSON.stringify({ scope }) });
    assert.deepEqual(response.result, { ok: true, freedBytes, removedFiles, skipped }, scope);
    assert.equal(deleted.length, removedFiles);
    assert.equal(deleted.some((path) => path.includes('avatar-')), false);
  }

  // 缓存根是符号链接时直接拒绝，避免删除范围被指到数据目录之外
  const unsafe = operationRoutes({ ...base, lstat: async () => ({ isSymbolicLink: () => true }) });
  assert.equal((await call(unsafe.get('cache/clear'), { method: 'POST', body: '{"scope":"all"}' })).code, 500);

  const empty = operationRoutes({ listCacheFiles: async () => [], lstat: async () => ({ isSymbolicLink: () => false }) });
  assert.deepEqual((await call(empty.get('cache/clear'), { method: 'POST', body: '{"scope":"all"}' })).result,
    { ok: true, freedBytes: 0, removedFiles: 0, skipped: 0 });
});

test('account 路由：二维码用 data URL，确认后落盘且不泄露凭据，logout 使旧会话失效', async () => {
  const jar = {};
  let saved = 0, loggedOut = 0, status = 'waiting', polledKey;
  const routes = operationRoutes({ auth: {
    logout: async () => { loggedOut++; },
    qrStart: async () => ({ url: 'qr-url', key: 'bili-key' }),
    currentJar: async () => ({ jar }),
    qrPoll: async (key, actualJar) => { polledKey = key; assert.equal(actualJar, jar); return { status, data: { secret: true } }; },
    saveLoginFromPoll: async (data, actualJar) => { assert.equal(data.secret, true); assert.equal(actualJar, jar); saved++; return { accountId: '1', uname: 'name', cookies: 'secret' }; },
  }, toDataURL: async url => { assert.equal(url, 'qr-url'); return 'data:image/png;base64,test'; } });

  const start = await call(routes.get('account/qr/start'), { method: 'POST' });
  assert.equal(start.result.ok, true);
  assert.equal(start.result.image, 'data:image/png;base64,test');
  assert.match(start.result.id, /^[0-9a-f-]{36}$/);
  // 对外只给会话 id，B站的 qrcode_key 不进响应
  assert.equal(JSON.stringify(start.result).includes('bili-key'), false);

  for (status of ['waiting', 'scanned', 'expired', 'confirmed']) {
    const response = await call(routes.get('account/qr/poll'), { method: 'POST', body: JSON.stringify({ id: start.result.id }) });
    assert.deepEqual(response.result, { ok: true, status, ...(status === 'confirmed' ? { account: { mid: '1', uname: 'name' } } : {}) });
  }
  assert.equal(polledKey, 'bili-key');
  assert.equal(saved, 1);
  assert.equal(JSON.stringify((await call(routes.get('account/qr/poll'), { method: 'POST', body: JSON.stringify({ id: start.result.id }) })).result).includes('secret'), false);

  assert.deepEqual((await call(routes.get('account/logout'), { method: 'POST' })).result, { ok: true, loggedIn: false });
  assert.equal(loggedOut, 1);
  // 退出后旧二维码会话必须失效，不能靠在途 poll 把凭据写回来
  const stale = await call(routes.get('account/qr/poll'), { method: 'POST', body: JSON.stringify({ id: start.result.id }) });
  assert.equal(stale.code, 409);
  assert.equal(stale.result.error, 'QR_SESSION_INVALID');
});
test('history route clamps limit to 1–50', async () => {
  let limit;
  const handler = operationRoutes({ readHistory: async options => { limit = options.limit; return []; } }).get('history');
  for (const [query, expected] of [['', 20], ['?limit=0', 1], ['?limit=999', 50], ['?limit=bad', 20]]) {
    const req = fakeReq(); req.url = '/bilibili-bridge/api/history' + query;
    await handler(req, { writeHead(code) { assert.equal(code, 200); }, end(body) { assert.deepEqual(JSON.parse(body), { ok: true, items: [] }); } });
    assert.equal(limit, expected);
  }
});

function harness(current, { corrupt = false, missing = false } = {}) {
  const state = { value: current, reads: 0, corruptAfterFirst: Boolean(arguments[1]?.corruptAfterFirst) };
  const routes = [];
  const writes = [];
  registerSettingsRoutes(
    { inject(names, callback) { callback({ webServer: { register(route) { routes.push(route); return () => {}; } } }); } },
    {
      readFile: async () => {
        state.reads += 1;
        if (missing) { const error = new Error('missing'); error.code = 'ENOENT'; throw error; }
        if (corrupt) return '{ broken';
        if (state.corruptAfterFirst && state.reads > 1) return '{ broken';
        return JSON.stringify(state.value);
      },
      writeJsonAtomic: async (path, value) => { state.value = value; writes.push([path, value]); },
    },
  );
  return { handler: routes[2].handler, writes };
}

function fakeReq({ method = 'GET', body, headers = TRUST, remote = '127.0.0.1' } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(body)];
  return {
    method,
    headers,
    socket: { remoteAddress: remote },
    async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk; },
  };
}

async function call(handler, options) {
  let code;
  let result;
  await handler(fakeReq(options), { writeHead(value) { code = value; }, end(value) { result = JSON.parse(value); } });
  return { code, result };
}

test('来源校验 fail closed：非回环、缺 Host、缺 Origin、跨源都拒绝', async () => {
  const { handler, writes } = harness({});
  const cases = [
    { headers: TRUST, remote: '10.0.0.1' },
    { headers: { origin: TRUST.origin } },                        // 缺 host
    { headers: { host: 'localhost', origin: 'http://evil' } },    // 跨站来源
    { headers: { host: 'evil.example', origin: 'http://evil.example' } }, // DNS rebinding 形态
    { headers: { host: 'localhost:1983', 'sec-fetch-site': 'cross-site' } }, // 缺 Origin 且标了跨站
    { headers: TRUST, remote: '' },
  ];
  for (const options of cases) {
    const { code } = await call(handler, { method: 'POST', body: '{}', ...options });
    assert.equal(code, 403, JSON.stringify(options));
  }
  assert.equal(writes.length, 0);
});

test('请求体超限与非法 JSON 不写入', async () => {
  const { handler, writes } = harness({});
  assert.equal((await call(handler, { method: 'POST', body: 'x'.repeat(65537) })).code, 413);
  assert.equal((await call(handler, { method: 'POST', body: 'x', headers: { ...TRUST, 'content-length': '65537' } })).code, 413);
  assert.equal((await call(handler, { method: 'POST', body: 'bad' })).code, 400);
  assert.equal(writes.length, 0);
});

test('配置文件损坏时拒绝保存，不覆盖原文件', async () => {
  const { handler, writes } = harness(null, { corrupt: true });
  assert.equal((await call(handler, { method: 'GET' })).code, 409);
  assert.equal((await call(handler, { method: 'POST', body: '{}' })).code, 409);
  assert.equal(writes.length, 0);
});

test('校验失败不写入；成功保留未知字段、过滤响应并返回 revision', async () => {
  const current = { note: 'keep', cookies: { secret: 'credential' }, ffmpegPath: 'local', budget: { roundsLimit: 6 } };
  const { handler, writes } = harness(current);
  const invalid = await call(handler, { method: 'POST', body: JSON.stringify({ budget: { roundsLimit: 999 } }) });
  assert.equal(invalid.code, 400);
  assert.ok(invalid.result.errors.length);
  assert.equal(writes.length, 0);

  const success = await call(handler, { method: 'POST', body: JSON.stringify({ budget: { roundsLimit: 7 } }) });
  assert.equal(success.code, 200);
  assert.equal(success.result.revision.length > 0, true);
  assert.equal(writes[0][1].note, 'keep');
  assert.equal(writes[0][1].budget.roundsLimit, 7);
  assert.equal(JSON.stringify(success.result).includes('credential'), false);

  const get = await call(handler, {});
  assert.equal(get.code, 200);
  assert.ok(get.result.path.endsWith('config.json'));
  assert.equal(JSON.stringify(get.result).includes('credential'), false);
});

test('旧 revision 提交被拒绝，不覆盖别人刚保存的字段', async () => {
  const current = { budget: { roundsLimit: 6 } };
  const { handler, writes } = harness(current);
  const stale = await call(handler, { method: 'POST', body: JSON.stringify({ revision: 'deadbeef', budget: { roundsLimit: 9 } }) });
  assert.equal(stale.code, 409);
  assert.equal(stale.result.error, 'STALE_REVISION');
  assert.equal(writes.length, 0);
});

test('并发保存串行化，两次修改都会保留', async () => {
  const { handler, writes } = harness({ budget: { roundsLimit: 6 } });
  const [first, second] = await Promise.all([
    call(handler, { method: 'POST', body: JSON.stringify({ budget: { roundsLimit: 7 } }) }),
    call(handler, { method: 'POST', body: JSON.stringify({ cache: { enabled: false } }) }),
  ]);
  assert.equal(first.code, 200);
  assert.equal(second.code, 200);
  assert.equal(writes.length, 2);
  const final = writes[1][1];
  assert.equal(final.budget.roundsLimit, 7);
  assert.equal(final.cache.enabled, false);
});

test('配置不存在时按空配置处理，PUT 等其它方法 405', async () => {
  const { handler } = harness(null, { missing: true });
  const get = await call(handler, {});
  assert.equal(get.code, 200);
  assert.deepEqual(get.result.config.budget, {});
  assert.equal((await call(handler, { method: 'PUT' })).code, 405);
});
test('非对象请求体返回 400 且不写盘', async () => {
  const { handler, writes } = harness({ budget: { roundsLimit: 6 } });
  for (const body of ['null', '[]', '42', '"x"']) {
    const { code } = await call(handler, { method: 'POST', body });
    assert.equal(code, 400, body);
  }
  assert.equal(writes.length, 0);
});

test('排队期间配置损坏也返回 409，而不是时好时坏', async () => {
  const { handler } = harness({ budget: { roundsLimit: 6 } }, { corruptAfterFirst: true });
  const { code, result } = await call(handler, { method: 'POST', body: JSON.stringify({ budget: { roundsLimit: 7 } }) });
  assert.equal(code, 409);
  assert.equal(result.error, 'CONFIG_CORRUPT');
});

 test('dev routes clamp limits, forward since and require trusted clear', async () => {
   let options, cleared = 0;
   const routes = operationRoutes({ isDevEnabled: () => true, snapshotDevLog: value => { options = value; return []; }, clearDevLog: () => { cleared++; } });
   for (const [query, limit] of [['',50], ['?limit=0&since=42',1], ['?limit=999',100], ['?limit=bad',50]]) {
     const req = fakeReq(); req.url = '/bilibili-bridge/api/dev/log' + query;
     await routes.get('dev/log')(req, { writeHead: code => assert.equal(code,200), end: body => assert.deepEqual(JSON.parse(body), { ok:true, enabled:true, items:[] }) });
     assert.equal(options.limit, limit); assert.equal(options.since, query.includes('since') ? 42 : 0);
   }
   assert.equal((await call(routes.get('dev/clear'), { method:'POST', headers:{} })).code,403);
   assert.equal(cleared,0);
   assert.deepEqual(await call(routes.get('dev/clear'), { method:'POST' }), { code:200, result:{ ok:true } });
   assert.equal(cleared,1);
 });

test('dev settings accept booleans and reject other values', async () => {
  const { handler, writes } = harness({});
  assert.equal((await call(handler, { method: 'POST', body: JSON.stringify({ dev: { enabled: 'true' } }) })).code, 400);
  assert.equal(writes.length, 0);
  const result = await call(handler, { method: 'POST', body: JSON.stringify({ dev: { enabled: true } }) });
  assert.equal(result.code, 200);
  assert.equal(result.result.config.dev.enabled, true);
});
