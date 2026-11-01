import assert from 'node:assert/strict';
import test from 'node:test';
import { fromBiliCode } from '../../lib/bili/errors.mjs';
import { assertMediaUrl, DEFAULT_REFERER, headersFor, USER_AGENT } from '../../lib/bili/http.mjs';
import { mixinKey, signQuery } from '../../lib/bili/wbi.mjs';
import { parseDanmakuXml, sampleDanmaku } from '../../lib/media/danmaku.mjs';
import { normalizeTargets } from '../../lib/media/inspect.mjs';

test('mixinKey 固定 32 位', () => {
  const key = mixinKey('7cd084941338484aae1ad9425b84077c', '4932caff0ff746eab6f01bf08b70ac45');
  assert.equal(key.length, 32);
});

test('signQuery 确定性、排序、过滤非法字符', () => {
  const keys = {
    imgKey: '7cd084941338484aae1ad9425b84077c',
    subKey: '4932caff0ff746eab6f01bf08b70ac45',
  };
  const now = 1_700_000_000_000;
  const a = signQuery({ mid: '123', pn: 1, keyword: "a!b'c(d)e*f" }, keys.imgKey, keys.subKey, now);
  const b = signQuery({ keyword: "a!b'c(d)e*f", pn: 1, mid: '123' }, keys.imgKey, keys.subKey, now);
  assert.equal(a, b);
  assert.match(a, /w_rid=[0-9a-f]{32}$/);
  assert.match(a, /wts=1700000000/);
  const names = a
    .split('&')
    .map((pair) => pair.split('=')[0])
    .filter((name) => name !== 'w_rid');
  assert.deepEqual(names, ['keyword', 'mid', 'pn', 'wts']);
  assert.ok(!/[!'()*]/.test(a));
});

test('弹幕 XML 解析与实体解码', () => {
  const xml = '<i><d p="12.5,1,25,16777215,0,0,abc,1">你好 &amp; 世界</d><d p="61.2,1,25,0,0,0,def,2">第二条</d></i>';
  const items = parseDanmakuXml(xml);
  assert.equal(items.length, 2);
  assert.equal(items[0].timeSec, 12.5);
  assert.equal(items[0].text, '你好 & 世界');
});

test('弹幕按时间桶采样，保留密度', () => {
  const items = [];
  for (let i = 0; i < 100; i += 1) items.push({ timeSec: i, text: `弹幕-${i}-${'x'.repeat(i % 7)}` });
  const result = sampleDanmaku(items, { bucketSec: 30, limit: 6, perBucket: 2 });
  assert.equal(result.total, 100);
  assert.ok(result.density.length >= 3);
  assert.equal(result.samples.length, 6);
  assert.ok(result.samples.every((sample) => typeof sample.timeSec === 'number'));
});

test('补帧目标：时间点 + 区间、上限、非法输入', () => {
  const targets = normalizeTargets({
    timestampsMs: [1000],
    intervals: [{ startMs: 10_000, endMs: 30_000, reason: '看图表' }],
    maxFrames: 5,
  });
  assert.ok(targets.length > 1);
  assert.ok(targets.length <= 5);
  assert.equal(targets[0].requestedMs, 1000);
  assert.throws(() => normalizeTargets({ timestampsMs: [-1] }), /时间点/);
  assert.throws(() => normalizeTargets({ intervals: [{ startMs: 10, endMs: 5 }] }), /区间/);
  assert.throws(() => normalizeTargets({}), /timestampsMs/);
});

test('业务码映射到稳定错误码', () => {
  assert.equal(fromBiliCode(-101).code, 'AUTH_REQUIRED');
  assert.equal(fromBiliCode(-352).retryable, true);
  assert.equal(fromBiliCode(-404).code, 'NOT_FOUND');
  assert.equal(fromBiliCode(-9999).code, 'UPSTREAM_ERROR');
});

test('媒体 URL 白名单：只放行 B站 域名，挡住内网与外部地址', () => {
  assert.equal(assertMediaUrl('//i0.hdslb.com/bfs/x.jpg').hostname, 'i0.hdslb.com');
  assert.equal(assertMediaUrl('https://upos-sz-mirror.bilivideo.com/a.m4s').protocol, 'https:');
  for (const bad of [
    'https://127.0.0.1/x',
    'https://localhost/x',
    'http://192.168.1.5/x',
    'http://169.254.169.254/latest/meta-data',
    'https://evil.example.com/x',
    'file:///etc/passwd',
  ]) {
    assert.throws(() => assertMediaUrl(bad), (error) => error.code === 'INVALID_ARGUMENT', `应当拒绝 ${bad}`);
  }
});

test('请求头统一：媒体请求带视频页 Referer', () => {
  const headers = headersFor('https://www.bilibili.com/video/BV1xx411c7mD');
  assert.equal(headers.referer, 'https://www.bilibili.com/video/BV1xx411c7mD');
  assert.equal(headers['user-agent'], USER_AGENT);
  assert.equal(headersFor().referer, DEFAULT_REFERER);
  assert.match(USER_AGENT, /Windows NT/);
});
