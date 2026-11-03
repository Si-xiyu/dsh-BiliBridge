import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dataDir } from '../bili/store.mjs';

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

let queue = Promise.resolve();
export function appendHistory(entry) {
  const dir = dataDir();
  const file = join(dir, 'history.jsonl');
  // 串行追加和裁剪，避免同进程并发调用时互相覆盖记录。
  const task = queue.then(async () => {
    await mkdir(dir, { recursive: true });
    await appendFile(file, JSON.stringify(entry) + '\n', { mode: 0o600 });
    const lines = (await readFile(file, 'utf8')).trimEnd().split('\n');
    if (lines.length > 200) await writeFile(file, lines.slice(-200).join('\n') + '\n');
  }).catch(() => { console.warn('[bilibili] 写入调用记录失败'); });
  queue = task;
  return task;
}

export async function readHistory({ limit = 20 } = {}) {
  await queue;
  try { return parseHistory(await readFile(join(dataDir(), 'history.jsonl'), 'utf8'), Math.max(1, Math.trunc(limit) || 20)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
