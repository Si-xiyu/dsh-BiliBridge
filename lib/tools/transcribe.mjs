import { appendHistory } from '../media/history.mjs';
/** Stage 2 按需转写：窗口越界必须报错，避免实际成本与 Agent 请求不一致。 */
import { currentJar } from '../bili/auth.mjs';
import { getVideo } from '../bili/api.mjs';
import { BiliError } from '../bili/errors.mjs';
import { getPlayUrls } from '../bili/playurl.mjs';
import { judgeTranscript, segmentsToEntries, transcribeUrl } from '../media/asr.mjs';
import { asToolError, ok, registerTool } from './helpers.mjs';
import { beginAnalysis, charge, refund, snapshot } from '../media/budget.mjs';
import { readTranscribeCache, writeTranscribeCache } from '../media/cache.mjs';
import { analysisConfig } from '../media/analysis-config.mjs';

// faster-whisper 支持的语言很多，但只放行这些常用项：
// 传个它不认识的代码会先用网络取播放地址、抽音频、启动模型，最后才报 UPSTREAM_ERROR，
// 既慢又难判断。宁可在这里早失败。
const SUPPORTED_LANGUAGES = new Set(['auto', 'zh', 'en', 'ja', 'ko', 'fr', 'de', 'es', 'ru', 'pt', 'it', 'ar']);

export function normalizeTranscribeArgs(
  { bvid, page = 1, startSeconds = 0, durationSeconds, language = 'auto' } = {},
  { maxWindowSeconds = 300, defaultWindowSeconds = 30 } = {},
) {
  const effective = durationSeconds ?? defaultWindowSeconds;
  if (typeof bvid !== 'string' || !/^BV[0-9A-Za-z]{10}$/.test(bvid) ||
      !Number.isInteger(page) || page < 1 ||
      !Number.isFinite(startSeconds) || startSeconds < 0 ||
      !Number.isFinite(effective) || effective <= 0 || effective > maxWindowSeconds ||
      typeof language !== 'string' || !SUPPORTED_LANGUAGES.has(language)) {
    throw new BiliError(
      'INVALID_ARGUMENT',
      `需要有效 BV 号、正整数分 P、非负起点、(0, ${maxWindowSeconds}] 秒时长；language 只能是 ${[...SUPPORTED_LANGUAGES].join('/')}`,
    );
  }
  return { bvid, page, startSeconds, durationSeconds: effective, language };
}

export function validateTranscribeWindow(video, args, options = {}) {
  const normalized = normalizeTranscribeArgs(args, options);
  const pageInfo = video.pages?.find((item) => item.page === normalized.page);
  if (!pageInfo) throw new BiliError('INVALID_ARGUMENT', `视频没有第 ${normalized.page} 个分 P`);
  // 不能用整片总时长兜底，否则多 P 视频会接受当前分 P 之外的窗口。
  if (!Number.isFinite(pageInfo.duration) || pageInfo.duration <= 0 ||
      normalized.startSeconds + normalized.durationSeconds > pageInfo.duration) {
    throw new BiliError('INVALID_ARGUMENT', '转写窗口超出当前分 P 时长');
  }
  return pageInfo;
}

export function registerTranscribeTools(ctx) {
  registerTool(ctx, {
    name: 'bilibili_transcribe',
    description:
      'Stage 2 高成本音频转写：指定分 P 内的窗口，默认 30 秒、单次上限 300 秒（均可在设置页调整）。' +
      '返回原始视频时间轴上的 ASR 段落与置信度；越界窗口报错。',
    parameters: {
      type: 'object',
      properties: {
        bvid: { type: 'string', description: 'BV 号' },
        page: { type: 'integer', minimum: 1, default: 1 },
        startSeconds: { type: 'number', minimum: 0, default: 0 },
        // schema 的 maximum 是硬上限；真正的上限由设置页的 asr.maxWindowSeconds 决定，在代码里夹。
        durationSeconds: { type: 'number', exclusiveMinimum: 0, maximum: 900, description: '窗口长度；默认取设置里的 asr.defaultWindowSeconds' },
        language: { type: 'string', default: 'auto', description: 'auto 或语言代码，例如 zh、en' },
      },
      required: ['bvid'],
      additionalProperties: false,
    },
    timeoutMs: 600_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const started = Date.now();
      const history = {
        at: new Date().toISOString(), tool: 'bilibili_transcribe',
        bvid: /^BV[0-9A-Za-z]{10}$/.test(args?.bvid) ? args.bvid : null,
        page: Number.isInteger(args?.page) ? args.page : 1,
        params: { audioSeconds: null, window: null }, cacheHit: false, ok: false, error: null,
      };
      try {
        const asrConfig = analysisConfig().asr;
        // 硬禁用：设置里关掉后直接失败，别让 Agent 以为“换个参数就能绕过”。
        if (!asrConfig.enabled) {
          throw new BiliError('ASR_DISABLED', '本地 ASR 已在设置中关闭（设置 → B站工具 → 视频理解）');
        }
        const windowOptions = {
          maxWindowSeconds: asrConfig.maxWindowSeconds,
          defaultWindowSeconds: asrConfig.defaultWindowSeconds,
        };
        const options = normalizeTranscribeArgs(args, windowOptions);
        history.params = { audioSeconds: options.durationSeconds, window: { startSeconds: options.startSeconds, durationSeconds: options.durationSeconds } };
        const signal = exec?.signal;
        const { jar } = await currentJar();
        const video = await getVideo(options.bvid, { jar, signal });
        const pageInfo = validateTranscribeWindow(video, options, windowOptions);
        // bundleId 只能由本进程签发：不接受调用方传入，否则换一个 id 就能重置同一视频的预算。
        const bundleId = beginAnalysis({ bvid: video.bvid, cid: pageInfo.cid });
        const model = analysisConfig().asrModel;
        const cacheKey = { ...options, bvid: video.bvid, cid: pageInfo.cid, model };
        let payload = await readTranscribeCache(cacheKey);
        const cacheHit = payload !== null;
        history.cacheHit = cacheHit;
        const reservationId = charge({ bundleId, audioSeconds: cacheHit ? 0 : options.durationSeconds, kind: 'asr' });
        if (!cacheHit) {
          try {
            const referer = `https://www.bilibili.com/video/${video.bvid}/?p=${options.page}`;
            const play = await getPlayUrls({ bvid: video.bvid, cid: pageInfo.cid, jar, signal, referer });
            if (!play.audioUrl) throw new BiliError('UPSTREAM_ERROR', '播放地址没有可用的音频流');
            payload = await transcribeUrl({ ...options, model, audioUrl: play.audioUrl, referer, signal });
          } catch (error) {
            // 已经提交给 worker 的请求可能真的跑完了：这时不能退款，否则重复调用会重复烧算力却不计成本。
            const consumed = error?.data?.submitted === true;
            if (!consumed) {
              // Expiration must not mask the original ASR failure.
              try { refund({ bundleId, audioSeconds: options.durationSeconds, reservationId }); } catch {}
            }
            throw error;
          }
          // Cache I/O failure must not refund successfully processed audio.
          await writeTranscribeCache(cacheKey, payload).catch(() => {});
        }
        history.ok = true;
        history.params.audioSeconds = payload.duration_sec ?? options.durationSeconds;
        return ok({
          budget: { ...snapshot({ bundleId }), cacheHit },
          segments: segmentsToEntries(payload),
          model: payload.model ?? null,
          language: payload.language ?? null,
          confidence: payload.confidence ?? {},
          verdict: judgeTranscript(payload),
          timing: {
            audioSeconds: payload.duration_sec ?? null,
            // 缓存命中时 elapsed_sec 是当初那次转写的耗时，不是本次调用的成本；
            // 直接回填会让模型误判“这次很快”，所以命中共置 null，另给 cachedElapsedSeconds。
            elapsedSeconds: cacheHit ? null : (payload.elapsed_sec ?? null),
            ...(cacheHit ? { cachedElapsedSeconds: payload.elapsed_sec ?? null } : {}),
          },
          // 表示这次只覆盖分 P 的一个窗口，并不表示识别段落被裁剪。
          truncated: options.startSeconds > 0 || options.durationSeconds < pageInfo.duration,
        }, { source: 'bilibili_transcribe', cache: cacheHit ? 'hit' : 'miss' });
      } catch (error) {
        history.ok = false;
        history.error = error instanceof BiliError ? error.code : 'UPSTREAM_ERROR';
        asToolError(error instanceof BiliError ? error : new BiliError(
          error?.name === 'AbortError' ? 'CANCELLED' : error?.name === 'TimeoutError' ? 'TIMEOUT' : 'UPSTREAM_ERROR',
          String(error?.message ?? error),
        ));
      } finally {
        await appendHistory({ ...history, elapsedMs: Date.now() - started });
      }
    },
  });
}
