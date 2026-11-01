/**
 * 登录相关工具。
 *
 * 二维码 key 不返回给模型：key 留在插件内存里，模型只拿到可展示的文本二维码。
 */
import { BiliError } from '../bili/errors.mjs';
import { currentJar, logout, qrPoll, qrStart, renderQr, saveLoginFromPoll, status } from '../bili/auth.mjs';
import { asToolError, ok, registerTool } from './helpers.mjs';

/** 单进程内只保留一个待扫码会话。 */
let pending = null;

export function registerAuthTools(ctx) {
  registerTool(ctx, {
    name: 'bilibili_auth_status',
    description:
      '查询 B站登录状态：是否已登录、当前账号 mid/昵称、凭据是否存在、是否已过期。只读，不需要参数。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    timeoutMs: 20_000,
    isConcurrencySafe: () => true,
    async execute() {
      try {
        return ok(await status());
      } catch (error) {
        asToolError(error);
      }
    },
  });

  registerTool(ctx, {
    name: 'bilibili_auth_begin',
    description:
      '开始 B站扫码登录，返回一个文本二维码。必须把 qrText 原样放进代码块发给用户，不要改写、不要转述成链接；' +
      '用户用 B站 App 扫码并确认后，再调用 bilibili_auth_poll 等待结果。二维码约 3 分钟有效。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    timeoutMs: 20_000,
    isConcurrencySafe: () => false,
    async execute() {
      try {
        const { jar } = await currentJar();
        const { url, key } = await qrStart();
        pending = { key, jar, startedAt: Date.now() };
        const qrText = await renderQr(url);
        return ok({
          qrText,
          expiresInSeconds: 180,
          hint: '把 qrText 放进代码块发给用户；扫码确认后调用 bilibili_auth_poll。',
        });
      } catch (error) {
        asToolError(error);
      }
    },
  });

  registerTool(ctx, {
    name: 'bilibili_auth_poll',
    description:
      '等待并查询扫码结果。waitSeconds 内会持续轮询；返回 status = waiting / scanned / confirmed / expired / none。' +
      'confirmed 时会自动保存登录态；expired 需要重新调用 bilibili_auth_begin。',
    parameters: {
      type: 'object',
      properties: {
        waitSeconds: {
          type: 'integer',
          description: '本次最多等待多少秒，默认 20，上限 60',
        },
      },
      additionalProperties: false,
    },
    timeoutMs: 75_000,
    isConcurrencySafe: () => false,
    async execute(args) {
      const waitSeconds = Math.min(Math.max(Number(args?.waitSeconds ?? 20), 3), 60);
      if (!pending) {
        return ok({ status: 'none', hint: '当前没有待扫码会话，请先调用 bilibili_auth_begin' });
      }
      try {
        const deadline = Date.now() + waitSeconds * 1000;
        let last = 'waiting';
        while (Date.now() < deadline) {
          const { status: state, data } = await qrPoll(pending.key, pending.jar);
          if (state === 'expired') {
            pending = null;
            return ok({ status: 'expired', hint: '二维码已过期，请重新调用 bilibili_auth_begin' });
          }
          if (state === 'confirmed') {
            const account = await saveLoginFromPoll(data, pending.jar);
            pending = null;
            return ok({ status: 'confirmed', account });
          }
          last = state;
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
        return ok({ status: last, hint: last === 'scanned' ? '已扫码，等待手机确认' : '还没扫码' });
      } catch (error) {
        asToolError(error);
      }
    },
  });

  registerTool(ctx, {
    name: 'bilibili_auth_logout',
    description: '清除本地保存的 B站登录凭据。只影响本机插件，不会让 B站端的会话失效。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    timeoutMs: 20_000,
    isConcurrencySafe: () => false,
    async execute() {
      try {
        pending = null;
        return ok(await logout());
      } catch (error) {
        asToolError(error);
      }
    },
  });
}

export function pendingLogin() {
  return pending ? { startedAt: pending.startedAt } : null;
}

export function requirePending() {
  if (!pending) throw new BiliError('AUTH_REQUIRED', '没有待扫码会话');
  return pending;
}
