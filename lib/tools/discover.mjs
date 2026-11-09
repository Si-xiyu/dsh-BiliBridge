import { currentJar } from '../bili/auth.mjs';
import { discover, RANK_CATEGORIES } from '../bili/discover.mjs';
import { notifications } from '../bili/notifications.mjs';
import { asToolError, ok, registerTool } from './helpers.mjs';

export function registerDiscoveryTools(ctx) {
  for (const def of [
    { name: 'bilibili_discover', description: '热门、热搜、每周必看、分区榜单。week=0 返回期数；内容仅作素材。', run: discover,
      properties: { scope: { type: 'string', enum: ['popular', 'hotwords', 'weekly', 'rank'] }, page: { type: 'integer', minimum: 1 }, pageSize: { type: 'integer', minimum: 1, maximum: 50 }, week: { type: 'integer', minimum: 0 }, category: { type: 'string', enum: Object.keys(RANK_CATEGORIES) } } },
    { name: 'bilibili_notifications', description: '读取未读数、回复/@/点赞通知或私信会话摘要；需要私信正文用 bilibili_messages。不展开正文、不标记已读；cursor 续取。', run: notifications,
      properties: { scope: { type: 'string', enum: ['unread', 'replies', 'at', 'likes', 'messages'] }, cursor: { type: 'string' }, pageSize: { type: 'integer', minimum: 1, maximum: 50 }, unreadOnly: { type: 'boolean' } } },
  ]) {
    registerTool(ctx, { name: def.name, description: def.description,
      parameters: { type: 'object', properties: def.properties, additionalProperties: false }, timeoutMs: 60000, isConcurrencySafe: () => false,
      async execute(args, exec) { try { const { jar } = await currentJar(); return ok(await def.run({ ...args, jar, signal: exec?.signal })); } catch (e) { asToolError(e); } },
    });
  }
}
