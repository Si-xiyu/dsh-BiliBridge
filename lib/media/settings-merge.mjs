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
/**
 * 判定是否同源 loopback 写请求。
 *
 * 缺信息一律拒绝（fail closed）：
 * - 远端地址必须是回环，空值也不放行；
 * - 必须带 Host 且必须是回环地址（防 DNS rebinding：rebinding 后 Host 是外部域名）；
 * - 必须带 Origin 或 Referer，且其 host:port 与 Host 完全一致。
 */
export function trustedRequest(request) {
  const remote = request.socket?.remoteAddress ?? request.remoteAddress ?? '';
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) return false;
  const headers = request.headers ?? {};
  const host = headers.host;
  if (typeof host !== 'string' || !host) return false;
  const origin = headers.origin ?? headers.referer;
  if (typeof origin !== 'string' || !origin) return false;
  let url;
  try { url = new URL(origin); } catch { return false; }
  if (!['http:', 'https:'].includes(url.protocol)) return false;
  // 用**来源协议**解析 Host 再比较：否则 https 的默认端口 443 不会被归一化，
  // 合法的 https://localhost + Host: localhost:443 会被误拒。
  let hostUrl;
  try { hostUrl = new URL(`${url.protocol}//${host}`); } catch { return false; }
  const hostname = hostUrl.hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1');
  if (!['127.0.0.1', 'localhost', '::1'].includes(hostname)) return false;
  return url.host === hostUrl.host;
}
