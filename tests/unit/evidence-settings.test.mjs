import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEvidence } from '../../lib/media/evidence.mjs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const enabled = { subtitles: true, comments: true, danmaku: true, frames: true };
function fixture() {
  const calls = [];
  const stub = (source, value) => async () => { calls.push(source); return value; };
  return { calls, dependencies: {
    getVideo: stub('metadata', { aid: 1, pages: [{ page: 1, cid: 2, duration: 60 }] }),
    getSubtitles: stub('subtitles', { status: 'empty', cues: [] }),
    getComments: stub('comments', { status: 'empty', total: 0 }),
    getDanmaku: stub('danmaku', { status: 'empty', total: 0, density: [] }),
    buildOverviewWithAdaptive: stub('frames', { images: [], warnings: [] }),
  } };
}
for (const source of Object.keys(enabled)) {
  test(`settings disables ${source} without a request or missing gap`, async () => {
    const f = fixture();
    const { bundle } = await buildEvidence({ bvid: 'fixture', settings: { ...enabled, [source]: false }, include: { [source]: true }, dependencies: f.dependencies });
    assert.ok(!f.calls.includes(source));
    assert.equal(bundle.sources.find(s => s.kind === source).status, 'skipped');
    assert.equal(bundle.sources.find(s => s.kind === source).skippedBy, 'settings');
    assert.ok(!bundle.gaps.includes({ subtitles: 'no_subtitles', comments: 'no_comments', danmaku: 'no_danmaku', frames: 'no_visual' }[source]));
    if (source === 'danmaku') assert.deepEqual(bundle.suggestedWindows, []);
    if (['comments', 'danmaku'].includes(source)) assert.deepEqual([bundle[source].status, bundle[source].skippedBy], ['skipped', 'settings']);
    if (source === 'subtitles') assert.match(bundle.subtitles.note, /设置关闭/);
  });
}
test('caller skips and settings take priority for all sources', async () => {
  for (const settings of [enabled, Object.fromEntries(Object.keys(enabled).map(k => [k, false]))]) {
    const f = fixture();
    const { bundle } = await buildEvidence({ settings, dependencies: f.dependencies, include: Object.fromEntries(Object.keys(enabled).map(k => [k, false])) });
    assert.deepEqual(f.calls, ['metadata']);
    assert.deepEqual(bundle.gaps, []);
    for (const source of bundle.sources.slice(1)) {
      assert.equal(source.status, 'skipped');
      assert.equal(source.skippedBy, settings[source.kind] ? 'caller' : 'settings');
      if (['comments', 'danmaku'].includes(source.kind)) {
        assert.equal(bundle[source.kind].status, source.status);
        assert.equal(bundle[source.kind].skippedBy, source.skippedBy);
      }
    }
    assert.match(bundle.subtitles.note, settings.subtitles ? /调用方关闭/ : /设置关闭/);
  }
});
test('cursor and window conflicts reject before collection', async () => {
  for (const [source, option] of [['subtitles', { subtitleCursor: 'cursor' }], ['danmaku', { danmakuWindow: { startSeconds: 0, endSeconds: 1 } }]]) {
    for (const by of ['settings', 'caller']) {
      const f = fixture();
      await assert.rejects(buildEvidence({ ...option, dependencies: f.dependencies, settings: { ...enabled, [source]: by !== 'settings' }, include: { [source]: by !== 'caller' } }), e => e.code === 'INVALID_ARGUMENT' && e.message.includes(by === 'settings' ? '设置' : '调用方'));
      assert.deepEqual(f.calls, []);
    }
  }
});
test('default configuration requests all four sources and retains actual missing gaps', async () => {
  const previous = process.env.BILI_DATA_DIR;
  const dir = await mkdtemp(join(tmpdir(), 'evidence-settings-'));
  try {
    process.env.BILI_DATA_DIR = dir;
    const f = fixture();
    const { bundle } = await buildEvidence({ dependencies: f.dependencies });
    assert.deepEqual(f.calls, ['metadata', 'subtitles', 'danmaku', 'comments', 'frames']);
    assert.deepEqual(bundle.gaps, ['no_subtitles', 'no_danmaku', 'no_comments', 'no_visual']);
    for (const source of ['comments', 'danmaku']) {
      assert.equal(bundle[source].status, 'empty');
      assert.equal(bundle[source].status, bundle.sources.find(s => s.kind === source).status);
      assert.ok(bundle.gaps.includes(`no_${source}`));
      assert.equal(bundle[source].skippedBy, undefined);
    }
    await writeFile(join(dir, 'config.json'), JSON.stringify({ extract: { comments: false } }));
    const configured = fixture();
    const result = await buildEvidence({ dependencies: configured.dependencies });
    assert.ok(!configured.calls.includes('comments'));
    assert.equal(result.bundle.comments.skippedBy, 'settings');
  } finally {
    if (previous === undefined) delete process.env.BILI_DATA_DIR; else process.env.BILI_DATA_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
test('requested comment and danmaku failures preserve status and missing gaps', async () => {
  const f = fixture();
  for (const name of ['getComments', 'getDanmaku']) f.dependencies[name] = async () => { throw Error('fixture failure'); };
  const { bundle } = await buildEvidence({ settings: enabled, dependencies: f.dependencies });
  for (const source of ['comments', 'danmaku']) {
    assert.equal(bundle[source].status, 'failed');
    assert.ok(bundle.gaps.includes(`no_${source}`));
    assert.equal(bundle[source].skippedBy, undefined);
  }
});
