import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dataDir, withLock, writeJsonAtomic } from './store.mjs';
import { BiliError } from './errors.mjs';

const NOT_SUBMITTED = new Set(['AUTH_REQUIRED', 'WRITE_PAUSED', 'WRITE_STATE_CORRUPT', 'INVALID_ARGUMENT', 'PERMISSION_DENIED', 'RATE_LIMITED']);

/**
 * 读账号级写入状态。
 *
 * 不能用 readJson：它把损坏/无权限都当空对象，会让我们按“没有任何暂停”继续发送，
 * 从而绕开已有的风控暂停。这里只容忍文件不存在。
 */
async function readState(file) {
  let text;
  try { text = await readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  try {
    const value = JSON.parse(text.replace(/^\uFEFF/, ''));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    throw new BiliError('WRITE_STATE_CORRUPT', '写入状态文件损坏，拒绝发送', { data: { submission: 'not-submitted' } });
  }
}

/**
 * 账号级写入门禁：持久化间隔、退避与风控暂停。
 *
 * 关键区分：**进入 effect（真正发请求）之前**的任何失败（凭证不足、状态损坏、
 * 抢锁超时、读状态失败）都一定没有提交到 B 站，必须标 `submission: 'not-submitted'`；
 * 否则上层（发送账本）会把它当成“结果未知”记成 PENDING_CONFIRM，后续同内容发送被永久判重。
 */
export async function limitedWrite(jar, effect, { now = Date.now, minIntervalMs = 3000, pauseMs = 300000, root = dataDir() } = {}) {
  let submitted = false;
  try {
    const account = jar?.get('DedeUserID');
    if (!/^[1-9]\d*$/.test(account ?? '')) throw new BiliError('AUTH_REQUIRED', '写入需要已登录账号');
    await mkdir(root, { recursive: true });
    const file = join(root, `write-rate-${account}.json`);

    // Hold through response so a concurrent tool cannot slip past a risk response.
    return await withLock(`${file}.lock`, async () => {
      const state = await readState(file);
      const resumeAt = Math.max(state.nextAt ?? 0, state.pausedUntil ?? 0);
      if (now() < resumeAt) {
        if ((state.pausedUntil ?? 0) > now() || state.failures > 0) {
          throw new BiliError('WRITE_PAUSED', `写入暂停至 ${new Date(resumeAt).toISOString()}`, { data: { resumeAt } });
        }
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
    // 已经进入 effect 的错误原样上抛：它可能是“结果未知”，账本要按未决处理。
    if (submitted) throw error;
    if (error?.submission === 'not-submitted') throw error;
    if (error instanceof BiliError && NOT_SUBMITTED.has(error.code)) {
      error.submission = 'not-submitted';
      throw error;
    }
    // 其余一律是“进队列/读状态”阶段的失败：明确告诉上层没提交。
    const wrapped = new BiliError('WRITE_BUSY', '写请求未能进入发送队列（未提交，可稍后重试）', { data: { submission: 'not-submitted' } });
    wrapped.submission = 'not-submitted';
    wrapped.cause = error;
    throw wrapped;
  }
}
