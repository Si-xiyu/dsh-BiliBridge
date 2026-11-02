import { BiliError } from './errors.mjs';
/** Pure transition: retryable alone is never evidence of non-submission. */
export function writeDecision({ error, attempt = 0, after, desired }) {
  if (after) return after.state === desired ? 'success' : 'error';
  if (!error) return 'read';
  if (error.submission === 'not-submitted') return error.retryable === true && attempt === 0 ? 'retry' : 'error';
  return 'read';
}
export function validateWrite({ intent, desired, mediaId, folders }) {
  if (intent !== undefined && intent !== 'preview' && intent !== 'apply') throw new BiliError('INVALID_ARGUMENT', 'intent must be preview or apply');
  if (typeof desired !== 'boolean') throw new BiliError('INVALID_ARGUMENT', 'Target state must be boolean');
  if (folders !== undefined && (!/^[1-9]\d*$/.test(String(mediaId ?? '')) || !folders.items?.some(f => String(f.mediaId) === String(mediaId)))) throw new BiliError('INVALID_ARGUMENT', 'mediaId must identify a visible favorite folder of the current account');
}
/**
 * 写后回读要容忍最终一致性：B站写接口返回成功后，立刻读状态仍可能是旧值
 * （实测点赞成功后马上读还是 false）。这里做有限次轮询，而不是一次读不到就报未验证。
 */
async function readSettled(read, desired, { attempts = 3, delayMs = 400, sleep } = {}) {
  let last = { state: 'unknown', evidence: 'api' };
  for (let index = 0; index < attempts; index += 1) {
    try { last = await read(); } catch { last = { state: 'unknown', evidence: 'api' }; }
    if (last?.state === desired) return last;
    if (index < attempts - 1) await sleep(delayMs * (index + 1));
  }
  return last;
}

/** Injected effects; retry policy above is pure and independently testable. */
export async function guardedWrite({
  intent, desired, target, read, write,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  validateWrite({ intent, desired });
  const before = await read();
  const base = { dryRun: intent !== 'apply', target, before, after: null, verified: false, reconciled: false };
  if (base.dryRun) return { ...base, wouldApply: before.state === 'unknown' ? 'unknown' : before.state !== desired, current: before };
  let failure;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { await write(); failure = undefined; break; }
    catch (error) {
      failure = error;
      const action = writeDecision({ error, attempt, desired });
      if (action === 'retry') continue;
      if (action === 'error') throw new BiliError(error.code ?? 'WRITE_FAILED', error.message);
      break;
    }
  }
  const after = await readSettled(read, desired, { sleep });
  if (writeDecision({ after, desired }) !== 'success') throw new BiliError('WRITE_UNVERIFIED', 'Write outcome unconfirmed; do not blindly retry', { data: { ...base, after, cause: failure?.code } });
  return { ...base, after, applied: true, verified: true, reconciled: Boolean(failure) };
}
