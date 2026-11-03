import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import sharp from 'sharp';
import { BiliError } from './errors.mjs';
import { fetchBuffer, postMultipart, postJson, postForm, request } from './http.mjs';
import { sender, validateIntent, validateText } from './send.mjs';
import { previewSend, verifyPreview } from './send-preview.mjs';
import { textHash, sendOnce, checkSend } from './send-ledger.mjs';
import { listDynamics } from './dynamics.mjs';

const MAX_IMAGE = 10 * 1024 * 1024;
async function matchImages(pics, expected, signal) {
  if (pics.length !== expected.length) return false;
  for (let i = 0; i < pics.length; i++) {
    const buffer = (await fetchBuffer(pics[i].src ?? pics[i].url ?? pics[i].img_src, { signal, maxBytes: MAX_IMAGE })).buffer;
    if (textHash(buffer) !== expected[i]) return false;
  }
  return true;
}
export async function prepareImages(images = [], signal) {
  if (!Array.isArray(images) || images.length > 9) throw new BiliError('INVALID_ARGUMENT', '最多 9 张图片');
  const files = [];
  for (const path of images) {
    if (typeof path !== 'string') throw new BiliError('INVALID_ARGUMENT', '图片必须是绝对路径或 B站图片 URL');
    let buffer;
    if (/^https:\/\//.test(path)) {
      buffer = (await fetchBuffer(path, { maxBytes: MAX_IMAGE, signal })).buffer;
    } else {
      if (!isAbsolute(path) || path.startsWith('\\\\')) throw new BiliError('INVALID_ARGUMENT', '只允许本机绝对路径');
      const handle = await open(path, 'r');
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > MAX_IMAGE || info.size === 0) throw new BiliError('INVALID_ARGUMENT', '图片必须为 1 字节到 10MB 的普通文件');
        buffer = await handle.readFile();
        if (buffer.length > MAX_IMAGE) throw new BiliError('INVALID_ARGUMENT', '图片超过 10MB');
      } finally { await handle.close(); }
    }
    const meta = await sharp(buffer, { limitInputPixels: 40000000 }).metadata();
    if (!['jpeg', 'png', 'gif'].includes(meta.format)) throw new BiliError('INVALID_ARGUMENT', '只支持 JPG/PNG/GIF');
    files.push({ buffer, manifest: { path, size: buffer.length, sha256: textHash(buffer), width: meta.width, height: meta.height, format: meta.format } });
  }
  return files;
}

export async function dynamicPublish({ intent = 'preview', operationId, text, images = [], topicId, scheduleTime = 0, previewToken, jar, signal } = {}) {
  validateIntent(intent);
  const account = await sender(jar);
  if (intent === 'check') return checkSend({ account, kind: 'dynamic', operationId, find: async row => {
    if (row.target.scheduleTime) {
      const data = await request('https://api.vc.bilibili.com/dynamic_draft/v1/dynamic_draft/draft_list', { jar, signal });
      for (const draft of data.drafts ?? []) {
        let req, pics;
        try { req = JSON.parse(draft.request); pics = typeof req.pictures === 'string' ? JSON.parse(req.pictures) : req.pictures ?? []; } catch { continue; }
        if (Number(draft.publish_time) === row.target.scheduleTime && textHash(req.content ?? req.description) === row.textHash && await matchImages(pics, row.target.images, signal)) {
          return { draftId: String(draft.draft_id), scheduleTime: row.target.scheduleTime };
        }
      }
      return null;
    }
    // Text alone cannot confirm an image upload: compare the posted image content hashes.
    const page = await listDynamics({ mid: account, pageSize: 20, jar, signal });
    for (const item of page.items) {
      const at = Date.parse(item.publishedAt);
      if (!(at >= row.createdAt - 5000 && at <= row.createdAt + 180000 && textHash(item.text) === row.textHash)) continue;
      const detail = await request('https://api.bilibili.com/x/polymer/web-dynamic/v1/detail', { query: { id: item.dynamicId }, jar, signal });
      if (row.target.topicId && String(detail.item?.modules?.module_dynamic?.topic?.id) !== row.target.topicId) continue;
      const major = detail.item?.modules?.module_dynamic?.major;
      const pics = major?.draw?.items ?? major?.opus?.pics ?? [];
      if (await matchImages(pics, row.target.images, signal)) return { dynamicId: item.dynamicId, url: `https://t.bilibili.com/${item.dynamicId}` };
    }
    return null;
  } });
  text = validateText(text, 10000);
  if (topicId !== undefined && (typeof topicId !== 'string' || !/^[1-9]\d*$/.test(topicId))) throw new BiliError('INVALID_ARGUMENT', 'topicId 必须是正整数字符串');
  if (!Number.isSafeInteger(scheduleTime) || scheduleTime < 0 || (scheduleTime && scheduleTime < Date.now() / 1000 + 120)) throw new BiliError('INVALID_ARGUMENT', '定时至少在两分钟以后，使用秒级时间戳');
  if (scheduleTime && topicId) throw new BiliError('UNSUPPORTED', '定时接口暂不支持话题组合，请立即发布或去掉话题');
  const files = await prepareImages(images, signal);
  const payload = { text, images: files.map(f => f.manifest), topicId: topicId ?? null, scheduleTime };
  if (intent === 'preview') return previewSend(account, 'dynamic', payload);
  await verifyPreview(account, 'dynamic', payload, previewToken);
  const target = { account, topicId: topicId ?? null, scheduleTime, images: files.map(f => f.manifest.sha256) };
  return sendOnce({ account, kind: 'dynamic', target, text, submit: async operation => {
    const pics = [];
    for (const file of files) {
      const form = new FormData();
      form.set('file_up', new Blob([file.buffer], { type: `image/${file.manifest.format}` }), `image.${file.manifest.format === 'jpeg' ? 'jpg' : file.manifest.format}`);
      form.set('category', 'daily'); form.set('biz', 'new_dyn');
      let result;
      try {
        result = await postMultipart('https://api.bilibili.com/x/dynamic/feed/draw/upload_bfs', { jar, form, signal });
        if (!result.image_url || !result.image_width || !result.image_height) throw new BiliError('INVALID_RESPONSE', '图床未返回完整信息，停止发布');
      } catch (error) { error.submission = 'not-submitted'; throw error; }
      pics.push({ img_src: result.image_url, img_width: result.image_width, img_height: result.image_height, img_size: result.img_size });
    }
    if (scheduleTime) {
      const req = pics.length ? { biz: 3, category: 3, type: 0, pictures: JSON.stringify(pics), title: '', tags: '', description: text, content: text, from: 'create.dynamic.web', at_uids: '', at_control: '[]' }
        : { dynamic_id: 0, type: 4, rid: 0, content: text, extension: '{"emoji_type":1}', at_uids: '', ctrl: '[]' };
      req.csrf_token = jar.get('bili_jct');
      const result = await postForm('https://api.vc.bilibili.com/dynamic_draft/v1/dynamic_draft/add_draft', { jar, signal, fields: { type: pics.length ? 4 : 2, publish_time: scheduleTime, request: JSON.stringify(req), csrf_token: jar.get('bili_jct') } });
      if (!result.draft_id) throw new BiliError('INVALID_RESPONSE', '未取得草稿 ID，需核对');
      return { draftId: String(result.draft_id), scheduleTime };
    }
    const dyn_req = { content: { contents: [{ raw_text: text, type: 1, biz_id: '' }] }, scene: pics.length ? 2 : 1, pics,
      meta: { app_meta: { from: 'create.dynamic.web', mobi_app: 'web' } }, upload_id: `${account}_${Math.floor(Date.now() / 1000)}_${String(parseInt(operation.slice(0, 4), 16) % 10000).padStart(4, '0')}`,
      ...(topicId ? { topic: { id: topicId, from_source: 'dyn.web.list', from_topic_id: 0 } } : {}) };
    const result = await postJson('https://api.bilibili.com/x/dynamic/feed/create/dyn', { jar, signal, payload: { dyn_req } });
    const id = result.dyn_id_str ?? result.dyn_id;
    if (!id) throw new BiliError('INVALID_RESPONSE', '未取得动态 ID，需核对');
    return { dynamicId: String(id), url: `https://t.bilibili.com/${id}` };
  } });
}
