import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { BiliError } from './errors.mjs';
import { dataDir, withLock, writeJsonAtomic } from './store.mjs';

export const TRAFFIC_DEFAULTS = Object.freeze({
  gapMs: 1500, readHourly: 600, readDaily: 3000, writeHourly: 12, writeDaily: 30,
  writeGapMs: 3000, publishGapMs: 120000, messageGapMs: 60000,
});
const hash = value => createHash('sha256').update(value).digest('hex');
export function trafficIdentity(jar) {
  const mid = jar?.get('DedeUserID');
  return /^[1-9]\d*$/.test(mid ?? '') ? `mid-${mid}` : jar?.get('SESSDATA') ? `session-${hash(jar.get('SESSDATA'))}` : 'anonymous';
}
const sessionHash = jar => jar?.get('SESSDATA') ? hash(jar.get('SESSDATA')) : null;
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const numeric = v => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const corrupt = () => new BiliError('TRAFFIC_STATE_CORRUPT', '请求保护状态损坏，已停止请求；请检查状态文件，不要删除状态绕过限制');
const numberFields = (v, names) => names.every(k => v[k] === undefined || numeric(v[k]));
const countersValid = v => object(v) && numberFields(v, ['hourAt', 'hourCount', 'dayAt', 'dayCount']);
function validate(s) {
  if (!object(s) || s.version !== 1 || !numeric(s.clock) || !numeric(s.nextAt) || !object(s.global) || !object(s.accounts) ||
      !numberFields(s.global, ['until', 'streak'])) throw corrupt();
  for (const [id, a] of Object.entries(s.accounts)) {
    if (!/^(mid-[1-9]\d*|session-[a-f0-9]{64}|anonymous)$/.test(id) || !object(a) ||
        !countersValid(a.read) || !countersValid(a.write) || !object(a.local) ||
        !numberFields(a, ['nextWriteAt', 'highAt', 'highUntil', 'failures']) ||
        (a.manual !== undefined && !['auth', 'captcha'].includes(a.manual)) ||
        (a.session !== undefined && a.session !== null && !/^[a-f0-9]{64}$/.test(a.session)) ||
        !Object.values(a.local).every(numeric)) throw corrupt();
  }
  return s;
}
async function readState(file) {
  try { return validate(JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''))); }
  catch (e) { if (e.code === 'ENOENT') return { version: 1, clock: 0, nextAt: 0, global: {}, accounts: {} }; throw corrupt(); }
}
function stop(code, message, data = {}) {
  const e = new BiliError(code, message, { data, retryable: false });
  e.submission = 'not-submitted';
  return e;
}
export function trafficKind(url, method = 'GET') {
  const p = new URL(url).pathname;
  if (['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())) return 'read';
  if (p.endsWith('/send_msg')) return 'message';
  if (p === '/x/v2/reply/add' || p === '/x/dynamic/feed/create/dyn' || p.endsWith('/add_draft') || p.endsWith('/publish_now')) return 'publish';
  return 'write';
}
function recoveryEndpoint(url) {
  const u = new URL(url);
  return (u.hostname === 'passport.bilibili.com' && ['/x/passport-login/web/qrcode/generate', '/x/passport-login/web/qrcode/poll'].includes(u.pathname)) ||
    (u.hostname === 'api.bilibili.com' && ['/x/web-interface/nav', '/x/frontend/finger/spi'].includes(u.pathname));
}
function rotate(c, t) {
  if (c.hourAt === undefined || t - c.hourAt >= 3600000) Object.assign(c, { hourAt: t, hourCount: 0 });
  // Explicit Asia/Shanghai day boundaries, independent of the host timezone.
  const day = Math.floor((t + 8 * 3600000) / 86400000) * 86400000;
  if (c.dayAt === undefined || day > c.dayAt) Object.assign(c, { dayAt: day, dayCount: 0 });
}
function budget(c, hourly, daily, t, scope) {
  rotate(c, t);
  if (c.hourCount >= hourly || c.dayCount >= daily) {
    const resumeAt = Math.max(c.hourCount >= hourly ? c.hourAt + 3600000 : 0, c.dayCount >= daily ? c.dayAt + 86400000 - 8 * 3600000 : 0);
    throw stop('TRAFFIC_BUDGET_EXCEEDED', '已达到本地请求预算，请等待窗口恢复，不要换工具重试', { scope, resumeAt });
  }
}
function retryAfter(value, now) {
  if (!value) return 0;
  const ms = /^\d+(\.\d+)?$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now;
  return Number.isFinite(ms) ? Math.max(0, ms) : 0;
}

/** One API request at a time across processes. The lock includes response parsing
 * so queued requests see a risk response before they can dispatch. No retries. */
export function createTrafficGuard({ root = dataDir, now = Date.now, sleep = (ms, signal) => delay(ms, undefined, { signal }), policy = {} } = {}) {
  const cfg = { ...TRAFFIC_DEFAULTS, ...policy };
  if (!Object.values(cfg).every(numeric)) throw new TypeError('Invalid traffic policy');
  const directory = () => typeof root === 'function' ? root() : root;
  async function locked(signal, fn) {
    await mkdir(directory(), { recursive: true, mode: 0o700 });
    const file = join(directory(), 'traffic-state.json');
    let entered = false;
    try {
      return await withLock(`${file}.lock`, async () => {
        entered = true;
        const s = await readState(file);
        // A backwards wall clock never resets quotas or shortens a pause.
        const t = Math.max(now(), s.clock);
        s.clock = t;
        return fn(s, t, () => writeJsonAtomic(file, s));
      }, { timeoutMs: 30000, staleMs: 180000, signal });
    } catch (e) {
      if (entered || e instanceof BiliError || signal?.aborted) throw e;
      throw stop('TRAFFIC_BUSY', '请求保护状态不可用或队列繁忙；本次未发送，请稍后检查');
    }
  }
  function account(s, jar) {
    const id = trafficIdentity(jar);
    return s.accounts[id] ??= { read: {}, write: {}, local: {} };
  }
  function blocked(s, a, t, { url, jar, kind = 'read', media = false }) {
    const recovery = !media && kind === 'read' && recoveryEndpoint(url);
    if (s.global.until > t && !recovery) throw stop('TRAFFIC_PAUSED', '平台风控暂停中，不要换工具或连续重试', { scope: 'global', resumeAt: s.global.until, reason: s.global.reason });
    if (a.manual && !recovery && jar?.get('SESSDATA')) throw stop('TRAFFIC_MANUAL_REQUIRED', a.manual === 'auth' ? '登录已失效，请重新扫码验证' : '需要在网页端完成人工验证，再执行 traffic resume --go', { scope: 'account', reason: a.manual });
    if (kind !== 'read' && a.local[kind] > t) throw stop('TRAFFIC_PAUSED', '该类写入受平台限制，请等待恢复', { scope: kind, resumeAt: a.local[kind] });
  }
  async function legacy(jar, t) {
    const mid = jar?.get('DedeUserID');
    if (!/^[1-9]\d*$/.test(mid ?? '')) return 0;
    try {
      const s = JSON.parse(await readFile(join(directory(), `write-rate-${mid}.json`), 'utf8'));
      if (!object(s) || !numberFields(s, ['nextAt', 'pausedUntil', 'failures'])) throw corrupt();
      const until = Math.max(s.nextAt ?? 0, s.pausedUntil ?? 0);
      return until > t ? until : 0;
    } catch (e) { if (e.code === 'ENOENT') return 0; throw corrupt(); }
  }
  function observe(s, a, t, options, response, payload) {
    const code = Number(payload?.code);
    const local = [21020, 21046].includes(code);
    const risk = [412, 429].includes(response.status) || [-412, -352, -799, -509, -10403].includes(code);
    if (risk) {
      s.global.streak = Math.min(4, (s.global.streak ?? 0) + 1);
      s.global.until = Math.max(s.global.until ?? 0, t + Math.max(retryAfter(response.headers.get('retry-after'), now()), Math.min(1800000, 300000 * 2 ** (s.global.streak - 1))));
      s.global.reason = `HTTP ${response.status}; code ${Number.isFinite(code) ? code : 'unknown'}`;
      s.global.endpoint = new URL(options.url).pathname;
    }
    if (local) a.local.message = Math.max(a.local.message ?? 0, t + (code === 21046 ? 86400000 : 300000));
    if ([12015, -105].includes(code)) a.manual = 'captcha';
    if (a.manual !== 'captcha' && options.jar?.get('SESSDATA') && (code === -101 || response.status === 401 || (new URL(options.url).pathname === '/x/web-interface/nav' && payload?.data?.isLogin === false))) {
      a.manual = 'auth'; a.session = sessionHash(options.jar);
    }
    // Only a fresh, validated login clears an expired-session block. It never
    // clears captcha, quotas or an active platform pause.
    if (a.manual === 'auth' && new URL(options.url).pathname === '/x/web-interface/nav' && code === 0 && payload?.data?.isLogin === true && String(payload.data.mid) === options.jar?.get('DedeUserID') && sessionHash(options.jar) !== a.session) {
      delete a.manual; delete a.session;
    }
    if (options.kind !== 'read') {
      if (response.ok && code === 0) a.failures = 0;
      else if (!risk && !local) { a.failures = Math.min(6, (a.failures ?? 0) + 1); a.nextWriteAt = Math.max(a.nextWriteAt ?? 0, t + cfg.writeGapMs * 2 ** a.failures); }
    }
  }
  async function run(options, effect) {
    const kind = options.kind ?? trafficKind(options.url, options.method);
    options = { ...options, kind };
    let dispatched = false;
    try {
      return await locked(options.signal, async (s, t, save) => {
        const a = account(s, options.jar);
        blocked(s, a, t, options);
        const writing = kind !== 'read';
        if (writing && !options.jar?.get('SESSDATA')) throw stop('AUTH_REQUIRED', '写入需要已登录账号');
        if (writing) {
          const legacyUntil = await legacy(options.jar, t);
          const highGap = kind === 'publish' ? cfg.publishGapMs : kind === 'message' ? cfg.messageGapMs : 0;
          const until = Math.max(a.nextWriteAt ?? 0, legacyUntil, highGap ? a.highUntil ?? 0 : 0, highGap && a.highAt !== undefined ? a.highAt + highGap : 0);
          if (until > t) throw stop('WRITE_PAUSED', '写入冷却或退避中；本次未发送', { scope: 'account-write', resumeAt: until });
        }
        if (!options.media) budget(a[writing ? 'write' : 'read'], writing ? cfg.writeHourly : cfg.readHourly, writing ? cfg.writeDaily : cfg.readDaily, t, writing ? 'account-write' : 'account-read');
        const wait = options.media ? 0 : Math.max(0, s.nextAt - t);
        if (wait > 30000) throw stop('TRAFFIC_PAUSED', '本地时钟回退或请求仍在冷却，请检查状态', { resumeAt: s.nextAt, scope: 'global' });
        if (wait) await sleep(wait, options.signal);
        options.signal?.throwIfAborted();
        t = Math.max(now(), s.clock);
        blocked(s, a, t, options);
        if (!options.media) {
          budget(a[writing ? 'write' : 'read'], writing ? cfg.writeHourly : cfg.readHourly, writing ? cfg.writeDaily : cfg.readDaily, t, writing ? 'account-write' : 'account-read');
          a[writing ? 'write' : 'read'].hourCount++; a[writing ? 'write' : 'read'].dayCount++;
          s.nextAt = t + cfg.gapMs;
        }
        s.clock = t;
        if (writing) { a.nextWriteAt = t + cfg.writeGapMs; if (['publish', 'message'].includes(kind)) { a.highAt = t; a.highUntil = t + (kind === 'publish' ? cfg.publishGapMs : cfg.messageGapMs); } }
        await save(); // Reserve durably before the only dispatch point.
        dispatched = true;
        let result;
        try { result = await effect(); }
        catch (e) {
          if (writing) { a.failures = Math.min(6, (a.failures ?? 0) + 1); a.nextWriteAt = Math.max(a.nextWriteAt, Math.max(now(), t) + cfg.writeGapMs * 2 ** a.failures); await save(); }
          throw e;
        }
        t = Math.max(now(), s.clock); s.clock = t;
        observe(s, a, t, options, result.response, result.payload);
        await save();
        return result;
      });
    } catch (e) {
      if (!dispatched) e.submission = 'not-submitted';
      throw e;
    }
  }
  async function status(jar) {
    return locked(undefined, async (s, t) => {
      const a = account(s, jar); rotate(a.read, t); rotate(a.write, t);
      return { account: trafficIdentity(jar), policy: cfg, observedAt: t, resumeAt: s.global.until ?? 0, reason: s.global.reason ?? null, manual: a.manual ?? null,
        writeResumeAt: Math.max(a.nextWriteAt ?? 0, await legacy(jar, t)), localResumeAt: a.local,
        remaining: { readHourly: Math.max(0, cfg.readHourly - a.read.hourCount), readDaily: Math.max(0, cfg.readDaily - a.read.dayCount), writeHourly: Math.max(0, cfg.writeHourly - a.write.hourCount), writeDaily: Math.max(0, cfg.writeDaily - a.write.dayCount) } };
    });
  }
  async function resume(jar) {
    return locked(undefined, async (s, t, save) => {
      const a = account(s, jar);
      if (a.manual === 'auth') throw stop('TRAFFIC_MANUAL_REQUIRED', '请先重新扫码并验证登录；不能手动清除登录失效状态');
      delete a.manual; await save();
      return { resumedManual: true, resumeAt: Math.max(s.global.until ?? 0, a.nextWriteAt ?? 0, await legacy(jar, t)), note: '仅确认人工验证已完成；平台暂停、预算和未决发送记录均保留' };
    });
  }
  // Preflight for external media processes: no quota is consumed and no network
  // callback is executed under this lock. In-flight ffmpeg is not intercepted.
  async function check(options) { return locked(options.signal, async (s, t) => blocked(s, account(s, options.jar), t, { ...options, kind: 'read', media: true })); }
  return { run, status, resume, check };
}
export const trafficGuard = createTrafficGuard();
