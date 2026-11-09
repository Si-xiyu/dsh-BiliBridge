/**
 * Stage 1 证据包（Fast Path）。
 *
 * 元信息 / 平台字幕 / 弹幕 / 评论 / 封面 + 均匀故事板与有预算上限的自适应九宫格。
 * **不跑 ASR、不跑 OCR** —— 那是 Stage 2 的按需深度分析（bilibili_transcribe / bilibili_inspect）。
 * 没有平台字幕时字幕就是 `empty`，这不是错误，而是事实；怎么补交给 Agent 决定。
 *
 * 各来源独立采集、独立记状态；单个来源失败只降级为 partial。
 */
import { join } from 'node:path';
import { getVideo } from '../bili/api.mjs';
import { dataDir } from '../bili/store.mjs';
import { getComments } from './comments.mjs';
import { getDanmaku, validateDanmakuWindow } from './danmaku.mjs';
import { coverageRatio } from './timeline.mjs';
import { BiliError } from '../bili/errors.mjs';
import { buildOverviewWithAdaptive } from './adaptive-overview.mjs';
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
 * 字幕覆盖：按**区间并集**算（实现在 timeline.mjs，字幕采集也要用，避免循环依赖）。
 * 这里保留 re-export，方便既有调用与测试。
 */
export { coverageRatio } from './timeline.mjs';

/**
 * 从弹幕密度里挑几个“可能值得深挖”的窗口（纯计算，不额外请求）。
 * 只取前 limit 个最密的，再按时间排序；重复窗口去重；不改动传入数组。
 */
export function suggestedWindowsFromDensity(density, { limit = 3 } = {}) {
  const cap = Math.max(0, Math.min(3, Number(limit) || 0));
  if (cap === 0) return [];

  const seen = new Set();
  const picked = [];
  for (const bucket of [...(density ?? [])].sort((a, b) => Number(b.count) - Number(a.count))) {
    const count = Number(bucket?.count);
    if (!(count > 0)) continue;
    const start = Number(bucket.startSec);
    const end = Number(bucket.endSec);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const key = `${start}:${end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push({ start, end, count });
    if (picked.length >= cap) break;
  }

  return picked
    .sort((a, b) => a.start - b.start)
    .map((bucket) => ({
      startSeconds: bucket.start,
      endSeconds: bucket.end,
      reason: 'danmaku_peak',
      danmakuCount: bucket.count,
    }));
}

/**
 * @param {{bvid:string, page?:number, include?:Record<string,boolean>, jar?:any, signal?:AbortSignal,
 *   limits?:{maxCues?:number, danmakuLimit?:number, commentLimit?:number}}} options
 */
export async function buildEvidence(options) {
  const { bvid, page = 1, include = {}, jar, signal, limits = {}, subtitleCursor, danmakuWindow } = options;
  for (const [name, fallback, max] of [['danmakuLimit', 60, 100], ['commentLimit', 10, 20]]) {
    const value = limits[name] ?? fallback;
    if (!Number.isInteger(value) || value < 0 || value > max) throw new BiliError('INVALID_ARGUMENT', `${name} 必须是 0–${max} 的整数`);
  }
  if (subtitleCursor !== undefined && include.subtitles === false) throw new BiliError('INVALID_ARGUMENT', '字幕续取不能禁用字幕');
  if (danmakuWindow !== undefined && include.danmaku === false) throw new BiliError('INVALID_ARGUMENT', '弹幕窗口不能禁用弹幕');
  const want = {
    metadata: true,
    subtitles: true,
    danmaku: true,
    comments: true,
    frames: true,
    ...include,
    ...(subtitleCursor !== undefined ? { frames: false, comments: false, danmaku: danmakuWindow !== undefined, subtitles: true } : {}),
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
  validateDanmakuWindow(danmakuWindow, durationMs / 1000);

  const [subtitleResult, danmakuResult, commentResult, overview] = await Promise.all([
    want.subtitles
      ? getSubtitles({ bvid, aid: video.aid, cid, jar, signal, maxCues: limits.maxCues ?? 800, durationMs, subtitleCursor })
          .catch((error) => { if (['INVALID_ARGUMENT', 'CURSOR_STALE'].includes(error.code)) throw error; return { status: 'failed', cues: [], error: errorInfo(error) }; })
      : Promise.resolve({ status: 'skipped', cues: [] }),
    want.danmaku
      ? getDanmaku({ cid, bvid, signal, limit: limits.danmakuLimit ?? 60, danmakuWindow })
          .catch((error) => ({ status: 'failed', total: 0, density: [], samples: [], error: errorInfo(error) }))
      : Promise.resolve({ status: 'skipped', total: 0, density: [], samples: [] }),
    want.comments
      ? getComments({ aid: video.aid, jar, signal, limit: limits.commentLimit ?? 10 })
          .catch((error) => ({ status: 'failed', hot: [], latest: [], total: 0, error: errorInfo(error) }))
      : Promise.resolve({ status: 'skipped', hot: [], latest: [], total: 0 }),
    want.frames
      ? buildOverviewWithAdaptive({ video, cid, durationMs, jar, signal }).catch((error) => {
          if (signal?.aborted || error.code === 'CANCELLED') throw error;
          return { images: [], warnings: [{ source: 'frames', ...errorInfo(error) }] };
        })
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

  // 两个不同的指标，别混用：
  // - coverage：区间并集 / 时长。字幕句子之间本来就有气口，正常视频也就 0.95–0.99。
  // - extent：**完整字幕轨**最后一条的结束时间 / 时长。它回答"这条轨一直铺到片尾了吗"。
  // 状态用 extent 判"轨道有没有断在中间"，用 coverage 兜底判"是不是稀得没法用"；
  // "我们只返回了前 800 条"是另一件事（truncated），单独提示。
  const coverage = Number.isFinite(subtitleResult.coverage)
    ? Number(subtitleResult.coverage)
    : coverageRatio(cues, durationMs);
  const coveredToMs = transcript.length ? transcript[transcript.length - 1].endMs : 0;
  const trackEndMs = Number(subtitleResult.lastEndMs ?? coveredToMs);
  const extent = durationMs > 0 ? Math.min(1, trackEndMs / durationMs) : 0;
  const warnings = [...overview.warnings];

  // Stage 1 的字幕状态：skipped / failed / empty / partial / ok。
  // `insufficient` 是 Stage 2 的结论，不属于这里。
  const subtitlesRequested = want.subtitles;
  let subtitleStatus;
  if (!subtitlesRequested) subtitleStatus = 'skipped';
  else if (subtitleResult.status === 'failed') subtitleStatus = 'failed';
  else if (!transcript.length) subtitleStatus = 'empty';
  else if (extent < 0.95 || coverage < 0.9) subtitleStatus = 'partial';
  else subtitleStatus = 'ok';

  if (subtitleStatus === 'partial') {
    warnings.push({
      code: 'SUBTITLE_PARTIAL',
      message:
        `平台字幕只铺到 ${formatMs(trackEndMs)} / ${formatMs(durationMs)}（区间覆盖 ${(coverage * 100).toFixed(0)}%）；` +
        '没覆盖的部分不要当成"作者说过"。需要时可调用 bilibili_transcribe 或 bilibili_inspect。',
    });
  }
  if (subtitleResult.truncated) {
    warnings.push({
      code: 'SUBTITLE_TRUNCATED',
      message:
        `字幕共 ${subtitleResult.cuesTotal ?? '?'} 条，本次返回第 ${(subtitleResult.offset ?? 0) + 1}–${(subtitleResult.offset ?? 0) + transcript.length} 条（到 ${formatMs(coveredToMs)}）；` +
        '需要更后面的平台字幕时，将 subtitles.nextCursor 作为 subtitleCursor 续取。',
    });
  }

  const danmakuTotal = Number(danmakuResult.total ?? 0);
  const commentTotal = Number(commentResult.total ?? 0);
  const hasFrames = overview.images.length > 0;

  // ── 线索字段：帮 Agent 决定要不要进 Stage 2、进哪儿 ──────────────────
  // gaps 从最终状态派生，避免“没采集”和“确实没有”混在一起。
  const gaps = [];
  if (subtitleStatus === 'empty') gaps.push('no_subtitles');
  if (subtitleStatus === 'partial') gaps.push('subtitles_partial');
  if (subtitleStatus === 'failed') gaps.push('subtitles_failed');
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
      status: subtitleStatus,
      origin: 'platform',
      fetchedAt: nowIso(),
      truncated: Boolean(subtitleResult.truncated),
      cuesTotal: Number(subtitleResult.cuesTotal ?? transcript.length),
      ...(transcript.length
        ? {
            // 这里给的是**完整字幕轨**的范围（不是被截断后的返回范围），
            // 与 subtitles.truncated 一起读才不会被误当成“只覆盖到这儿”。
            coverage: { startMs: subtitleResult.trackRange?.startMs ?? transcript[0].startMs, endMs: Math.round(trackEndMs), ratio: Number(coverage.toFixed(3)) },
          }
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
    // Stage 1 只看平台字幕：有就填，没有就空；skipped 表示调用方关掉了字幕采集。
    subtitles: {
      source: 'platform',
      status: subtitleStatus,
      track: subtitleResult.track
        ? { lan: subtitleResult.track.lan, lanDoc: subtitleResult.track.lanDoc, isAi: subtitleResult.track.isAi }
        : null,
      coverage: Number(coverage.toFixed(3)),
      coveredToMs: Math.round(trackEndMs),
      cuesTotal: Number(subtitleResult.cuesTotal ?? transcript.length),
      nextCursor: subtitleResult.nextCursor ?? null,
      returnedRange: subtitleResult.returnedRange ?? null,
      cumulativeRange: subtitleResult.cumulativeRange ?? null,
      trackRange: subtitleResult.trackRange ?? null,
      truncated: Boolean(subtitleResult.truncated),
      note:
        subtitleStatus === 'empty'
          ? '当前登录态没有返回平台字幕轨；匿名结果不能证明视频没有字幕。不要编造台词，可按需调用 bilibili_transcribe。'
          : subtitleStatus === 'skipped'
            ? '调用方关闭了字幕采集，`empty` 与 `skipped` 不是一回事。'
            : subtitleStatus === 'failed'
              ? `字幕接口失败（${subtitleResult.error?.code ?? 'ERROR'}），不代表视频没有字幕。`
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
      availableTotal: danmakuResult.availableTotal ?? null,
      window: danmakuResult.window ?? null,
      note: danmakuResult.note ?? null,
    },
    comments: {
      total: commentTotal,
      hot: commentResult.hot ?? [],
      latest: commentResult.latest ?? [],
      note: '评论发布时间不是视频时间轴',
    },
    ...(overview.adaptive ? { adaptive: overview.adaptive } : {}),
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
  return { cover: join(dir, 'cover.img'), storyboard: join(dir, `storyboard-v2-${cid}.jpg`) };
}
