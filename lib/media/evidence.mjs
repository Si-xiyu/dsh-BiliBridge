/**
 * Stage 1 证据包：元信息 + 字幕 + 弹幕 + 评论 + 概览画面。
 *
 * 各来源独立采集、独立记状态；单个来源失败只降级为 partial。
 */
import { join } from 'node:path';
import { getVideo } from '../bili/api.mjs';
import { BiliError } from '../bili/errors.mjs';
import { getPlayUrls } from '../bili/playurl.mjs';
import { dataDir } from '../bili/store.mjs';
import { judgeTranscript, segmentsToEntries, transcribeUrl } from './asr.mjs';
import { getComments } from './comments.mjs';
import { getDanmaku } from './danmaku.mjs';
import { buildOverview } from './frames.mjs';
import { buildSubtitleTranscript } from './ocr.mjs';
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
  const { bvid, page = 1, include = {}, jar, signal, limits = {}, subtitleSource = 'auto' } = options;
  const want = {
    metadata: true,
    subtitles: true,
    danmaku: true,
    comments: true,
    frames: true,
    // OCR 是可选能力：默认不跑，只有 subtitleSource='ocr' 或显式 include.ocr 才跑。
    ocr: false,
    ...include,
  };
  // 字幕来源偏好：none 时连平台字幕都不取，避免“说了不要字幕却还是返回字幕”。
  const preference = subtitleSource ?? 'auto';
  const wantSubtitles = want.subtitles && preference !== 'none';

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
    wantSubtitles
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

  // ── 字幕字段：platform → asr →（可选）ocr ────────────────────────────
  // 字幕只是信息源之一。拿不到就如实标 insufficient 并记下“试过哪几路”，不猜。
  const referer = `https://www.bilibili.com/video/${bvid}`;
  const attempts = [];
  const pageHasVideo = Boolean(video?.bvid);

  let transcript = preference === 'none'
    ? []
    : cues.map((cue, index) => ({
        id: cue.id ?? `cue-${index + 1}`,
        startMs: cue.startMs,
        endMs: cue.endMs,
        text: cue.text,
        origin: 'platform',
      }));
  let subtitleOrigin = transcript.length ? 'platform' : 'none';
  const platformUsable = subtitleResult.status === 'ok' && transcript.length > 0;

  // attempts 只记“真正试过的来源”；none 不是来源，用 subtitleNote 说明。
  const subtitleNote = preference === 'none' ? '调用方要求不取字幕（subtitleSource=none）' : undefined;
  if (preference !== 'none') {
    attempts.push({
      source: 'platform',
      status: platformUsable ? 'ok' : subtitleResult.status ?? 'empty',
      ...(subtitleResult.error ? { reason: String(subtitleResult.error.message ?? '').slice(0, 200) } : {}),
    });
  }

  let asrSummary = { status: 'skipped' };
  let asrTruncated = false;
  const wantAsr = !platformUsable && pageHasVideo && (preference === 'auto' || preference === 'asr');
  if (wantAsr) {
    try {
      const play = await getPlayUrls({ bvid, cid, jar, signal, referer });
      if (!play.audioUrl) throw new BiliError('CONTENT_UNAVAILABLE', '这个视频没有独立音频流（可能是老格式），无法转写');
      const payload = await transcribeUrl({
        audioUrl: play.audioUrl,
        referer,
        maxSeconds: limits.asrMaxSeconds ?? 900,
        language: limits.asrLanguage ?? 'zh',
        signal,
      });
      const entries = segmentsToEntries(payload);
      const verdict = judgeTranscript(payload);
      asrTruncated = (payload.duration_sec ?? 0) * 1000 < durationMs - 5000;
      asrSummary = {
        status: entries.length ? (verdict.usable ? 'ok' : 'low_confidence') : 'empty',
        engine: payload.engine,
        model: payload.model,
        language: payload.language,
        audioSeconds: payload.duration_sec,
        elapsedSeconds: payload.elapsed_sec,
        confidence: payload.confidence ?? null,
        verdict,
        truncated: asrTruncated,
        note: '本地 faster-whisper 转写；标点与专有名词可能有错，不能当成作者原话引用。',
      };
      if (entries.length && verdict.usable) {
        transcript = entries.map((entry, index) => ({
          id: `asr-${index + 1}`,
          startMs: entry.atMs,
          endMs: entry.endMs ?? entry.atMs,
          text: entry.text,
          origin: 'asr',
        }));
        subtitleOrigin = 'asr';
      }
      attempts.push({
        source: 'asr',
        status: asrSummary.status,
        ...(verdict.usable ? {} : { reason: verdict.reason ?? '置信度不足' }),
        ...(asrTruncated ? { note: '只转写了前段音频' } : {}),
      });
    } catch (error) {
      const info = errorInfo(error);
      asrSummary = { status: 'failed', ...info };
      // code 必须保留：DEPENDENCY_MISSING / TIMEOUT / CANCELLED / UPSTREAM_ERROR 的处置完全不同。
      attempts.push({ source: 'asr', status: 'failed', code: info.code, reason: info.message });
    }
  }

  // OCR 现在只是可选能力：默认不跑，只有显式 preference==='ocr' 或 include.ocr 才跑。
  let ocrSummary = { status: 'skipped' };
  const textUsable = transcript.length > 0;
  const wantOcr = !textUsable && (preference === 'ocr' || (preference === 'auto' && want.ocr));
  if (wantOcr) {
    if (process.platform !== 'win32') {
      // 先判平台，别白跑一遍抽帧再失败：这不是“OCR 失败”，是本平台没有实现。
      ocrSummary = { status: 'unsupported', note: '当前 OCR 走 Windows.Media.Ocr，本平台未提供实现' };
      attempts.push({ source: 'ocr', status: 'unsupported', reason: '本平台无 OCR 实现' });
    } else {
      try {
        const result = await buildSubtitleTranscript({
          video,
          cid,
          jar,
          signal,
          durationMs,
          samples: limits.ocrSamples ?? 10,
        });
        ocrSummary = { ...result };
        if (result.entries.length) {
          transcript = result.entries.map((entry, index) => ({
            id: `ocr-${index + 1}`,
            startMs: entry.atMs,
            endMs: entry.endAtMs ?? entry.atMs,
            text: entry.text,
            origin: 'ocr',
            region: entry.region,
          }));
          subtitleOrigin = 'ocr';
        }
        attempts.push({
          source: 'ocr',
          status: ocrSummary.status,
          ...(ocrSummary.status === 'partial' ? { reason: '部分采样点没取到画面' } : {}),
        });
      } catch (error) {
        ocrSummary = { status: 'failed', ...errorInfo(error) };
        attempts.push({ source: 'ocr', status: 'failed', reason: errorInfo(error).message });
        warnings.push({
          code: 'OCR_FAILED',
          message: `硬字幕 OCR 失败（${ocrSummary.code}：${ocrSummary.message}）；这段视频既没有平台字幕，也没有 OCR 文本。`,
        });
      }
    }
  }

  // 统一状态：有文本 → ok/partial；一条都没有 → 只问平台或显式不要字幕时 empty，其余 insufficient。
  const transcriptCoveredMs = transcript.length ? transcript[transcript.length - 1].endMs : 0;
  let subtitleStatus;
  if (transcript.length) {
    subtitleStatus = subtitlePartial || asrTruncated ? 'partial' : 'ok';
  } else if (preference === 'platform' || preference === 'none') {
    subtitleStatus = 'empty';
  } else {
    subtitleStatus = 'insufficient';
  }

  const subtitleSourceEntry = {
    kind: 'subtitles',
    status: platformUsable ? subtitleResult.status : subtitleStatus,
    origin: subtitleOrigin,
    fetchedAt: nowIso(),
    truncated: Boolean(subtitleResult.truncated),
    ...(transcript.length ? { coverage: { startMs: transcript[0].startMs ?? 0, endMs: transcriptCoveredMs } } : {}),
    ...(subtitleResult.error ? { error: subtitleResult.error } : {}),
  };
  const asrSourceEntry = {
    kind: 'asr',
    status: asrSummary.status,
    fetchedAt: nowIso(),
    truncated: asrTruncated,
    ...(asrSummary.audioSeconds ? { coverage: { startMs: 0, endMs: Math.round(asrSummary.audioSeconds * 1000) } } : {}),
    ...(asrSummary.code ? { error: { code: asrSummary.code, message: asrSummary.message } } : {}),
  };
  const ocrSourceEntry = {
    kind: 'ocr',
    status: ocrSummary.status,
    fetchedAt: nowIso(),
    truncated: false,
    ...(ocrSummary.entries?.length
      ? { coverage: { startMs: ocrSummary.entries[0].atMs, endMs: ocrSummary.entries.at(-1).atMs } }
      : {}),
    ...(ocrSummary.code ? { error: { code: ocrSummary.code, message: ocrSummary.message } } : {}),
  };
  // strip 是给人调试用的长图，不进工具返回值、也不作为图片附件。
  const { strip: _strip, ...ocrPublic } = ocrSummary;

  const sources = [
    {
      kind: 'metadata',
      status: 'ok',
      fetchedAt: nowIso(),
      truncated: false,
      coverage: { startMs: 0, endMs: durationMs },
    },
    subtitleSourceEntry,
    asrSourceEntry,
    ocrSourceEntry,
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
    // 统一字幕字段：来源可能是 platform / asr / ocr，origin 逐条标注。
    subtitleSource: subtitleOrigin,
    subtitleStatus,
    ...(subtitleNote ? { subtitleNote } : {}),
    attempts,
    transcript,
    transcriptCoverage: {
      endMs: transcript.length ? transcript[transcript.length - 1].endMs : 0,
      durationMs,
      partial: subtitleStatus === 'partial',
    },
    subtitleTrack: subtitleResult.track
      ? { lan: subtitleResult.track.lan, lanDoc: subtitleResult.track.lanDoc, isAi: subtitleResult.track.isAi }
      : null,
    asr: asrSummary,
    ocr: ocrPublic,
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
