import test from 'node:test';
import assert from 'node:assert/strict';
import { CookieJar } from '../../lib/bili/http.mjs';
import { listMessages, listSessions } from '../../lib/bili/messages.mjs';

const jar = new CookieJar({ SESSDATA: 'fixture', DedeUserID: '123' });

async function withFetch(handler, run) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  try { return await run(); } finally { globalThis.fetch = original; }
}

test('sessions 投影会话摘要、游标和未读过滤，不泄漏整包', async () => {
  const queries = [];
  const data = await withFetch(async (input) => {
    const url = new URL(input);
    queries.push(Object.fromEntries(url.searchParams));
    return Response.json({ code: 0, data: { has_more: 1, session_list: [
      { talker_id: 456, session_type: 1, unread_count: 2, session_ts: 1700000000000000, is_follow: 1,
        last_msg: { sender_uid: 456, msg_type: 1, content: '{"content":"你好"}', timestamp: 1700000000, msg_key: 1, msg_seqno: 9, msg_status: 0 } },
      { talker_id: 789, session_type: 2, unread_count: 0, session_ts: 1700000001000000, group_name: '粉丝团' },
    ] } });
  }, () => listSessions({ jar, size: 2 }));
  assert.equal(queries[0].session_type, '4');
  assert.equal(data.items.length, 2);
  assert.equal(data.items[0].talkerId, '456');
  assert.equal(data.items[0].unreadCount, 2);
  assert.equal(data.items[0].following, true);
  assert.equal(data.items[0].lastMessage.text, '你好');
  assert.equal(data.items[0].name, null);
  assert.equal(data.items[1].name, '粉丝团');
  assert.ok(data.nextCursor);
  const filtered = await withFetch(async () => Response.json({ code: 0, data: { has_more: 0, session_list: [
    { talker_id: 1, session_type: 1, unread_count: 0, session_ts: 1 },
    { talker_id: 2, session_type: 1, unread_count: 3, session_ts: 2 },
  ] } }), () => listSessions({ jar, sessionType: 1, unreadOnly: true }));
  assert.deepEqual(filtered.items.map((item) => item.talkerId), ['2']);
  assert.equal(filtered.nextCursor, null);
});

test('thread 投影正文、图片、方向与分页游标', async () => {
  const queries = [];
  const data = await withFetch(async (input) => {
    const url = new URL(input);
    queries.push(Object.fromEntries(url.searchParams));
    return Response.json({ code: 0, data: { has_more: 1, min_seqno: 100, max_seqno: 200, messages: [
      { sender_uid: 123, msg_type: 1, content: '{"content":"我发的"}', timestamp: 1700000000, msg_key: 2, msg_seqno: 200, msg_status: 0 },
      { sender_uid: 456, msg_type: 2, content: '{"url":"https://i0.hdslb.com/a.jpg","width":4,"height":3}', timestamp: 1699999999, msg_key: 1, msg_seqno: 199, msg_status: 1 },
    ] } });
  }, () => listMessages({ jar, talkerId: '456', size: 2 }));
  assert.equal(queries[0].talker_id, '456');
  assert.equal(data.items[0].direction, 'out');
  assert.equal(data.items[0].text, '我发的');
  assert.equal(data.items[1].direction, 'in');
  assert.equal(data.items[1].image.url, 'https://i0.hdslb.com/a.jpg');
  assert.equal(data.items[1].recalled, true);
  assert.ok(data.nextCursor);
  await withFetch(async (input) => {
    const url = new URL(input);
    assert.equal(url.searchParams.get('end_seqno'), '100');
    return Response.json({ code: 0, data: { has_more: 0, messages: [] } });
  }, () => listMessages({ jar, talkerId: '456', cursor: data.nextCursor }));
});

test('私信读取的鉴权、参数与游标绑定', async () => {
  await assert.rejects(listSessions({ jar: new CookieJar({ DedeUserID: '123' }) }), { code: 'AUTH_REQUIRED' });
  await assert.rejects(listSessions({ jar, sessionType: 6 }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(listMessages({ jar, talkerId: '0' }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(listMessages({ jar, talkerId: '456', sessionType: 4 }), { code: 'INVALID_ARGUMENT' });
  const cursor = Buffer.from(JSON.stringify({ scope: 'thread', account: '999', sessionType: 1, talkerId: '456', endSeqno: '1' })).toString('base64url');
  await assert.rejects(listMessages({ jar, talkerId: '456', cursor }), { code: 'INVALID_ARGUMENT' });
});
