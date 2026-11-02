/** Stage 2 按需转写：窗口越界必须报错，避免实际成本与 Agent 请求不一致。 */
import { currentJar } from '../bili/auth.mjs';
import { getVideo } from '../bili/api.mjs';
import { BiliError } from '../bili/errors.mjs';
import { getPlayUrls } from '../bili/playurl.mjs';
import { judgeTranscript, segmentsToEntries, transcribeUrl } from '../media/asr.mjs';
import { asToolError, ok, registerTool } from './helpers.mjs';

export function normalizeTranscribeArgs({ bvid, page = 1, startSeconds = 0, durationSeconds = 30, language = 'auto' } = {}) {
  if (typeof bvid !== 'string' || !/^BV[0-9A-Za-z]{10}$/.test(bvid) ||
      !Number.isInteger(page) || page < 1 ||
      !Number.isFinite(startSeconds) || startSeconds < 0 ||
      !Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 300 ||
      typeof language !== 'string' || !/^(auto|[a-z]{2,3})$/.test(language)) {
    throw new BiliError('INVALID_ARGUMENT', '需要有效 BV 号、正整数分 P、非负起点、(0, 300] 秒时长及 auto 或语言代码');
  }
  return { bvid, page, startSeconds, durationSeconds, language };
}

export function validateTranscribeWindow(video, args) {
  const options = normalizeTranscribeArgs(args);
  const pageInfo = video.pages?.find((item) => item.page === options.page);
  if (!pageInfo) throw new BiliError('INVALID_ARGUMENT', `视频没有第 ${options.page} 个分 P`);
  // 不能用整片总时长兜底，否则多 P 视频会接受当前分 P 之外的窗口。
  if (!Number.isFinite(pageInfo.duration) || pageInfo.duration <= 0 ||
      options.startSeconds + options.durationSeconds > pageInfo.duration) {
    throw new BiliError('INVALID_ARGUMENT', '转写窗口超出当前分 P 时长');
  }
  return pageInfo;
}

export function registerTranscribeTools(ctx) {
  registerTool(ctx, {
    name: 'bilibili_transcribe',
    description: 'Stage 2 高成本音频转写：指定分 P 内的窗口，默认 30 秒、最大 300 秒。返回原始视频时间轴上的 ASR 段落与置信度；越界窗口报错。',
    parameters: {
      type: 'object',
      properties: {
        bvid: { type: 'string', description: 'BV 号' },
        page: { type: 'integer', minimum: 1, default: 1 },
        startSeconds: { type: 'number', minimum: 0, default: 0 },
        durationSeconds: { type: 'number', exclusiveMinimum: 0, maximum: 300, default: 30 },
        language: { type: 'string', default: 'auto', description: 'auto 或语言代码，例如 zh、en' },
      },
      required: ['bvid'],
      additionalProperties: false,
    },
    timeoutMs: 600_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      try {
        const options = normalizeTranscribeArgs(args);
        const signal = exec?.signal;
        const { jar } = await currentJar();
        const video = await getVideo(options.bvid, { jar, signal });
        const pageInfo = validateTranscribeWindow(video, options);
        const referer = `https://www.bilibili.com/video/${video.bvid}/?p=${options.page}`;
        const play = await getPlayUrls({ bvid: video.bvid, cid: pageInfo.cid, jar, signal, referer });
        if (!play.audioUrl) throw new BiliError('UPSTREAM_ERROR', '播放地址没有可用的音频流');
        const payload = await transcribeUrl({ ...options, audioUrl: play.audioUrl, referer, signal });
        return ok({
          segments: segmentsToEntries(payload),
          model: payload.model ?? null,
          language: payload.language ?? null,
          confidence: payload.confidence ?? {},
          verdict: judgeTranscript(payload),
          timing: { audioSeconds: payload.duration_sec ?? null, elapsedSeconds: payload.elapsed_sec ?? null },
          // 表示这次只覆盖分 P 的一个窗口，并不表示识别段落被裁剪。
          truncated: options.startSeconds > 0 || options.durationSeconds < pageInfo.duration,
        }, { source: 'bilibili_transcribe', cache: 'miss' });
      } catch (error) {
        asToolError(error instanceof BiliError ? error : new BiliError(
          error?.name === 'AbortError' ? 'CANCELLED' : error?.name === 'TimeoutError' ? 'TIMEOUT' : 'UPSTREAM_ERROR',
          String(error?.message ?? error),
        ));
      }
    },
  });
}
