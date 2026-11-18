import '../helpers/http-isolation.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { registerAuthTools } from '../../lib/tools/auth.mjs';
import { loadCredentials } from '../../lib/bili/store.mjs';

test('registered auth tools generate and confirm a QR session, save verified credentials and log out locally', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'bili-auth-tool-'));
  const previous = process.env.BILI_DATA_DIR;
  process.env.BILI_DATA_DIR = root;
  context.after(async () => {
    if (previous === undefined) delete process.env.BILI_DATA_DIR;
    else process.env.BILI_DATA_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });
  const tools = new Map();
  registerAuthTools({ tools: { register(tool) { tools.set(tool.name, tool); } } });
  const call = name => tools.get(`bilibili_auth_${name}`).execute({});
  const requests = [];
  let pollCode = 86038;
  context.mock.method(globalThis, 'fetch', async (input, options) => {
    const url = new URL(input);
    const endpoint = url.pathname.split('/').at(-1);
    requests.push(endpoint);
    assert.notEqual(options.method, 'POST');
    let data;
    if (endpoint === 'generate') data = { url: 'https://passport.bilibili.com/test-qr', qrcode_key: 'fixture-key' };
    else if (endpoint === 'poll') {
      assert.equal(url.searchParams.get('qrcode_key'), 'fixture-key');
      data = { code: pollCode, url: 'https://www.bilibili.com/?SESSDATA=fixture-session&bili_jct=fixture-csrf&DedeUserID=123' };
    } else if (endpoint === 'spi') data = { b_3: 'fixture-buvid' };
    else if (endpoint === 'nav') {
      const cookie = options.headers.cookie ?? options.headers.Cookie ?? '';
      if (cookie.includes('SESSDATA=fixture-session')) data = { isLogin: true, mid: 123, uname: 'Fixture' };
      else return Response.json({ code: -101 });
    } else throw new Error(`unexpected endpoint: ${endpoint}`);
    return Response.json({ code: 0, data });
  });

  assert.equal((await call('status')).data.loggedIn, false);
  assert.equal((await call('poll')).data.status, 'none');
  const begin = await call('begin');
  assert.match(begin.data.qrText, /██/);
  assert.equal((await call('poll')).data.status, 'expired');
  assert.equal(await loadCredentials(), null);

  pollCode = 0;
  await call('begin');
  const confirmed = await call('poll');
  assert.equal(confirmed.data.status, 'confirmed');
  assert.equal(confirmed.data.account.accountId, '123');
  assert.doesNotMatch(JSON.stringify(confirmed), /fixture-session|fixture-csrf/);
  assert.equal((await loadCredentials()).accountId, '123');
  assert.equal((await call('status')).data.loggedIn, true);
  const beforeLogout = requests.length;
  assert.equal((await call('logout')).data.loggedOut, true);
  assert.equal(requests.length, beforeLogout);
  assert.deepEqual((await loadCredentials()).cookies, {});
  assert.equal((await call('status')).data.loggedIn, false);
});
