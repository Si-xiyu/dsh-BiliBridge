/**
 * 手工验证 Stage 1 证据包（不经过 DSH）。
 *   BILI_DATA_DIR=./.bili-data node tests/manual-evidence.mjs BV1YLHu6zEDp
 */
import { currentJar } from '../lib/bili/auth.mjs';
import { buildEvidence } from '../lib/media/evidence.mjs';

const bvid = process.argv[2];
if (!bvid) {
  console.error('缺少 bvid');
  process.exit(2);
}

const { jar } = await currentJar();
const { bundle, images } = await buildEvidence({ bvid, jar });

console.log(
  JSON.stringify(
    {
      video: bundle.video,
      sources: bundle.sources,
      transcript: { cues: bundle.transcript.length, first: bundle.transcript.slice(0, 3) },
      danmaku: {
        total: bundle.danmaku.total,
        samples: bundle.danmaku.samples.length,
        density: bundle.danmaku.density.length,
      },
      comments: { total: bundle.comments.total, hot: bundle.comments.hot.length },
      frames: bundle.frames,
      images: images.map((image) => ({
        kind: image.kind,
        bytes: image.buffer?.length ?? 0,
        mediaType: image.mediaType,
      })),
      warnings: bundle.warnings,
    },
    null,
    2,
  ),
);
