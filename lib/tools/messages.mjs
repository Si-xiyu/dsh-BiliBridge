import { currentJar } from '../bili/auth.mjs';
import { BiliError } from '../bili/errors.mjs';
import { listMessages, listSessions, SESSION_TYPES, THREAD_SESSION_TYPES } from '../bili/messages.mjs';
import { asToolError, ok, registerTool } from './helpers.mjs';

export function registerMessageTools(ctx) {
  registerTool(ctx, {
    name: 'bilibili_messages',
    description:
      '读取私信：scope=sessions 返回会话列表，scope=thread 按 talkerId 读取正文。只读、不标记已读；' +
      '正文截断到 500 字，图片只给 URL 不自动下载；cursor 原样传回 nextCursor。',
    parameters: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['sessions', 'thread'], description: 'sessions=会话列表；thread=某个会话的正文' },
        talkerId: { type: 'string', pattern: '^[1-9][0-9]*$', description: 'thread 必填；对方 UID（sessions 返回的 talkerId）' },
        sessionType: { type: 'integer', enum: SESSION_TYPES, description: 'sessions 默认 4（全部）；thread 只支持 1 用户 / 2 粉丝团' },
        size: { type: 'integer', minimum: 1, maximum: 50, description: '默认 20，最大 50' },
        cursor: { type: 'string', maxLength: 8192, description: '下一步游标，原样传回 nextCursor' },
        unreadOnly: { type: 'boolean', description: '仅 sessions：只返回未读会话' },
      },
      required: ['scope'],
      additionalProperties: false,
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => false,
    // 私信正文属于私密内容，devlog 不落参数/结果预览。
    sensitive: true,
    async execute(args, exec) {
      try {
        const { jar } = await currentJar();
        const scope = args?.scope;
        if (scope === 'thread') {
          if (args?.sessionType !== undefined && !THREAD_SESSION_TYPES.includes(Number(args.sessionType))) {
            throw new BiliError('INVALID_ARGUMENT', 'thread 的 sessionType 仅支持 1 或 2');
          }
          const data = await listMessages({ ...args, jar, signal: exec?.signal });
          return ok(data, { source: 'svr_sync/fetch_session_msgs' });
        }
        if (scope === 'sessions') {
          if (args?.talkerId !== undefined) {
            throw new BiliError('INVALID_ARGUMENT', 'scope=sessions 不接受 talkerId');
          }
          const data = await listSessions({ ...args, jar, signal: exec?.signal });
          return ok(data, { source: 'session_svr/get_sessions' });
        }
        throw new BiliError('INVALID_ARGUMENT', 'scope 只能是 sessions 或 thread');
      } catch (error) {
        asToolError(error);
      }
    },
  });
}
