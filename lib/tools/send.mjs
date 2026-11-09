import { currentJar } from '../bili/auth.mjs';
import { commentSend, messageSend } from '../bili/send.mjs';
import { dynamicPublish } from '../bili/publish.mjs';
import { asToolError, ok, registerTool } from './helpers.mjs';

const common = {
  intent: { type: 'string', enum: ['preview', 'apply', 'check'], default: 'preview' },
  text: { type: 'string', minLength: 1, maxLength: 10000 },
  previewToken: { type: 'string', description: 'preview 返回；目标/正文/素材变化需重新预览' },
  operationId: { type: 'string', description: 'check 使用发送结果中的操作 ID' },
};
export function registerSendTools(ctx) {
  for (const def of [
    { name: 'bilibili_comment_send', description: '发表评论或回复；rpid 为目标，root 为楼层根 ID。默认预览；apply 需审批；check 只读核对未决发送，禁止盲目重发。', run: commentSend,
      properties: { bvid: { type: 'string' }, rpid: { type: 'string', pattern: '^(0|[1-9][0-9]*)$' }, root: { type: 'string', pattern: '^(0|[1-9][0-9]*)$' } } },
    { name: 'bilibili_message_send', description: '发送文字私信。默认预览，apply 需审批；check 只读核对未决发送，不匹配不代表发送失败。', run: messageSend,
      properties: { receiverMid: { type: 'string', pattern: '^[1-9][0-9]*$' } } },
    { name: 'bilibili_dynamic_publish', description: '发布文字/图片动态；先预览再 apply 审批。图片为本机绝对路径或 B站图片 URL，≤9 张、每张≤10MB。check 核对未决发布。', run: dynamicPublish,
      properties: { images: { type: 'array', maxItems: 9, items: { type: 'string' } }, topicId: { type: 'string', pattern: '^[1-9][0-9]*$' }, scheduleTime: { type: 'integer', minimum: 0, description: '秒级时间戳；0=立即发布；定时不支持关联话题' } } },
  ]) registerTool(ctx, { name: def.name, description: def.description,
    parameters: { type: 'object', properties: { ...common, ...def.properties }, additionalProperties: false }, timeoutMs: 180000, isConcurrencySafe: () => false,
    // 私信正文属于私密内容，不写进 devlog 的参数/结果预览。
    sensitive: def.name === 'bilibili_message_send',
    async execute(args, exec) { try { const { jar } = await currentJar(); return ok(await def.run({ ...args, jar, signal: exec?.signal })); } catch (e) { asToolError(e); } },
  });
}
