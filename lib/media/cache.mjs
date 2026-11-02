/** Persistent window results. Malformed/expired files are misses; config and
 * defaults live in analysis-config.mjs. OCR callers must provide normalized window
 * seconds, bandRatio, intervalMs and language. No inspect integration here.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { dataDir, readJson, writeJsonAtomic } from '../bili/store.mjs';
import { ANALYSIS_DEFAULTS, analysisConfig } from './analysis-config.mjs';

function cachePath(kind, options) {
  const fields = [options.bvid, String(options.cid), options.model, options.language,
    options.startSeconds, options.durationSeconds];
  if (kind === 'ocr') fields.push(options.bandRatio, options.intervalMs);
  const key = createHash('sha256').update(JSON.stringify(fields)).digest('hex');
  return join(dataDir(), 'cache', kind, `${key}.json`);
}

/**
 * 逐段校验：坏段落会让“命中”变成持续报错，宁可当未命中重转。
 * 空数组是合法的（整段无人声），不能当成坏缓存，否则静音窗口会反复重转。
 */
function validSegments(segments) {
  if (!Array.isArray(segments)) return false;
  return segments.every((segment) => segment && typeof segment === 'object' &&
    Number.isFinite(segment.start) && Number.isFinite(segment.end) &&
    segment.end >= segment.start && typeof segment.text === 'string');
}

async function read(kind, options) {
  const config = analysisConfig().cache;
  if (!config.enabled) return null;
  const record = await readJson(cachePath(kind, options));
  if (!record || record.schemaVersion !== ANALYSIS_DEFAULTS.schemaVersion ||
      !Number.isFinite(record.writtenAt) || record.writtenAt > Date.now() ||
      Date.now() - record.writtenAt >= config.ttlMs ||
      !record.payload || typeof record.payload !== 'object' || Array.isArray(record.payload) ||
      (kind === 'asr' && !validSegments(record.payload.segments))) return null;
  return record.payload;
}

async function write(kind, options, payload = options.payload) {
  if (!analysisConfig().cache.enabled) return;
  const file = cachePath(kind, options);
  // Store's temporary names use pid/time; serialize same-process writes per path.
  const previous = writes.get(file) ?? Promise.resolve();
  const pending = previous.catch(() => {}).then(() => writeJsonAtomic(file, {
    schemaVersion: ANALYSIS_DEFAULTS.schemaVersion, writtenAt: Date.now(), payload,
  }));
  writes.set(file, pending);
  try { await pending; } finally { if (writes.get(file) === pending) writes.delete(file); }
}
const writes = new Map();
export const readTranscribeCache = (options) => read('asr', options);
export const writeTranscribeCache = (options, payload) => write('asr', options, payload);
export const readOcrCache = (options) => read('ocr', options);
export const writeOcrCache = (options, payload) => write('ocr', options, payload);
