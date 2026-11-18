import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import sharp from 'sharp';
import { BiliError } from './errors.mjs';
import { fetchBuffer, postMultipart, postJson } from './http.mjs';
import { sender, validateIntent, validateText } from './send.mjs';
import { previewSend, verifyPreview } from './send-preview.mjs';
import { textHash, sendOnce, checkSend } from './send-ledger.mjs';
import { getDynamicDetail, listDynamics } from './dynamics.mjs';
import { fetchDraftRows, readDraftContent } from './drafts.mjs';

const MAX_IMAGE = 10 * 1024 * 1024;
async function matchImages(pics, expected, signal) {
  if (pics.length !== expected.length) return false;
  for (let i = 0; i < pics.length; i++) {
    const url = typeof pics[i] === 'string' ? pics[i] : pics[i]?.src ?? pics[i]?.url ?? pics[i]?.img_src;
    if (!url) return false;
    const buffer = (await fetchBuffer(url, { signal, maxBytes: MAX_IMAGE })).buffer;
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
      // 旧账本行没有发送前基线；无法区分“本次新建”和“早就在那儿”，
      // 只能保持 PENDING_CONFIRM，交给人工核对，不能自动确认。
      if (!Array.isArray(row.target.existingDraftIds)) return null;
      const drafts = await fetchDraftRows({ jar, signal });
      let match = null;
      const before = new Set(row.target.existingDraftIds.map(String));
      for (const draft of drafts) {
        const draftId = String(draft?.draft_id ?? '');
        if (!/^[1-9]\d*$/.test(draftId) || before.has(draftId) || Number(draft.publish_time) !== row.target.scheduleTime) continue;
        const content = readDraftContent(draft);
        if (typeof content?.text !== 'string' || textHash(content.text) !== row.textHash || !Array.isArray(content.pictures)) continue;
        if (!(await matchImages(content.pictures, row.target.images, signal))) continue;
        if (match) return null;
        match = { draftId, scheduleTime: row.target.scheduleTime };
      }
      return match;
    }
    // Text alone cannot confirm an image upload: compare the posted image content hashes.
    const page = await listDynamics({ mid: account, pageSize: 20, jar, signal });
    for (const item of page.items) {
      const at = Date.parse(item.publishedAt);
      if (!item.dynamicId || !(at >= row.createdAt - 5000 && at <= row.createdAt + 180000) || (item.text && textHash(item.text) !== row.textHash)) continue;
      let detail;
      try { detail = await getDynamicDetail({ dynamicId: item.dynamicId, jar, signal }); }
      catch (error) { if (error.code === 'NOT_FOUND') continue; throw error; }
      if (detail.author?.mid !== account || textHash(detail.text) !== row.textHash ||
        (detail.topicId ?? null) !== (row.target.topicId ?? null)) continue;
      if (await matchImages(detail.pics ?? [], row.target.images, signal)) return { dynamicId: item.dynamicId, url: detail.url };
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
  const imageHashes = files.map(f => f.manifest.sha256);
  const baseTarget = { account, topicId: topicId ?? null, scheduleTime, images: imageHashes };
  // 定时发布的 check 只能确认“发送前不存在、现在出现”的草稿；先记录基线，
  // 避免把用户早已存在的同时间同正文草稿误判成本次发送成功。
  const existingDraftIds = scheduleTime
    ? (await fetchDraftRows({ jar, signal })).map(draft => String(draft?.draft_id ?? '')).filter(id => /^[1-9]\d*$/.test(id))
    : undefined;
  const target = existingDraftIds ? { ...baseTarget, existingDraftIds } : baseTarget;
  return sendOnce({ account, kind: 'dynamic', keyTarget: baseTarget, target, text, submit: async operation => {
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
    const dyn_req = { content: { contents: [{ raw_text: text, type: 1, biz_id: '' }] }, scene: pics.length ? 2 : 1, pics,
      meta: { app_meta: { from: 'create.dynamic.web', mobi_app: 'web' } }, upload_id: `${account}_${Math.floor(Date.now() / 1000)}_${String(parseInt(operation.slice(0, 4), 16) % 10000).padStart(4, '0')}`,
      ...(scheduleTime ? { option: { timer_pub_time: scheduleTime } } : {}),
      ...(topicId ? { topic: { id: topicId, from_source: 'dyn.web.list', from_topic_id: 0 } } : {}) };
    const result = await postJson('https://api.bilibili.com/x/dynamic/feed/create/dyn', { jar, signal, payload: { dyn_req } });
    if (scheduleTime) {
      const draftId = String(result.draft_id_str ?? result.draft_id ?? '');
      if (!/^[1-9]\d*$/.test(draftId)) throw new BiliError('INVALID_RESPONSE', '未取得草稿 ID，请用 check 核对；不要改成立即发布或重发');
      return { draftId, scheduleTime };
    }
    const id = result.dyn_id_str ?? result.dyn_id;
    if (!id) throw new BiliError('INVALID_RESPONSE', '未取得动态 ID，需核对');
    return { dynamicId: String(id), url: `https://t.bilibili.com/${id}` };
  } });
}
