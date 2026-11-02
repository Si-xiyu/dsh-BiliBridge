import assert from 'node:assert/strict';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CookieJar } from '../../lib/bili/http.mjs';
import { clearPlayUrlCache, getPlayUrls } from '../../lib/bili/playurl.mjs';
import { medianGapSeconds, maxAbsDeltaMs, normalizeTargets } from '../../lib/media/inspect.mjs';
import { mergeDuplicateOcrEntries, normalizeOcrText, planSamples } from '../../lib/media/ocr.mjs';
import { judgeTranscript, segmentsToEntries } from '../../lib/media/asr.mjs';
import { coverageRatio, normalizeCues } from '../../lib/media/timeline.mjs';
import { suggestedWindowsFromDensity } from '../../lib/media/evidence.mjs';
import {
  locateStoryboardOrder,
  pickOverviewOrders,
  spriteIndexOfOrder,
  tileIndexOfOrder,
  validTileCount,
} from '../../lib/media/frames.mjs';
import { resetFfmpegCache, resolveToolchain } from '../../lib/media/ffmpeg.mjs';

const nav = {
  isLogin: false,
  wbi_img: {
    img_url: 'https://example.test/7cd084941338484aae1ad9425b84077c.png',
    sub_url: 'https://example.test/4932caff0ff746eab6f01bf08b70ac45.png',
  },
};

async function mockFetch(routes, fn) {
  const previous = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const target = new URL(url);
    calls.push({ url: target, options });
    const handler = routes[target.pathname];
    if (!handler) {
      if (target.pathname === '/x/web-interface/nav') return Response.json({ code: 0, data: nav });
      assert.ok(handler, `unexpected request ${target.pathname}`);
    }
    const body = typeof handler === 'function' ? handler(target, options) : handler;
    return Response.json(body);
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = previous;
  }
}

const jar = () => new CookieJar({ buvid3: 'fixture' });

function dash(qualities) {
  return {
    code: 0,
    data: {
      accept_quality: qualities,
      dash: {
        video: qualities.map((id) => ({ id, baseUrl: `https://cdn.example/${id}.m4s`, bandwidth: id * 1000 })),
        audio: [{ baseUrl: 'https://cdn.example/audio.m4s', bandwidth: 132000 }],
      },
    },
  };
}

test('playurl 选择不超过请求画质的最高档', async () => {
  clearPlayUrlCache();
  await mockFetch({ '/x/player/wbi/playurl': dash([112, 80, 64, 32, 16]) }, async () => {
    const play = await getPlayUrls({ bvid: 'BV1xx411c7mD', cid: 1, qn: 80, jar: jar() });
    assert.equal(play.quality.id, 80);
    assert.equal(play.format, 'dash');
    assert.match(play.videoUrl, /^https:\/\/cdn\.example\/80\.m4s$/);
    assert.match(play.audioUrl, /audio\.m4s$/);
    assert.deepEqual(play.acceptQuality, [112, 80, 64, 32, 16]);
  });
});

test('playurl 请求超出上限时给最高档，请求很低时给最低档', async () => {
  clearPlayUrlCache();
  await mockFetch({ '/x/player/wbi/playurl': dash([112, 80, 32]) }, async () => {
    const high = await getPlayUrls({ bvid: 'BV1xx411c7mD', cid: 1, qn: 999, jar: jar() });
    assert.equal(high.quality.id, 112);
  });
  clearPlayUrlCache();
  await mockFetch({ '/x/player/wbi/playurl': dash([112, 80, 32]) }, async () => {
    const low = await getPlayUrls({ bvid: 'BV1xx411c7mD', cid: 1, qn: 20, jar: jar() });
    assert.equal(low.quality.id, 32);
  });
});

test('playurl 兼容 durl 老格式，并缓存同一次结果', async () => {
  clearPlayUrlCache();
  await mockFetch(
    { '/x/player/wbi/playurl': { code: 0, data: { quality: 32, durl: [{ url: 'https://cdn.example/all.mp4' }] } } },
    async (calls) => {
      const first = await getPlayUrls({ bvid: 'BV1xx411c7mD', cid: 2, qn: 80, jar: jar() });
      assert.equal(first.format, 'durl');
      assert.equal(first.quality.label, '480P');
      const second = await getPlayUrls({ bvid: 'BV1xx411c7mD', cid: 2, qn: 80, jar: jar() });
      assert.equal(second.cached, true);
      // 第二次命中缓存，不应再打 playurl（只有第一次的 nav + playurl）。
      assert.equal(calls.filter((call) => call.url.pathname === '/x/player/wbi/playurl').length, 1);
    },
  );
});

test('playurl 没有可用流时报 CONTENT_UNAVAILABLE，不返回空 URL', async () => {
  clearPlayUrlCache();
  await mockFetch({ '/x/player/wbi/playurl': { code: 0, data: {} } }, async () => {
    await assert.rejects(getPlayUrls({ bvid: 'BV1xx411c7mD', cid: 3, jar: jar() }), { code: 'CONTENT_UNAVAILABLE' });
  });
});

test('补帧时间点必须落在当前分 P 内', () => {
  // 不给 durationMs 时不校验（老调用保持可用）
  assert.equal(normalizeTargets({ timestampsMs: [999_999] }).length, 1);
  // 给了就必须挡住越界：否则故事板会默默映射到最后一格
  assert.throws(
    () => normalizeTargets({ timestampsMs: [5000], durationMs: 3000 }),
    (error) => error.code === 'INVALID_ARGUMENT' && /超出当前分 P/.test(error.message),
  );
  assert.equal(normalizeTargets({ timestampsMs: [3000], durationMs: 3000 }).length, 1, '边界值等于时长应允许');
});

test('故事板格间距用中位数，用来如实报告精度', () => {
  assert.equal(medianGapSeconds([0, 6, 12, 18, 24]), 6);
  assert.equal(medianGapSeconds([0, 8, 16, 25]), 8);
  assert.equal(medianGapSeconds([0]), null);
  assert.equal(medianGapSeconds([]), null);
  assert.equal(medianGapSeconds(undefined), null);
});

test('字幕带采样点：数量夹在 2–24、均匀、落在片内', () => {
  const samples = planSamples({ durationMs: 600_000, count: 12 });
  assert.equal(samples.length, 12);
  for (let i = 1; i < samples.length; i += 1) assert.ok(samples[i] > samples[i - 1], '采样点必须递增');
  assert.ok(samples[0] >= 0 && samples[0] < 60_000, '首个采样点应靠近片头但留白');
  assert.ok(samples.at(-1) > 540_000 && samples.at(-1) <= 600_000, '末个采样点应靠近片尾');

  assert.equal(planSamples({ durationMs: 600_000, count: 1 }).length, 2, '太少会被抬到 2');
  assert.equal(planSamples({ durationMs: 600_000, count: 99 }).length, 24, '太多会被压到 24');
  assert.throws(() => planSamples({ durationMs: 0 }), (error) => error.code === 'INVALID_ARGUMENT');
  assert.throws(() => planSamples({ durationMs: NaN }), (error) => error.code === 'INVALID_ARGUMENT');
});

test('故事板多雪碧图：格→图/格 映射与跨图定位', () => {
  const meta = {
    images: ['a', 'b', 'c'],
    cols: 10,
    rows: 10,
    index: Array.from({ length: 250 }, (_, i) => i),
  };
  assert.equal(validTileCount(meta), 250);
  assert.equal(spriteIndexOfOrder(meta, 0), 0);
  assert.equal(spriteIndexOfOrder(meta, 99), 0);
  assert.equal(spriteIndexOfOrder(meta, 100), 1);
  assert.equal(spriteIndexOfOrder(meta, 249), 2);
  assert.equal(tileIndexOfOrder(meta, 150), 50);
  assert.equal(tileIndexOfOrder(meta, 249), 49);

  // 关键回归：长视频 2000s 必须落到第 3 张图，而不是第一张图的最后一格（816s）。
  assert.equal(locateStoryboardOrder(meta, 2000), 249);
  assert.equal(spriteIndexOfOrder(meta, locateStoryboardOrder(meta, 2000)), 2);
  assert.equal(locateStoryboardOrder(meta, 149), 149);
  assert.equal(locateStoryboardOrder(meta, 151), 151);
});

test('故事板概览取样覆盖整条时间轴', () => {
  const meta = {
    images: ['a', 'b', 'c'],
    cols: 10,
    rows: 10,
    index: Array.from({ length: 250 }, (_, i) => i),
  };
  const orders = pickOverviewOrders(meta, 9);
  assert.equal(orders.length, 9);
  assert.equal(orders[0], 0);
  assert.equal(orders.at(-1), 249, '末格应落在最后一张图，而不是第一张图的第 99 格');
  for (let i = 1; i < orders.length; i += 1) assert.ok(orders[i] > orders[i - 1], '取样点应递增');

  const single = { images: ['a'], cols: 10, rows: 10, index: Array.from({ length: 40 }, (_, i) => i) };
  const singleOrders = pickOverviewOrders(single, 9);
  assert.equal(singleOrders.at(-1), 39);
});

test('字幕覆盖按区间并集：重叠、乱序、越界、中间挖空', () => {
  assert.equal(coverageRatio([{ startMs: 0, endMs: 1000 }, { startMs: 500, endMs: 1500 }], 2000), 0.75);
  assert.equal(coverageRatio([{ startMs: 1000, endMs: 2000 }, { startMs: 0, endMs: 500 }], 2000), 0.75);
  assert.equal(coverageRatio([{ startMs: 0, endMs: 3000 }], 2000), 1);
  // 中间挖空：最后一条结束时间是 2000（看起来全覆盖），实际只有 75%。
  assert.equal(coverageRatio([{ startMs: 0, endMs: 1000 }, { startMs: 1500, endMs: 2000 }], 2000), 0.75);
  assert.equal(coverageRatio([], 2000), 0);
  assert.equal(coverageRatio([{ startMs: 0, endMs: 100 }], 0), 0);
});

test('字幕规范化：越界/倒序/负值 cue 会被裁剪或丢弃', () => {
  const cues = [
    { startMs: 5000, endMs: 6000 }, // 整段在片尾之外 → 丢弃
    { startMs: 0, endMs: 1000 },
    { startMs: 2000, endMs: 1500 }, // 倒序 → 丢弃
    { startMs: -100, endMs: 500 }, // 起点为负 → 裁到 0
  ];
  const out = normalizeCues(cues, 2000);
  // 按结束时间排一下再比，避免依赖稳定排序的细节
  const pairs = out.map((cue) => [cue.startMs, cue.endMs]).sort((a, b) => a[1] - b[1]);
  assert.deepEqual(pairs, [[0, 500], [0, 1000]]);
  // 只剩 0–1000 被覆盖
  assert.equal(coverageRatio(out, 2000), 0.5);
  // 全部越界时覆盖度为 0，而不是把 extent 伪造成 1
  assert.equal(coverageRatio(normalizeCues([{ startMs: 5000, endMs: 6000 }], 2000), 2000), 0);
});

test('故事板没有时间索引时明确不可用，而不是伪造一格', () => {
  const noIndex = { images: ['a'], cols: 10, rows: 10, index: [] };
  assert.equal(validTileCount(noIndex), 0);
  assert.deepEqual(pickOverviewOrders(noIndex, 9), []);
  assert.equal(locateStoryboardOrder(noIndex, 10), -1);

  const noImages = { images: [], cols: 10, rows: 10, index: [0, 8, 16] };
  assert.equal(validTileCount(noImages), 0);

  // index 比容量长：容量封顶
  const longer = { images: ['a'], cols: 2, rows: 2, index: [0, 1, 2, 3, 4, 5] };
  assert.equal(validTileCount(longer), 4);
});

test('suggestedWindows：去重、按时间排序、不改动输入、limit=0 返回空', () => {
  const density = [
    { startSec: 30, endSec: 60, count: 5 },
    { startSec: 0, endSec: 30, count: 9 },
    { startSec: 0, endSec: 30, count: 9 },
    { startSec: 60, endSec: 90, count: 1 },
  ];
  const snapshot = JSON.stringify(density);
  const windows = suggestedWindowsFromDensity(density, { limit: 2 });
  assert.equal(JSON.stringify(density), snapshot, '不应修改传入的 density 数组');
  assert.deepEqual(windows.map((w) => w.startSeconds), [0, 30]);
  assert.equal(windows[0].danmakuCount, 9);
  assert.deepEqual(suggestedWindowsFromDensity(density, { limit: 0 }), []);
});

test('故事板误差用每帧实测偏差，而不是中位间距的一半', () => {
  // 用户给的反例：index=[0,2,4,6,100]，请求 50s 会落到 6s（偏差 44s）。
  // 中位间距是 2s，一半只有 1s —— 拿它当“最大误差”会严重低报。
  const frames = [{ deltaMs: -44000 }, { deltaMs: 0 }];
  assert.equal(maxAbsDeltaMs(frames), 44000);
  assert.equal(maxAbsDeltaMs([{ deltaMs: 1200 }]), 1200);
  assert.equal(maxAbsDeltaMs([]), null);
  assert.equal(maxAbsDeltaMs([{ deltaMs: null }]), null);
  // 中位间距仍是“典型值”，与上界分开报告：间距 [2,2,2,94] 的中位数是 2s。
  assert.equal(medianGapSeconds([0, 2, 4, 6, 100]), 2);
});

test('ASR 置信度判定：空、低置信、可用三种情况', () => {
  assert.equal(judgeTranscript({ segments: [] }).level, 'empty');
  assert.equal(judgeTranscript({ segments: [{ start: 0, end: 1, text: 'x' }], confidence: { low_confidence_ratio: 0.5 } }).level, 'low');
  assert.equal(judgeTranscript({ segments: [{ start: 0, end: 1, text: 'x' }], confidence: { avg_logprob: -1.4, low_confidence_ratio: 0.1 } }).level, 'low');
  assert.equal(judgeTranscript({ segments: [{ start: 0, end: 1, text: 'x' }], confidence: { avg_logprob: -0.2, low_confidence_ratio: 0.05 } }).usable, true);
});

test('ASR 段落转统一证据条目：毫秒时间、跳过空文本', () => {
  const entries = segmentsToEntries({
    segments: [
      { start: 1.5, end: 2.5, text: '  你好  ' },
      { start: 3, end: 3.5, text: '   ' },
      { start: 4.2, end: 5.9, text: '世界' },
    ],
  });
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0], { atMs: 1500, endMs: 2500, text: '你好', source: 'asr' });
  assert.equal(entries[1].atMs, 4200);
});

test('OCR 文本清理：中文之间不保留空格，保持英文单词边界', () => {
  assert.equal(normalizeOcrText('这 被 称 为 枳 械 智 力'), '这被称为枳械智力');
  assert.equal(normalizeOcrText('  中文   和 English 混排  '), '中文和 English 混排');
  assert.equal(normalizeOcrText('lt\'s ealled mechanieal'), "lt's ealled mechanieal");
  assert.equal(normalizeOcrText(null), '');
});

test('OCR 连续重复行合并：只保留最早时间，并记录命中次数与结束时间', () => {
  const merged = mergeDuplicateOcrEntries([
    { atMs: 1000, text: '同一句', region: 'subtitle-band', source: 'ocr' },
    { atMs: 3000, text: '同一句', region: 'subtitle-band', source: 'ocr' },
    { atMs: 5000, text: '换了一句', region: 'subtitle-band', source: 'ocr' },
    { atMs: 7000, text: '同一句', region: 'subtitle-band', source: 'ocr' },
  ]);
  assert.equal(merged.length, 3, 'A/A/B/A 合并成 3 条（不跨行合并）');
  assert.equal(merged[0].atMs, 1000);
  assert.equal(merged[0].endAtMs, 3000);
  assert.equal(merged[0].hits, 2);
  assert.equal(merged[1].text, '换了一句');
  assert.equal(merged[2].atMs, 7000);
});

test('ffmpeg 不存在时抛 DEPENDENCY_MISSING，而不是静默降级', async () => {
  // 隔离：数据目录里不能有 config.json（否则会真的找到 ffmpeg），PATH 也要清空。
  const previousPath = process.env.FFMPEG_PATH;
  const previousData = process.env.BILI_DATA_DIR;
  const previousEnvPath = process.env.PATH;
  process.env.FFMPEG_PATH = 'E:\\definitely\\not\\here\\ffmpeg.exe';
  process.env.BILI_DATA_DIR = join(tmpdir(), `bili-no-config-${process.pid}`);
  process.env.PATH = '';
  resetFfmpegCache();
  try {
    await assert.rejects(resolveToolchain(), (error) => error.code === 'DEPENDENCY_MISSING');
  } finally {
    if (previousPath === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = previousPath;
    if (previousData === undefined) delete process.env.BILI_DATA_DIR;
    else process.env.BILI_DATA_DIR = previousData;
    process.env.PATH = previousEnvPath;
    resetFfmpegCache();
  }
});
