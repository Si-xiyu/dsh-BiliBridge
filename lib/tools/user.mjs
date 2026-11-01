import { currentJar } from '../bili/auth.mjs';
import { userProfile } from '../bili/user.mjs';
import { asToolError, ok, registerTool } from './helpers.mjs';

export function registerUserTools(ctx) {
  registerTool(ctx, {
    name: 'bilibili_user_profile', description: '读取用户主页、粉丝与关注数、可取得时的投稿总数。空间接口触发风控时直接报错。',
    parameters: { type: 'object', properties: { mid: { type: 'string', pattern: '^[1-9][0-9]*$' } }, required: ['mid'], additionalProperties: false },
    timeoutMs: 90_000, isConcurrencySafe: () => false,
    async execute(args, exec) {
      try { const { jar } = await currentJar(); return ok(await userProfile({ ...args, jar, signal: exec?.signal }), { source: 'space/wbi/acc/info + relation/stat + space/wbi/arc/search' }); }
      catch (error) { asToolError(error); }
    },
  });
}
