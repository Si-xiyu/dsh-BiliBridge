/**
 * 本地状态：凭据、原子写、文件锁。
 *
 * 凭据文件权限 0600；写入走 tmp + rename；并发用 lock 文件。
 */
import { chmod, mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** 数据目录：默认 ~/.dsh/bilibili，可用 BILI_DATA_DIR 覆盖（开发用）。 */
export function dataDir() {
  return process.env.BILI_DATA_DIR || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'bilibili');
}

export function credentialsPath() {
  return join(dataDir(), 'credentials.json');
}

export async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export async function writeJsonAtomic(file, value, { mode = 0o600 } = {}) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  await chmod(tmp, mode);
  await rename(tmp, file);
}

async function statSafe(path) {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

/**
 * 跨进程文件锁。
 * @template T
 * @param {string} lockPath
 * @param {() => Promise<T>} fn
 * @param {{timeoutMs?: number, staleMs?: number}} [options]
 * @returns {Promise<T>}
 */
export async function withLock(lockPath, fn, options = {}) {
  const timeoutMs = options.timeoutMs ?? 3000;
  const staleMs = options.staleMs ?? 30_000;
  const deadline = Date.now() + timeoutMs;

  let handle;
  while (!handle) {
    try {
      handle = await open(lockPath, 'wx');
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const info = await statSafe(lockPath);
      if (info && Date.now() - info.mtimeMs > staleMs) {
        await unlink(lockPath).catch(() => {});
        continue;
      }
      if (Date.now() > deadline) throw new Error(`获取锁超时：${lockPath}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  try {
    return await fn();
  } finally {
    await handle.close().catch(() => {});
    await unlink(lockPath).catch(() => {});
  }
}

/**
 * 读取凭据。
 * @returns {Promise<null | {version:number, accountId?:string, cookies:Record<string,string>, refreshToken?:string, savedAt?:number}>}
 */
export async function loadCredentials() {
  const parsed = await readJson(credentialsPath(), null);
  if (!parsed || typeof parsed !== 'object' || typeof parsed.cookies !== 'object' || !parsed.cookies) return null;
  return parsed;
}

export async function saveCredentials(credentials) {
  const file = credentialsPath();
  await withLock(`${file}.lock`, () =>
    writeJsonAtomic(file, { version: 1, ...credentials, savedAt: Date.now() }),
  );
}

export async function clearCredentials() {
  const file = credentialsPath();
  await withLock(`${file}.lock`, () => writeJsonAtomic(file, { version: 1, cookies: {} }));
}
