import assert from 'node:assert/strict';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CookieJar } from '../../lib/bili/http.mjs';
import { clearPlayUrlCache, getPlayUrls } from '../../lib/bili/playurl.mjs';
import { medianGapSeconds } from '../../lib/media/inspect.mjs';
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

test('故事板格间距用中位数，用来如实报告精度', () => {
  assert.equal(medianGapSeconds([0, 6, 12, 18, 24]), 6);
  assert.equal(medianGapSeconds([0, 8, 16, 25]), 8);
  assert.equal(medianGapSeconds([0]), null);
  assert.equal(medianGapSeconds([]), null);
  assert.equal(medianGapSeconds(undefined), null);
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
