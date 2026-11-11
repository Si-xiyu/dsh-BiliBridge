import { ANALYSIS_DEFAULTS, validateAsrSettings } from './analysis-config.mjs';
// 可编辑的运行路径。旧版把 ffmpegPath/asrPython 等写在顶层；现在优先读 runtime 段，
// 顶层同名键继续作为 legacy 兼容入口（见 runtimePath）。
export const RUNTIME_KEYS = Object.freeze(['ffmpegPath', 'ffmpegCaFile', 'asrPython', 'asrModelDir']);
export const RUNTIME_VALUE_MAX = 4096;
// 控制字符（含 \t\n）一律拒绝：路径里出现它们多半是粘贴带入了换行，静默接受只会让 spawn 失败得莫名其妙。
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;
export const WRITABLE_KEYS = { budget: ['roundsLimit', 'audioSecondsLimit', 'ttlMs'], cache: ['enabled', 'ttlMs'], asr: ['enabled', 'model', 'defaultWindowSeconds', 'maxWindowSeconds'], ocr: ['enabled'], dev: ['enabled'], extract: ['subtitles', 'comments', 'danmaku', 'frames'], adaptive: ['adaptiveEnabled'], runtime: RUNTIME_KEYS };
export const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
/**
 * 读一个运行路径的生效值：runtime 段优先，顶层同名键作为 legacy 兜底。
 *
 * 语义（有意为之）：
 * - `runtime` 里出现这个键就“生效”，即使值是空串；空串表示自动/缺省，**不再**回落到顶层旧键，
 *   否则用户无法用空值覆盖已有的旧配置。
 * - `runtime` 段整体不存在或没有这个键时，才读顶层旧键。
 * - 返回 trim 后的字符串；空值/缺省返回 null，调用方按候选列表继续回落。
 */
export function runtimePath(config, key) {
  const nested = config?.runtime;
  if (isObject(nested) && Object.hasOwn(nested, key)) {
    const text = typeof nested[key] === 'string' ? nested[key].trim() : '';
    return text || null;
  }
  const legacy = config?.[key];
  return typeof legacy === 'string' && legacy.trim() ? legacy.trim() : null;
}
/**
 * 保存后要不要清运行时缓存：比较**生效值**（runtime 段或 legacy 顶层键），
 * 而不是原始 JSON。所以只改被 runtime 覆盖的旧键不会白白重启探测。
 */
export function runtimeCacheResets(before, after) {
  const changed = key => runtimePath(before, key) !== runtimePath(after, key);
  return { ffmpeg: changed('ffmpegPath') || changed('ffmpegCaFile'), asr: changed('asrPython') || changed('asrModelDir') };
}
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
      } else if (section === 'runtime') {
        // 只接受字符串：路径由用户自己填，后端不做存在性校验（可能指向别的机器/尚未安装）。
        if (typeof value !== 'string' || value.trim().length > RUNTIME_VALUE_MAX) { errors.push(name + ': 必须是不超过 4096 字符的字符串'); continue; }
        if (CONTROL_CHARS.test(value)) { errors.push(name + ': 不能包含控制字符'); continue; }
        // 空串=自动：保留键本身，让 runtimePath 区分“显式清空”和“没配”。
        config[section][key] = value.trim();
        continue; // 已写入 trim 后的值，跳过末尾的统一赋值
      } else if (key === 'enabled' || section === 'extract' || (section === 'adaptive' && key === 'adaptiveEnabled')) {
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
  return explainTrust(request).ok;
}

const LOOPBACK_NAMES = new Set(['127.0.0.1', 'localhost', '::1']);

function hostnameOf(url) {
  return url.hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1');
}

/** 端口归一化：URL 会省略默认端口，比较前补回来。 */
function portOf(url) {
  if (url.port) return url.port;
  return url.protocol === 'https:' ? '443' : '80';
}

/**
 * 判定是否同源 loopback 写请求，并给出拒绝原因（方便前端/日志说明为什么 403）。
 *
 * 与旧版的区别：不再要求 Origin 的**主机名**与 Host 一致。
 * 浏览器从 http://localhost:3928 打开、而 Host 写的是 127.0.0.1:3928 时，
 * 旧规则会误判 403（用户点保存报 forbidden 就是这个原因）。
 *
 * 但仍然要求**端口一致**：否则同机另一个端口上的页面可以跨站表单 POST 过来，
 * 把配置改掉（无需 CORS 预检）。所以规则是：
 * - 远端必须回环；
 * - Host 主机名必须是回环（挡 DNS rebinding）；
 * - 有 Origin/Referer 时：主机名回环 + 端口与 Host 相同；
 * - 没有 Origin 时：只接受浏览器标成 same-origin/none，或非浏览器客户端。
 */
export function explainTrust(request) {
  const remote = request.socket?.remoteAddress ?? request.remoteAddress ?? '';
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) return { ok: false, reason: 'remote-not-loopback' };
  const headers = request.headers ?? {};
  const host = headers.host;
  if (typeof host !== 'string' || !host) return { ok: false, reason: 'host-missing' };
  let hostUrl;
  try { hostUrl = new URL(`http://${host}`); } catch { return { ok: false, reason: 'host-invalid' }; }
  if (!LOOPBACK_NAMES.has(hostnameOf(hostUrl))) return { ok: false, reason: 'host-not-loopback' };

  const origin = headers.origin ?? headers.referer;
  if (typeof origin !== 'string' || !origin) {
    const site = String(headers['sec-fetch-site'] ?? '').toLowerCase();
    if (site && site !== 'same-origin' && site !== 'none') return { ok: false, reason: 'origin-missing-cross-site' };
    return { ok: true };
  }
  let url;
  try { url = new URL(origin); } catch { return { ok: false, reason: 'origin-invalid' }; }
  if (!['http:', 'https:'].includes(url.protocol)) return { ok: false, reason: 'origin-scheme' };
  if (!LOOPBACK_NAMES.has(hostnameOf(url))) return { ok: false, reason: 'origin-not-loopback' };
  // 端口必须一致：同机不同端口的页面不能写我们的配置。
  if (portOf(url) !== portOf(hostUrl)) return { ok: false, reason: 'origin-port-mismatch' };
  return { ok: true };
}
