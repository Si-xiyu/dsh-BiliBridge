/**
 * Stage 1 证据包（Fast Path）。
 *
 * 只做**低成本、可预期**的信息收集：元信息 / 平台字幕 / 弹幕 / 评论 / 封面 + 故事板九宫格。
 * **不跑 ASR、不跑 OCR** —— 那是 Stage 2 的按需深度分析（bilibili_transcribe / bilibili_inspect）。
 * 没有平台字幕时字幕就是 `empty`，这不是错误，而是事实；怎么补交给 Agent 决定。
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
 * 字幕覆盖：按**区间并集**算，不是拿最后一条的结束时间去除。
 * 中间挖空（比如只覆盖开头和结尾）时，最后一条结束时间会高估覆盖度。
 * @param {Array<{startMs:number,endMs:number}>} cues
 * @param {number} durationMs
 */
export function coverageRatio(cues, durationMs) {
  if (!Array.isArray(cues) || !cues.length || !(durationMs > 0)) return 0;
  let covered = 0;
  let cursor = 0;
  for (const cue of cues) {
    const start = Math.max(cursor, Number(cue.startMs) || 0);
    const end = Math.min(durationMs, Number(cue.endMs) || 0);
    if (end > start) covered += end - start;
    if (end > cursor) cursor = end;
  }
  return Math.min(1, covered / durationMs);
}

/** 从弹幕密度里挑几个“可能值得深挖”的窗口（纯计算，不额外请求）。 */
export function suggestedWindowsFromDensity(density, { limit = 3 } = {}) {
  const rows = (density ?? [])
    .filter((bucket) => Number(bucket?.count) > 0)
    .sort((a, b) => Number(b.count) - Number(a.count))
    .slice(0, Math.max(1, limit));
  return rows
    .sort((a, b) => Number(a.startSec) - Number(b.startSec))
    .map((bucket) => ({
      startSeconds: Number(bucket.startSec),
      endSeconds: Number(bucket.endSec),
      reason: 'danmaku_peak',
      danmakuCount: Number(bucket.count),
    }));
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
  const requestedPage = Number(page ?? 1);
  const pageInfo = video.pages.find((item) => item.page === requestedPage);
  if (!pageInfo) {
    throw Object.assign(
      new Error(`视频没有第 ${requestedPage} 个分 P（共 ${video.pages.length} 个）`),
      { code: 'CONTENT_UNAVAILABLE' },
    );
  }
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

  const cues = (subtitleResult.cues ?? []).filter((cue) => Number.isFinite(cue?.startMs) && Number.isFinite(cue?.endMs));
  const transcript = cues.map((cue, index) => ({
    id: cue.id ?? `cue-${index + 1}`,
    startMs: cue.startMs,
    endMs: cue.endMs,
    text: cue.text,
    origin: 'platform',
  }));

  const coverage = coverageRatio(cues, durationMs);
  const warnings = [...overview.warnings];

  // Stage 1 的字幕只有三种状态；`insufficient` 是 Stage 2 的结论，不属于这里。
  let subtitleStatus;
  if (!transcript.length) subtitleStatus = 'empty';
  else if (coverage < 0.98) subtitleStatus = 'partial';
  else subtitleStatus = 'ok';

  if (subtitleStatus === 'partial') {
    warnings.push({
      code: 'SUBTITLE_PARTIAL',
      message: `平台字幕只覆盖全片的 ${(coverage * 100).toFixed(0)}%；没覆盖的部分不要当成"作者说过"。需要时可调用 bilibili_transcribe 或 bilibili_inspect。`,
    });
  }

  const danmakuTotal = Number(danmakuResult.total ?? 0);
  const commentTotal = Number(commentResult.total ?? 0);
  const hasFrames = overview.images.length > 0;

  // ── 线索字段：帮 Agent 决定要不要进 Stage 2、进哪儿 ──────────────────
  const gaps = [];
  if (!transcript.length) gaps.push('no_subtitles');
  if (transcript.length && coverage < 0.8) gaps.push('subtitles_partial');
  if (danmakuTotal === 0) gaps.push('no_danmaku');
  if (commentTotal === 0) gaps.push('no_comments');
  if (!hasFrames) gaps.push('no_visual');

  const suggestedWindows = suggestedWindowsFromDensity(danmakuResult.density, { limit: 3 });

  let evidenceLevel;
  if (coverage >= 0.8) evidenceLevel = 'rich';
  else if (danmakuTotal > 0 || commentTotal > 0 || transcript.length > 0) evidenceLevel = 'text-only';
  else evidenceLevel = 'thin';

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
      status: subtitleStatus === 'empty' ? (subtitleResult.status === 'failed' ? 'failed' : 'empty') : subtitleStatus,
      origin: 'platform',
      fetchedAt: nowIso(),
      truncated: Boolean(subtitleResult.truncated),
      ...(transcript.length
        ? { coverage: { startMs: transcript[0].startMs, endMs: transcript[transcript.length - 1].endMs, ratio: Number(coverage.toFixed(3)) } }
        : {}),
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
      status: !want.frames ? 'skipped' : hasFrames ? 'ok' : 'unavailable',
      fetchedAt: nowIso(),
      truncated: false,
    },
  ];

  const bundle = {
    schemaVersion: '2',
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
    // Stage 1 只看平台字幕：有就填，没有就空。
    subtitles: {
      source: 'platform',
      status: subtitleStatus,
      track: subtitleResult.track
        ? { lan: subtitleResult.track.lan, lanDoc: subtitleResult.track.lanDoc, isAi: subtitleResult.track.isAi }
        : null,
      coverage: Number(coverage.toFixed(3)),
      coveredToMs: transcript.length ? transcript[transcript.length - 1].endMs : 0,
      truncated: Boolean(subtitleResult.truncated),
      note:
        subtitleStatus === 'empty'
          ? '没有平台字幕（官方与 AI 都没有）。不要据此编造台词；需要文字内容请走 bilibili_transcribe。'
          : null,
    },
    transcript,
    gaps,
    suggestedWindows,
    evidenceLevel,
    danmaku: {
      total: danmakuTotal,
      density: danmakuResult.density ?? [],
      samples: danmakuResult.samples ?? [],
    },
    comments: {
      total: commentTotal,
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
