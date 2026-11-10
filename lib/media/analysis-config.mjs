import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from '../bili/store.mjs';

// config.json 相关段落：
//   budget.{ttlMs,roundsLimit,audioSecondsLimit}
//   cache.{enabled,ttlMs}            —— 缓存 TTL 与内存里的分析 TTL 是两回事
//   asr.{enabled,model,defaultWindowSeconds,maxWindowSeconds}
//   ocr.{enabled}
// 兼容旧键：顶层 asrModel 仍等价于 asr.model。
export const ANALYSIS_DEFAULTS = Object.freeze({
  budget: Object.freeze({ ttlMs: 2 * 60 * 60 * 1000, roundsLimit: 6, audioSecondsLimit: 900 }),
  cache: Object.freeze({ enabled: true, ttlMs: 30 * 24 * 60 * 60 * 1000 }),
  asr: Object.freeze({ enabled: true, model: 'small', defaultWindowSeconds: 30, maxWindowSeconds: 300 }),
  ocr: Object.freeze({ enabled: true }),
  dev: Object.freeze({ enabled: false }),
  extract: Object.freeze({ subtitles: true, comments: true, danmaku: true, frames: true }),
  adaptive: Object.freeze({ adaptiveEnabled: true }),
  schemaVersion: 1,
});

export const ASR_MODELS = Object.freeze(['tiny', 'base', 'small', 'medium']);

const inRange = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;

export function analysisConfig() {
  let raw;
  try {
    raw = JSON.parse(readFileSync(join(dataDir(), 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    // 缺失/损坏都退回默认值：这份配置只影响成本与开关，不该让工具整体不可用。
  }

  const result = {
    budget: { ...ANALYSIS_DEFAULTS.budget },
    cache: { ...ANALYSIS_DEFAULTS.cache },
    asr: { ...ANALYSIS_DEFAULTS.asr },
    ocr: { ...ANALYSIS_DEFAULTS.ocr },
    dev: { ...ANALYSIS_DEFAULTS.dev },
    extract: { ...ANALYSIS_DEFAULTS.extract },
  };

  for (const section of ['budget', 'cache']) {
    for (const key of Object.keys(result[section])) {
      const value = raw?.[section]?.[key];
      if (key === 'enabled' ? typeof value === 'boolean' :
        Number.isFinite(value) && value >= (key === 'ttlMs' ? 1 : 0) && (key !== 'roundsLimit' || Number.isInteger(value))) {
        result[section][key] = value;
      }
    }
  }

  if (typeof raw?.dev?.enabled === 'boolean') result.dev.enabled = raw.dev.enabled;
  for (const key of Object.keys(result.extract)) {
    if (typeof raw?.extract?.[key] === 'boolean') result.extract[key] = raw.extract[key];
  }
  const asrRaw = raw?.asr ?? {};
  if (typeof asrRaw.enabled === 'boolean') result.asr.enabled = asrRaw.enabled;
  if (typeof raw?.ocr?.enabled === 'boolean') result.ocr.enabled = raw.ocr.enabled;

  // 模型：asr.model > 旧顶层 asrModel > 环境变量 > 默认值；非法值忽略。
  const model = asrRaw.model ?? raw?.asrModel ?? process.env.BILI_ASR_MODEL;
  if (ASR_MODELS.includes(model)) result.asr.model = model;

  if (inRange(asrRaw.defaultWindowSeconds, 10, 120)) result.asr.defaultWindowSeconds = asrRaw.defaultWindowSeconds;
  if (inRange(asrRaw.maxWindowSeconds, 30, 600)) result.asr.maxWindowSeconds = asrRaw.maxWindowSeconds;
  // 上限不能低于默认值，否则“不传窗口”时会立刻越界。
  if (result.asr.maxWindowSeconds < result.asr.defaultWindowSeconds) {
    result.asr.maxWindowSeconds = result.asr.defaultWindowSeconds;
  }

  // 旧字段保留：工具与文档里还有引用，删掉会静默变成 undefined。
  result.asrModel = result.asr.model;
  return result;
}

export function extractConfig() {
  return analysisConfig().extract;
}

/** 供设置接口做一次性校验，避免“读逻辑”和“写逻辑”各写一套范围。 */
export function validateAsrSettings(patch = {}) {
  const errors = [];
  if (patch.enabled !== undefined && typeof patch.enabled !== 'boolean') errors.push('asr.enabled 必须是布尔值');
  if (patch.model !== undefined && !ASR_MODELS.includes(patch.model)) errors.push(`asr.model 只能是 ${ASR_MODELS.join('/')}`);
  if (patch.defaultWindowSeconds !== undefined && !inRange(patch.defaultWindowSeconds, 10, 120)) {
    errors.push('asr.defaultWindowSeconds 必须是 10–120 的整数');
  }
  if (patch.maxWindowSeconds !== undefined && !inRange(patch.maxWindowSeconds, 30, 600)) {
    errors.push('asr.maxWindowSeconds 必须是 30–600 的整数');
  }
  return errors;
}
