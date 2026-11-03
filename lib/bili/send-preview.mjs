import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { dataDir, readJson, writeJsonAtomic } from './store.mjs';
import { textHash } from './send-ledger.mjs';
import { BiliError } from './errors.mjs';

export async function previewSend(account, kind, payload, root = dataDir()) {
  const previewToken = randomUUID();
  await writeJsonAtomic(join(root, 'send-previews', `${previewToken}.json`), { account, kind, digest: textHash(JSON.stringify(payload)), expiresAt: Date.now() + 600000 });
  return { status: 'PREVIEW', previewToken, expiresInSeconds: 600, account, kind, ...payload };
}
export async function verifyPreview(account, kind, payload, token, root = dataDir()) {
  if (typeof token !== 'string' || !/^[0-9a-f-]{36}$/.test(token)) throw new BiliError('PREVIEW_REQUIRED', '先 preview，再带 previewToken apply');
  const row = await readJson(join(root, 'send-previews', `${token}.json`));
  if (!row || row.account !== account || row.kind !== kind || row.expiresAt < Date.now() || row.digest !== textHash(JSON.stringify(payload))) {
    throw new BiliError('PREVIEW_REQUIRED', '预览过期或正文/目标/素材已变化，请重新预览并确认');
  }
}
