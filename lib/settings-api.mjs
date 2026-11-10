import { isDevEnabled, snapshotDevLog, clearDevLog } from './devlog.mjs';
import { listImages } from './imagelog.mjs';
import QRCode from 'qrcode';
import { readHistory } from './media/history.mjs';
import { explainTrust, mergeWritable, trustedRequest, WRITABLE_KEYS, isObject } from './media/settings-merge.mjs';
import { ANALYSIS_DEFAULTS } from './media/analysis-config.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { readdir, stat, lstat, readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as auth from './bili/auth.mjs';
import { dataDir, writeJsonAtomic } from './bili/store.mjs';
import { DEFAULT_REFERER, USER_AGENT } from './bili/http.mjs';
import { BiliError } from './bili/errors.mjs';
import { resolveToolchain, resetFfmpegCache } from './media/ffmpeg.mjs';
import { resolveAsr } from './media/asr.mjs';
import { listAnalyses } from './media/budget.mjs';

// 头像只允许这些域名；下载走“自己跟跳转”，因为通用 fetchBuffer 会跟随重定向，
// 上游返回一个指向内网/白名单外的 302 就能绕过域名校验。
const AVATAR_HOST = /(^|\.)hdslb\.com$/;
const AVATAR_MAX_BYTES = 4 * 1024 * 1024;

// 真实缓存布局是 cache/asr/*.json 与 cache/<bvid>/{cover.img,storyboard-v2-*.jpg,sprite-*.jpg,inspect-*.jpg}，
// 所以按**文件名**归类，不能按一级目录（否则全落进“其它”）。
export function categorizeCache(path) {
  const normalized = String(path).replaceAll('\\', '/');
  if (normalized.startsWith('asr/')) return 'asr';
  const base = normalized.split('/').pop() ?? '';
  if (/^cover\./.test(base)) return 'cover';
  if (/^(storyboard-v2-|sprite-|storyboard-)/.test(base)) return 'storyboard';
  if (/^avatar-/.test(base)) return 'avatar';
  if (/^inspect-/.test(base)) return 'inspect';
  return '其它';
}

// 统计与磁盘遍历分开，测试无需依赖真实缓存。
export function summarizeCache(files = []) {
  const names = ['asr', 'storyboard', 'cover', 'inspect', 'avatar', '其它'];
  const buckets = names.map(name => ({ name, bytes: 0, files: 0 }));
  const byName = new Map(buckets.map(b => [b.name, b]));
  for (const file of files) {
    const bucket = byName.get(categorizeCache(file.path)) ?? byName.get('其它');
    bucket.bytes += file.bytes;
    bucket.files++;
  }
  return { totalBytes: buckets.reduce((n, b) => n + b.bytes, 0),
    totalFiles: buckets.reduce((n, b) => n + b.files, 0), buckets };
}

export async function listCacheFiles(root = join(dataDir(), 'cache')) {
  const files = [];
  async function walk(dir, prefix = '') {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); }
    catch (e) { if (e.code === 'ENOENT') return; throw e; }
    for (const e of entries) {
      const relative = prefix + e.name;
      // 不跟随符号链接/目录联接：清理时一旦跟进去，删除范围就跑到缓存目录之外了。
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { await walk(join(dir, e.name), relative + '/'); continue; }
      if (!e.isFile()) continue;
      try { const info = await stat(join(dir, e.name)); files.push({ path: relative, bytes: info.size, mtimeMs: info.mtimeMs }); }
      // 扫描过程中缓存被清理是常态（P3 就有清理按钮），单个文件消失不该让整次统计失败。
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  await walk(root);
  return files;
}

export function assembleStatus({ account, runtime, budget, cache, generatedAt }) {
  return { ok: true, account, runtime, budget, cache, generatedAt };
}
const probe = async reader => {
  try { return { ...await reader(), ok: true }; }
  catch (e) { return { ok: false, code: e instanceof BiliError ? e.code : 'INTERNAL_ERROR' }; }
};
export async function readStatus(readers = {}) {
  const { account = auth.status, toolchain = resolveToolchain, asr = resolveAsr,
    budget = listAnalyses, cache = readCache, ocr = () => ({
      platform: process.platform, available: process.platform === 'win32' &&
        existsSync(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'))
    }), now = () => new Date().toISOString() } = readers;
  // 未登录/目录损坏时页面应该显示“未知”，而不是整页 500。
  // 但降级必须**可见**：每个分区都带 ok/code，页面据此显示“读取失败”，不能把故障画成空数据。
  const safeObject = async (reader, fallback) => {
    try { return { ...(await reader()), ok: true }; }
    catch (e) { return { ...fallback, ok: false, code: e instanceof BiliError ? e.code : 'INTERNAL_ERROR' }; }
  };
  const safeList = async (reader) => {
    try {
      const value = await reader();
      return Array.isArray(value) ? { ok: true, items: value } : { ok: false, code: 'INTERNAL_ERROR', items: [] };
    } catch (e) {
      return { ok: false, code: e instanceof BiliError ? e.code : 'INTERNAL_ERROR', items: [] };
    }
  };
  const [accountView, ffmpeg, asrView, budgetView, cacheView, ocrView] = await Promise.all([
    safeObject(account, { loggedIn: false }),
    probe(toolchain),
    probe(asr),
    safeList(budget),
    safeObject(cache, { totalBytes: 0, totalFiles: 0, buckets: [] }),
    probe(ocr),
  ]);
  return assembleStatus({
    account: accountView,
    runtime: { ffmpeg, asr: asrView, ocr: ocrView },
    budget: budgetView,
    cache: cacheView,
    generatedAt: now(),
  });
}
const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};
/**
 * 读响应体，边读边计数，超过上限立刻中断。
 *
 * 不能先 arrayBuffer() 再检查长度：那样超限内容已经全部进内存了。
 */
async function readLimited(response, limit) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > limit) throw new BiliError('NOT_FOUND', '头像过大');
    return buffer;
  }
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        throw new BiliError('NOT_FOUND', '头像过大');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks);
}

/**
 * 下载头像：自己跟跳转并逐跳校验域名。
 *
 * 不能直接用 fetchBuffer：它内部 `redirect: 'follow'`，只校验初始 URL，
 * 上游返回一个 302 指向内网/白名单外就能绕过限制。公开头像也不需要账号 Cookie。
 * 超时覆盖整个“跳转 + 读响应体”过程，避免慢速响应把请求挂死。
 */
async function downloadAvatar(startUrl, { timeoutMs = 20_000 } = {}) {
  let current = startUrl;
  for (let hop = 0; hop < 3; hop += 1) {
    const parsed = new URL(current);
    if (parsed.protocol !== 'https:' || !AVATAR_HOST.test(parsed.hostname)) {
      throw new BiliError('NOT_FOUND', '头像地址被拒绝');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(parsed.toString(), {
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'user-agent': USER_AGENT, referer: DEFAULT_REFERER, accept: 'image/*' },
      });
      if (response.status >= 300 && response.status < 400) {
        // 放弃这一跳的响应体，否则慢速/悬挂的 body 会一直占着连接。
        await response.body?.cancel?.().catch?.(() => {});
        const location = response.headers.get('location');
        if (!location) throw new BiliError('NOT_FOUND', '头像重定向缺少目标');
        current = new URL(location, parsed).toString();
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel?.().catch?.(() => {});
        throw new BiliError('NOT_FOUND', `头像拉取失败 ${response.status}`);
      }
      const buffer = await readLimited(response, AVATAR_MAX_BYTES);
      if (!buffer.length) throw new BiliError('NOT_FOUND', '头像为空');
      return buffer;
    } catch (error) {
      if (error?.name === 'AbortError') throw new BiliError('TIMEOUT', '头像拉取超时');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new BiliError('NOT_FOUND', '头像重定向过多');
}

async function avatar() {
  const { jar } = await auth.currentJar();
  const nav = await auth.navInfo(jar);
  if (!/^\d+$/.test(String(nav.mid))) throw new BiliError('NOT_FOUND', '头像不可用');
  const file = join(dataDir(), 'cache', 'avatar-' + nav.mid + '.img');
  try { if (Date.now() - (await stat(file)).mtimeMs < 86400000) return await readFile(file); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  const buffer = await downloadAvatar(new URL(nav.face).toString());
  await mkdir(join(dataDir(), 'cache'), { recursive: true });
  await writeFile(file, buffer);
  return buffer;
}
// 仅投影已知设置，避免扩展字段意外泄露敏感内容。
function publicConfig(config) {
  if (config.asr?.model === undefined && ['tiny','base','small','medium'].includes(config.asrModel)) {
    config = { ...config, asr: { ...config.asr, model: config.asrModel } };
  }
  return Object.fromEntries(Object.entries(WRITABLE_KEYS).map(([section, keys]) => [section,
    Object.fromEntries(keys.filter(key => Object.hasOwn(config[section] ?? {}, key))
      .filter(key => ['string','number','boolean'].includes(typeof config[section][key]))
      .map(key => [key, config[section][key]]))]));
}

function revisionOf(text) {
  return createHash('sha1').update(text).digest('hex').slice(0, 16);
}

/**
 * 严格读配置：文件不存在 → 空对象；存在但解析失败 → 抛 CONFIG_CORRUPT。
 *
 * 不能用 readJson：它把坏文件当空对象，一次合法保存就会把 ffmpegPath 等未知字段整份清零。
 */
async function readConfigStrict(path, readFileImpl) {
  let raw;
  try { raw = await readFileImpl(path, 'utf8'); }
  catch (error) {
    if (error?.code === 'ENOENT') return { config: {}, revision: 'empty' };
    throw error;
  }
  const text = String(raw).replace(/^\uFEFF/, '');
  let parsed;
  try { parsed = JSON.parse(text); }
  catch { throw new BiliError('CONFIG_CORRUPT', 'config.json 无法解析，拒绝写入'); }
  if (!isObject(parsed)) throw new BiliError('CONFIG_CORRUPT', 'config.json 顶层不是对象');
  return { config: parsed, revision: revisionOf(text) };
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  if (Number(req.headers?.['content-length']) > 65536) throw new BiliError('BODY_TOO_LARGE', '请求体超过 64KB');
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 65536) throw new BiliError('BODY_TOO_LARGE', '请求体超过 64KB');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// 同一进程内把“读—校验—合并—写”串起来，避免并发保存互相覆盖丢键。
let saveQueue = Promise.resolve();

async function settings(req, res, readers) {
  if (!['GET', 'POST'].includes(req.method)) return json(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' });
  const path = join(dataDir(), 'config.json');
  const readFileImpl = readers.readFile ?? readFile;

  let loaded;
  try { loaded = await readConfigStrict(path, readFileImpl); }
  catch (error) {
    const corrupt = error instanceof BiliError && error.code === 'CONFIG_CORRUPT';
    return json(res, corrupt ? 409 : 500, { ok: false, error: error?.code ?? 'INTERNAL_ERROR' });
  }

  if (req.method === 'GET') {
    return json(res, 200, { ok: true, config: publicConfig(loaded.config), revision: loaded.revision, path });
  }

  if (!trustedRequest(req)) return json(res, 403, { ok: false, error: 'FORBIDDEN', reason: explainTrust(req).reason });

  let body;
  try { body = JSON.parse(await readBody(req)); }
  catch (error) {
    if (error instanceof BiliError && error.code === 'BODY_TOO_LARGE') return json(res, 413, { ok: false, error: 'BODY_TOO_LARGE' });
    return json(res, 400, { ok: false, errors: ['settings: JSON 解析失败'] });
  }
  // 必须是对象：null/数组/数字不能当成“空补丁”去重写文件（否则会无谓地改 revision）。
  if (!isObject(body)) return json(res, 400, { ok: false, errors: ['settings: 请求体必须是对象'] });
  const { revision, ...patch } = body;
  if (revision !== undefined && revision !== loaded.revision) {
    // 页面基于旧快照提交：直接拒绝，让前端重新读取，避免覆盖别人刚保存的字段。
    return json(res, 409, { ok: false, error: 'STALE_REVISION', revision: loaded.revision });
  }

  const task = saveQueue.then(async () => {
    let current;
    try { current = await readConfigStrict(path, readFileImpl); }
    catch (error) {
      // 排队期间配置坏了也要给 409（与首次读取一致），不能时好时坏。
      const corrupt = error instanceof BiliError && error.code === 'CONFIG_CORRUPT';
      return json(res, corrupt ? 409 : 500, { ok: false, error: error?.code ?? 'INTERNAL_ERROR' });
    }
    if (revision !== undefined && revision !== current.revision) {
      return json(res, 409, { ok: false, error: 'STALE_REVISION', revision: current.revision });
    }
    const { config, errors } = mergeWritable(current.config, patch);
    if (errors.length) return json(res, 400, { ok: false, errors });
    await (readers.writeJsonAtomic ?? writeJsonAtomic)(path, config);
    if (config.ffmpegPath !== current.config.ffmpegPath || config.ffmpegCaFile !== current.config.ffmpegCaFile) {
      (readers.resetFfmpegCache ?? resetFfmpegCache)();
    }
    const text = `${JSON.stringify(config, null, 2)}\n`;
    return json(res, 200, { ok: true, config: publicConfig(config), revision: revisionOf(text) });
  });
  saveQueue = task.catch(() => {});
  return task;
}

/** 恢复默认：只覆盖已知设置段，`ffmpegPath` 等未知键原样保留。 */
async function resetSettings(req, res, readers) {
  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' });
  if (!trustedRequest(req)) return json(res, 403, { ok: false, error: 'FORBIDDEN', reason: explainTrustReason(req) });
  const path = join(dataDir(), 'config.json');
  const readFileImpl = readers.readFile ?? readFile;

  let loaded;
  try { loaded = await readConfigStrict(path, readFileImpl); }
  catch (error) {
    const corrupt = error instanceof BiliError && error.code === 'CONFIG_CORRUPT';
    return json(res, corrupt ? 409 : 500, { ok: false, error: error?.code ?? 'INTERNAL_ERROR' });
  }

  const task = saveQueue.then(async () => {
    // 排队期间配置可能已被别的请求改过：进队列后重新读，不要用旧快照合并。
    let fresh;
    try { fresh = await readConfigStrict(path, readFileImpl); }
    catch (error) {
      const corrupt = error instanceof BiliError && error.code === 'CONFIG_CORRUPT';
      return json(res, corrupt ? 409 : 500, { ok: false, error: error?.code ?? 'INTERNAL_ERROR' });
    }
    const defaults = {
      budget: { ...ANALYSIS_DEFAULTS.budget },
      cache: { ...ANALYSIS_DEFAULTS.cache },
      asr: { ...ANALYSIS_DEFAULTS.asr },
      ocr: { ...ANALYSIS_DEFAULTS.ocr },
      dev: { ...ANALYSIS_DEFAULTS.dev },
      extract: { ...ANALYSIS_DEFAULTS.extract },
      adaptive: { ...ANALYSIS_DEFAULTS.adaptive },
    };
    const { config, errors } = mergeWritable(fresh.config, defaults);
    if (errors.length) return json(res, 400, { ok: false, errors });
    await (readers.writeJsonAtomic ?? writeJsonAtomic)(path, config);
    const text = `${JSON.stringify(config, null, 2)}\n`;
    return json(res, 200, { ok: true, config: publicConfig(config), revision: revisionOf(text) });
  });
  saveQueue = task.catch(() => {});
  return task;
}
export async function readCache(root) { return summarizeCache(await listCacheFiles(root)); }

/**
 * 只清理**已知缓存布局**：asr 的 json、BV 目录下的图片、以及（scope=all 时）其它缓存文件。
 * 不按“目录里有什么就删什么”，避免它被误接到别处时删掉配置/凭据。
 */
export function selectForCleanup(path, scope) {
  const normalized = String(path).replaceAll('\\', '/');
  if (normalized.startsWith('/') || normalized.includes('..') || normalized.includes(':')) return false;
  const name = normalized.split('/').pop();
  const isAsr = /^asr\/[0-9a-f]{64}\.json$/.test(normalized);
  const isMedia = /^BV[0-9A-Za-z]{10}\/(cover\.img|storyboard-v2-\d+\.jpg|sprite-\d+-\d+\.jpg|inspect-\d+-\d+(?:-\d+)?\.jpg)$/.test(normalized);
  const isAvatar = /^avatar-\d+\.img$/.test(normalized);
  if (scope === 'asr') return isAsr;
  if (scope === 'media') return isMedia;
  // all：清 asr + 画面，保留头像（清了页面会闪），也不碰任何不认识的文件。
  return isAsr || isMedia || (isAvatar ? false : /^[^/]+\.(json|img|jpg)$/.test(normalized));
}

export async function clearCache(scope, readers = {}) {
  const root = join(dataDir(), 'cache');
  const lstatStat = await (readers.lstat ?? lstat)(root).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  // 缓存根目录本身是链接时直接拒绝：后面的相对路径校验挡不住“根被指到别处”这种情况。
  if (lstatStat && lstatStat.isSymbolicLink()) {
    throw new BiliError('CACHE_ROOT_UNSAFE', '缓存目录是符号链接，拒绝清理');
  }
  const files = await (readers.listCacheFiles ?? listCacheFiles)(root);
  const now = (readers.cacheNow ?? Date.now)();
  const statFile = readers.stat ?? stat;
  const unlinkFile = readers.unlink ?? unlink;
  let freedBytes = 0;
  let removedFiles = 0;
  let skipped = 0;
  for (const file of files) {
    const path = String(file.path).replaceAll('\\', '/');
    if (!selectForCleanup(path, scope)) continue;
    if (!Number.isFinite(file.mtimeMs) || now - file.mtimeMs <= 60_000) { skipped++; continue; }
    const target = join(root, path);
    try {
      // 删除前再确认一次：扫描后可能刚好有转写写进了同一个文件，按旧快照删会误删新缓存。
      const fresh = await statFile(target);
      if (now - fresh.mtimeMs <= 60_000 || fresh.size !== file.bytes) { skipped++; continue; }
      await unlinkFile(target);
      freedBytes += fresh.size;
      removedFiles++;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return { ok: true, freedBytes, removedFiles, skipped };
}

// 扫码会话与账号操作的状态：
// - 每次 start 递增 generation 并清空旧会话（避免两个二维码互相覆盖账号）；
// - logout 也清空会话，让在途的 confirmed 无法把凭据又写回来；
// - 落盘与退出走同一个串行队列，防止“确认”和“退出”交叉执行。
let qrGeneration = 0;
const qrSessions = new Map();
let authQueue = Promise.resolve();
function enqueueAuth(task) {
  const run = authQueue.then(task);
  authQueue = run.catch(() => {});
  return run;
}

async function operation(name, req, res, readers) {
  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' });
  if (!trustedRequest(req)) return json(res, 403, { ok: false, error: 'FORBIDDEN', reason: explainTrust(req).reason });
  let body;
  try {
    body = JSON.parse(await readBody(req) || '{}');
    if (!isObject(body)) throw new Error();
    if (name === 'cache/clear' && !['asr', 'media', 'all'].includes(body.scope)) throw new Error();
    if (name === 'account/qr/poll' && (typeof body.id !== 'string' || !body.id.trim() || body.id.length > 512)) throw new Error();
  } catch { return json(res, 400, { ok: false, error: 'INVALID_ARGUMENT' }); }
  try {
    if (name === 'dev/clear') { await (readers.clearDevLog ?? clearDevLog)(); return json(res, 200, { ok: true }); }
    const account = readers.auth ?? auth;
    if (name === 'cache/clear') return json(res, 200, await clearCache(body.scope, readers));
    if (name === 'account/logout') {
      qrGeneration += 1;
      qrSessions.clear();
      await enqueueAuth(() => account.logout());
      return json(res, 200, { ok: true, loggedIn: false });
    }
    if (name === 'account/qr/start') {
      qrGeneration += 1;
      qrSessions.clear();
      const { url, key } = await account.qrStart();
      const image = await (readers.toDataURL ?? QRCode.toDataURL)(url);
      // 对外只暴露会话 id；B站的 qrcode_key 留在服务端，客户端拿不到它就无法绕开会话失效。
      const id = randomUUID();
      qrSessions.set(id, { key });
      return json(res, 200, { ok: true, id, image });
    }
    const session = qrSessions.get(body.id);
    if (!session) return json(res, 409, { ok: false, error: 'QR_SESSION_INVALID' });
    const { jar } = await account.currentJar();
    const result = await account.qrPoll(session.key, jar);
    if (result.status !== 'confirmed') return json(res, 200, { ok: true, status: result.status });
    // 确认落盘前复核会话：期间可能已经 logout 或重新 start。
    const saved = await enqueueAuth(async () => {
      if (!qrSessions.has(body.id)) throw new BiliError('QR_SESSION_INVALID', '扫码会话已失效');
      const accountInfo = await account.saveLoginFromPoll(result.data, jar);
      qrSessions.delete(body.id);
      return accountInfo;
    });
    return json(res, 200, {
      ok: true,
      status: 'confirmed',
      account: { mid: saved?.mid ?? saved?.accountId, uname: saved?.uname },
    });
  } catch (error) {
    if (error instanceof BiliError && error.code === 'QR_SESSION_INVALID') {
      return json(res, 409, { ok: false, error: 'QR_SESSION_INVALID' });
    }
    return json(res, 500, { ok: false, error: 'INTERNAL_ERROR' });
  }
}

export function registerSettingsRoutes(ctx, readers = {}) {
  if (typeof ctx.inject !== 'function') return;
  return ctx.inject(['webServer', 'loader'], hostCtx => {
    const disposers = ['status', 'avatar', 'settings', 'settings/reset', 'cache/clear', 'account/logout', 'account/qr/start', 'account/qr/poll', 'history', 'dev/log', 'dev/clear', 'images', 'image'].map(name => hostCtx.webServer.register({
      kind: 'exact', path: '/bilibili-bridge/api/' + name,
      handler: async (req, res) => {
        try {
          if (name === 'dev/log') {
            if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' });
            // 日志里是工具参数与结果，读接口和写接口一样做来源校验。
            if (!trustedRequest(req)) return json(res, 403, { ok: false, error: 'FORBIDDEN', reason: explainTrust(req).reason });
            const params = new URL(req.url ?? '/', 'http://localhost').searchParams;
            const raw = Number(params.get('limit') ?? 50);
            const limit = Number.isFinite(raw) ? Math.max(1, Math.min(100, Math.trunc(raw))) : 50;
            const value = Number(params.get('since') ?? 0);
            const since = Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
            // 右侧调试台按会话过滤；不传或 all 时返回全部。
            const session = params.get('session') ?? null;
            const enabled = (readers.isDevEnabled ?? isDevEnabled)();
            // 关闭后不再回放历史内容：页面不该看到“关掉之后还留着”的旧日志。
            if (!enabled) return json(res, 200, { ok: true, enabled: false, items: [] });
            return json(res, 200, { ok: true, enabled: true, items: await (readers.snapshotDevLog ?? snapshotDevLog)({ since, limit, session }) });
          }
          // settings/reset 也含 '/'，必须排在按名字前缀分发之前。
          if (name === 'settings/reset') return await resetSettings(req, res, readers);
          if (name.includes('/')) return await operation(name, req, res, readers);
          if (name === 'settings') return await settings(req, res, readers);
          if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' });
          if (name === 'history') {
            const raw = Number(new URL(req.url ?? '/', 'http://localhost').searchParams.get('limit') ?? 20);
            const limit = Number.isFinite(raw) ? Math.max(1, Math.min(50, Math.trunc(raw))) : 20;
            return json(res, 200, { ok: true, items: await (readers.readHistory ?? readHistory)({ limit }) });
          }
          if (name === 'status') return json(res, 200, await readStatus(readers));
          // 图片缩略图条：只暴露本次进程登记的图片（路径 → 只读字节），
          // 文件名做 basename + 后缀白名单，拒绝任何路径穿越。
          if (name === 'images') {
            if (!trustedRequest(req)) return json(res, 403, { ok: false, error: 'FORBIDDEN', reason: explainTrust(req).reason });
            const params = new URL(req.url ?? '/', 'http://localhost').searchParams;
            const raw = Number(params.get('limit') ?? 12);
            const limit = Number.isFinite(raw) ? Math.max(1, Math.min(30, Math.trunc(raw))) : 12;
            return json(res, 200, { ok: true, items: (readers.listImages ?? listImages)({ limit }) });
          }
          if (name === 'image') {
            // 本地图片字节同样做来源校验，避免被任意站点 embed 读取。
            if (!trustedRequest(req)) return json(res, 403, { ok: false, error: 'FORBIDDEN', reason: explainTrust(req).reason });
            const params = new URL(req.url ?? '/', 'http://localhost').searchParams;
            const bvid = params.get('bvid') ?? '';
            const file = params.get('name') ?? '';
            // Windows 保留名（CON/NUL/COM1…）与尾随点/空格在 Windows 上会被特殊解析，直接拒绝。
            const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(file);
            const safeFile = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(file) && !file.includes('..') &&
              !/[. ]$/.test(file) && !reserved && /\.(jpg|jpeg|png|img|webp)$/i.test(file);
            if (!/^BV[0-9A-Za-z]{10}$/.test(bvid) || !safeFile) {
              return json(res, 400, { ok: false, error: 'INVALID_ARGUMENT' });
            }
            const dir = join(dataDir(), 'cache', bvid);
            const target = join(dir, file);
            // 只允许读取**本次进程登记过**的文件：即使同名文件存在，没登记也不给读。
            const registered = (readers.listImages ?? listImages)({ limit: 60 }).some((item) => item.path === target);
            if (!registered) return json(res, 404, { ok: false, error: 'NOT_FOUND' });
            try {
              // 拒绝符号链接/junction，防止 cache 目录里被塞链接指到缓存外。
              const info = await lstat(target);
              if (!info.isFile() || info.isSymbolicLink()) return json(res, 404, { ok: false, error: 'NOT_FOUND' });
            } catch {
              return json(res, 404, { ok: false, error: 'NOT_FOUND' });
            }
            let buffer;
            try { buffer = await readFile(target); }
            catch { return json(res, 404, { ok: false, error: 'NOT_FOUND' }); }
            const type = /\.png$/i.test(file) ? 'image/png' : /\.webp$/i.test(file) ? 'image/webp' : 'image/jpeg';
            res.writeHead(200, { 'content-type': type, 'cache-control': 'private, max-age=60' });
            return res.end(buffer);
          }
          const buffer = await avatar();
          res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-store' });
          res.end(buffer);
        } catch (e) {
          // 不回显上游异常文本，防止其中夹带凭据。
          json(res, name === 'avatar' ? 404 : 500, { ok: false, error: e instanceof BiliError ? e.code : 'INTERNAL_ERROR' });
        }
      },
    }));
    return () => disposers.forEach((dispose) => dispose());
  });
}
