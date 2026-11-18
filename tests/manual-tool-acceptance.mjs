import { parseArgs } from 'node:util';
import assert from 'node:assert/strict';
import { apply } from '../lib/index.js';

const { values } = parseArgs({ options: {
  bvid: { type: 'string', default: 'BV1YLHu6zEDp' },
  'asr-bvid': { type: 'string', default: 'BV1YLHu6zEDp' },
  'dynamic-id': { type: 'string' },
  keyword: { type: 'string', default: '编程' },
  media: { type: 'boolean', default: false },
} });
const tools = new Map();
const gates = [];
apply({
  on(name, hook) { if (name === 'tools/pre-execute') gates.push(hook); },
  tools: { register(tool) { assert.ok(!tools.has(tool.name)); tools.set(tool.name, tool); } },
});
assert.equal(tools.size, 27);
assert.equal(gates.length, 1);
const bvid = values.bvid;
const verified = new Set();
const outcomes = [];
const platformStop = new Set(['AUTH_REQUIRED', 'RATE_LIMITED', 'RISK_CONTROLLED', 'INVALID_RESPONSE',
  'TRAFFIC_BUSY', 'TRAFFIC_PAUSED', 'TRAFFIC_BUDGET_EXCEEDED', 'TRAFFIC_MANUAL_REQUIRED', 'TRAFFIC_STATE_CORRUPT']);
let stopped = false;

async function check(name, args = {}, validate = () => {}, label = name) {
  if (stopped) { outcomes.push({ name, label, status: 'not_run' }); return; }
  assert.notEqual(args.intent, 'apply');
  try {
    const tool = tools.get(name);
    const signal = AbortSignal.timeout(tool.timeoutMs ?? 120_000);
    const result = await gates[0]({ name, args }, () => tool.execute(args, { signal }));
    if (result?.status === 'partial') {
      const reasons = [
        result.data?.stopDetails?.code,
        ...(result.data?.sources ?? []).filter(source => source.status === 'failed').map(source => source.error?.code),
      ].filter(Boolean);
      stopped = Boolean(result.data?.stopped) || reasons.some(code => platformStop.has(code));
      outcomes.push({ name, label, status: 'partial', reasons });
      process.exitCode = 1;
      return result;
    }
    assert.equal(result?.status, 'ok');
    validate(result);
    verified.add(name);
    outcomes.push({ name, label, status: 'passed' });
    return result;
  } catch (error) {
    outcomes.push({ name, label, status: 'failed', code: error.code ?? 'ERROR', biliCode: error.biliCode });
    if (platformStop.has(error.code)) stopped = true;
    process.exitCode = 1;
  }
}

const login = await check('bilibili_auth_status', {}, result => assert.equal(result.data.loggedIn, true));
const mid = login?.data?.accountId;
if (!mid) stopped = true;
await check('bilibili_me', {}, result => assert.equal(result.data.loggedIn, true));
await check('bilibili_video', { bvid }, result => assert.equal(result.data.bvid, bvid));
await check('bilibili_user_videos', { mid, ps: 1 });
await check('bilibili_watch_later_list');
const folders = await check('bilibili_favorites_list');
const mediaId = folders?.data?.items?.[0]?.mediaId;
if (mediaId) await check('bilibili_favorites_list', { mediaId: String(mediaId), ps: 1 }, undefined, 'favorite_items');
await check('bilibili_search', { keyword: values.keyword, pageSize: 1 });
await check('bilibili_comments', { bvid, pageSize: 1 });
await check('bilibili_user_profile', { mid });
await check('bilibili_dynamics', { pageSize: 1 });
if (values['dynamic-id']) await check('bilibili_dynamics', { dynamicId: values['dynamic-id'], includeImages: values.media }, undefined, 'dynamic_detail');
await check('bilibili_discover', { scope: 'rank', pageSize: 1 });
await check('bilibili_notifications', { scope: 'unread' });
await check('bilibili_messages', { scope: 'sessions', size: 1 });
await check('bilibili_content_manage', { action: 'list_drafts' });
await check('bilibili_collect', { keyword: values.keyword, maxVideos: 1, commentsPerVideo: 1 });
await check('bilibili_extract', { bvid, commentLimit: 1, danmakuLimit: 5, include: { frames: values.media } });
if (values.media) {
  await check('bilibili_inspect', { bvid, timestampsMs: [5000], maxFrames: 1, source: 'ffmpeg' }, result => {
    assert.equal(result.data.source, 'ffmpeg');
    assert.equal(result.data.frames.length, 1);
  });
  await check('bilibili_transcribe', { bvid: values['asr-bvid'], startSeconds: 15, durationSeconds: 20 }, result => {
    assert.equal(result.data.verdict.usable, true);
  });
}
console.log(JSON.stringify({
  mode: 'live_read_handler',
  registered: tools.size,
  verified: verified.size,
  outcomes,
  unverified: [...tools.keys()].filter(name => !verified.has(name)),
}, null, 2));
