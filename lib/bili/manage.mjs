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
import { textHash } from './send-ledger.mjs';

const REPLY_DEL = 'https://api.bilibili.com/x/v2/reply/del';
const REPLY_ROOT = 'https://api.bilibili.com/x/v2/reply/reply';
const COMMENTS = 'https://api.bilibili.com/x/v2/reply';
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

function commentAuthor(row, rpid) {
  if (String(row?.rpid_str ?? row?.rpid ?? '') !== String(rpid)) return null;
  return {
    mid: String(row?.member?.mid ?? row?.mid ?? ''),
    text: String(row?.content?.message ?? '').slice(0, 200),
  };
}

/**
 * 查一条评论的作者。
 *
 * 先按 root=rpid 取根评论（一级评论通常能直接命中）；再在最近 5 页评论
 * 及其楼中楼里找。找不到就拒绝删除：视频作者也能删别人的评论，不能只凭
 * rpid 和“视频是我的”就动手。
 */
async function findCommentAuthor({ video, rpid, jar, signal }) {
  try {
    const data = await request(REPLY_ROOT, { query: { type: 1, oid: video.aid, root: rpid, ps: 20, pn: 1 }, jar, signal });
    const hit = commentAuthor(data?.root, rpid) ?? (data?.replies ?? []).map((row) => commentAuthor(row, rpid)).find(Boolean);
    if (hit) return hit;
  } catch (error) {
    if (!['NOT_FOUND', 'INVALID_ARGUMENT', 'CONTENT_UNAVAILABLE'].includes(error.code)) throw error;
  }
  for (let pn = 1; pn <= 5; pn += 1) {
    const data = await request(COMMENTS, { query: { type: 1, oid: video.aid, sort: 0, ps: 20, pn }, jar, signal });
    for (const row of data?.replies ?? []) {
      const hit = commentAuthor(row, rpid) ?? (row?.replies ?? []).map((child) => commentAuthor(child, rpid)).find(Boolean);
      if (hit) return hit;
    }
    const page = data?.page;
    if (page && Number(page.pn) * Number(page.ps) >= Number(page.count)) break;
  }
  return null;
}

export async function deleteComment({ intent = 'preview', bvid, rpid, previewToken, jar, signal } = {}) {
  const mode = manageIntent(intent);
  const account = await sender(jar);
  const video = await getVideo(bvid, { jar, signal });
  const target = { bvid: video.bvid, aid: String(video.aid), rpid: positiveId(String(rpid ?? ''), 'rpid') };
  const payload = { action: 'delete_comment', target };
  if (mode === 'preview') {
    const found = await findCommentAuthor({ video, rpid: target.rpid, jar, signal });
    if (!found) {
      throw new BiliError('PERMISSION_DENIED', '无法确认该评论属于当前账号；为避免误删他人评论，已拒绝删除。请从 bilibili_comments 重新获取 rpid。');
    }
    if (String(found.mid) !== account) {
      throw new BiliError('PERMISSION_DENIED', '只能删除自己发布的评论');
    }
    const preview = await previewSend(account, 'delete_comment', payload);
    return { ...preview, comment: { rpid: target.rpid, mid: found.mid, text: found.text } };
  }
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
  // token 只绑定 dynamicId：删除的目标就是这条动态本身。详情用于预览展示与
  // 归属校验，但不能成为 apply 的前置条件——否则“已经删掉了”的重试会先失败。
  const payload = { action: 'delete_dynamic', target: { dynamicId: id } };
  if (mode === 'preview') {
    const detail = await getDynamicDetail({ dynamicId: id, jar, signal });
    if (String(detail.author?.mid ?? '') !== account) {
      throw new BiliError('PERMISSION_DENIED', '只能删除自己发布的动态');
    }
    const preview = await previewSend(account, 'delete_dynamic', payload);
    return {
      ...preview,
      detail: {
        author: detail.author ?? null,
        url: detail.url ?? `https://t.bilibili.com/${id}`,
        text: String(detail.text ?? '').slice(0, 200),
      },
    };
  }
  await verifyPreview(account, 'delete_dynamic', payload, previewToken);
  // apply 不先查详情：动态可能已被删除/不可见，详情查询失败不能证明删除成功。
  // 直接用 token 绑定的 id 发删除请求，只把明确的 500404 当作“已完成”。
  try {
    // 文档把 rm_dynamic 标为 multipart/form-data；用 multipart 更接近网页端。
    const form = new FormData();
    form.set('dynamic_id', id);
    await postMultipart(RM_DYNAMIC, { jar, form, signal });
  } catch (error) {
    if (error?.biliCode === 500404) return { status: 'DELETED', alreadyDeleted: true, dynamicId: id };
    throw error;
  }
  return { status: 'DELETED', dynamicId: id };
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

/**
 * 取单个草稿并生成“发布内容指纹”。
 *
 * 只绑定 draftId 不够：预览之后草稿仍可能在网页端被编辑，apply 时用旧 token
 * 就会发布用户没看过的正文/图片。指纹覆盖 request 原文和发布时间，previewToken
 * 因此与“将要发布的内容”绑定。
 */
async function findDraft({ draftId, jar, signal }) {
  const data = await request(DRAFT_LIST, { jar, signal });
  if (data.drafts !== undefined && data.drafts !== null && !Array.isArray(data.drafts)) {
    throw new BiliError('INVALID_RESPONSE', '定时草稿列表格式异常');
  }
  const row = (data.drafts ?? []).find((draft) => String(draft?.draft_id) === String(draftId));
  if (!row) throw new BiliError('NOT_FOUND', '定时草稿不存在或已被删除');
  return {
    row,
    draft: parseDraft(row),
    requestHash: textHash(String(row.request ?? '')),
    publishTime: Number(row.publish_time ?? 0) || 0,
  };
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
  // 预览与 apply 都以“当前草稿内容”生成 token；草稿被改过就要求重新预览。
  const current = await findDraft({ draftId: id, jar, signal });
  const target = { draftId: id, publishTime: current.publishTime, requestHash: current.requestHash };
  const payload = { action: 'publish_draft_now', target };
  if (mode === 'preview') return { ...(await previewSend(account, 'publish_draft_now', payload)), draft: current.draft };
  await verifyPreview(account, 'publish_draft_now', payload, previewToken);
  await postForm(PUBLISH_NOW, { jar, signal, fields: { draft_id: id } });
  return { status: 'PUBLISHED', draftId: id, draft: current.draft };
}
