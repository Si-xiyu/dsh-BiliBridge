import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { dataDir, readJson, withLock, writeJsonAtomic } from './store.mjs';
import { BiliError } from './errors.mjs';

/**
 * 账号级写入门禁：持久化间隔、退避与风控暂停。
 *
 * 关键区分：**进入 effect（真正发请求）之前**的失败（抢锁超时、读状态失败）
 * 一定没有提交到 B 站，必须标 `submission: 'not-submitted'`；否则上层（发送账本）
 * 会把它当成“结果未知”，记成 PENDING_CONFIRM，后续同内容发送会被永久判重。
 */
export async function limitedWrite(jar, effect, { now = Date.now, minIntervalMs = 3000, pauseMs = 300000, root = dataDir() } = {}) {
  const account = jar?.get('DedeUserID');
  if (!/^[1-9]\d*$/.test(account ?? '')) throw new BiliError('AUTH_REQUIRED', '写入需要已登录账号');
  await mkdir(root, { recursive: true });
  const file = join(root, `write-rate-${account}.json`);

  let submitted = false;
  try {
    // Hold through response so a concurrent tool cannot slip past a risk response.
    return await withLock(`${file}.lock`, async () => {
      const state = await readJson(file, {});
      const resumeAt = Math.max(state.nextAt ?? 0, state.pausedUntil ?? 0);
      if (now() < resumeAt) {
        if ((state.pausedUntil ?? 0) > now() || state.failures > 0) throw new BiliError('WRITE_PAUSED', `写入暂停至 ${new Date(resumeAt).toISOString()}`, { data: { resumeAt } });
        await new Promise((resolve) => setTimeout(resolve, Math.min(resumeAt - now(), minIntervalMs)));
      }
      await writeJsonAtomic(file, { ...state, nextAt: now() + minIntervalMs });
      try {
        submitted = true;
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
  } catch (error) {
    if (submitted) throw error;
    // 到这里说明请求根本没发出去：可能是抢锁超时、读状态失败或凭证不足。
    // 给上层一个明确“未提交”的信号，让它记 FAILED 而不是未决。
    if (error?.code && error.submission === 'not-submitted') throw error;
    if (error instanceof BiliError && ['AUTH_REQUIRED', 'WRITE_PAUSED', 'INVALID_ARGUMENT', 'PERMISSION_DENIED', 'RATE_LIMITED'].includes(error.code)) {
      error.submission = 'not-submitted';
      throw error;
    }
    const wrapped = new BiliError('WRITE_BUSY', '写请求未能进入发送队列（未提交，可稍后重试）', { data: { submission: 'not-submitted' } });
    wrapped.submission = 'not-submitted';
    wrapped.cause = error;
    throw wrapped;
  }
}
