import { currentJar } from '../bili/auth.mjs';
import { BiliError } from '../bili/errors.mjs';
import { deleteComment, deleteDynamic, deleteDraft, listDrafts, publishDraftNow } from '../bili/manage.mjs';
import { asToolError, ok, registerTool } from './helpers.mjs';

export function registerManageTools(ctx) {
  registerTool(ctx, {
    name: 'bilibili_content_manage',
    description:
      '管理自己发布的内容：删除评论（delete_comment）、删除动态（delete_dynamic）、列出/删除/立即发布定时草稿。' +
      '删除与立即发布先用 intent=preview 取得 previewToken，apply 才真正执行并需要审批；list_drafts 只读。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['delete_comment', 'delete_dynamic', 'list_drafts', 'delete_draft', 'publish_draft_now'],
          description: '要执行的管理动作',
        },
        intent: { type: 'string', enum: ['preview', 'apply'], description: '默认 preview；apply 才写入' },
        bvid: { type: 'string', pattern: '^BV[0-9A-Za-z]{10}$', description: 'delete_comment 必填' },
        rpid: { type: 'string', pattern: '^[1-9][0-9]*$', description: 'delete_comment 必填：评论 ID' },
        dynamicId: { type: 'string', pattern: '^[1-9][0-9]*$', description: 'delete_dynamic 必填' },
        draftId: { type: 'string', pattern: '^[1-9][0-9]*$', description: 'delete_draft / publish_draft_now 必填' },
        previewToken: { type: 'string', description: 'preview 返回；目标变化需重新预览' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    timeoutMs: 120_000,
    isConcurrencySafe: () => false,
    // 定时草稿正文属于未发布内容；结果预览不落 devlog。
    sensitive: true,
    async execute(args, exec) {
      try {
        const { jar } = await currentJar();
        const action = args?.action;
        if (!['delete_comment', 'delete_dynamic', 'list_drafts', 'delete_draft', 'publish_draft_now'].includes(action)) {
          throw new BiliError('INVALID_ARGUMENT', '不支持的 action');
        }
        if (action === 'list_drafts') {
          if (args?.intent === 'apply') throw new BiliError('INVALID_ARGUMENT', 'list_drafts 是只读动作，不接受 intent=apply');
          return ok(await listDrafts({ jar, signal: exec?.signal }), { source: 'dynamic_draft/draft_list' });
        }
        const common = { intent: args?.intent, previewToken: args?.previewToken, jar, signal: exec?.signal };
        if (action === 'delete_comment') {
          if (!args?.bvid || !args?.rpid) throw new BiliError('INVALID_ARGUMENT', 'delete_comment 需要 bvid 和 rpid');
          return ok(await deleteComment({ ...common, bvid: args.bvid, rpid: args.rpid }));
        }
        if (action === 'delete_dynamic') {
          if (!args?.dynamicId) throw new BiliError('INVALID_ARGUMENT', 'delete_dynamic 需要 dynamicId');
          return ok(await deleteDynamic({ ...common, dynamicId: args.dynamicId }));
        }
        if (action === 'delete_draft') {
          if (!args?.draftId) throw new BiliError('INVALID_ARGUMENT', 'delete_draft 需要 draftId');
          return ok(await deleteDraft({ ...common, draftId: args.draftId }));
        }
        if (!args?.draftId) throw new BiliError('INVALID_ARGUMENT', 'publish_draft_now 需要 draftId');
        return ok(await publishDraftNow({ ...common, draftId: args.draftId }));
      } catch (error) {
        asToolError(error);
      }
    },
  });
}
