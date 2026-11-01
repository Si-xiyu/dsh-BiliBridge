import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { credentialsPath, dataDir, readJson, writeJsonAtomic } from '../../lib/bili/store.mjs';

const execFileAsync = promisify(execFile);

async function tempDir() {
  return mkdtemp(join(tmpdir(), 'bili-store-'));
}

test('readJson 剥掉 UTF-8 BOM', async () => {
  const dir = await tempDir();
  try {
    const file = join(dir, 'bom.json');
    // Windows 上的 Set-Content / 编辑器常写出带 BOM 的 JSON。
    await writeFile(file, '\uFEFF{"ffmpegPath":"D:/x/ffmpeg.exe"}', 'utf8');
    const parsed = await readJson(file, null);
    assert.deepEqual(parsed, { ffmpegPath: 'D:/x/ffmpeg.exe' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('readJson 解析失败时返回 fallback，不抛错', async () => {
  const dir = await tempDir();
  try {
    const file = join(dir, 'broken.json');
    await writeFile(file, '{ not json', 'utf8');
    assert.equal(await readJson(file, null), null);
    assert.deepEqual(await readJson(file, { ok: true }), { ok: true });
    // 文件不存在也走 fallback
    assert.equal(await readJson(join(dir, 'missing.json'), 'none'), 'none');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('dataDir 优先 BILI_DATA_DIR，其次 DSH_HOME，最后 ~/.dsh/bilibili', () => {
  const previousData = process.env.BILI_DATA_DIR;
  const previousHome = process.env.DSH_HOME;
  try {
    process.env.BILI_DATA_DIR = 'E:/tmp/bili-data';
    assert.equal(dataDir(), 'E:/tmp/bili-data');

    delete process.env.BILI_DATA_DIR;
    process.env.DSH_HOME = 'E:/tmp/dsh-home';
    assert.equal(dataDir(), join('E:/tmp/dsh-home', 'bilibili'));

    delete process.env.DSH_HOME;
    assert.match(dataDir(), /\.dsh[\\/]bilibili$/);
  } finally {
    if (previousData === undefined) delete process.env.BILI_DATA_DIR;
    else process.env.BILI_DATA_DIR = previousData;
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
  }
});

test('credentialsPath 落在数据目录里', () => {
  const previous = process.env.BILI_DATA_DIR;
  try {
    process.env.BILI_DATA_DIR = 'E:/tmp/bili-data';
    assert.equal(credentialsPath(), join('E:/tmp/bili-data', 'credentials.json'));
  } finally {
    if (previous === undefined) delete process.env.BILI_DATA_DIR;
    else process.env.BILI_DATA_DIR = previous;
  }
});

test('writeJsonAtomic 原子写：目录自动创建、内容可回读、带版本号', async () => {
  const dir = await tempDir();
  try {
    const file = join(dir, 'nested', 'credentials.json');
    await writeJsonAtomic(file, { version: 1, cookies: { SESSDATA: 'x' } });
    const parsed = await readJson(file, null);
    assert.equal(parsed.version, 1);
    assert.equal(parsed.cookies.SESSDATA, 'x');
    // 覆盖写不残留临时文件
    await writeJsonAtomic(file, { version: 1, cookies: {} });
    assert.deepEqual((await readJson(file, null)).cookies, {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Windows 上凭据文件只保留当前用户（icacls 生效）', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('仅 Windows：POSIX 上由 chmod 0600 负责');
    return;
  }
  const dir = await tempDir();
  try {
    const file = join(dir, 'credentials.json');
    await writeJsonAtomic(file, { version: 1, cookies: {} });
    const { stdout } = await execFileAsync('icacls', [file]);
    assert.ok(
      stdout.includes(process.env.USERNAME),
      `ACL 里应当有当前用户：${stdout}`,
    );
    // /inheritance:r 之后，父目录继承来的通用组必须消失。
    assert.ok(!/Authenticated Users/i.test(stdout), `不应再有继承的通用组：${stdout}`);
    assert.ok(!/BUILTIN\\Users:/i.test(stdout), `不应再有 BUILTIN\\Users：${stdout}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
