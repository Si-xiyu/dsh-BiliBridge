/**
 * 统一 HTTP 客户端：Cookie 注入、超时、错误码映射、风控页识别。
 *
 * 所有 B站请求都必须从这里走——凭据只在 CookieJar 里，不进入工具返回值。
 */
import { BiliError, fromBiliCode } from './errors.mjs';

export const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const DEFAULT_HEADERS = {
  'user-agent': USER_AGENT,
  referer: 'https://www.bilibili.com/',
  origin: 'https://www.bilibili.com',
  'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
};

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
 * 发一次请求并解包 `data`。
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
  const {
    method = 'GET',
    query,
    body,
    jar,
    signal,
    timeoutMs = 15000,
    headers = {},
    acceptCodes = [],
  } = options;

  const target = new URL(url);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') target.searchParams.set(k, String(v));
    }
  }

  const h = { ...DEFAULT_HEADERS, ...headers };
  if (jar) {
    const cookie = jar.header();
    if (cookie) h.cookie = cookie;
  }
  if (body !== undefined) h['content-type'] = 'application/x-www-form-urlencoded';

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

  if (response.status === 412) {
    throw new BiliError('RATE_LIMITED', '触发 B站风控：HTTP 412。请暂停一会儿再试，不要连续重试。', {
      status: 412,
      retryable: true,
    });
  }
  if (!response.ok) {
    throw new BiliError('UPSTREAM_ERROR', `HTTP ${response.status}：${target.pathname}`, {
      status: response.status,
      retryable: response.status === 429 || response.status >= 500,
    });
  }

  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    // 风控页通常是 HTML；不要直接 JSON.parse 后崩掉。
    throw new BiliError('INVALID_RESPONSE', '响应不是 JSON（大概率被风控页/验证页拦截）', {
      status: response.status,
    });
  }

  const code = Number(json.code ?? 0);
  if (code !== 0 && !acceptCodes.includes(code)) throw fromBiliCode(code, json.message, json.data);
  return json.data ?? {};
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
