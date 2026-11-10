/**
 * 本次进程内工具产出的图片登记表（内存环形缓冲）。
 *
 * 用途：`bilibili_extract` / `bilibili_inspect` 把图片落盘后登记一条，
 * 客户端底部缩略图条（`shell.bottom`）轮询 `/bilibili-bridge/api/images` 展示，
 * 这样"模型调完工具，图就出现在会话里"，不需要模型再复述路径。
 *
 * 只存路径与元数据，不存图片字节；进程重启即清空（图片文件仍在磁盘缓存里）。
 */
import { basename } from 'node:path';

const MAX = 60;
let entries = [];

export function recordImage({ path, kind = 'image', bvid, name, mediaType = 'image/jpeg', at = Date.now(), sessionId = null } = {}) {
  if (typeof path !== 'string' || !path || typeof bvid !== 'string' || !bvid) return null;
  const item = { path, name: name ?? basename(path), kind, bvid, mediaType, at, sessionId };
  // 同一文件重复产出时移到末尾，避免缩略图条重复。
  entries = entries.filter((entry) => entry.path !== path);
  entries.push(item);
  if (entries.length > MAX) entries = entries.slice(-MAX);
  return item;
}

export function listImages({ limit = 12 } = {}) {
  // 显式 0/负数也按 1 处理，不要静默回退到默认值。
  const bounded = Math.min(MAX, Math.max(1, Number.isFinite(Number(limit)) ? Math.trunc(Number(limit)) : 12));
  return structuredClone(entries.slice(-bounded).reverse());
}

export function clearImages() { entries = []; }
