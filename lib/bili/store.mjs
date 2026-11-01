/**
 * 本地状态：凭据、原子写、文件锁。
 *
 * 凭据文件只允许当前用户访问；写入走 tmp + rename；并发用 lock 文件。
 */
import { execFile } from 'node:child_process';
import { chmod, mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** 数据目录：默认 ~/.dsh/bilibili，可用 BILI_DATA_DIR 覆盖（开发用）。 */
export function dataDir() {
  return process.env.BILI_DATA_DIR || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'bilibili');
}

export function credentialsPath() {
  return join(dataDir(), 'credentials.json');
}

export async function readJson(file, fallback = null) {
  try {
    const text = await readFile(file, 'utf8');
    // Windows 上的编辑器/命令行常写 BOM，JSON.parse 会直接失败，
    // 配置就会“悄悄不生效”。这里统一剥掉。
    return JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

/**
 * 只允许当前用户访问该文件。
 *
 * POSIX 用 0600；Windows 上 mode 只映射到只读位，必须显式改 ACL，否则
 * “凭据 0600”只是一句空话。失败不阻断写凭据（否则登录整个坏掉），但会打日志。
 * @param {string} file
 */
export async function restrictFile(file) {
  if (process.platform === 'win32') {
    const user = process.env.USERNAME;
    if (!user) return;
    const principal = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${user}` : user;
    try {
      await execFileAsync('icacls', [file, '/inheritance:r', '/grant:r', `${principal}:(F)`], {
        windowsHide: true,
      });
    } catch (error) {
      console.warn(`[bilibili] 收紧 ${file} 的访问权限失败：${error?.message ?? error}`);
    }
    return;
  }
  await chmod(file, 0o600);
}

export async function writeJsonAtomic(file, value, { mode = 0o600 } = {}) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  await restrictFile(tmp);
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
