/**
 * 账号与视频只读工具。
 */
import { currentJar } from '../bili/auth.mjs';
import { getCurrentUser, getVideo, listUserVideos } from '../bili/api.mjs';
import { asToolError, ok, registerTool, resolveMid } from './helpers.mjs';

export function registerVideoTools(ctx) {
  registerTool(ctx, {
    name: 'bilibili_me',
    description:
      '获取当前登录的 B站账号（mid、昵称、等级、VIP）。未登录时返回 loggedIn=false，不报错。' +
      '当用户问“我的账号”“我是谁”或需要 mid 时使用。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    timeoutMs: 20_000,
    isConcurrencySafe: () => true,
    async execute() {
      try {
        const { jar } = await currentJar();
        const me = await getCurrentUser({ jar });
        if (!me) return ok({ loggedIn: false, hint: '还没有登录，请先调用 bilibili_auth_begin' });
        return ok({ loggedIn: true, ...me });
      } catch (error) {
        asToolError(error);
      }
    },
  });

  registerTool(ctx, {
    name: 'bilibili_video',
    description:
      '按 BV 号读取视频元数据与当前统计：标题、UP 主、发布时间、时长、分 P、播放/点赞/收藏/评论数。' +
      '不需要登录。stat 来自 B站缓存，可能滞后数分钟；fetchedAt 是本次抓取时间，回答“现在多少播放量”时要一并说明。',
    parameters: {
      type: 'object',
      properties: {
        bvid: { type: 'string', description: 'BV 号，例如 BV1GJ411x7h7' },
      },
      required: ['bvid'],
      additionalProperties: false,
    },
    timeoutMs: 20_000,
    isConcurrencySafe: () => true,
    async execute(args) {
      try {
        const { jar } = await currentJar();
        const video = await getVideo(args?.bvid, { jar });
        return ok(video, { source: 'web-interface/view', cache: 'bypass' });
      } catch (error) {
        asToolError(error);
      }
    },
  });

  registerTool(ctx, {
    name: 'bilibili_user_videos',
    description:
      '读取某个用户的投稿列表（按发布时间倒序）。mid 省略时用当前登录账号，适合回答“我最新发的视频”。' +
      '重要：置顶投稿会排在列表第一位，判断“最新”必须看 created 字段，不能直接取 items[0]。' +
      '没有投稿时返回空列表，不要再去请求不存在的视频。',
    parameters: {
      type: 'object',
      properties: {
        mid: { type: 'string', description: '用户 mid；省略则使用当前登录账号' },
        pn: { type: 'integer', description: '页码，默认 1' },
        ps: { type: 'integer', description: '每页数量，默认 10，最大 20' },
        keyword: { type: 'string', maxLength: 100 },
        order: {
          type: 'string',
          enum: ['pubdate', 'click', 'stow'],
          description: '排序：pubdate=发布时间，click=播放量，stow=收藏数；默认 pubdate',
        },
      },
      additionalProperties: false,
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => false,
    async execute(args) {
      try {
        const { jar } = await currentJar();
        const mid = await resolveMid(args?.mid, jar);
        const pn = Math.max(Number(args?.pn ?? 1), 1);
        const ps = Math.min(Math.max(Number(args?.ps ?? 10), 1), 20);
        const order = ['pubdate', 'click', 'stow'].includes(args?.order) ? args.order : 'pubdate';
        const list = await listUserVideos(mid, { pn, ps, order, keyword: args?.keyword, jar });
        return ok({ ...list, resolvedMid: String(mid) });
      } catch (error) {
        asToolError(error);
      }
    },
  });
}
