/**
 * 自己内容的管理：删除评论、删除动态、定时草稿列表/删除/立即发布。
 *
 * 删除和“立即发布草稿”都是不可逆写操作：先 preview 绑定目标，apply 时校验
 * previewToken，再提交。这里不套发送账本（账本语义是“发出去的内容”），
 * 但同样只允许在 apply 时真正写。
 */
import { getDynamicDetail } from './dynamics.mjs';
import { getVideo } from './api.mjs';
import { postForm, postMultipart, request } from './http.mjs';
import { BiliError } from './errors.mjs';
import { sender, validateIntent } from './send.mjs';
import { previewSend, verifyPreview } from './send-preview.mjs';

const REPLY_DEL = 'https://api.bilibili.com/x/v2/reply/del';
const RM_DYNAMIC = 'https://api.vc.bilibili.com/dynamic_svr/v1/dynamic_svr/rm_dynamic';
const DRAFT_LIST = 'https://api.vc.bilibili.com/dynamic_draft/v1/dynamic_draft/draft_list';
const RM_DRAFT = 'https://api.vc.bilibili.com/dynamic_draft/v1/dynamic_draft/rm_draft';
const PUBLISH_NOW = 'https://api.vc.bilibili.com/dynamic_draft/v1/dynamic_draft/publish_now';

function manageIntent(intent) {
  const mode = validateIntent(intent ?? 'preview');
  if (mode === 'check') throw new BiliError('INVALID_ARGUMENT', '内容管理不支持 check；删除操作请重新 preview');
  return mode;
}

function positiveId(value, label) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
    throw new BiliError('INVALID_ARGUMENT', `${label} 必须是正整数字符串`);
  }
  return value;
}

export async function deleteComment({ intent = 'preview', bvid, rpid, previewToken, jar, signal } = {}) {
  const mode = manageIntent(intent);
  const account = await sender(jar);
  const video = await getVideo(bvid, { jar, signal });
  const target = { bvid: video.bvid, aid: String(video.aid), rpid: positiveId(String(rpid ?? ''), 'rpid') };
  const payload = { action: 'delete_comment', target };
  if (mode === 'preview') return previewSend(account, 'delete_comment', payload);
  await verifyPreview(account, 'delete_comment', payload, previewToken);
  try {
    await postForm(REPLY_DEL, { jar, signal, fields: { type: 1, oid: video.aid, rpid: target.rpid } });
  } catch (error) {
    // 12022 表示已经被删除了；按目标状态语义视为成功，避免重试。
    if (error?.biliCode === 12022) return { status: 'DELETED', alreadyDeleted: true, ...target };
    throw error;
  }
  return { status: 'DELETED', ...target };
}

export async function deleteDynamic({ intent = 'preview', dynamicId, previewToken, jar, signal } = {}) {
  const mode = manageIntent(intent);
  const account = await sender(jar);
  const id = positiveId(String(dynamicId ?? ''), 'dynamicId');
  const detail = await getDynamicDetail({ dynamicId: id, jar, signal });
  if (String(detail.author?.mid ?? '') !== account) {
    throw new BiliError('PERMISSION_DENIED', '只能删除自己发布的动态');
  }
  const target = {
    dynamicId: id,
    author: detail.author ?? null,
    url: detail.url ?? `https://t.bilibili.com/${id}`,
    text: String(detail.text ?? '').slice(0, 200),
  };
  const payload = { action: 'delete_dynamic', target };
  if (mode === 'preview') return previewSend(account, 'delete_dynamic', payload);
  await verifyPreview(account, 'delete_dynamic', payload, previewToken);
  try {
    // 文档把 rm_dynamic 标为 multipart/form-data；用 multipart 更接近网页端。
    const form = new FormData();
    form.set('dynamic_id', id);
    await postMultipart(RM_DYNAMIC, { jar, form, signal });
  } catch (error) {
    if (error?.biliCode === 500404) return { status: 'DELETED', alreadyDeleted: true, ...target };
    throw error;
  }
  return { status: 'DELETED', ...target };
}

function parseDraft(draft) {
  let req = {};
  try { req = JSON.parse(draft?.request ?? '{}'); } catch { req = {}; }
  let pics = [];
  try {
    pics = Array.isArray(req?.pictures) ? req.pictures : JSON.parse(req?.pictures ?? '[]');
  } catch { pics = []; }
  const publishAt = Number(draft?.publish_time);
  return {
    draftId: draft?.draft_id === undefined ? null : String(draft.draft_id),
    type: draft?.type === undefined ? null : Number(draft.type),
    publishTime: Number.isFinite(publishAt) && publishAt > 0 ? new Date(publishAt * 1000).toISOString() : null,
    ...(typeof req?.content === 'string' ? { text: req.content.slice(0, 300) } : {}),
    ...(typeof req?.description === 'string' ? { text: req.description.slice(0, 300) } : {}),
    ...(typeof req?.title === 'string' && req.title ? { title: req.title.slice(0, 100) } : {}),
    imageCount: Array.isArray(pics) ? pics.length : 0,
  };
}

export async function listDrafts({ jar, signal } = {}) {
  const data = await request(DRAFT_LIST, { jar, signal });
  if (data.drafts !== undefined && data.drafts !== null && !Array.isArray(data.drafts)) {
    throw new BiliError('INVALID_RESPONSE', '定时草稿列表格式异常');
  }
  const items = (data.drafts ?? []).map(parseDraft);
  return { count: items.length, items, note: '只读：不会发布或删除草稿' };
}

export async function deleteDraft({ intent = 'preview', draftId, previewToken, jar, signal } = {}) {
  const mode = manageIntent(intent);
  const account = await sender(jar);
  const id = positiveId(String(draftId ?? ''), 'draftId');
  const payload = { action: 'delete_draft', target: { draftId: id } };
  if (mode === 'preview') return previewSend(account, 'delete_draft', payload);
  await verifyPreview(account, 'delete_draft', payload, previewToken);
  await postForm(RM_DRAFT, { jar, signal, fields: { draft_id: id } });
  return { status: 'DELETED', draftId: id };
}

export async function publishDraftNow({ intent = 'preview', draftId, previewToken, jar, signal } = {}) {
  const mode = manageIntent(intent);
  const account = await sender(jar);
  const id = positiveId(String(draftId ?? ''), 'draftId');
  const payload = { action: 'publish_draft_now', target: { draftId: id } };
  if (mode === 'preview') return previewSend(account, 'publish_draft_now', payload);
  await verifyPreview(account, 'publish_draft_now', payload, previewToken);
  await postForm(PUBLISH_NOW, { jar, signal, fields: { draft_id: id } });
  return { status: 'PUBLISHED', draftId: id };
}
