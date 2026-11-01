/**
 * 稍后观看、收藏夹、点赞工具。
 *
 * 写操作会先解析 bvid → aid，再走目标状态语义（liked=true/false、added=true/false），
 * 避免模型重试时把状态反转。
 */
import { currentJar } from '../bili/auth.mjs';
import { getVideo } from '../bili/api.mjs';
import {
  listFavoriteFolders,
  listFavoriteItems,
  listWatchLater,
  setFavorite,
  setVideoLike,
  setWatchLater,
} from '../bili/collections.mjs';
import { asToolError, ok, registerTool } from './helpers.mjs';

export function registerCollectionTools(ctx) {
  registerTool(ctx, {
    name: 'bilibili_watch_later_list',
    description:
      '读取当前账号的稍后观看列表（B站最多保留约 100 条），返回每条视频的 aid、bvid、标题、时长、进度。需要登录。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    timeoutMs: 30_000,
    isConcurrencySafe: () => false,
    async execute() {
      try {
        const { jar } = await currentJar();
        return ok(await listWatchLater({ jar }));
      } catch (error) {
        asToolError(error);
      }
    },
  });

  registerTool(ctx, {
    name: 'bilibili_watch_later_set',
    description:
      '把视频加入或移出稍后观看。added=true 加入，added=false 移除；目标状态语义，重复调用不会反转。' +
      '这是写操作，需要用户确认。',
    parameters: {
      type: 'object',
      properties: {
        bvid: { type: 'string', description: 'BV 号' },
        added: { type: 'boolean', description: 'true=加入，false=移除' },
      },
      required: ['bvid', 'added'],
      additionalProperties: false,
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => false,
    async execute(args) {
      try {
        const { jar } = await currentJar();
        const video = await getVideo(args?.bvid, { jar });
        const result = await setWatchLater({ jar, aid: video.aid, added: Boolean(args?.added) });
        return ok({ ...result, bvid: video.bvid, title: video.title });
      } catch (error) {
        asToolError(error);
      }
    },
  });

  registerTool(ctx, {
    name: 'bilibili_favorites_list',
    description:
      '读取当前账号的收藏夹。不传 mediaId 时返回收藏夹列表（id、名称、数量）；' +
      '传 mediaId 时返回该收藏夹里的视频（分页）。需要登录。',
    parameters: {
      type: 'object',
      properties: {
        mediaId: { type: 'string', description: '收藏夹 id；省略则列出收藏夹' },
        pn: { type: 'integer', description: '页码，默认 1' },
        ps: { type: 'integer', description: '每页数量，默认 20，最大 20' },
      },
      additionalProperties: false,
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => false,
    async execute(args) {
      try {
        const { jar } = await currentJar();
        if (args?.mediaId === undefined || args?.mediaId === null || args?.mediaId === '') {
          return ok(await listFavoriteFolders({ jar }));
        }
        const pn = Math.max(Number(args?.pn ?? 1), 1);
        const ps = Math.min(Math.max(Number(args?.ps ?? 20), 1), 20);
        return ok(await listFavoriteItems({ jar, mediaId: args.mediaId, pn, ps }));
      } catch (error) {
        asToolError(error);
      }
    },
  });

  registerTool(ctx, {
    name: 'bilibili_favorite_set',
    description:
      '把视频收藏到指定收藏夹，或从收藏夹移除。added=true 收藏，false 移除。' +
      'mediaId 从 bilibili_favorites_list 获取；这是写操作，需要用户确认。',
    parameters: {
      type: 'object',
      properties: {
        bvid: { type: 'string', description: 'BV 号' },
        mediaId: { type: 'string', description: '收藏夹 id' },
        added: { type: 'boolean', description: 'true=收藏，false=取消收藏' },
      },
      required: ['bvid', 'mediaId', 'added'],
      additionalProperties: false,
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => false,
    async execute(args) {
      try {
        const { jar } = await currentJar();
        const video = await getVideo(args?.bvid, { jar });
        const result = await setFavorite({
          jar,
          aid: video.aid,
          mediaId: args?.mediaId,
          added: Boolean(args?.added),
        });
        return ok({ ...result, bvid: video.bvid, title: video.title });
      } catch (error) {
        asToolError(error);
      }
    },
  });

  registerTool(ctx, {
    name: 'bilibili_video_like_set',
    description:
      '给视频点赞或取消点赞。liked=true 点赞，false 取消；目标状态语义。这是写操作，需要用户确认。',
    parameters: {
      type: 'object',
      properties: {
        bvid: { type: 'string', description: 'BV 号' },
        liked: { type: 'boolean', description: 'true=点赞，false=取消' },
      },
      required: ['bvid', 'liked'],
      additionalProperties: false,
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => false,
    async execute(args) {
      try {
        const { jar } = await currentJar();
        const video = await getVideo(args?.bvid, { jar });
        const result = await setVideoLike({ jar, aid: video.aid, liked: Boolean(args?.liked) });
        return ok({ ...result, bvid: video.bvid, title: video.title });
      } catch (error) {
        asToolError(error);
      }
    },
  });
}
