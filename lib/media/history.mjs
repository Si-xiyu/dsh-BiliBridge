import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dataDir, withLock } from '../bili/store.mjs';

const KEEP_LINES = 200;

export function parseHistory(text, limit = 20) {
  const items = [];
  for (const line of text.split('\n')) {
    try {
      const value = JSON.parse(line);
      if (value && typeof value === 'object' && !Array.isArray(value)) items.push(value);
    } catch {}
  }
  return items.slice(-limit).reverse();
}

/**
 * 追加一条调用记录，并把文件裁到最近 200 行。
 *
 * 两层保护：
 * - 进程内队列：同一进程里 250 条并发也不会互相抢锁；
 * - 跨进程文件锁 + 临时文件改名：主工作区与其它会话共用数据目录时，避免读快照后覆盖丢记录。
 */
let queue = Promise.resolve();

export function appendHistory(entry) {
  const dir = dataDir();
  const file = join(dir, 'history.jsonl');
  const task = queue
    .then(() => mkdir(dir, { recursive: true }).catch(() => {}))
    .then(() => withLock(join(dir, 'history.lock'), async () => {
      await appendFile(file, JSON.stringify(entry) + '\n', { mode: 0o600 });
      const text = await readFile(file, 'utf8');
      const lines = text.trimEnd().split('\n');
      if (lines.length <= KEEP_LINES) return;
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, lines.slice(-KEEP_LINES).join('\n') + '\n', { mode: 0o600 });
      await rename(tmp, file);
    }, { timeoutMs: 10_000 }))
    .catch(() => { console.warn('[bilibili] 写入调用记录失败'); });
  queue = task;
  return task;
}

export async function readHistory({ limit = 20 } = {}) {
  const bounded = Math.min(200, Math.max(1, Math.trunc(Number(limit)) || 20));
  try { return parseHistory(await readFile(join(dataDir(), 'history.jsonl'), 'utf8'), bounded); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
