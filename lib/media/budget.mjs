/** Process-local budgets: restart loses all accounting. TTL is fixed at creation,
 * not extended by activity. Expired IDs cannot be charged or refunded.
 * Failed attempts retain their round; only unused audio reservations are refunded.
 */
import { randomUUID } from 'node:crypto';
import { BiliError } from '../bili/errors.mjs';
import { analysisConfig } from './analysis-config.mjs';

const bundles = new Map();
const videos = new Map();
const aliases = new Map();

export function beginAnalysis({ bvid, cid, bundleId } = {}) {
  if (!bvid || cid == null) throw new BiliError('INVALID_ARGUMENT', '需要 bvid 和 cid');
  if (bundleId !== undefined && (typeof bundleId !== 'string' || !bundleId.trim())) {
    throw new BiliError('INVALID_ARGUMENT', 'bundleId 必须是非空字符串');
  }
  const now = Date.now();
  for (const [id, entry] of bundles) {
    if (entry.expiresAt <= now) {
      bundles.delete(id);
      if (videos.get(entry.key) === id) videos.delete(entry.key);
      if (entry.externalId && aliases.get(entry.externalId) === id) aliases.delete(entry.externalId);
    }
  }
  const key = JSON.stringify([bvid, String(cid)]);
  const existing = bundleId
    ? bundles.get(bundleId) ?? bundles.get(aliases.get(bundleId)) ?? bundles.get(videos.get(key))
    : bundles.get(videos.get(key));
  if (existing) {
    if (existing.key !== key) throw new BiliError('INVALID_ARGUMENT', 'bundleId 与视频不匹配');
    return existing.bundleId;
  }
  // 未知 bundleId 直接拒绝：调用方（尤其是模型）不能靠自己编一个 id 重开额度。
  // 预算只按 (bvid, cid) 在同一 TTL 内复用。
  if (bundleId) throw new BiliError('INVALID_ARGUMENT', 'bundleId 不是本进程签发的分析任务');
  const id = randomUUID();
  const config = analysisConfig().budget;
  bundles.set(id, { ...config, key, externalId: undefined, bundleId: id, rounds: 0, audioSecondsUsed: 0,
    expiresAt: now + config.ttlMs, reservations: new Map() });
  videos.set(key, id);
  return id;
}

function entryFor(bundleId) {
  const entry = bundles.get(bundleId);
  if (!entry || entry.expiresAt <= Date.now()) throw new BiliError('BUDGET_EXCEEDED', '分析预算已过期或不存在；remaining=0');
  return entry;
}

/**
 * 结算路径（refund / snapshot）允许账本已过期：
 * 转写可能已经跑完并写进缓存，这时把成功结果升级成 BUDGET_EXCEEDED 是错的。
 * 只有“新扣账”才必须要求账本有效。
 */
function settlingEntry(bundleId) {
  return bundles.get(bundleId) ?? null;
}

function validateSeconds(value) {
  if (!Number.isFinite(value) || value < 0) throw new BiliError('INVALID_ARGUMENT', 'audioSeconds 必须是非负有限数');
}

// No await between checking and deducting: concurrent callers cannot double-spend.
export function charge({ bundleId, audioSeconds = 0, kind } = {}) {
  validateSeconds(audioSeconds);
  const entry = entryFor(bundleId);
  const remaining = entry.audioSecondsLimit - entry.audioSecondsUsed;
  if (entry.rounds >= entry.roundsLimit || audioSeconds > remaining) {
    throw new BiliError('BUDGET_EXCEEDED', `分析预算不足；remaining=${remaining}；remainingRounds=${entry.roundsLimit - entry.rounds}`);
  }
  entry.rounds++;
  entry.audioSecondsUsed += audioSeconds;
  const reservationId = randomUUID();
  entry.reservations.set(reservationId, { audioSeconds, kind });
  return reservationId;
}

// Optional reservationId makes a caller's refund idempotent and isolates parallel work.
export function refund({ bundleId, audioSeconds = 0, reservationId } = {}) {
  validateSeconds(audioSeconds);
  const entry = settlingEntry(bundleId);
  // 账本可能已经过期/被回收：退款是尽力而为，不能因此把已成功的结果变成错误。
  if (!entry) return;
  let remaining = audioSeconds;
  const reservations = reservationId ? [[reservationId, entry.reservations.get(reservationId)]] : entry.reservations;
  for (const [id, reservation] of reservations) {
    if (!reservation || remaining <= 0) continue;
    const amount = Math.min(remaining, reservation.audioSeconds);
    entry.audioSecondsUsed -= amount;
    remaining -= amount;
    reservation.audioSeconds -= amount;
    if (reservation.audioSeconds === 0) entry.reservations.delete(id);
  }
}

export function snapshot({ bundleId } = {}) {
  const config = analysisConfig().budget;
  const entry = settlingEntry(bundleId);
  if (!entry) {
    return { bundleId: bundleId ?? null, expired: true, rounds: 0, roundsLimit: config.roundsLimit,
      audioSecondsUsed: 0, audioSecondsLimit: config.audioSecondsLimit,
      remainingSeconds: config.audioSecondsLimit, expiresAt: null };
  }
  const { rounds, roundsLimit, audioSecondsUsed, audioSecondsLimit, expiresAt } = entry;
  return { bundleId, expired: expiresAt <= Date.now(), rounds, roundsLimit, audioSecondsUsed, audioSecondsLimit,
    remainingSeconds: Math.max(0, audioSecondsLimit - audioSecondsUsed), expiresAt };
}
