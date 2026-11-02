import { readdir, stat, readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as auth from './bili/auth.mjs';
import { dataDir } from './bili/store.mjs';
import { fetchBuffer } from './bili/http.mjs';
import { BiliError } from './bili/errors.mjs';
import { resolveToolchain } from './media/ffmpeg.mjs';
import { resolveAsr } from './media/asr.mjs';
import { listAnalyses } from './media/budget.mjs';

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
      if (e.isDirectory()) await walk(join(dir, e.name), relative + '/');
      else if (e.isFile()) files.push({ path: relative, bytes: (await stat(join(dir, e.name))).size });
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
  // 未登录/目录损坏时页面应该显示“未知”，而不是整页 500；数组和对象要分开兜。
  const safeObject = async (reader, fallback) => {
    try { return { ...(await reader()), ok: true }; }
    catch (e) { return { ...fallback, ok: false, code: e instanceof BiliError ? e.code : 'INTERNAL_ERROR' }; }
  };
  const safeList = async (reader) => {
    try { const value = await reader(); return Array.isArray(value) ? value : []; }
    catch { return []; }
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
async function avatar() {
  const { jar } = await auth.currentJar();
  const nav = await auth.navInfo(jar);
  if (!/^\d+$/.test(String(nav.mid))) throw new BiliError('NOT_FOUND', '头像不可用');
  const file = join(dataDir(), 'cache', 'avatar-' + nav.mid + '.img');
  try { if (Date.now() - (await stat(file)).mtimeMs < 86400000) return await readFile(file); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  const url = new URL(nav.face);
  if (url.protocol !== 'https:' || !/(^|\.)hdslb\.com$/.test(url.hostname)) throw new BiliError('NOT_FOUND', '头像不可用');
  const { buffer } = await fetchBuffer(url.toString(), { jar, referer: 'https://www.bilibili.com/' });
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
          res.writeHead(200, { 'content-type': 'image/jpeg' });
          res.end(buffer);
        } catch (e) {
          // 不回显上游异常文本，防止其中夹带凭据。
          json(res, name === 'avatar' ? 404 : 500, { ok: false, error: e instanceof BiliError ? e.code : 'INTERNAL_ERROR' });
        }
      }
    }));
    return () => disposers.forEach(dispose => dispose());
  });
}
