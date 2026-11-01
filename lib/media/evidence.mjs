/**
 * Stage 1 证据包：元信息 + 字幕 + 弹幕 + 评论 + 概览画面。
 *
 * 各来源独立采集、独立记状态；单个来源失败只降级为 partial。
 */
import { join } from 'node:path';
import { getVideo } from '../bili/api.mjs';
import { dataDir } from '../bili/store.mjs';
import { getComments } from './comments.mjs';
import { getDanmaku } from './danmaku.mjs';
import { buildOverview } from './frames.mjs';
import { getSubtitles } from './subtitles.mjs';

function nowIso() {
  return new Date().toISOString();
}

function errorInfo(error) {
  return { code: error?.code ?? 'ERROR', message: String(error?.message ?? error).slice(0, 300) };
}

function formatMs(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const mm = String(Math.floor(total / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

/**
 * @param {{bvid:string, page?:number, include?:Record<string,boolean>, jar?:any, signal?:AbortSignal,
 *   limits?:{maxCues?:number, danmakuLimit?:number, commentLimit?:number}}} options
 */
export async function buildEvidence(options) {
  const { bvid, page = 1, include = {}, jar, signal, limits = {} } = options;
  const want = {
    metadata: true,
    subtitles: true,
    danmaku: true,
    comments: true,
    frames: true,
    ...include,
  };

  const video = await getVideo(bvid, { jar, signal });
  const pageInfo = video.pages.find((item) => item.page === Number(page)) ?? video.pages[0];
  const cid = pageInfo?.cid;
  if (!cid) throw Object.assign(new Error('视频没有可用的分 P'), { code: 'CONTENT_UNAVAILABLE' });
  const durationMs = (pageInfo.duration ?? video.duration ?? 0) * 1000;

  const [subtitleResult, danmakuResult, commentResult, overview] = await Promise.all([
    want.subtitles
      ? getSubtitles({ bvid, aid: video.aid, cid, jar, signal, maxCues: limits.maxCues ?? 800, durationMs })
          .catch((error) => ({ status: 'failed', cues: [], error: errorInfo(error) }))
      : Promise.resolve({ status: 'skipped', cues: [] }),
    want.danmaku
      ? getDanmaku({ cid, bvid, signal, limit: limits.danmakuLimit ?? 60 })
          .catch((error) => ({ status: 'failed', total: 0, density: [], samples: [], error: errorInfo(error) }))
      : Promise.resolve({ status: 'skipped', total: 0, density: [], samples: [] }),
    want.comments
      ? getComments({ aid: video.aid, jar, signal, limit: limits.commentLimit ?? 10 })
          .catch((error) => ({ status: 'failed', hot: [], latest: [], total: 0, error: errorInfo(error) }))
      : Promise.resolve({ status: 'skipped', hot: [], latest: [], total: 0 }),
    want.frames
      ? buildOverview({ video, cid, signal }).catch((error) => ({
          images: [],
          warnings: [{ source: 'frames', ...errorInfo(error) }],
        }))
      : Promise.resolve({ images: [], warnings: [] }),
  ]);

  const cues = subtitleResult.cues ?? [];
  const transcriptEndMs = cues.length ? cues[cues.length - 1].endMs : 0;
  const subtitlePartial = cues.length > 0 && durationMs > 0 && transcriptEndMs < durationMs - 60_000;
  const warnings = [...overview.warnings];

  const sources = [
    {
      kind: 'metadata',
      status: 'ok',
      fetchedAt: nowIso(),
      truncated: false,
      coverage: { startMs: 0, endMs: durationMs },
    },
    {
      kind: 'subtitles',
      status: subtitleResult.status,
      fetchedAt: nowIso(),
      truncated: Boolean(subtitleResult.truncated),
      ...(cues.length ? { coverage: { startMs: cues[0].startMs ?? 0, endMs: transcriptEndMs } } : {}),
      ...(subtitleResult.error ? { error: subtitleResult.error } : {}),
    },
    {
      kind: 'danmaku',
      status: danmakuResult.status,
      fetchedAt: nowIso(),
      truncated: false,
      ...(danmakuResult.error ? { error: danmakuResult.error } : {}),
    },
    {
      kind: 'comments',
      status: commentResult.status,
      fetchedAt: nowIso(),
      truncated: false,
      ...(commentResult.error ? { error: commentResult.error } : {}),
    },
    {
      kind: 'frames',
      status: !want.frames ? 'skipped' : overview.images.length ? 'ok' : 'unavailable',
      fetchedAt: nowIso(),
      truncated: false,
    },
  ];

  if (subtitlePartial) {
    warnings.push({
      code: 'SUBTITLE_PARTIAL',
      message: `字幕只覆盖到 ${formatMs(transcriptEndMs)} / ${formatMs(durationMs)}；之后的内容没有字幕，不要当作已看过。需要时可调用 bilibili_inspect 看画面。`,
      coverageEndMs: transcriptEndMs,
    });
  }

  const bundle = {
    schemaVersion: '1',
    bundleId: `bundle_${bvid}_${cid}_${Date.now()}`,
    video: {
      bvid,
      aid: video.aid,
      cid,
      page: pageInfo.page,
      title: video.title,
      owner: video.owner,
      publishedAt: video.publishedAt,
      durationMs,
      stat: video.stat,
      statNote: video.statNote,
    },
    sources,
    transcript: cues,
    transcriptCoverage: {
      endMs: transcriptEndMs,
      durationMs,
      partial: subtitlePartial,
    },
    subtitleTrack: subtitleResult.track
      ? { lan: subtitleResult.track.lan, lanDoc: subtitleResult.track.lanDoc, isAi: subtitleResult.track.isAi }
      : null,
    danmaku: {
      total: danmakuResult.total ?? 0,
      density: danmakuResult.density ?? [],
      samples: danmakuResult.samples ?? [],
    },
    comments: {
      total: commentResult.total ?? 0,
      hot: commentResult.hot ?? [],
      latest: commentResult.latest ?? [],
      note: '评论发布时间不是视频时间轴',
    },
    frames: overview.images.map((image, index) => ({
      id: `frame-${index + 1}`,
      kind: image.kind,
      layout: image.layout,
      note: image.note,
      cached: image.cached,
      path: image.path,
      timeAccuracy: image.timeAccuracy ?? 'none',
    })),
    warnings,
  };

  return { bundle, images: overview.images };
}

/** 供工具层在拿不到附件服务时给用户看的本地路径。 */
export function cachePaths(bvid, cid) {
  const dir = join(dataDir(), 'cache', bvid);
  return { cover: join(dir, 'cover.img'), storyboard: join(dir, `storyboard-${cid}.jpg`) };
}
