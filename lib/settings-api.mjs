import { readdir, stat, readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as auth from './bili/auth.mjs';
import { dataDir } from './bili/store.mjs';
import { DEFAULT_REFERER, USER_AGENT } from './bili/http.mjs';
import { BiliError } from './bili/errors.mjs';
import { resolveToolchain } from './media/ffmpeg.mjs';
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

export async function readCache(root = join(dataDir(), 'cache')) {
  const files = [];
  async function walk(dir, prefix = '') {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); }
    catch (e) { if (e.code === 'ENOENT') return; throw e; }
    for (const e of entries) {
      const relative = prefix + e.name;
      if (e.isDirectory()) { await walk(join(dir, e.name), relative + '/'); continue; }
      if (!e.isFile()) continue;
      try { files.push({ path: relative, bytes: (await stat(join(dir, e.name))).size }); }
      // 扫描过程中缓存被清理是常态（P3 就有清理按钮），单个文件消失不该让整次统计失败。
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  await walk(root);
  return summarizeCache(files);
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
export function registerSettingsRoutes(ctx, readers = {}) {
  if (typeof ctx.inject !== 'function') return;
  return ctx.inject(['webServer', 'loader'], hostCtx => {
    const disposers = ['status', 'avatar'].map(name => hostCtx.webServer.register({
      kind: 'exact', path: '/bilibili-bridge/api/' + name,
      handler: async (req, res) => {
        try {
          if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' });
          if (name === 'status') return json(res, 200, await readStatus(readers));
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
