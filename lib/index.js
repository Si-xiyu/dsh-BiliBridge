import { registerSettingsRoutes } from './settings-api.mjs';
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
import { registerTranscribeTools } from './tools/transcribe.mjs';
import { registerDiscoveryTools } from './tools/discover.mjs';
import { registerSendTools } from './tools/send.mjs';
import { registerCollectTools } from './tools/collect.mjs';
import { prepareImages } from './bili/publish.mjs';

export const name = 'bilibili';
export const inject = ['tools'];

/** 需要人工确认的写操作（目标状态语义）。 */
const WRITE_TOOLS = new Map([
  ['bilibili_watch_later_set', '加入/移出稍后观看'],
  ['bilibili_favorite_set', '收藏/取消收藏'],
  ['bilibili_video_like_set', '点赞/取消点赞'],
  ['bilibili_comment_send', '发送评论/回复'],
  ['bilibili_message_send', '发送私信'],
  ['bilibili_dynamic_publish', '发布动态'],
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
      // 默认是 dry-run 预览（只回读状态，不发写请求）：没有副作用就不该打扰用户。
      // 只有显式 intent=apply 才真正需要审批。
      const intent = exec?.args?.intent;
      if (intent === undefined || intent === 'preview') return next();
      if (intent === 'check' && ['bilibili_comment_send', 'bilibili_message_send', 'bilibili_dynamic_publish'].includes(exec.name)) return next();
      const files = exec.name === 'bilibili_dynamic_publish' && intent === 'apply'
        ? (await prepareImages(exec.args.images ?? [])).map(f => f.manifest) : undefined;
      const { previewToken, ...details } = exec.args ?? {};
      return { kind: 'ask', reason: `B站写操作：${label}。请确认目标、正文与参数：${JSON.stringify({ ...details, ...(files ? { images: files } : {}) })}` };
    },
    { prepend: true },
  );

  registerAuthTools(ctx);
  registerVideoTools(ctx);
  registerCollectionTools(ctx);
  registerExtractTools(ctx);
  registerTranscribeTools(ctx);
  registerSearchTools(ctx);
  registerCommentsTools(ctx);
  registerUserTools(ctx);
  registerDynamicTools(ctx);
  registerDiscoveryTools(ctx);
  registerSendTools(ctx);
  registerCollectTools(ctx);
  registerSettingsRoutes(ctx);
}
