import { isDevEnabled, recordToolCall } from '../devlog.mjs';
/**
 * 工具层公共件：统一返回信封、错误转换、注册。
 *
 * DSH 的工具失败语义是 throw / isError，不是返回 {status:"error"}；
 * 所以这里只在“内容部分缺失”时用 partial，其余错误一律抛。
 */
import { BiliError } from '../bili/errors.mjs';

export function jsonContent(value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
}

export function ok(data, provenance = {}) {
  return {
    status: 'ok',
    observedAt: new Date().toISOString(),
    data,
    warnings: [],
    provenance,
  };
}

export function partial(data, warnings, provenance = {}) {
  return {
    status: 'partial',
    observedAt: new Date().toISOString(),
    data,
    warnings,
    provenance,
  };
}

/** 把 BiliError 转成模型可读的错误；保留 code 供模型判断是否重试。 */
export function asToolError(error) {
  if (error instanceof BiliError) {
    const suffix = error.retryable ? '（可稍后重试）' : '';
    throw new Error(`${error.code}: ${error.message}${suffix}`);
  }
  throw error;
}

/**
 * DSH 要求工具返回值是 lossless JSON；`undefined` 字段会被判非法。
 * 统一走一次 JSON 往返，既去掉 undefined，也把类实例压成普通对象。
 */
export function sanitizeJson(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

/**
 * 注册一个工具，统一 output 声明与文本渲染。
 * @param {any} ctx
 * @param {object} def
 */
export function registerTool(ctx, def) {
  const execute = def.execute;
  ctx.tools.register({
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => jsonContent(value),
    },
    ...def,
    execute: async (args, exec) => {
      const enabled = def.name?.startsWith('bilibili_') && isDevEnabled();
      if (!enabled) return sanitizeJson(await execute(args, exec));
      const started = performance.now();
      const record = async details => {
        try { await recordToolCall({ tool: def.name, args, durationMs: performance.now() - started, ...details }); }
        catch { console.warn('[bilibili] 开发日志记录失败'); }
      };
      try {
        const result = sanitizeJson(await execute(args, exec));
        await record({ ok: true, result });
        return result;
      } catch (error) {
        await record({ ok: false, errorCode: error?.code });
        throw error;
      }
    },
  });
}

/** 工具参数里常见的“可选 mid”。 */
export async function resolveMid(mid, jar) {
  if (mid) return String(mid);
  const { getCurrentUser } = await import('../bili/api.mjs');
  const me = await getCurrentUser({ jar });
  if (!me) throw new BiliError('AUTH_REQUIRED', '需要先登录才能默认使用“我的账号”');
  return me.mid;
}
