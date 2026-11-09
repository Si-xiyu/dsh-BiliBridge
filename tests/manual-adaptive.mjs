/** Read-only live acceptance. Writes normal media caches, never credentials or signed URLs to logs.
 * node tests/manual-adaptive.mjs BV1GJ411x7h7 10 30 3 auto
 * node tests/manual-adaptive.mjs BV1GJ411x7h7 overview
 */
import { currentJar } from '../lib/bili/auth.mjs';
import { getVideo } from '../lib/bili/api.mjs';
import { buildInspection } from '../lib/media/inspect.mjs';
import { buildOverviewWithAdaptive } from '../lib/media/adaptive-overview.mjs';

const [bvid = 'BV1GJ411x7h7', start = '10', end = '30', count = '3', source = 'auto'] = process.argv.slice(2);
const started = Date.now();
try {
  const { jar } = await currentJar();
  const signal = AbortSignal.timeout(175000);
  const video = await getVideo(bvid, { jar, signal });
  const page = video.pages[0], durationMs = (page.duration ?? video.duration) * 1000;
  const options = { video, cid: page.cid, durationMs, jar, signal };
  const result = start === 'overview' ? await buildOverviewWithAdaptive(options) : await buildInspection({ ...options,
    selection: 'adaptive', range: start === 'full' ? undefined : { startMs: Number(start) * 1000, endMs: Number(end) * 1000 }, maxFrames: Number(count), source });
  console.log(JSON.stringify({ elapsedMs: Date.now() - started, bvid, cid: page.cid,
    selection: result.selection ?? result.adaptive,
    frames: result.frames,
    images: result.images.map(({ buffer, ...image }) => ({ ...image, bytes: buffer?.length })),
    fallbackCode: result.fallbackReason?.code, warnings: result.warnings,
  }, null, 2));
} catch (error) {
  // FFmpeg errors can include signed input URLs: only expose a stable code here.
  console.error(JSON.stringify({ elapsedMs: Date.now() - started, error: error.code ?? error.name ?? 'ERROR' }));
  process.exitCode = 1;
}
