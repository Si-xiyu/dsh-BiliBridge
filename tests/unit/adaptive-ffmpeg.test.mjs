import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveToolchain, runFfmpeg, scanVideo } from '../../lib/media/ffmpeg.mjs';

test('FFmpeg bounded low-resolution interval scan produces the expected RGB sampling grid', async (t) => {
  try { await resolveToolchain(); } catch { t.skip('FFmpeg unavailable'); return; }
  const dir = await mkdtemp(join(tmpdir(), 'bili-scan-smoke-'));
  try {
    const video = join(dir, 'source.mp4'), outFile = join(dir, 'scan.rgb');
    await runFfmpeg(['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
      'testsrc2=size=160x90:rate=25:duration=4', '-c:v', 'mpeg4', '-y', video]);
    await scanVideo({ url: video, outFile, startMs: 1000, endMs: 3000, fps: 2,
      width: 160, height: 90, timeoutMs: 10000 });
    assert.equal((await stat(outFile)).size, 4 * 160 * 90 * 3);
    await assert.rejects(scanVideo({ url: video, outFile, startMs: 0, endMs: 1000,
      fps: 1, width: 160, height: 90, signal: AbortSignal.abort(), timeoutMs: 10000 }), { code: 'CANCELLED' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
