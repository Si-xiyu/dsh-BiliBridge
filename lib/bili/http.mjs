/**
 * 统一 HTTP 客户端：Cookie 注入、超时、错误码映射、风控页识别、媒体下载。
 *
 * 所有 B站请求都必须从这里走——凭据只在 CookieJar 里，不进入工具返回值。
 *
 * 一次视频提取会跨 api.bilibili.com / i0.hdslb.com / comment.bilibili.com 多个域。
 * 如果每个通道各带一套 UA/Referer，风控看到的是四个客户端；因此请求头只在这里
 * 定义一套，图片/字幕/弹幕也必须走 fetchBuffer，不要各自 fetch。
 */
import { BiliError, fromBiliCode } from './errors.mjs';
import { trafficGuard } from './traffic-guard.mjs';

export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export const DEFAULT_REFERER = 'https://www.bilibili.com/';

/** Protect integer IDs before JSON.parse, including Node 20 without reviver source. */
export function parseApiJson(text) {
  const lossless = text.replace(/"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, token => {
    if (token[0] === '"' || !/^-?\d+$/.test(token) || Number.isSafeInteger(Number(token))) return token;
    return JSON.stringify(token);
  });
  return JSON.parse(lossless);
}

const DEFAULT_HEADERS = {
  'user-agent': USER_AGENT,
  referer: DEFAULT_REFERER,
  origin: 'https://www.bilibili.com',
  'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
};

/** 生成一套请求头；媒体请求传入视频页 Referer。 */
export function headersFor(referer = DEFAULT_REFERER) {
  return { ...DEFAULT_HEADERS, referer };
}

/** 最小 Cookie 容器；只保存 name=value，不关心 domain/path。 */
export class CookieJar {
  constructor(cookies = {}) {
    this.cookies = new Map();
    for (const [k, v] of Object.entries(cookies ?? {})) {
      if (v !== null && v !== undefined && v !== '') this.cookies.set(k, String(v));
    }
  }

  get(name) {
    return this.cookies.get(name);
  }

  set(name, value) {
    if (value === null || value === undefined || value === '') this.cookies.delete(name);
    else this.cookies.set(name, String(value));
  }

  /** 吸收响应里的 Set-Cookie（Node 20+ 提供 getSetCookie）。 */
  absorb(response) {
    const list = response.headers.getSetCookie?.() ?? [];
    for (const raw of list) {
      const pair = raw.split(';', 1)[0];
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      this.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  header() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  toObject() {
    return Object.fromEntries(this.cookies);
  }
}

/**
 * 允许抓取的域名后缀：接口、图片（hdslb）、弹幕、字幕、DASH 流。
 * 只放行这几个后缀，避免上游字段被当成任意 URL 去抓（SSRF）。
 */
export const MEDIA_HOST_SUFFIXES = ['bilibili.com', 'hdslb.com', 'bilivideo.com', 'bilivideo.cn', 'szbdyd.com'];

const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^\[?::1\]?$/,
];

/**
 * 校验一个媒体 URL：协议、私网地址、域名后缀。
 * @param {string} input
 * @param {{suffixes?: string[], base?: string}} [options]
 * @returns {URL}
 */
export function assertMediaUrl(input, { suffixes = MEDIA_HOST_SUFFIXES, base = DEFAULT_REFERER } = {}) {
  let target;
  try {
    target = new URL(String(input), base);
  } catch {
    throw new BiliError('INVALID_ARGUMENT', `不是合法的地址：${input}`);
  }
  if (!['http:', 'https:'].includes(target.protocol)) {
    throw new BiliError('INVALID_ARGUMENT', `不允许的协议：${target.protocol}`);
  }
  const host = target.hostname.toLowerCase();
  if (PRIVATE_HOST_PATTERNS.some((pattern) => pattern.test(host))) {
    throw new BiliError('INVALID_ARGUMENT', `不允许访问内网地址：${host}`);
  }
  if (!suffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) {
    throw new BiliError('INVALID_ARGUMENT', `不在允许的域名内：${host}`);
  }
  return target;
}

/** 发一次请求，只做传输层错误映射；不解包 JSON、不检查业务码。 */
async function send(target, { method = 'GET', headers = {}, body, jar, signal, timeoutMs = 15000 } = {}) {
  const h = { ...headers };
  if (jar) {
    const cookie = jar.header();
    if (cookie) h.cookie = cookie;
  }
  if (body !== undefined && !(body instanceof FormData) && !h['content-type']) h['content-type'] = 'application/x-www-form-urlencoded';

  const signals = [AbortSignal.timeout(timeoutMs)];
  if (signal) signals.push(signal);
  const combined = signals.length > 1 ? AbortSignal.any(signals) : signals[0];

  let response;
  try {
    response = await fetch(target, { method, headers: h, body, signal: combined, redirect: 'follow' });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new BiliError('TIMEOUT', `请求超时（${Math.round(timeoutMs / 1000)}s）：${target.pathname}`, {
        retryable: true,
      });
    }
    throw new BiliError('NETWORK_ERROR', `网络请求失败：${error?.message ?? error}`, { retryable: true });
  }

  if (jar) jar.absorb(response);

  return response;
}

function assertResponse(response, target, traffic) {
  if ([412, 429].includes(response.status)) {
    throw new BiliError('RATE_LIMITED', `触发 B站风控：HTTP ${response.status}。请暂停一会儿再试，不要连续重试。`, {
      status: response.status,
      data: traffic,
      hint: '请求保护已暂停后续请求；请查看 traffic status，不要自动重发。',
    });
  }
  if (!response.ok) {
    throw new BiliError('UPSTREAM_ERROR', `HTTP ${response.status}：${target.pathname}`, {
      status: response.status,
      retryable: response.status === 429 || response.status >= 500,
    });
  }
}

/**
 * 发一次 JSON 请求并解包 `data`。
 *
 * @param {string} url
 * @param {{
 *   method?: string, query?: Record<string, string|number|undefined>, body?: string,
 *   jar?: CookieJar, signal?: AbortSignal, timeoutMs?: number,
 *   headers?: Record<string,string>, acceptCodes?: number[],
 * }} [options]
 * @returns {Promise<any>} 响应里的 data 字段
 */
export async function request(url, options = {}) {
  const { method, query, body, jar, signal, timeoutMs, headers = {}, acceptCodes = [], referer, recovery = false } = options;

  const target = new URL(url);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') target.searchParams.set(k, String(v));
    }
  }

  const effectiveReferer = referer ?? headers.referer ?? DEFAULT_REFERER;
  // Parse under the cross-process lock: a queued request must see a business-code
  // risk response before it can dispatch. Never re-send on transport failure.
  const { response, payload: json, traffic } = await trafficGuard.run({ url: target.href, method, jar, signal, recovery }, async () => {
    const response = await send(target, {
      method, body, jar, signal, timeoutMs: Math.min(timeoutMs ?? 15000, 60000),
      headers: { ...headersFor(effectiveReferer), ...headers },
    });
    if ([412, 429].includes(response.status)) return { response };
    let payload;
    try { payload = parseApiJson(await response.text()); }
    catch (e) { if (!(e instanceof SyntaxError)) throw e; }
    return { response, payload };
  });
  assertResponse(response, target, traffic);
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    // 风控页通常是 HTML；不要直接 JSON.parse 后崩掉。
    throw new BiliError('INVALID_RESPONSE', '响应不是 JSON（大概率被风控页/验证页拦截）', {
      status: response.status,
      data: traffic,
      hint: '已暂停后续请求；不要自动重试，请查看 traffic status。',
    });
  }

  const code = Number(json.code ?? 0);
  if (code !== 0 && !acceptCodes.includes(code)) {
    // 新旧接口的错误字段不统一：多数用 message，旧版/部分 VC 接口用 msg。
    // 成功时 msg 常见为 "0"，不能把它当成平台原话。
    const platformMessage = [json.message, json.msg].find(
      (value) => typeof value === 'string' && value.trim() && value.trim() !== '0',
    );
    const error = fromBiliCode(code, platformMessage, json.data);
    error.biliCode = code;
    if (traffic?.resumeAt || traffic?.manual) {
      error.data = { ...traffic };
      error.retryable = false;
      error.hint = `${error.hint ?? ''} 请求已暂停，请查看 traffic status；不要自动重发。`.trim();
    }
    throw error;
  }
  return json.data ?? {};
}

export async function postJson(url, { jar, payload, signal } = {}) {
  const csrf = jar?.get('bili_jct');
  if (!csrf) throw new BiliError('AUTH_REQUIRED', '缺少 CSRF');
  return request(url, { method: 'POST', query: { csrf }, headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), jar, signal });
}

export async function postMultipart(url, { jar, form, signal } = {}) {
  if (!jar?.get('bili_jct')) throw new BiliError('AUTH_REQUIRED', '缺少 CSRF');
  form.set('csrf', jar.get('bili_jct'));
  return request(url, { method: 'POST', body: form, jar, signal, timeoutMs: 60000 });
}

/**
 * 取一个二进制资源（图片/字幕/弹幕），统一请求头、超时与大小上限。
 * @param {string} url
 * @param {{referer?: string, signal?: AbortSignal, timeoutMs?: number, maxBytes?: number, jar?: CookieJar}} [options]
 * @returns {Promise<{buffer: Buffer, contentType: string, url: string}>}
 */
export async function fetchBuffer(url, options = {}) {
  const { referer = DEFAULT_REFERER, signal, timeoutMs = 20_000, maxBytes = 8 * 1024 * 1024, jar } = options;
  const target = assertMediaUrl(url, { base: referer });
  const { response, buffer, traffic } = await trafficGuard.run({ url: target.href, jar, signal, media: true }, async () => {
    const response = await send(target, { headers: headersFor(referer), jar, signal, timeoutMs: Math.min(timeoutMs, 60000) });
    // Let the guard observe risk status before rejecting an error response.
    if (!response.ok) return { response };
    const length = Number(response.headers.get('content-length') ?? 0);
    if (length > maxBytes) throw new BiliError('BUDGET_EXCEEDED', `响应超过 ${Math.round(maxBytes / 1024 / 1024)}MB 限制`);
    return { response, buffer: Buffer.from(await response.arrayBuffer()) };
  });
  assertResponse(response, target, traffic);

  const length = Number(response.headers.get('content-length') ?? 0);
  if (length > maxBytes) {
    throw new BiliError('BUDGET_EXCEEDED', `响应超过 ${Math.round(maxBytes / 1024 / 1024)}MB 限制`);
  }
  if (buffer.byteLength > maxBytes) {
    throw new BiliError('BUDGET_EXCEEDED', `响应超过 ${Math.round(maxBytes / 1024 / 1024)}MB 限制`);
  }
  return { buffer, contentType: String(response.headers.get('content-type') ?? ''), url: target.toString() };
}

/** 发一次 POST（表单），自动带 csrf=bili_jct。 */
export async function postForm(url, { jar, fields = {}, signal, timeoutMs = 15000, acceptCodes = [] } = {}) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined && v !== null) body.set(k, String(v));
  }
  const csrf = jar?.get('bili_jct');
  if (!csrf) throw new BiliError('AUTH_REQUIRED', '缺少 bili_jct，无法执行写操作；请重新登录');
  body.set('csrf', csrf);
  return request(url, { method: 'POST', body: body.toString(), jar, signal, timeoutMs, acceptCodes });
}

/** 日志用：把明显的凭据字段替换掉。 */
export function redact(value) {
  if (value === null || value === undefined) return value;
  return String(value)
    .replace(/SESSDATA=[^;\s]+/gi, 'SESSDATA=***')
    .replace(/bili_jct=[^;\s]+/gi, 'bili_jct=***')
    .replace(/refresh_token=[^&\s]+/gi, 'refresh_token=***');
}
