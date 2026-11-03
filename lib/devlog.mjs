import { readFileSync } from 'node:fs';
import { appendFile, mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { dataDir, withLock } from './bili/store.mjs';

const SECRET = /cookie|sessdata|bili_jct|csrf|token|sign|upsig|deadline|playurl|face/i;
let entries = [], nextId = 0, queue = Promise.resolve();

export function isDevEnabled() {
  try { return JSON.parse(readFileSync(join(dataDir(), 'config.json'), 'utf8').replace(/^\uFEFF/, '')).dev?.enabled === true; }
  catch { return false; }
}

function redact(value, seen = new WeakSet()) {
  if (typeof value === 'string') {
    // 工具返回中也有 JSON 文本信封，先解析才能按键脱敏。
    try { return JSON.stringify(redact(JSON.parse(value), seen)); } catch {}
    return value.replace(/https?:\/\/[^\s"'<>\\]+/gi, url => /upsig=|deadline=/i.test(url) ? '[redacted-url]' : url)
      .replace(/((?:cookie|sessdata|bili_jct|csrf|token|sign|upsig|deadline|playurl|face)\s*[=:]\s*)[^\s,;"'<>]+/gi, '$1[redacted]');
  }
  if (!value || typeof value !== 'object') return typeof value === 'bigint' ? String(value) : value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  const result = Array.isArray(value) ? value.map(v => redact(v, seen)) : Object.fromEntries(Object.entries(value).map(([key, v]) => [key, SECRET.test(key) ? '[redacted]' : redact(v, seen)]));
  seen.delete(value);
  return result;
}
function clip(text, bytes) {
  let result = '';
  for (const char of text) { if (Buffer.byteLength(result + char) > bytes) break; result += char; }
  return result;
}
function enqueue(dir, task) {
  const run = queue.then(async () => {
    await mkdir(dir, { recursive: true });
    await withLock(join(dir, 'devlog.lock'), task, { timeoutMs: 10000 });
  }).catch(() => console.warn('[bilibili] 开发日志 I/O 失败'));
  queue = run;
  return run;
}
export function recordToolCall({ tool, args, ok, errorCode, durationMs, result }) {
  if (!isDevEnabled()) return;
  try {
    const raw = JSON.stringify(result) ?? '';
    const safeArgs = redact(args ?? {});
    const argsText = JSON.stringify(safeArgs);
    const preview = JSON.stringify(redact(result)) ?? '';
    const truncated = Buffer.byteLength(argsText) > 2048 || Buffer.byteLength(preview) > 4096;
    // 超限参数仍保持对象形状，并为 JSON 引号和转义留出空间。
    let boundedArgs = safeArgs;
    if (Buffer.byteLength(argsText) > 2048) {
      boundedArgs = { preview: clip(argsText, 1900) };
      while (Buffer.byteLength(JSON.stringify(boundedArgs)) > 2048) boundedArgs.preview = boundedArgs.preview.slice(0, -1);
    }
    const entry = { id: ++nextId, at: new Date().toISOString(), tool, args: boundedArgs, ok, ...(errorCode === undefined ? {} : { errorCode: redact(String(errorCode)) }), durationMs, resultBytes: Buffer.byteLength(raw), resultPreview: clip(preview, 4096), ...(truncated ? { truncated: true } : {}) };
    entries.push(entry);
    if (entries.length > 200) entries.shift();
    const dir = dataDir(), file = join(dir, 'devlog.jsonl');
    return enqueue(dir, async () => {
      await appendFile(file, JSON.stringify(entry) + '\n', { mode: 0o600 });
      const lines = (await readFile(file, 'utf8')).trimEnd().split('\n');
      if (lines.length <= 500) return;
      const tmp = `${file}.${randomUUID()}.tmp`;
      try { await writeFile(tmp, lines.slice(-500).join('\n') + '\n', { mode: 0o600 }); await rename(tmp, file); }
      finally { await unlink(tmp).catch(() => {}); }
    });
  } catch { console.warn('[bilibili] 开发日志记录失败'); }
}
export function snapshotDevLog({ since = 0, limit = 50 } = {}) {
  return structuredClone(entries.filter(item => item.id > since).slice(-Math.min(200, Math.max(1, Math.trunc(limit) || 50))).reverse());
}
export function clearDevLog() {
  entries = [];
  const dir = dataDir();
  return enqueue(dir, () => writeFile(join(dir, 'devlog.jsonl'), '', { mode: 0o600 }));
}
