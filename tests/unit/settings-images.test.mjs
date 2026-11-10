import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerSettingsRoutes } from '../../lib/settings-api.mjs';

const TRUST = { host: '127.0.0.1:1983', origin: 'http://127.0.0.1:1983' };
const bvid = 'BV1KDNA6eEgr';

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

test('图片字节路由：只读登记过的文件，拒绝越界/保留名/符号链接', async () => {
  const old = process.env.BILI_DATA_DIR;
  const dir = await mkdtemp(join(tmpdir(), 'bili-images-'));
  process.env.BILI_DATA_DIR = dir;
  try {
    const cacheDir = join(dir, 'cache', bvid);
    await mkdir(cacheDir, { recursive: true });
    const target = join(cacheDir, 'storyboard-v3-1-c.jpg');
    await writeFile(target, Buffer.from([0xff, 0xd8, 0xff]));
    const linkPath = join(cacheDir, 'linked.jpg');
    const map = routes({ listImages: () => [
      { path: target, name: 'storyboard-v3-1-c.jpg', bvid, kind: 'storyboard', at: 1 },
      { path: linkPath, name: 'linked.jpg', bvid, kind: 'storyboard', at: 2 },
    ] });
    const imageUrl = (name) => `/bilibili-bridge/api/image?bvid=${bvid}&name=${encodeURIComponent(name)}`;

    // 登记过 → 返回字节
    const ok = await raw(map.get('image'), { url: imageUrl('storyboard-v3-1-c.jpg') });
    assert.equal(ok.code, 200);
    assert.deepEqual([...ok.body], [0xff, 0xd8, 0xff]);

    // 未登记但文件存在 → 404（不能靠猜文件名读缓存）
    await writeFile(join(cacheDir, 'adaptive-1-abc.jpg'), Buffer.from([1]));
    assert.equal((await raw(map.get('image'), { url: imageUrl('adaptive-1-abc.jpg') })).code, 404);

    // 已登记但文件不存在 → 404
    await rm(target, { force: true });
    assert.equal((await raw(map.get('image'), { url: imageUrl('storyboard-v3-1-c.jpg') })).code, 404);

    // 路径穿越 / 保留名 / 尾随点 / 错误后缀 → 400
    for (const name of ['../config.json', 'config.json', 'a.png.exe', '', 'CON.jpg', 'nul.png', 'storyboard.jpg.']) {
      assert.equal((await raw(map.get('image'), { url: imageUrl(name) })).code, 400, `name=${name}`);
    }
    assert.equal((await raw(map.get('image'), { url: '/bilibili-bridge/api/image?bvid=..%2F..&name=a.jpg' })).code, 400);

    // 跨站来源 → 403（列表与字节都一样）
    for (const handler of [map.get('image'), map.get('images')]) {
      const cross = await raw(handler, {
        url: imageUrl('storyboard-v3-1-c.jpg'),
        headers: { host: '127.0.0.1:1983', origin: 'http://evil' },
      });
      assert.equal(cross.code, 403);
    }

    // 符号链接 → 404（Windows 下创建链接需要权限，失败则跳过这一项）
    const linkName = 'linked.jpg';
    try {
      await symlink(join(dir, 'outside.jpg'), linkPath, 'file');
      const linked = await raw(map.get('image'), { url: imageUrl(linkName) });
      assert.equal(linked.code, 404, '符号链接不能被读');
    } catch { /* EPERM：没有创建符号链接的权限 */ }
  } finally {
    if (old === undefined) delete process.env.BILI_DATA_DIR; else process.env.BILI_DATA_DIR = old;
    await rm(dir, { recursive: true, force: true });
  }
});
