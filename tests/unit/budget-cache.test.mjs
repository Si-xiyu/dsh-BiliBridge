import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beginAnalysis, charge, refund, snapshot } from '../../lib/media/budget.mjs';
import { readTranscribeCache, writeTranscribeCache, readOcrCache, writeOcrCache } from '../../lib/media/cache.mjs';

test('budget and persistent caches (offline)', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'bili-budget-'));
  const previous = process.env.BILI_DATA_DIR;
  process.env.BILI_DATA_DIR = dir;
  const config = (value) => writeFile(join(dir, 'config.json'), JSON.stringify(value));
  try {
    await t.test('TTL reuse, fixed expiration and configuration', async () => {
      await config({ budget: { ttlMs: 100, roundsLimit: 8, audioSecondsLimit: 50 } });
      const originalNow = Date.now;
      let now = originalNow();
      Date.now = () => now;
      try {
        const id = beginAnalysis({ bvid: 'ttl', cid: 1 });
        now += 99;
        assert.equal(beginAnalysis({ bvid: 'ttl', cid: 1 }), id);
        assert.equal(snapshot({ bundleId: id }).roundsLimit, 8);
        // 未知 bundleId 不能开新额度：已有账本就复用同一个（不重置），没有账本就拒绝。
        assert.equal(beginAnalysis({ bvid: 'ttl', cid: 1, bundleId: 'evidence-id' }), id);
        assert.throws(() => beginAnalysis({ bvid: 'fresh', cid: 1, bundleId: 'evidence-id' }), { code: 'INVALID_ARGUMENT' });
        // 已签发的 id 可以继续用于同一视频；换个视频则拒绝。
        assert.equal(beginAnalysis({ bvid: 'ttl', cid: 1, bundleId: id }), id);
        assert.throws(() => beginAnalysis({ bvid: 'other', cid: 1, bundleId: id }), { code: 'INVALID_ARGUMENT' });
        now++;
        assert.notEqual(beginAnalysis({ bvid: 'ttl', cid: 1 }), id);
        assert.throws(() => charge({ bundleId: id }), { code: 'BUDGET_EXCEEDED' });
      } finally { Date.now = originalNow; }
    });
    await t.test('atomic charges, rejected charge unchanged, isolated idempotent refunds', async () => {
      await config({ budget: { roundsLimit: 6, audioSecondsLimit: 30 } });
      const bundleId = beginAnalysis({ bvid: 'parallel', cid: 1 });
      const outcomes = await Promise.allSettled([1, 2].map(() => Promise.resolve().then(() =>
        charge({ bundleId, audioSeconds: 20, kind: 'asr' }))));
      assert.equal(outcomes.filter((r) => r.status === 'fulfilled').length, 1);
      assert.match(outcomes.find((r) => r.status === 'rejected').reason.message, /remaining=10/);
      const reservationId = outcomes.find((r) => r.status === 'fulfilled').value;
      refund({ bundleId, audioSeconds: 20, reservationId });
      charge({ bundleId, audioSeconds: 25 });
      refund({ bundleId, audioSeconds: 20, reservationId });
      assert.equal(snapshot({ bundleId }).audioSecondsUsed, 25);
      assert.equal(snapshot({ bundleId }).rounds, 2);
    });
    await t.test('cache hit consumes one round and no audio; rounds bounded independently', async () => {
      await config({ budget: { roundsLimit: 2, audioSecondsLimit: 30 } });
      const bundleId = beginAnalysis({ bvid: 'hit', cid: 1 });
      const key = { bvid: 'hit', cid: 1, model: 'small', language: 'auto', startSeconds: 0, durationSeconds: 30 };
      const payload = { segments: [], model: 'small' };
      await writeTranscribeCache(key, payload);
      assert.deepEqual(await readTranscribeCache(key), payload);
      charge({ bundleId, audioSeconds: 30 });
      charge({ bundleId, audioSeconds: (await readTranscribeCache(key)) ? 0 : 30 });
      assert.equal(snapshot({ bundleId }).remainingSeconds, 0);
      assert.equal(snapshot({ bundleId }).rounds, 2);
      assert.throws(() => charge({ bundleId, audioSeconds: 0 }), { code: 'BUDGET_EXCEEDED' });
      for (const difference of [{ cid: 2 }, { model: 'base' }, { language: 'zh' }, { startSeconds: 1 }, { durationSeconds: 20 }]) {
        assert.equal(await readTranscribeCache({ ...key, ...difference }), null);
      }
      const asrDir = join(dir, 'cache', 'asr');
      const [file] = await readdir(asrDir);
      for (const content of ['{broken', JSON.stringify({ schemaVersion: 100 }), JSON.stringify({ schemaVersion: 1, writtenAt: Date.now(), payload: {} })]) {
        await writeFile(join(asrDir, file), content);
        assert.equal(await readTranscribeCache(key), null);
      }
    });
    await t.test('OCR key isolation, cache TTL and disable configuration', async () => {
      const key = { bvid: 'ocr', cid: 1, language: 'zh', startSeconds: 0, durationSeconds: 30, bandRatio: 0.22, intervalMs: 2000 };
      const payload = { entries: [] };
      await writeOcrCache(key, payload);
      assert.deepEqual(await readOcrCache(key), payload);
      for (const difference of [{ bandRatio: 0.3 }, { intervalMs: 1000 }, { language: 'en' }]) {
        assert.equal(await readOcrCache({ ...key, ...difference }), null);
      }
      await config({ cache: { ttlMs: 1 } });
      await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(await readOcrCache(key), null);
      await config({ cache: { enabled: false } });
      await writeOcrCache({ ...key, cid: 2 }, payload);
      assert.equal((await readdir(join(dir, 'cache', 'ocr'))).length, 1);
      assert.equal(await readOcrCache(key), null);
    });
  } finally {
    if (previous === undefined) delete process.env.BILI_DATA_DIR;
    else process.env.BILI_DATA_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
