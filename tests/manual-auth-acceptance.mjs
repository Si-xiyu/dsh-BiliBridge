import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apply } from '../lib/index.js';

const tools = new Map();
apply({ on() {}, tools: { register(tool) { tools.set(tool.name, tool); } } });
const call = async (name, args = {}) => (await tools.get(`bilibili_auth_${name}`).execute(args)).data;
if (process.argv[2] === '--verify-restart') {
  assert.ok(process.env.BILI_DATA_DIR);
  const status = await call('status');
  assert.equal(status.loggedIn, true);
  assert.equal(status.accountId, process.argv[3]);
} else {
  const previous = process.env.BILI_DATA_DIR;
  const root = await mkdtemp(join(tmpdir(), 'bili-auth-acceptance-'));
  process.env.BILI_DATA_DIR = root;
  try {
    const begin = await call('begin');
    console.log(begin.qrText);
    console.log('请在 3 分钟内用 B 站 App 扫码并确认。只测试临时登录，不修改日常登录凭据。');
    const deadline = Date.now() + begin.expiresInSeconds * 1000;
    let result;
    while (Date.now() < deadline) {
      result = await call('poll', { waitSeconds: 15 });
      if (['confirmed', 'expired', 'none'].includes(result.status)) break;
    }
    assert.equal(result?.status, 'confirmed', '真实扫码未确认');
    execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--verify-restart', result.account.accountId], {
      stdio: 'inherit',
    });
    assert.equal((await call('logout')).loggedOut, true);
    assert.equal((await call('status')).hasCredentials, false);
    console.log(JSON.stringify({ qrConfirmed: true, restartVerified: true, localLogoutVerified: true }));
  } finally {
    if (previous === undefined) delete process.env.BILI_DATA_DIR;
    else process.env.BILI_DATA_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
}
