import { ANALYSIS_DEFAULTS, validateAsrSettings } from './analysis-config.mjs';
export const WRITABLE_KEYS = { budget: ['roundsLimit', 'audioSecondsLimit', 'ttlMs'], cache: ['enabled', 'ttlMs'], asr: ['enabled', 'model', 'defaultWindowSeconds', 'maxWindowSeconds'], ocr: ['enabled'] };
export const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
export function mergeWritable(current, patch) {
  const original = isObject(current) ? current : {};
  const config = { ...original }, errors = [];
  if (!isObject(patch)) return { config, errors: ['settings: 必须是对象'] };
  const ranges = { 'budget.roundsLimit': [1,50], 'budget.audioSecondsLimit': [60,7200], 'budget.ttlMs': [60000,86400000], 'cache.ttlMs': [86400000,7776000000] };
  for (const [section, keys] of Object.entries(WRITABLE_KEYS)) {
    if (!Object.hasOwn(patch, section)) continue;
    if (!isObject(patch[section])) { errors.push(section + ': 必须是对象'); continue; }
    config[section] = { ...(isObject(original[section]) ? original[section] : {}) };
    for (const key of keys) {
      if (!Object.hasOwn(patch[section], key)) continue;
      const value = patch[section][key], name = section + '.' + key;
      if (section === 'asr') {
        // 复用校验并保持整份提交一致，避免读写语义分叉。
        const issues = validateAsrSettings({ [key]: value });
        if (value === undefined || issues.length) { errors.push(...(issues.length ? issues : [name + ': 值不能为空'])); continue; }
      } else if (key === 'enabled') {
        if (typeof value !== 'boolean') { errors.push(name + ': 必须是布尔值'); continue; }
      } else {
        const [min,max] = ranges[name];
        if (!Number.isInteger(value) || value < min || value > max) { errors.push(name + ': 必须是 ' + min + '–' + max + ' 的整数'); continue; }
      }
      config[section][key] = value;
    }
  }
  if (isObject(patch.asr) && ['defaultWindowSeconds','maxWindowSeconds'].some(k => Object.hasOwn(patch.asr,k))) {
    const effective = { ...ANALYSIS_DEFAULTS.asr };
    for (const key of ['defaultWindowSeconds','maxWindowSeconds']) {
      const value = config.asr?.[key];
      if (value !== undefined && !validateAsrSettings({ [key]: value }).length) effective[key] = value;
    }
    if (effective.maxWindowSeconds < effective.defaultWindowSeconds) errors.push('asr.maxWindowSeconds: 不得小于 defaultWindowSeconds');
  }
  // 复用校验并保持整份提交一致，避免读写语义分叉。
  return { config: errors.length ? { ...original } : config, errors };
}
export function trustedRequest(request) {
  const remote = request.socket?.remoteAddress ?? request.remoteAddress ?? '';
  if (!['','127.0.0.1','::1','::ffff:127.0.0.1'].includes(remote)) return false;
  const headers = request.headers ?? {};
  if (!headers.host) return true;
  for (const key of ['origin','referer']) {
    if (headers[key] === undefined) continue;
    try { const url = new URL(headers[key]); if (!['http:','https:'].includes(url.protocol) || url.host !== headers.host) return false; }
    catch { return false; }
  }
  return true;
}
