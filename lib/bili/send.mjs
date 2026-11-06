import { randomUUID } from 'node:crypto';
import { getCurrentUser, getVideo } from './api.mjs';
import { postForm, request } from './http.mjs';
import { BiliError } from './errors.mjs';
import { assertMid } from './read.mjs';
import { sendOnce, checkSend, textHash } from './send-ledger.mjs';
import { previewSend, verifyPreview } from './send-preview.mjs';

export async function sender(jar) {
  const me = await getCurrentUser({ jar });
  if (!me) throw new BiliError('AUTH_REQUIRED', '请先登录');
  return me.mid;
}
export function validateIntent(intent = 'preview') {
  if (!['preview', 'apply', 'check'].includes(intent)) throw new BiliError('INVALID_ARGUMENT', 'intent 只能是 preview/apply/check');
  return intent;
}
export function validateText(text, max) {
  if (typeof text !== 'string' || !text.trim() || text.length > max) throw new BiliError('INVALID_ARGUMENT', `正文长度必须为 1–${max}`);
  return text.normalize('NFC');
}
function confirmedId(value) {
  if (!/^[1-9]\d*$/.test(String(value ?? ''))) throw new BiliError('INVALID_RESPONSE', '响应缺少内容 ID，需要核对结果');
  return String(value);
}

async function findComment(row, jar, signal, account) {
  const root = row.target.root;
  const data = await request(`https://api.bilibili.com/x/v2/reply${root ? '/reply' : ''}`, { query: { type: 1, oid: row.target.aid, root: root || undefined, sort: 0, pn: 1, ps: 20 }, jar, signal });
  const match = data.replies?.find(r => String(r.member?.mid) === account && textHash(r.content?.message) === row.textHash &&
    Number(r.ctime) * 1000 >= row.createdAt - 5000 && Number(r.ctime) * 1000 <= row.createdAt + 180000 &&
    (!root || String(r.parent_str ?? r.parent) === row.target.parent));
  return match ? { rpid: confirmedId(match.rpid_str ?? match.rpid), url: `https://www.bilibili.com/video/${row.target.bvid}#reply${match.rpid_str ?? match.rpid}` } : null;
}

export async function commentSend({ intent = 'preview', operationId, bvid, text, rpid = '0', root = '0', previewToken, jar, signal } = {}) {
  validateIntent(intent);
  const account = await sender(jar);
  if (intent === 'check') return checkSend({ account, kind: 'comment', operationId, find: row => findComment(row, jar, signal, account) });
  text = validateText(text, 1000);
  if (![rpid, root].every(id => typeof id === 'string' && /^(0|[1-9]\d*)$/.test(id)) || (rpid === '0' && root !== '0')) throw new BiliError('INVALID_ARGUMENT', '回复 ID 不合法');
  const video = await getVideo(bvid, { jar, signal });
  const target = { bvid, aid: String(video.aid), root: rpid === '0' ? '' : root === '0' ? rpid : root, parent: rpid === '0' ? '' : rpid };
  const payload = { target, text };
  if (intent === 'preview') return previewSend(account, 'comment', payload);
  await verifyPreview(account, 'comment', payload, previewToken);
  return sendOnce({ account, kind: 'comment', target, text, submit: async () => {
    const result = await postForm('https://api.bilibili.com/x/v2/reply/add', { jar, signal, fields: { oid: video.aid, type: 1, message: text, root: target.root, parent: target.parent, plat: 1 } });
    const id = confirmedId(result.rpid_str ?? result.rpid ?? result.reply?.rpid_str ?? result.reply?.rpid);
    return { rpid: id, url: `https://www.bilibili.com/video/${bvid}#reply${id}` };
  } });
}

export async function messageSend({ intent = 'preview', operationId, receiverMid, text, previewToken, jar, signal } = {}) {
  validateIntent(intent);
  const account = await sender(jar);
  if (intent === 'check') return checkSend({ account, kind: 'message', operationId, find: async row => {
    const data = await request('https://api.vc.bilibili.com/svr_sync/v1/svr_sync/fetch_session_msgs', { query: { talker_id: row.target.receiverMid, session_type: 1, size: 20 }, jar, signal });
    const match = data.messages?.find(r => {
      let content; try { content = JSON.parse(r.content); } catch { return false; }
      return String(r.sender_uid) === account && Number(r.timestamp) * 1000 >= row.createdAt - 5000 && Number(r.timestamp) * 1000 <= row.createdAt + 180000 && textHash(content.content) === row.textHash;
    });
    return match ? { messageId: confirmedId(match.msg_key), receiverMid: row.target.receiverMid } : null;
  } });
  assertMid(receiverMid); text = validateText(text, 1000);
  if (Buffer.byteLength(JSON.stringify({ content: text })) > 2000) throw new BiliError('INVALID_ARGUMENT', '私信内容超过 2000 字节');
  const target = { receiverMid };
  const payload = { target, text };
  if (intent === 'preview') return previewSend(account, 'message', payload);
  await verifyPreview(account, 'message', payload, previewToken);
  return sendOnce({ account, kind: 'message', target, text, submit: async () => {
    const result = await postForm('https://api.vc.bilibili.com/web_im/v1/web_im/send_msg', { jar, signal, fields: {
      'msg[sender_uid]': account, 'msg[receiver_id]': receiverMid, 'msg[receiver_type]': 1, 'msg[msg_type]': 1, 'msg[msg_status]': 0,
      'msg[content]': JSON.stringify({ content: text }), 'msg[dev_id]': randomUUID().toUpperCase(), 'msg[timestamp]': Math.floor(Date.now() / 1000), 'msg[new_face_version]': 1, csrf_token: jar.get('bili_jct'),
    } });
    return { messageId: confirmedId(result.msg_key), receiverMid };
  } });
}
