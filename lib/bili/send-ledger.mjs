import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dataDir, restrictFile, withLock } from './store.mjs';
import { BiliError } from './errors.mjs';

export const textHash = value => createHash('sha256').update(Buffer.isBuffer(value) ? value : String(value).normalize('NFC')).digest('hex');
const pending = row => ['SUBMITTING', 'PENDING_CONFIRM'].includes(row.status);

async function rows(file) {
  try { return (await readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); }
  catch (e) { if (e.code === 'ENOENT') return []; throw new BiliError('LEDGER_CORRUPT', '发送账本无法读取，禁止发送'); }
}

/** Lock is held only for durable reservation/update, never for network I/O. */
export async function ledgerUpdate(account, fn, { root = dataDir(), now = Date.now } = {}) {
  if (!/^[1-9]\d*$/.test(String(account))) throw new BiliError('AUTH_REQUIRED', '缺少账号');
  await mkdir(root, { recursive: true });
  const file = join(root, `sends-${account}.jsonl`);
  return withLock(`${file}.lock`, async () => {
    const history = await rows(file);
    const latest = [...new Map(history.map(row => [row.operationId, row])).values()];
    const { value, event } = await fn(latest);
    if (event) {
      await appendFile(file, JSON.stringify(event) + '\n', { mode: 0o600, flush: true });
      await restrictFile(file);
    }
    // Keep unresolved operations indefinitely; compact resolved history after 30 days.
    if (history.length > 2000) {
      const retained = [...latest.filter(r => pending(r) || now() - r.createdAt < 30 * 86400000), ...(event ? [event] : [])];
      // Atomic replacement with the same privacy properties as credentials.
      const { writeFile, rename } = await import('node:fs/promises');
      const tmp = `${file}.${randomUUID()}.tmp`;
      await writeFile(tmp, retained.map(r => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600, flush: true });
      await restrictFile(tmp); await rename(tmp, file);
    }
    return value;
  });
}

export async function sendOnce({ account, kind, target, text, fingerprint = '', submit, now = Date.now, root }) {
  const digest = textHash(text);
  const key = textHash(JSON.stringify([kind, target, digest, fingerprint]));
  const reservation = await ledgerUpdate(account, list => {
    const duplicate = list.findLast(r => r.key === key && (pending(r) || now() - r.createdAt < 300000));
    if (duplicate) return { value: { status: 'DUPLICATE', operationId: duplicate.operationId, originalStatus: duplicate.status } };
    const row = { operationId: randomUUID(), key, kind, target, textHash: digest, fingerprint, status: 'SUBMITTING', createdAt: now() };
    return { value: row, event: row };
  }, { root, now });
  if (reservation.status === 'DUPLICATE') return reservation;
  let event;
  try {
    const result = await submit(reservation.operationId);
    event = { ...reservation, status: 'SENT', result, updatedAt: now() };
  } catch (error) {
    const known = error.submission === 'not-submitted' || ['WRITE_PAUSED', 'AUTH_REQUIRED', 'INVALID_ARGUMENT', 'PERMISSION_DENIED', 'RATE_LIMITED'].includes(error.code) || (Number.isInteger(error.biliCode) && error.biliCode !== 0);
    event = { ...reservation, status: known ? 'FAILED' : 'PENDING_CONFIRM', error: error.code ?? 'NETWORK_ERROR', updatedAt: now() };
  }
  await ledgerUpdate(account, () => ({ value: null, event }), { root, now });
  return { status: event.status, operationId: event.operationId, result: event.result ?? null, error: event.error ?? null,
    ...(pending(event) ? { next: '使用同一工具 intent=check 和 operationId 核对；未匹配不能自动重发' } : {}) };
}

export async function checkSend({ account, operationId, kind, find, root }) {
  const row = await ledgerUpdate(account, list => ({ value: list.find(r => r.operationId === operationId && r.kind === kind) }), { root });
  if (!row) throw new BiliError('NOT_FOUND', '当前账号没有这条发送记录');
  if (!pending(row)) return { status: row.status, operationId, result: row.result ?? null };
  // SUBMITTING may still be running: do not race its completion.
  if (row.status === 'SUBMITTING' && Date.now() - row.createdAt < 180000) return { status: 'PENDING_CONFIRM', operationId, note: '请求可能仍在执行，请稍后核对' };
  const match = await find(row);
  if (!match) return { status: 'PENDING_CONFIRM', operationId, note: '最近内容未匹配；这不证明没有发送，禁止自动重发' };
  return ledgerUpdate(account, list => {
    const current = list.find(r => r.operationId === operationId);
    const event = { ...current, status: 'SENT', result: match, updatedAt: Date.now(), reconciled: true };
    return { value: { status: 'SENT', operationId, result: match, reconciled: true }, event };
  }, { root });
}
