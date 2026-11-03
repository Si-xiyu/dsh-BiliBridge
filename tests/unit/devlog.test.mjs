import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordToolCall, snapshotDevLog, clearDevLog, resetDevEnabledCache } from '../../lib/devlog.mjs';
import { registerTool } from '../../lib/tools/helpers.mjs';

test('devlog redacts, bounds, filters, persists and preserves tool execution', async () => {
  const old = process.env.BILI_DATA_DIR;
  const dir = await mkdtemp(join(tmpdir(), 'blb-dev-'));
  process.env.BILI_DATA_DIR = dir;
  const config = enabled => writeFile(join(dir, 'config.json'), JSON.stringify({ dev: { enabled } }));
  try {
    await clearDevLog();
    await config(false); resetDevEnabledCache();
    await recordToolCall({ tool: 'bilibili_test', args: { cookie: 'secret' }, ok: true });
    assert.equal(snapshotDevLog().length, 0);
    await config(true); resetDevEnabledCache();
    await recordToolCall({ tool: 'bilibili_test', args: { cookie: 'secret', nested: { token: 'credential' }, url: 'https://a/b?upsig=signature' }, ok: true, durationMs: 1, result: { text: JSON.stringify({ sessdata: 'hidden', url: 'https://a/b?deadline=123' }) } });
    let [item] = snapshotDevLog();
    assert.equal(item.args.cookie, '[redacted]');
    assert.equal(item.args.url, '[redacted-url]');
    const disk = await readFile(join(dir, 'devlog.jsonl'), 'utf8');
    for (const secret of ['secret', 'credential', 'signature', 'hidden', 'deadline=123']) assert.equal(disk.includes(secret), false);
    const since = item.id;
    await recordToolCall({ tool: 'bilibili_test', args: { text: '中'.repeat(3000) }, result: '中'.repeat(5000), ok: true });
    [item] = snapshotDevLog({ since });
    assert.equal(item.truncated, true);
    assert.ok(Buffer.byteLength(JSON.stringify(item.args)) <= 2048);
    assert.ok(Buffer.byteLength(item.resultPreview) <= 4096);
    assert.equal(snapshotDevLog({ since: item.id }).length, 0);
    let def;
    const ctx = { tools: { register(value) { def = value; } } };
    const result = { data: 1 };
    registerTool(ctx, { name: 'bilibili_success', execute: async () => result });
    assert.deepEqual(await def.execute({ bvid: 'BV1' }), result);
    assert.equal(snapshotDevLog()[0].ok, true);
    const error = Object.assign(new Error('original'), { code: 'TEST' });
    registerTool(ctx, { name: 'bilibili_failure', execute: async () => { throw error; } });
    await assert.rejects(def.execute({}), value => value === error);
    assert.equal(snapshotDevLog()[0].errorCode, 'TEST');
    registerTool(ctx, { name: 'internal', execute: async () => result });
    const last = snapshotDevLog()[0].id;
    await def.execute({}); assert.equal(snapshotDevLog()[0].id, last);
    for (let i = 0; i < 505; i++) await recordToolCall({ tool: 'bilibili_test', args: {}, result: {}, ok: true });
    assert.equal(snapshotDevLog({ limit: 100 }).length, 100);
    assert.equal(snapshotDevLog({ limit: 200 }).length, 200);
    assert.equal(snapshotDevLog({ limit: 200 }).at(-1).id, last + 306);
    const newest = snapshotDevLog({ limit: 100 });
    assert.equal(newest.at(-1).id, last + 406);
    assert.equal(snapshotDevLog({ since: 0, limit: 100 })[0].id, last + 505);
    assert.equal(snapshotDevLog({ since: last + 305, limit: 100 }).at(-1).id, last + 406);
    assert.equal(snapshotDevLog({ since: last, limit: 100 })[0].id, last + 505);
    assert.equal((await readFile(join(dir, 'devlog.jsonl'), 'utf8')).trim().split('\n').length, 500);
    await clearDevLog(); assert.deepEqual(snapshotDevLog(), []);
  } finally {
    if (old === undefined) delete process.env.BILI_DATA_DIR; else process.env.BILI_DATA_DIR = old;
    await rm(dir, { recursive: true, force: true });
  }
});
test('devlog 脱敏正文里夹带的 JSON 片段与单引号键值', async () => {
  const old = process.env.BILI_DATA_DIR;
  const dir = await mkdtemp(join(tmpdir(), 'blb-dev2-'));
  process.env.BILI_DATA_DIR = dir;
  try {
    await writeFile(join(dir, 'config.json'), JSON.stringify({ dev: { enabled: true } }));
    resetDevEnabledCache();
    await recordToolCall({
      tool: 'bilibili_text',
      args: {},
      ok: true,
      result: { text: `日志：{"bili_jct":"0123456789abcdef0123456789abcdef"} 以及 'SESSDATA': 'abc123'` },
    });
    const [item] = snapshotDevLog();
    assert.equal(item.resultPreview.includes('0123456789abcdef'), false);
    assert.equal(item.resultPreview.includes('abc123'), false);
    const disk = await readFile(join(dir, 'devlog.jsonl'), 'utf8');
    assert.equal(disk.includes('0123456789abcdef'), false);
  } finally {
    if (old === undefined) delete process.env.BILI_DATA_DIR; else process.env.BILI_DATA_DIR = old;
  }
});
test('devlog 脱敏转义引号与整段转义的 JSON', async () => {
  const old = process.env.BILI_DATA_DIR;
  const dir = await mkdtemp(join(tmpdir(), 'blb-dev3-'));
  process.env.BILI_DATA_DIR = dir;
  try {
    await writeFile(join(dir, 'config.json'), JSON.stringify({ dev: { enabled: true } }));
    resetDevEnabledCache();
    await recordToolCall({
      tool: 'bilibili_text',
      args: {},
      ok: true,
      // 第一种：值里带转义引号；第二种：整段 JSON 被转义
      result: { text: '日志：{"cookie":"a=\\"short-secret\\""} 以及 {\\"bili_jct\\":\\"other-secret\\"}' },
    });
    const [item] = snapshotDevLog();
    assert.equal(item.resultPreview.includes('short-secret'), false);
    assert.equal(item.resultPreview.includes('other-secret'), false);
  } finally {
    if (old === undefined) delete process.env.BILI_DATA_DIR; else process.env.BILI_DATA_DIR = old;
  }
});
test('devlog 不误伤只是提到敏感词的正文', async () => {
  const old = process.env.BILI_DATA_DIR;
  const dir = await mkdtemp(join(tmpdir(), 'blb-dev4-'));
  process.env.BILI_DATA_DIR = dir;
  try {
    await writeFile(join(dir, 'config.json'), JSON.stringify({ dev: { enabled: true } }));
    resetDevEnabledCache();
    const text = '这条视频讲了 cookie 设置说明与 token 过期处理，共 3 点。';
    await recordToolCall({ tool: 'bilibili_text', args: {}, ok: true, result: { text } });
    const [item] = snapshotDevLog();
    assert.ok(item.resultPreview.includes('cookie 设置说明'), '没有字段赋值的正文要保留');
  } finally {
    if (old === undefined) delete process.env.BILI_DATA_DIR; else process.env.BILI_DATA_DIR = old;
  }
});
test('devlog 覆盖 csrf_token/access_token 变体，且不误伤 face: smile 这类正文', async () => {
  const old = process.env.BILI_DATA_DIR;
  const dir = await mkdtemp(join(tmpdir(), 'blb-dev5-'));
  process.env.BILI_DATA_DIR = dir;
  try {
    await writeFile(join(dir, 'config.json'), JSON.stringify({ dev: { enabled: true } }));
    resetDevEnabledCache();
    await recordToolCall({ tool: 'bilibili_a', args: {}, ok: true, result: { text: '日志：{"csrf_token":"short-secret"}' } });
    await recordToolCall({ tool: 'bilibili_b', args: {}, ok: true, result: { text: '日志：{"access_token":"short-secret"}' } });
    await recordToolCall({ tool: 'bilibili_c', args: {}, ok: true, result: { text: '说明：face: smile，deadline: tomorrow' } });
    const [third, second, first] = snapshotDevLog();
    assert.equal(first.resultPreview.includes('short-secret'), false);
    assert.equal(second.resultPreview.includes('short-secret'), false);
    assert.ok(third.resultPreview.includes('face: smile'), '普通正文不该被整段抹掉');
  } finally {
    if (old === undefined) delete process.env.BILI_DATA_DIR; else process.env.BILI_DATA_DIR = old;
  }
});