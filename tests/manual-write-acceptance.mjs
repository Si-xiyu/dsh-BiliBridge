import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import sharp from 'sharp';
import { apply } from '../lib/index.js';
import { currentJar } from '../lib/bili/auth.mjs';
import { trafficGuard } from '../lib/bili/traffic-guard.mjs';

const { values, positionals: [mode] } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    apply: { type: 'boolean' },
    bvid: { type: 'string' },
    folder: { type: 'string' },
    'dm-mid': { type: 'string' },
  },
});
assert.ok(['state', 'comment', 'dynamic', 'draft', 'message'].includes(mode));
if (['state', 'comment'].includes(mode)) assert.match(values.bvid ?? '', /^BV[0-9A-Za-z]{10}$/);
if (mode === 'state') assert.ok(values.folder);
if (mode === 'message') assert.match(values['dm-mid'] ?? '', /^[1-9]\d*$/);

const tools = new Map();
let gate;
apply({ on(name, hook) { if (name === 'tools/pre-execute') gate = hook; },
  tools: { register(tool) { tools.set(tool.name, tool); } } });
const log = (step, data = {}) => console.log(JSON.stringify({ mode, step, ...data }));
const redact = error => ({ code: error.code ?? 'ERROR', biliCode: error.biliCode,
  ...(mode === 'dynamic' && error.code === 'ERR_ASSERTION' ? { message: error.message } : {}) });
async function invoke(name, args = {}) {
  const tool = tools.get(`bilibili_${name}`);
  const run = () => tool.execute(args, { signal: AbortSignal.timeout(tool.timeoutMs ?? 120_000) });
  const result = await gate({ name: tool.name, args }, args.intent === 'apply' ? () => {
    throw new Error('缺少审批门禁，未执行写入');
  } : run);
  if (args.intent !== 'apply') return result;
  assert.ok(values.apply);
  assert.equal(result.kind, 'ask');
  return run();
}

async function preview(name, args) {
  const result = (await invoke(name, { ...args, intent: 'preview' })).data;
  log(`${name}.preview`, { status: result.status ?? 'PREVIEW', current: result.current?.state });
  return result;
}

async function mutate(name, args, plan) {
  return (await invoke(name, { ...args, intent: 'apply',
    ...(plan.previewToken ? { previewToken: plan.previewToken } : {}) })).data;
}

async function setState(name, args, key) {
  const before = await preview(name, { ...args, [key]: true });
  const original = before.current?.state;
  assert.equal(typeof original, 'boolean');
  if (!values.apply) return;
  const desired = !original;
  try {
    const changed = await mutate(name, { ...args, [key]: desired }, {});
    assert.equal(changed.verified, true);
    assert.equal(changed.after?.state, desired);
    log(`${name}.changed`, { original, desired, verified: true });
  } finally {
    const restore = { ...args, [key]: original };
    const state = await preview(name, restore);
    if (state.current?.state === !original) {
      const restored = await mutate(name, restore, {});
      assert.equal(restored.verified, true);
      assert.equal(restored.after?.state, original);
    } else assert.equal(state.current?.state, original);
    log(`${name}.restored`, { original, verified: true });
  }
}

async function send(name, args) {
  const plan = await preview(name, args);
  if (!values.apply) return null;
  let result = await mutate(name, args, plan);
  log(`${name}.apply`, { status: result.status, operationId: result.operationId, error: result.error, biliCode: result.biliCode, result: result.result });
  if (result.status === 'PENDING_CONFIRM') {
    result = (await invoke(name, { intent: 'check', operationId: result.operationId })).data;
    log(`${name}.check`, { status: result.status, result: result.result });
  }
  if (result.status !== 'SENT') throw Object.assign(new Error('未确认发送成功，不重发'), { code: result.error ?? result.status, biliCode: result.biliCode });
  return result.result;
}

async function remove(args) {
  const plan = await preview('content_manage', args);
  const deleted = await mutate('content_manage', args, plan);
  assert.equal(deleted.status, 'DELETED');
}

try {
  if (values.apply) {
    const requiredWrites = { state: 6, comment: 2, dynamic: 3, draft: 2, message: 1 }[mode];
    const { jar } = await currentJar();
    const status = await trafficGuard.status(jar);
    if (Math.min(status.remaining.writeHourly, status.remaining.writeDaily) < requiredWrites) {
      throw Object.assign(new Error('写入余额不足以完成验收和清理'), { code: 'INSUFFICIENT_CLEANUP_BUDGET' });
    }
    const resumeAt = Math.max(status.resumeAt, status.writeResumeAt,
      ['comment', 'dynamic', 'draft'].includes(mode) ? status.publishResumeAt : 0,
      mode === 'message' ? status.messageResumeAt : 0);
    if (resumeAt > status.observedAt) {
      log('cooldown', { resumeAt });
      throw Object.assign(new Error('写入仍在冷却，未开始验收'), { code: 'WRITE_PAUSED' });
    }
  }
  const text = `BiliBridge 工具验收测试，请忽略。（${Date.now()}）`;
  if (mode === 'state') {
    const { items } = (await invoke('favorites_list')).data;
    const folders = items.filter(item => item.title === values.folder);
    assert.equal(folders.length, 1);
    await setState('watch_later_set', { bvid: values.bvid }, 'added');
    await setState('favorite_set', { bvid: values.bvid, mediaId: String(folders[0].mediaId) }, 'added');
    await setState('video_like_set', { bvid: values.bvid }, 'liked');
  } else if (mode === 'comment') {
    const target = { bvid: values.bvid };
    const read = async () => (await invoke('comments', { ...target, sort: 'new', pageSize: 20, includeReplies: false })).data.items;
    await read();
    const sent = await send('comment_send', { ...target, text });
    if (sent) {
      const { rpid } = sent;
      try {
        assert.ok((await read()).some(item => String(item.rpid) === rpid));
        log('comment.readback', { rpid });
      } finally {
        await remove({ action: 'delete_comment', ...target, rpid });
        assert.ok(!(await read()).some(item => String(item.rpid) === rpid));
        log('comment.deleted', { rpid });
      }
    }
  } else if (mode === 'message') {
    const target = { receiverMid: values['dm-mid'] };
    if (await send('message_send', { ...target, text })) {
      const { items } = (await invoke('messages', { scope: 'thread', talkerId: target.receiverMid, size: 10 })).data;
      assert.ok(items.some(item => item.direction === 'out' && item.text === text));
      log('message.readback', { verified: true });
    }
  } else if (mode === 'draft') {
    const read = async () => (await invoke('content_manage', { action: 'list_drafts' })).data.items;
    await read();
    const sent = await send('dynamic_publish', { text, scheduleTime: Math.floor(Date.now() / 1000) + 3600 });
    if (sent) {
      const { draftId } = sent;
      try {
        assert.ok((await read()).some(item => item.draftId === draftId && item.text === text));
        log('draft.readback', { draftId });
      } finally {
        await remove({ action: 'delete_draft', draftId });
        assert.ok(!(await read()).some(item => item.draftId === draftId));
        log('draft.deleted', { draftId });
      }
    }
  } else {
    const dir = await mkdtemp(join(tmpdir(), 'bili-write-acceptance-'));
    try {
      const image = join(dir, 'test.png');
      await sharp({ create: { width: 256, height: 256, channels: 3, background: '#3c9ba8' } }).png().toFile(image);
      const sent = await send('dynamic_publish', { text, images: [image] });
      if (sent) {
        const { dynamicId } = sent;
        const read = () => invoke('dynamics', { dynamicId });
        try {
          const { data } = await read();
          if (data.text !== text) {
            log('dynamic.text_mismatch', {
              actualLength: data.text?.length,
              expectedLength: text.length,
              trimMatches: data.text?.trim() === text,
              containsExpected: data.text?.includes(text),
              pictureCount: data.pics?.length ?? 0,
            });
          }
          assert.equal(data.text, text, 'published dynamic text does not match after projection');
          assert.equal(data.pics?.length, 1, 'published dynamic image missing after projection');
          log('dynamic.readback', { dynamicId, pictures: data.pics.length });
        } finally {
          await remove({ action: 'delete_dynamic', dynamicId });
          await assert.rejects(read, { code: 'NOT_FOUND' });
          log('dynamic.deleted', { dynamicId });
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
} catch (error) {
  log('failed', redact(error));
  process.exitCode = 1;
}
