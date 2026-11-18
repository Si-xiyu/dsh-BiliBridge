/**
 * 扫码登录真实验收（PNG 版）：临时数据目录，不碰日常凭据。
 *
 *   node tests/manual-auth-png-acceptance.mjs [--png <path>]
 *
 * 输出一张 PNG 二维码供聊天里展示；扫码确认后验证“新进程复用凭据 →
 * 本地登出清空凭据”。二维码约 3 分钟有效。
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import QRCode from 'qrcode';
import { currentJar, logout, qrStart, qrWait, status } from '../lib/bili/auth.mjs';

const { values } = parseArgs({ options: {
  png: { type: 'string', default: fileURLToPath(new URL('../.bili-data/login-qr-scan.png', import.meta.url)) },
  'wait-seconds': { type: 'string', default: '180' },
} });
const root = await mkdtemp(join(tmpdir(), 'bili-auth-png-'));
const previous = process.env.BILI_DATA_DIR;
process.env.BILI_DATA_DIR = root;
try {
  const { url, key } = await qrStart();
  await QRCode.toFile(values.png, url, { width: 520, margin: 2, errorCorrectionLevel: 'M' });
  await chmod(values.png, 0o600);
  console.log('QR_PNG=' + values.png);
  const { jar } = await currentJar();
  const confirmed = await qrWait(key, jar, {
    timeoutMs: Number(values['wait-seconds']) * 1000,
    intervalMs: 2000,
    onStatus: (state) => console.log('QR_STATUS=' + state),
  });
  console.log('CONFIRMED=' + JSON.stringify(confirmed));

  // 用全新进程读取同一临时数据目录，验证凭据确实落盘且能复用。
  const verify = `
    import assert from 'node:assert/strict';
    import { status } from ${JSON.stringify(fileURLToPath(new URL('../lib/bili/auth.mjs', import.meta.url)))};
    const state = await status();
    assert.equal(state.loggedIn, true);
    assert.equal(state.accountId, process.env.VERIFY_MID);
    console.log('RESTART_OK=' + state.accountId);
  `;
  execFileSync(process.execPath, ['--input-type=module', '-e', verify], {
    stdio: 'inherit', env: { ...process.env, VERIFY_MID: confirmed.accountId },
  });

  await logout();
  const after = await status();
  assert.equal(after.hasCredentials, false);
  assert.equal(after.loggedIn, false);
  console.log('LOGOUT_OK');
} finally {
  if (previous === undefined) delete process.env.BILI_DATA_DIR;
  else process.env.BILI_DATA_DIR = previous;
  await rm(root, { recursive: true, force: true });
}
