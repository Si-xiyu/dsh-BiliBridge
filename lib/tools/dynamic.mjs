import { currentJar } from '../bili/auth.mjs';
import { BiliError } from '../bili/errors.mjs';
import { getDynamicDetail, listDynamics, SPACE_DYNAMICS, FOLLOW_DYNAMICS } from '../bili/dynamics.mjs';
import { asToolError, ok, registerTool } from './helpers.mjs';
import { attachRemoteImages } from './images.mjs';

/** 图文动态的附件与文本一起返回；没有附件时退化为纯文本，不影响结果。 */
function contentRenderer(value) {
  const { images, ...rest } = value ?? {};
  const blocks = [{ type: 'text', text: JSON.stringify(rest, null, 2) }];
  for (const image of images ?? []) {
    if (image.attachment) blocks.push({ type: 'image', attachment: image.attachment });
  }
  return blocks;
}

export function registerDynamicTools(ctx) {
  registerTool(ctx, {
    name: 'bilibili_dynamics',
    description:
      '读取用户动态（mid 省略=关注流）或单条动态详情（dynamicId）。转发动态保留 origin 索引与原图；' +
      'dynamicId + includeImages 可把当前/原动态图片作为附件返回（默认最多 3 张）。offset 原样传回 nextOffset。',
    parameters: {
      type: 'object',
      properties: {
        mid: { type: 'string', pattern: '^[1-9][0-9]*$' },
        offset: { type: 'string', maxLength: 8192 },
        pageSize: { type: 'integer', minimum: 1, maximum: 50 },
        dynamicId: { type: 'string', pattern: '^[1-9][0-9]*$', description: '读取单条动态详情；与 mid/offset/pageSize 互斥' },
        includeImages: { type: 'boolean', description: '仅 dynamicId 详情：下载当前/原动态图片并作为附件返回，默认 false' },
        maxImages: { type: 'integer', minimum: 1, maximum: 9, description: 'includeImages 时的图片上限，默认 3' },
      },
      additionalProperties: false,
    },
    timeoutMs: 90_000,
    isConcurrencySafe: () => false,
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => contentRenderer(value) },
    async execute(args, exec) {
      try {
        const { jar } = await currentJar();
        if (args?.dynamicId !== undefined) {
          if (args?.mid !== undefined || args?.offset !== undefined || args?.pageSize !== undefined) {
            throw new BiliError('INVALID_ARGUMENT', 'dynamicId 与 mid/offset/pageSize 互斥');
          }
          const detail = await getDynamicDetail({ dynamicId: args.dynamicId, jar, signal: exec?.signal });
          let imageResult = { images: [], imageAttached: false, imageChannel: 'not_requested', warnings: [] };
          if (args?.includeImages === true) {
            const maxImages = Math.min(Math.max(Number(args?.maxImages ?? 3), 1), 9);
            const urls = [...new Set([...(detail.pics ?? []), ...(detail.origin?.pics ?? [])])];
            imageResult = await attachRemoteImages(ctx, exec, urls.map((url) => ({ url })), { maxImages, namePrefix: 'dynamic' });
          }
          return {
            ...ok(detail, { source: 'polymer/web-dynamic/v1/detail' }),
            ...(imageResult.images.length ? { images: imageResult.images } : {}),
            imageAttached: imageResult.imageAttached,
            imageChannel: imageResult.imageChannel,
            warnings: imageResult.warnings,
          };
        }
        if (args?.includeImages === true) throw new BiliError('INVALID_ARGUMENT', 'includeImages 仅用于 dynamicId 详情');
        const data = await listDynamics({ ...args, jar, signal: exec?.signal });
        return ok(data, { source: args?.mid ? SPACE_DYNAMICS : FOLLOW_DYNAMICS });
      } catch (error) {
        asToolError(error);
      }
    },
  });
}
