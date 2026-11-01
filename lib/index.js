/**
 * dsh-BiliBridge — DSH 工具插件入口。
 *
 * 只做装配：注册工具、挂写操作审批门禁。业务逻辑在 lib/bili/。
 */
import { registerAuthTools } from './tools/auth.mjs';
import { registerCollectionTools } from './tools/collection.mjs';
import { registerExtractTools } from './tools/extract.mjs';
import { registerVideoTools } from './tools/video.mjs';
import { registerSearchTools } from './tools/search.mjs';
import { registerCommentsTools } from './tools/comments.mjs';
import { registerUserTools } from './tools/user.mjs';
import { registerDynamicTools } from './tools/dynamic.mjs';

export const name = 'bilibili';
export const inject = ['tools'];

/** 需要人工确认的写操作（目标状态语义）。 */
const WRITE_TOOLS = new Map([
  ['bilibili_watch_later_set', '加入/移出稍后观看'],
  ['bilibili_favorite_set', '收藏/取消收藏'],
  ['bilibili_video_like_set', '点赞/取消点赞'],
]);

/**
 * @param {any} ctx
 */
export function apply(ctx) {
  // 代码层审批：不依赖提示词。没有 approval 通道时 DSH 会 fail closed。
  ctx.on(
    'tools/pre-execute',
    async (exec, next) => {
      const label = WRITE_TOOLS.get(exec.name);
      if (!label) return next();
      return { kind: 'ask', reason: `B站写操作：${label}。请确认目标视频与参数。` };
    },
    { prepend: true },
  );

  registerAuthTools(ctx);
  registerVideoTools(ctx);
  registerCollectionTools(ctx);
  registerExtractTools(ctx);
  registerSearchTools(ctx);
  registerCommentsTools(ctx);
  registerUserTools(ctx);
  registerDynamicTools(ctx);
}
