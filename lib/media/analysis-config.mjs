import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from '../bili/store.mjs';

// config.json: budget.{ttlMs,roundsLimit,audioSecondsLimit}, cache.{enabled,ttlMs}.
// Cache TTL is independent of the in-memory analysis TTL.
export const ANALYSIS_DEFAULTS = Object.freeze({
  budget: Object.freeze({ ttlMs: 2 * 60 * 60 * 1000, roundsLimit: 6, audioSecondsLimit: 900 }),
  cache: Object.freeze({ enabled: true, ttlMs: 30 * 24 * 60 * 60 * 1000 }),
  asrModel: 'small',
  schemaVersion: 1,
});

export function analysisConfig() {
  let raw;
  try { raw = JSON.parse(readFileSync(join(dataDir(), 'config.json'), 'utf8').replace(/^\uFEFF/, '')); } catch {}
  const result = { asrModel: raw?.asrModel || process.env.BILI_ASR_MODEL || ANALYSIS_DEFAULTS.asrModel };
  for (const section of ['budget', 'cache']) {
    result[section] = { ...ANALYSIS_DEFAULTS[section] };
    for (const key of Object.keys(result[section])) {
      const value = raw?.[section]?.[key];
      if (key === 'enabled' ? typeof value === 'boolean' :
        Number.isFinite(value) && value >= (key === 'ttlMs' ? 1 : 0) && (key !== 'roundsLimit' || Number.isInteger(value))) {
        result[section][key] = value;
      }
    }
  }
  return result;
}
