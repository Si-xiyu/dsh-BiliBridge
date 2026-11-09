import test from 'node:test';
import assert from 'node:assert/strict';
import { pageSummary } from '../../lib/media/evidence.mjs';

test('多分 P 视频带出分 P 名称与总数', () => {
  const video = { pages: [{ page: 1, part: '创造模式-中文版' }, { page: 2, part: 'Creator Mode-EN Version' }] };
  assert.deepEqual(pageSummary(video, { page: 2, part: 'Creator Mode-EN Version' }),
    { page: 2, part: 'Creator Mode-EN Version', pageCount: 2 });
});

test('单 P 或缺失字段时退化安全', () => {
  assert.deepEqual(pageSummary({ pages: [{ page: 1 }] }, { page: 1 }), { page: 1, part: null, pageCount: 1 });
  assert.deepEqual(pageSummary({}, undefined), { page: null, part: null, pageCount: 1 });
});
