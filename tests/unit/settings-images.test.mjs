import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerSettingsRoutes } from '../../lib/settings-api.mjs';

const TRUST = { host: '127.0.0.1:1983', origin: 'http://127.0.0.1:1983' };

function routes(readers = {}) {
  const map = new Map();
  registerSettingsRoutes({ inject(_names, callback) {
    callback({ webServer: { register(route) { map.set(route.path.split('/api/')[1], route.handler); return () => {}; } } });
  } }, readers);
  return map;
}

function request({ method = 'GET', url = '/', headers = TRUST, remote = '127.0.0.1' } = {}) {
  return { method, url, headers, socket: { remoteAddress: remote }, async *[Symbol.asyncIterator]() {} };
}

async function raw(handler, options) {
  let code, body;
  await handler(request(options), { writeHead(value) { code = value; }, end(value) { body = value; } });
  return { code, body };
}

test('图片列表来自内存登记；字节路由有白名单与来源校验', async () => {
  const old = process.env.BILI_DATA_DIR;
  const dir = await mkdtemp(join(tmpdir(), 'bili-images-'));
  process.env.BILI_DATA_DIR = dir;
  try {
    const bvid = 'BV1KDNA6eEgr';
    await mkdir(join(dir, 'cache', bvid), { recursive: true });
    await writeFile(join(dir, 'cache', bvid, 'storyboard-v3-1-c.jpg'), Buffer.from([0xff, 0xd8, 0xff]));
    const map = routes({ listImages: () => [{ path: 'p', name: 'storyboard-v3-1-c.jpg', bvid, kind: 'storyboard', at: 1 }] });

    const list = await raw(map.get('images'), { url: '/bilibili-bridge/api/images?limit=5' });
    assert.equal(list.code, 200);
    assert.equal(JSON.parse(list.body).items.length, 1);

    const ok = await raw(map.get('image'), { url: `/bilibili-bridge/api/image?bvid=${bvid}&name=storyboard-v3-1-c.jpg` });
    assert.equal(ok.code, 200);
    assert.deepEqual([...ok.body], [0xff, 0xd8, 0xff]);

    for (const name of ['../config.json', 'config.json', 'a.png.exe', '']) {
      const bad = await raw(map.get('image'), { url: `/bilibili-bridge/api/image?bvid=${bvid}&name=${encodeURIComponent(name)}` });
      assert.equal(bad.code, 400, `name=${name}`);
    }
    const badBvid = await raw(map.get('image'), { url: '/bilibili-bridge/api/image?bvid=..%2F..&name=a.jpg' });
    assert.equal(badBvid.code, 400);

    const cross = await raw(map.get('image'), {
      url: `/bilibili-bridge/api/image?bvid=${bvid}&name=storyboard-v3-1-c.jpg`,
      headers: { host: '127.0.0.1:1983', origin: 'http://evil' },
    });
    assert.equal(cross.code, 403);
  } finally {
    if (old === undefined) delete process.env.BILI_DATA_DIR; else process.env.BILI_DATA_DIR = old;
    await rm(dir, { recursive: true, force: true });
  }
});
