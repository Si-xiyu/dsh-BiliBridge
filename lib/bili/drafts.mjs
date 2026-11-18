import { BiliError } from './errors.mjs';
import { postJson, request } from './http.mjs';

const TIMING_LIST = 'https://api.bilibili.com/x/polymer/web-dynamic/v1/timing/draft/list';
const TIMING_DELETE = 'https://api.bilibili.com/x/dynamic/feed/timing_dyn/delete';
const TIMING_PUBLISH = 'https://api.bilibili.com/x/dynamic/feed/timing_dyn/publish';
const LEGACY_LIST = 'https://api.vc.bilibili.com/dynamic_draft/v1/dynamic_draft/get_drafts';

/**
 * 合并新版（timing）与旧版定时草稿。
 *
 * 两套接口的 ID 不通用：新版 ID 只能交给 timing_dyn/*，旧版只能交给
 * dynamic_draft/*。行里保留 source 让调用方不要串用。
 */
export async function fetchDraftRows({ jar, signal } = {}) {
  const timing = await request(TIMING_LIST, {
    query: { web_location: '333.1365' }, referer: 'https://t.bilibili.com/', jar, signal,
  });
  if (!Array.isArray(timing.items) && !(timing.items == null && timing.count === 0)) {
    throw new BiliError('INVALID_RESPONSE', '新版定时草稿列表格式异常');
  }
  const current = (timing.items ?? []).map(item => ({
    draft_id: item.id_str,
    publish_time: item.author?.pub_ts,
    request: JSON.stringify({ content: item.content, topic: item.topic }),
    source: 'timing',
    content: item.content,
    topic: item.topic,
  }));
  const legacy = await request(LEGACY_LIST, { jar, signal });
  const rows = legacy.drafts ?? legacy.list;
  if (rows != null && !Array.isArray(rows)) throw new BiliError('INVALID_RESPONSE', '定时草稿列表格式异常');
  const ids = new Set(current.map(item => String(item.draft_id)));
  return [...current, ...(rows ?? []).filter(item => !ids.has(String(item?.draft_id)))];
}

export function readDraftContent(draft) {
  let requestBody;
  try { requestBody = JSON.parse(draft?.request ?? 'null'); } catch { return null; }
  if (!requestBody || typeof requestBody !== 'object') return null;
  const payload = requestBody.dyn_req ?? requestBody;
  const contents = payload.content?.contents;
  let text = payload.content ?? payload.description;
  if (Array.isArray(contents) && contents.every(node => node?.type === 1 && typeof node.raw_text === 'string')) {
    text = contents.map(node => node.raw_text).join('');
  }
  if (typeof text !== 'string') text = payload.content?.summary?.text;
  let pictures = payload.pictures ?? payload.pics ?? payload.content?.pics ?? [];
  if (typeof pictures === 'string') {
    try { pictures = JSON.parse(pictures); } catch { pictures = null; }
  }
  return { text: typeof text === 'string' ? text : undefined, pictures, title: payload.title ?? payload.content?.title };
}

/**
 * 新版草稿正文的富文本节点 → dyn_req contents。
 *
 * 网页端在“立即发布”时用同一套映射重建请求。这里只映射能确定语义的节点；
 * 抽奖/投票/商品卡依赖列表里没有的附加字段，宁可在预览阶段拒绝，也不发一个
 * 内容残缺的动态。
 */
function timingContents(content) {
  const nodes = content?.summary?.rich_text_nodes;
  if (!Array.isArray(nodes) || !nodes.length) {
    const text = typeof content?.summary?.text === 'string' ? content.summary.text : '';
    return text ? [{ raw_text: text, type: 1, biz_id: '' }] : [];
  }
  const out = [];
  const plain = text => { if (text) out.push({ raw_text: text, type: 1, biz_id: '' }); };
  for (const node of nodes) {
    const text = typeof node?.text === 'string' ? node.text : typeof node?.orig_text === 'string' ? node.orig_text : '';
    switch (node?.type) {
      case 'RICH_TEXT_NODE_TYPE_AT':
        // 缺少 rid 时退回纯文本，绝不能因为一个字段缺失就把这段文字丢掉。
        if (!text) break;
        if (node.rid) out.push({ raw_text: text, type: 2, biz_id: String(node.rid) });
        else plain(text);
        break;
      case 'RICH_TEXT_NODE_TYPE_BV':
        if (node.rid) out.push({ raw_text: String(node.rid), type: 7, biz_id: String(node.rid) });
        else plain(text);
        break;
      case 'RICH_TEXT_NODE_TYPE_EMOJI':
        if (text) out.push({ raw_text: text, type: 9, biz_id: '' });
        break;
      case 'RICH_TEXT_NODE_TYPE_LOTTERY':
      case 'RICH_TEXT_NODE_TYPE_VOTE':
      case 'RICH_TEXT_NODE_TYPE_GOODS':
        throw new BiliError('UNSUPPORTED', '该定时草稿含抽奖/投票/商品卡，插件暂不能安全地立即发布，请在 B站网页操作');
      default:
        // 网页端对未知节点也按可见文本处理；保留文字比保留节点类型更重要。
        plain(text);
    }
  }
  return out;
}

function timingPics(content) {
  const pics = content?.pics;
  if (pics == null) return [];
  if (!Array.isArray(pics)) throw new BiliError('INVALID_RESPONSE', '定时草稿图片格式异常');
  return pics.map(pic => {
    // 网页端把列表里的 {url,width,height,size,live_url,aigc} 转成上传后的图片结构。
    const src = pic?.url ?? pic?.src ?? pic?.img_src;
    const width = Number(pic?.width ?? pic?.img_width);
    const height = Number(pic?.height ?? pic?.img_height);
    const size = Number(pic?.size ?? pic?.img_size);
    if (typeof src !== 'string' || !src || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      throw new BiliError('INVALID_RESPONSE', '定时草稿图片缺少地址或尺寸，已在预览阶段停止，请核对网页端草稿');
    }
    return {
      img_src: src, img_width: width, img_height: height,
      ...(Number.isFinite(size) && size > 0 ? { img_size: size } : {}),
      ...(pic?.live_url ? { live_video_src: String(pic.live_url) } : {}),
      ...(pic?.aigc === true ? { ai_gen_pic: true } : {}),
    };
  });
}

/** 由新版草稿列表内容重建“立即发布”请求体，与网页端 u8.getReq 的结构一致。 */
export function buildTimingDynReq(row) {
  if (row?.source !== 'timing') throw new BiliError('INVALID_ARGUMENT', '不是新版定时草稿');
  const content = row.content;
  const contents = timingContents(content);
  const pics = timingPics(content);
  if (!contents.length && !pics.length) {
    throw new BiliError('INVALID_RESPONSE', '定时草稿没有可发布的正文或图片，已停止');
  }
  if (pics.length && !contents.length) contents.push({ raw_text: '分享图片', type: 1, biz_id: '' });
  const topic = row.topic;
  return {
    content: {
      contents,
      ...(typeof content?.title === 'string' && content.title ? { title: content.title } : {}),
    },
    pics,
    // 网页端 getReq 在正文或图片非空时会把 scene=0 推成 2。
    scene: 2,
    meta: { app_meta: { from: 'create.dynamic.web', mobi_app: 'web' } },
    option: {
      aigc: 2,
      ...(pics.length ? { pic_mode: Number(content?.style) === 1 ? 1 : 0 } : {}),
    },
    ...(topic?.id ? {
      topic: {
        id: String(topic.id),
        ...(typeof topic.name === 'string' && topic.name ? { name: topic.name } : {}),
        ...(typeof topic.from_source === 'string' && topic.from_source ? { from_source: topic.from_source } : {}),
      },
    } : {}),
  };
}

export async function deleteTimingDraft({ draftId, jar, signal } = {}) {
  return postJson(TIMING_DELETE, { jar, signal, payload: { dyn_id_str: String(draftId) } });
}

export async function publishTimingDraft({ draftId, dynReq, jar, signal } = {}) {
  return postJson(TIMING_PUBLISH, { jar, signal, payload: { dyn_id_str: String(draftId), dyn_req: dynReq } });
}
