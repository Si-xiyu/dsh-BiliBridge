import { search } from './search.mjs';
import { listComments } from './comments.mjs';
import { getVideo } from './api.mjs';
import { getSubtitles } from '../media/subtitles.mjs';
import { positiveInteger } from './read.mjs';
import { BiliError } from './errors.mjs';

const STOP_CODES = new Set(['RATE_LIMITED', 'RISK_CONTROLLED', 'AUTH_REQUIRED', 'TRAFFIC_PAUSED', 'TRAFFIC_BUDGET_EXCEEDED', 'TRAFFIC_MANUAL_REQUIRED', 'TRAFFIC_STATE_CORRUPT']);

/** Sequential bounded collection; no ASR/OCR and no nested comment fetches. */
export async function collect({ keyword, maxVideos = 5, commentsPerVideo = 20, subtitles = true, jar, signal } = {}) {
  positiveInteger(maxVideos, 'maxVideos', 5, 10); positiveInteger(commentsPerVideo, 'commentsPerVideo', 20, 20);
  if (typeof subtitles !== 'boolean') throw new BiliError('INVALID_ARGUMENT', 'subtitles 必须是 boolean');
  const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(110000)]) : AbortSignal.timeout(110000);
  const results = [];
  let candidates = [], stopped = null, stopDetails = null, bytes = 0;
  const recordError = (row, source, error) => {
    row.errors.push({ source, code: error.code ?? 'UPSTREAM_ERROR' });
    if (STOP_CODES.has(error.code)) {
      stopped = error.code;
      stopDetails = { code: error.code, message: error.message, ...(error.data ?? {}) };
      row.incomplete = true;
    }
  };
  try {
    const found = await search({ keyword, pageSize: maxVideos, jar, signal: combined });
    candidates = found.items.slice(0, maxVideos);
    for (const item of candidates) {
      if (combined.aborted) { stopped = signal?.aborted ? 'CANCELLED' : 'TIME_BUDGET'; break; }
      const row = { video: item, comments: null, subtitles: null, errors: [] };
      try { row.comments = await listComments({ bvid: item.bvid, pageSize: commentsPerVideo, includeReplies: false, jar, signal: combined }); }
      catch (e) { recordError(row, 'comments', e); }
      if (subtitles && !stopped && !combined.aborted) {
        try {
          const video = await getVideo(item.bvid, { jar, signal: combined });
          const page = video.pages[0];
          if (!page) throw new BiliError('CONTENT_UNAVAILABLE', '视频没有分 P');
          const sub = await getSubtitles({ bvid: item.bvid, aid: video.aid, cid: page.cid, durationMs: page.duration * 1000, jar, signal: combined });
          row.subtitles = { status: sub.status, language: sub.track?.lan, cues: sub.cues, cuesTotal: sub.cuesTotal, coverage: sub.coverage, nextCursor: sub.nextCursor ?? null };
        } catch (e) { recordError(row, 'subtitles', e); }
      }
      const size = Buffer.byteLength(JSON.stringify(row));
      if (size + bytes > 512000) { stopped = 'OUTPUT_BUDGET'; break; }
      results.push(row); bytes += size;
      if (stopped) break;
      if (combined.aborted) { stopped = signal?.aborted ? 'CANCELLED' : 'TIME_BUDGET'; break; }
    }
  } catch (e) {
    if (!combined.aborted) throw e;
    stopped = signal?.aborted ? 'CANCELLED' : 'TIME_BUDGET';
  }
  return { keyword, results, stopped, stopDetails, partial: Boolean(stopped) || results.some(r => r.errors.length),
    incomplete: results.filter(r => r.incomplete).map(r => r.video.bvid),
    unprocessed: candidates.slice(results.length).map(v => v.bvid), limits: { maxVideos: 10, commentsPerVideo: 20, nestedReplyRequests: 0, outputBytes: 512000, timeoutSeconds: 110, asr: false, ocr: false } };
}
