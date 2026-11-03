import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { dataDir, readJson, withLock, writeJsonAtomic } from './store.mjs';
import { BiliError } from './errors.mjs';

/** Persistent, account-wide admission gate. No automatic mutation retries. */
export async function limitedWrite(jar, effect, { now = Date.now, minIntervalMs = 3000, pauseMs = 300000, root = dataDir() } = {}) {
  const account = jar?.get('DedeUserID');
  if (!/^[1-9]\d*$/.test(account ?? '')) throw new BiliError('AUTH_REQUIRED', '写入需要已登录账号');
  await mkdir(root, { recursive: true });
  const file = join(root, `write-rate-${account}.json`);
  // Hold through response so a concurrent tool cannot slip past a risk response.
  return withLock(`${file}.lock`, async () => {
    const state = await readJson(file, {});
    const resumeAt = Math.max(state.nextAt ?? 0, state.pausedUntil ?? 0);
    if (now() < resumeAt) {
      if ((state.pausedUntil ?? 0) > now() || state.failures > 0) throw new BiliError('WRITE_PAUSED', `写入暂停至 ${new Date(resumeAt).toISOString()}`, { data: { resumeAt } });
      await new Promise(resolve => setTimeout(resolve, Math.min(resumeAt - now(), minIntervalMs)));
    }
    await writeJsonAtomic(file, { ...state, nextAt: now() + minIntervalMs });
    try {
      const result = await effect();
      await writeJsonAtomic(file, { nextAt: now() + minIntervalMs, failures: 0 });
      return result;
    } catch (error) {
      const risk = ['RATE_LIMITED', 'RISK_CONTROLLED'].includes(error.code) || [412, 429].includes(error.status);
      const failures = Math.min((state.failures ?? 0) + 1, 6);
      const nextAt = now() + (risk ? pauseMs : minIntervalMs * 2 ** failures);
      await writeJsonAtomic(file, { failures, nextAt, pausedUntil: risk ? nextAt : 0, reason: error.code ?? 'NETWORK_ERROR' });
      throw error;
    }
  }, { timeoutMs: 1000, staleMs: 180000 });
}
