/**
 * 新版定时草稿“立即发布”真实验收：只处理网页里明确可处置的 test 草稿。
 *
 *   node tests/manual-publish-draft-acceptance.mjs --apply --draft-id <id>
 *
 * 需要插件钩子返回 ask，且剩余写入额度足够发布 + 删除动态。发布结果没有
 * 动态 ID 时只读动态列表核对，绝不再提交一次；核对不到就保留草稿并退出。
 */
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { apply } from '../lib/index.js';
import { currentJar } from '../lib/bili/auth.mjs';
import { trafficGuard } from '../lib/bili/traffic-guard.mjs';

const { values } = parseArgs({ options: {
  apply: { type: 'boolean', default: false },
  'draft-id': { type: 'string' },
} });
const tools = new Map();
let gate;
apply({ on(name, hook) { if (name === 'tools/pre-execute') gate = hook; },
  tools: { register(tool) { tools.set(tool.name, tool); } } });
const log = (step, data = {}) => console.log(JSON.stringify({ mode: 'publish_draft_now', step, ...data }));
async function invoke(name, args = {}) {
  const tool = tools.get(`bilibili_${name}`);
  const run = () => tool.execute(args, { signal: AbortSignal.timeout(tool.timeoutMs ?? 120_000) });
  if (args.intent !== 'apply') return gate({ name: tool.name, args }, run);
  assert.ok(values.apply, '真实发布需要 --apply');
  const decision = await gate({ name: tool.name, args }, () => { throw new Error('缺少审批门禁'); });
  assert.equal(decision?.kind, 'ask');
  return run();
}
const listDrafts = async () => (await invoke('content_manage', { action: 'list_drafts' })).data.items;

try {
  const me = (await invoke('auth_status')).data.accountId;
  const drafts = await listDrafts();
  // 即使指定 ID，也只接受正文为 test 的一次性草稿，避免误发布真实内容。
  const candidates = drafts.filter((draft) => draft.source === 'timing' && draft.text === 'test' &&
    (!values['draft-id'] || draft.draftId === values['draft-id']));
  assert.equal(candidates.length, 1, '需要且只能有一条明确的 test 定时草稿');
  const draftId = candidates[0].draftId;
  log('draft.found', { draftId, title: candidates[0].title, publishTime: candidates[0].publishTime });

  const { jar } = await currentJar();
  const status = await trafficGuard.status(jar);
  if (Math.min(status.remaining.writeHourly, status.remaining.writeDaily) < 2) {
    throw Object.assign(new Error('写入余额不足以发布并清理'), { code: 'INSUFFICIENT_CLEANUP_BUDGET' });
  }
  const resumeAt = Math.max(status.publishResumeAt, status.writeResumeAt);
  if (resumeAt > status.observedAt) {
    log('cooldown', { resumeAt });
    await sleep(resumeAt - status.observedAt + 500);
  }

  // 发布前快照最近同文动态：发布接口没有返回 ID 时，只清理“新出现且唯一”的一条。
  const before = (await invoke('dynamics', { mid: me, pageSize: 20 })).data.items
    .filter((item) => Date.parse(item.publishedAt) >= Date.now() - 30 * 60_000 && item.text === 'test')
    .map((item) => item.dynamicId);
  const preview = (await invoke('content_manage', { action: 'publish_draft_now', draftId, intent: 'preview' })).data;
  assert.equal(preview.status, 'PREVIEW');
  log('publish.preview', { text: preview.draft?.text, imageCount: preview.draft?.imageCount });
  const published = (await invoke('content_manage', { action: 'publish_draft_now', draftId, intent: 'apply', previewToken: preview.previewToken })).data;
  log('publish.apply', { status: published.status, dynamicId: published.dynamicId ?? null, error: published.error });

  let dynamicId = published.dynamicId;
  if (!dynamicId) {
    const page = (await invoke('dynamics', { mid: me, pageSize: 20 })).data.items;
    const fresh = page.filter((item) => !before.includes(item.dynamicId) &&
      Date.parse(item.publishedAt) >= Date.now() - 10 * 60_000 && item.text === 'test');
    assert.equal(fresh.length, 1, '发布后未能唯一定位新动态；不回退删除任何旧动态');
    dynamicId = fresh[0].dynamicId;
  }
  assert.ok(dynamicId, '发布结果未确认：动态列表里找不到 test 动态；草稿保留，不重发');
  const detail = (await invoke('dynamics', { dynamicId })).data;
  assert.equal(detail.text, 'test');
  log('publish.readback', { dynamicId, text: detail.text });
  assert.ok(!(await listDrafts()).some((draft) => draft.draftId === draftId), '发布后草稿仍在列表');
  log('draft.consumed', { draftId });

  const deletePreview = (await invoke('content_manage', { action: 'delete_dynamic', dynamicId, intent: 'preview' })).data;
  assert.equal(deletePreview.status, 'PREVIEW');
  const deleted = (await invoke('content_manage', { action: 'delete_dynamic', dynamicId, intent: 'apply', previewToken: deletePreview.previewToken })).data;
  assert.equal(deleted.status, 'DELETED');
  await assert.rejects(invoke('dynamics', { dynamicId }), (error) => error.code === 'NOT_FOUND');
  log('dynamic.deleted', { dynamicId });
  log('passed', { draftId, dynamicId });
} catch (error) {
  log('failed', { code: error.code ?? 'ERROR', biliCode: error.biliCode, message: String(error.message).slice(0, 200) });
  process.exitCode = 1;
}
