import { readFileSync, statSync } from 'node:fs';
import { appendFile, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { dataDir, restrictFile, withLock } from './bili/store.mjs';

// 命中这些键名的值一律不回显；authorization / access_key 这类也别放过。
const SECRET_KEY = /cookie|sessdata|bili_jct|csrf|token|sign|upsig|deadline|playurl|face|authorization|access_key|refresh_token|bili_ticket|^sid$/i;
const SECRET_TEXT = /(sessdata|bili_jct|bili_ticket|access_key|refresh_token|authorization|csrf|token|upsig|deadline)\s*[=:]\s*[^\s,;"'<>]+/gi;
// 形如 JWT / 长 base64 的不透明串：与其猜它是不是凭据，不如直接打码。
const OPAQUE = /\b[A-Za-z0-9+/_-]{40,}={0,2}\b/g;

const MAX_ARGS_BYTES = 2048;
const MAX_PREVIEW_BYTES = 4096;
const TRIM_BYTES = 256 * 1024;
const TRIM_LINES = 500;

let entries = [];
let nextId = 0;
let queue = Promise.resolve();
// 进程内计数：攒够 TRIM_LINES 行就裁剪一次，避免每次调用都读全文；
// 文件大小超过 TRIM_BYTES 时作为跨进程兜底再检查一次。
let appendedSinceTrim = 0;
// icacls 在 Windows 上每次几十毫秒，只在新建/替换文件后收紧一次权限即可。
let securedFile = '';

// 每次工具调用都读盘代价不小；缓存 2 秒，配置改动最迟 2 秒后生效。
let enabledCache = { value: false, at: 0 };
export function isDevEnabled() {
  const now = Date.now();
  if (now - enabledCache.at < 2000) return enabledCache.value;
  let value = false;
  try {
    value = JSON.parse(readFileSync(join(dataDir(), 'config.json'), 'utf8').replace(/^\uFEFF/, '')).dev?.enabled === true;
  } catch {}
  enabledCache = { value, at: now };
  return value;
}
export function resetDevEnabledCache() { enabledCache = { value: false, at: 0 }; }

function clipBytes(text, bytes) {
  let result = '';
  for (const char of text) {
    if (Buffer.byteLength(result + char) > bytes) return { text: result, truncated: true };
    result += char;
  }
  return { text: result, truncated: false };
}

/**
 * 文本脱敏。
 *
 * 策略从“逐字段抠 JSON”改成**粗粒度**：只要这段文本里出现凭据字段的赋值
 * （`"bili_jct":` / `sessdata=` / `cookie:` 等），整段替换成 [redacted-text]。
 * 原因：转义引号、内部花括号、URL 编码等变体太多，逐字段匹配总能在某个变体上
 * 截断并把秘密留在后半段；预览是调试用途，整段抹掉比漏一个更可接受。
 * 没有字段赋值、只是正文里提到 cookie 这类词的内容会原样保留。
 */
const SECRET_FIELD = /(?:^|[\s{,;([<])(["']?)(sessdata|bili_jct|bili_ticket|access_key|refresh_token|authorization|csrf|token|upsig|deadline|cookie|playurl|face|sid)\1\s*[:=]/i;

function scrubText(text) {
  let out = text;
  // 先按 URL 解码：SESSDATA%3Dxxx 这类会被漏掉。
  try {
    const decoded = decodeURIComponent(out);
    if (decoded !== out) out = decoded;
  } catch {}
  // 还原被转义过的引号，否则 \"bili_jct\":\"...\" 完全匹配不到。
  out = out.replace(/\\"/g, '"');
  if (SECRET_FIELD.test(out)) return '[redacted-text]';
  // 没有凭据字段赋值时，再处理 URL 签名与形似 token 的长串。
  return out
    .replace(/https?:\/\/[^\s"'<>\\]+/gi, (url) => (/upsig=|deadline=/i.test(url) ? '[redacted-url]' : url))
    .replace(SECRET_TEXT, '$1=[redacted]')
    .replace(/\b([A-Za-z0-9_-]+)%3D([^&\s"'<>]+)/gi, (match, key) => (SECRET_KEY.test(key) ? `${key}%3D[redacted]` : match))
    .replace(OPAQUE, (token) => (/^[A-Za-z0-9+/=_-]+$/.test(token) ? '[redacted-token]' : token));
}

function redact(value, depth = 0, seen = new WeakSet()) {
  if (depth > 6) return '[depth-limit]';
  if (typeof value === 'string') {
    // 工具返回里常有 JSON 文本信封，先解析才能按键脱敏。
    if (value.length <= 64 * 1024) {
      try { return redact(JSON.parse(value), depth + 1, seen); } catch {}
    }
    return scrubText(value);
  }
  if (typeof value === 'bigint') return String(value);
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  let out;
  if (Array.isArray(value)) {
    // ["Cookie","secret"] 这种成对数组：键是敏感名时，值也打码。
    out = value.map((item, index) => {
      if (typeof item === 'string' && index % 2 === 1 && typeof value[index - 1] === 'string' && SECRET_KEY.test(value[index - 1])) {
        return '[redacted]';
      }
      return redact(item, depth + 1, seen);
    });
  } else {
    out = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SECRET_KEY.test(key) ? '[redacted]' : redact(item, depth + 1, seen)]));
  }
  seen.delete(value);
  return out;
}

function enqueue(dir, task) {
  const run = queue
    .then(async () => {
      await mkdir(dir, { recursive: true });
      await withLock(join(dir, 'devlog.lock'), task, { timeoutMs: 10_000 });
    })
    .catch(() => console.warn('[bilibili] 开发日志 I/O 失败'));
  queue = run;
  return run;
}

function buildEntry({ tool, args, ok, errorCode, durationMs, result }) {
  const raw = (() => { try { return JSON.stringify(result) ?? ''; } catch { return ''; } })();
  const safeArgs = redact(args ?? {});
  const argsText = (() => { try { return JSON.stringify(safeArgs); } catch { return '{}'; } })();
  const argsClip = clipBytes(argsText, MAX_ARGS_BYTES);
  const previewSource = (() => { try { return JSON.stringify(redact(result)) ?? ''; } catch { return ''; } })();
  const previewClip = clipBytes(previewSource, MAX_PREVIEW_BYTES);
  return {
    id: ++nextId,
    at: new Date().toISOString(),
    tool,
    // 超限时保持对象形状，避免前端拿到字符串还要猜
    args: argsClip.truncated ? { preview: clipBytes(argsText, MAX_ARGS_BYTES - 40).text } : safeArgs,
    ok,
    ...(errorCode === undefined ? {} : { errorCode: scrubText(String(errorCode)) }),
    durationMs,
    resultBytes: Buffer.byteLength(raw),
    resultPreview: previewClip.text,
    ...(argsClip.truncated || previewClip.truncated ? { truncated: true } : {}),
  };
}

/**
 * 记录一次工具调用。**不阻塞工具返回**：内存先记，落盘丢给后台队列。
 * 开发者模式关闭时立即返回（开关有 2 秒缓存）。
 */
export function recordToolCall(payload) {
  if (!isDevEnabled()) return Promise.resolve();
  let entry;
  try {
    entry = buildEntry(payload);
  } catch {
    console.warn('[bilibili] 开发日志记录失败');
    return;
  }
  entries.push(entry);
  if (entries.length > 200) entries.shift();
  const dir = dataDir();
  const file = join(dir, 'devlog.jsonl');
  // 返回 promise 只为测试能等落盘；工具层不 await 它。
  return enqueue(dir, async () => {
    await appendFile(file, JSON.stringify(entry) + '\n', { mode: 0o600 });
    if (securedFile !== file) { await restrictFile(file); securedFile = file; }
    // 只在文件明显变大时才读全文裁剪，避免每次调用都整文件重写。
    appendedSinceTrim += 1;
    const info = await stat(file).catch(() => null);
    if (appendedSinceTrim < TRIM_LINES && (!info || info.size <= TRIM_BYTES)) return;
    const lines = (await readFile(file, 'utf8')).trimEnd().split('\n');
    if (lines.length <= TRIM_LINES) return;
    const tmp = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, lines.slice(-TRIM_LINES).join('\n') + '\n', { mode: 0o600 });
      await restrictFile(tmp);
      await rename(tmp, file);
      securedFile = file;
    } finally {
      await unlink(tmp).catch(() => {});
    }
  });
}

export function snapshotDevLog({ since = 0, limit = 50 } = {}) {
  const bounded = Math.min(200, Math.max(1, Math.trunc(limit) || 50));
  return structuredClone(entries.filter((item) => item.id > since).slice(-bounded).reverse());
}

export function clearDevLog() {
  entries = [];
  resetDevEnabledCache();
  const dir = dataDir();
  return enqueue(dir, async () => {
    const file = join(dir, 'devlog.jsonl');
    await writeFile(file, '', { mode: 0o600 });
    await restrictFile(file);
    securedFile = file;
  });
}

/** 供测试/诊断：文件大小（不读内容）。 */
export function devLogStat(file = join(dataDir(), 'devlog.jsonl')) {
  try { return statSync(file).size; } catch { return 0; }
}
