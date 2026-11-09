/**
 * 工具层图片附件公共件。
 *
 * 图片只有在“宿主有 attachments 服务 + 当前模型声明 image 输入”时才放进 tool result；
 * 否则只返回 URL/本地路径，绝不把回合打崩。
 */
import { fetchBuffer } from '../bili/http.mjs';

export async function imageCapability(ctx, exec) {
  const attachments = ctx?.get?.('attachments');
  const llm = ctx?.get?.('llm');
  const provider = exec?.agent?.options?.provider;
  const model = exec?.agent?.options?.model;
  if (!attachments) return { ok: false, reason: 'attachments_service_unavailable' };
  if (!llm || !provider || !model) return { ok: false, reason: 'model_route_unknown' };
  try {
    const info = await llm.resolveModelInfo(provider, model, exec?.signal);
    if (!info?.inputModalities?.includes('image')) return { ok: false, reason: 'model_text_only' };
    return { ok: true, attachments, model, provider };
  } catch {
    return { ok: false, reason: 'model_info_failed' };
  }
}

export function mediaTypeOf(contentType, url) {
  const type = String(contentType ?? '').split(';', 1)[0].trim().toLowerCase();
  if (type.startsWith('image/')) return type;
  const match = /\.([a-z0-9]+)(?:[?#]|$)/i.exec(String(url ?? ''));
  const ext = match?.[1]?.toLowerCase();
  if (ext === 'png') return 'image/png';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  return 'image/jpeg';
}

/**
 * 下载远程图片并按宿主能力转成附件。
 *
 * 上限既有张数也有单张字节数；任何一张失败只记 warning，不影响文本结果。
 * @param {{url?: string, src?: string, width?: number, height?: number}[]} items
 */
export async function attachRemoteImages(ctx, exec, items, { maxImages = 9, maxBytes = 10 * 1024 * 1024, namePrefix = 'dynamic' } = {}) {
  const capability = await imageCapability(ctx, exec);
  const candidates = [];
  for (const item of (items ?? []).slice(0, maxImages)) {
    const url = item?.url ?? item?.src;
    if (typeof url !== 'string' || !url) continue;
    candidates.push({
      url,
      ...(item.width ? { width: item.width } : {}),
      ...(item.height ? { height: item.height } : {}),
    });
  }
  // 模型不支持图片或宿主没有附件服务时，下载了也用不上；直接返回 URL，
  // 避免 9 张图在慢 CDN 上把工具的总预算耗光。
  if (!capability.ok) {
    return {
      images: candidates.map((item) => ({ kind: `${namePrefix}-image`, ...item })),
      imageAttached: false,
      imageChannel: capability.reason,
      warnings: [],
    };
  }
  const images = [];
  const warnings = [];
  for (const [index, item] of candidates.entries()) {
    let buffer;
    let contentType = '';
    try {
      const fetched = await fetchBuffer(item.url, { maxBytes, signal: exec?.signal });
      buffer = fetched.buffer;
      contentType = fetched.contentType;
    } catch (error) {
      warnings.push({ code: 'IMAGE_FETCH_FAILED', message: String(error?.message ?? error).slice(0, 200), url: item.url });
      images.push({ kind: `${namePrefix}-image`, ...item });
      continue;
    }
    let attachment;
    const limits = capability.attachments.imageLimits;
    if (!limits || buffer.byteLength <= limits.maxImageBytes) {
      try {
        attachment = await capability.attachments.saveImage({
          data: buffer,
          mediaType: mediaTypeOf(contentType, item.url),
          name: `${namePrefix}-${index + 1}.jpg`,
        });
      } catch (error) {
        warnings.push({ code: 'IMAGE_ATTACH_FAILED', message: String(error?.message ?? error).slice(0, 200), url: item.url });
      }
    } else {
      warnings.push({ code: 'BUDGET_EXCEEDED', message: '图片超过宿主大小限制', url: item.url });
    }
    images.push({
      kind: `${namePrefix}-image`,
      ...item,
      ...(attachment ? { attachment } : {}),
    });
  }
  return {
    images,
    imageAttached: images.some((image) => image.attachment),
    imageChannel: 'attached',
    warnings,
  };
}
