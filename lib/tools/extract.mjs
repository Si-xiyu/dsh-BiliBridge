/**
 * 视频证据工具：Stage 1 提取、Stage 2 定向补帧。
 *
 * 图片只在“宿主有附件服务 + 当前模型声明 image 输入”时才放进 tool result；
 * 否则返回本地路径并标记 image_attached=false，绝不把回合打崩。
 */
import { join } from 'node:path';
import { currentJar } from '../bili/auth.mjs';
import { getVideo } from '../bili/api.mjs';
import { dataDir } from '../bili/store.mjs';
import { BiliError } from '../bili/errors.mjs';
import { buildEvidence } from '../media/evidence.mjs';
import { buildInspection } from '../media/inspect.mjs';
import { asToolError, ok, registerTool } from './helpers.mjs';

/**
 * 分 P 解析：请求的分 P 不存在时必须报错。
 * 静默回落到第 1 个分 P 会让模型拿到另一个视频段落的字幕/弹幕，却以为是自己要的那段。
 */
function resolvePage(video, page) {
  const requested = Number(page ?? 1);
  const found = video.pages.find((item) => item.page === requested);
  if (!found) {
    throw new BiliError('CONTENT_UNAVAILABLE', `视频没有第 ${requested} 个分 P（共 ${video.pages.length} 个）`);
  }
  return found;
}

function contentRenderer(value) {  const { images, ...rest } = value ?? {};
  const blocks = [{ type: 'text', text: JSON.stringify(rest, null, 2) }];
  for (const image of images ?? []) {
    if (image.attachment) blocks.push({ type: 'image', attachment: image.attachment });
  }
  return blocks;
}

async function imageCapability(ctx, exec) {
  const attachments = ctx.get('attachments');
  const llm = ctx.get('llm');
  const provider = exec?.agent?.options?.provider;
  const model = exec?.agent?.options?.model;
  if (!attachments) return { ok: false, reason: 'attachments_service_unavailable' };
  if (!llm || !provider || !model) return { ok: false, reason: 'model_route_unknown' };
  try {
    const info = await llm.resolveModelInfo(provider, model, exec?.signal);
    if (!info?.inputModalities?.includes('image')) return { ok: false, reason: 'model_text_only' };
    return { ok: true, attachments, model, provider };
  } catch {
    return { ok: false, reason: 'model_info_failed' };
  }
}

async function attachImages(ctx, exec, images, bvid, cid) {
  const capability = await imageCapability(ctx, exec);
  const dir = join(dataDir(), 'cache', bvid);
  const paths = {
    cover: join(dir, 'cover.img'),
    storyboard: join(dir, `storyboard-v2-${cid}.jpg`),
    inspect: null,
  };
  const out = [];
  const warnings = [];

  for (const image of images) {
    // 图片自己带路径时以它为准（封面/故事板/字幕带都会落盘）。
    const path = image.path ?? (image.kind === 'cover' ? paths.cover : paths.storyboard);
    let attachment;
    if (capability.ok) {
      const limits = capability.attachments.imageLimits;
      if (!limits || image.buffer.byteLength <= limits.maxImageBytes) {
        try {
          attachment = await capability.attachments.saveImage({
            data: image.buffer,
            mediaType: image.mediaType,
            // 名字要能区分来源：ffmpeg 抽帧不是故事板，硬字幕长图也不是。
            name:
              image.kind === 'cover'
                ? 'cover.jpg'
                : image.kind === 'inspect'
                  ? 'frames.jpg'
                  : image.kind === 'subtitle-strip'
                    ? 'subtitle-strip.jpg'
                    : 'storyboard.jpg',
          });
        } catch (error) {
          warnings.push({ source: image.kind, code: 'IMAGE_ATTACH_FAILED', message: String(error?.message ?? error) });
        }
      } else {
        warnings.push({ source: image.kind, code: 'BUDGET_EXCEEDED', message: '图片超过宿主大小限制' });
      }
    }
    out.push({
      kind: image.kind,
      path,
      layout: image.layout,
      note: image.note,
      ...(attachment ? { attachment } : {}),
    });
  }

  return {
    images: out,
    imageAttached: out.some((image) => image.attachment),
    imageChannel: capability.ok ? 'attached' : capability.reason,
    warnings,
  };
}

export function registerExtractTools(ctx) {
  registerTool(ctx, {
    name: 'bilibili_extract',
    description:
      'Stage 1 快速证据包（Fast Path，秒级）：元信息、平台字幕、弹幕密度与代表样本、热门/最新评论、封面、' +
      '故事板九宫格（跨全部雪碧图，覆盖整条时间轴）。文本证据 + 最多 2 张图。' +
      '**不做 ASR、不做 OCR**：没有平台字幕时 subtitles.status=empty，这是事实而不是错误。' +
      '返回 gaps[]（缺什么）、suggestedWindows[]（弹幕密度峰值，可作深挖候选）、evidenceLevel（证据丰富度）。' +
      '需要更具体的文字或画面时再进 Stage 2：bilibili_transcribe（指定窗口转写）或 bilibili_inspect（定点取帧）。' +
      'subtitles.status=empty 时不要拿标题/简介/评论编造视频内容。',
    parameters: {
      type: 'object',
      properties: {
        bvid: { type: 'string', description: 'BV 号' },
        page: { type: 'integer', description: '分 P 序号，默认 1' },
        include: {
          type: 'object',
          description: '可选：关闭某些来源以省时间',
          properties: {
            metadata: { type: 'boolean' },
            subtitles: { type: 'boolean' },
            danmaku: { type: 'boolean' },
            comments: { type: 'boolean' },
            frames: { type: 'boolean' },
          },
          additionalProperties: false,
        },
        danmakuLimit: { type: 'integer', description: '弹幕样本上限，默认 60' },
        commentLimit: { type: 'integer', description: '评论上限，默认 10' },
      },
      required: ['bvid'],
      additionalProperties: false,
    },
    timeoutMs: 120_000,
    isConcurrencySafe: () => false,
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => contentRenderer(value) },
    async execute(args, exec) {
      try {
        const { jar } = await currentJar();
        const { bundle, images } = await buildEvidence({
          bvid: args?.bvid,
          page: Number(args?.page ?? 1),
          include: args?.include ?? {},
          jar,
          signal: exec?.signal,
          limits: {
            danmakuLimit: Number(args?.danmakuLimit ?? 60),
            commentLimit: Number(args?.commentLimit ?? 10),
          },
        });
        const attached = await attachImages(ctx, exec, images, bundle.video.bvid, bundle.video.cid);
        const failedSources = bundle.sources.filter((source) => source.status === 'failed');
        // 顶层 status 只反映“来源是否有失败”；没有字幕是事实，不是降级。
        const degraded = failedSources.length > 0;
        const value = {
          ...ok(bundle, { source: 'bilibili_extract', cache: images.some((image) => image.cached) ? 'hit' : 'miss' }),
          status: degraded ? 'partial' : 'ok',
          warnings: [...bundle.warnings, ...attached.warnings],
          images: attached.images,
          imageAttached: attached.imageAttached,
          imageChannel: attached.imageChannel,
        };
        return value;
      } catch (error) {
        asToolError(error);
      }
    },
  });

  registerTool(ctx, {
    name: 'bilibili_inspect',
    description:
      'Stage 2 定向取画面：按时间点/区间抽真实帧，并用 ffmpeg 从播放流抽取（误差约一帧）；' +
      'ffmpeg 或播放地址不可用时降级 B站故事板，返回里标 source / maxErrorMs —— source=storyboard 时不要声称精确。' +
      '可选 OCR：ocr=true 对取到的帧识别文字（PPT/代码/图表/硬字幕），ocrRegion=frame|subtitle-band；' +
      '或传 subtitleWindow 做窗口连续硬字幕 OCR（与 ocr 互斥，适合整片硬字幕视频）。' +
      '单次最多 9 帧；只在文本证据不足时调用。',
    parameters: {
      type: 'object',
      properties: {
        bvid: { type: 'string', description: 'BV 号' },
        page: { type: 'integer', description: '分 P 序号，默认 1' },
        timestampsMs: {
          type: 'array',
          items: { type: 'number' },
          description: '要看的毫秒时间点，例如 [125000, 382000]',
        },
        intervals: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              startMs: { type: 'number' },
              endMs: { type: 'number' },
              reason: { type: 'string' },
            },
            required: ['startMs', 'endMs'],
            additionalProperties: false,
          },
          description: '要看的区间；每段会取 2–3 帧',
        },
        maxFrames: { type: 'integer', description: '总帧数上限，默认 6，最大 9' },
        source: {
          type: 'string',
          enum: ['auto', 'ffmpeg', 'storyboard'],
          description: 'auto=优先 ffmpeg 再降级；ffmpeg=失败就报错；storyboard=强制用故事板',
        },
        ocr: {
          type: 'boolean',
          description: '对取到的帧做 OCR（一次批量识别）；默认 false，不改现有行为',
        },
        ocrRegion: {
          type: 'string',
          enum: ['frame', 'subtitle-band'],
          description: 'OCR 区域：frame=整帧（默认），subtitle-band=只认底部字幕带',
        },
        bandRatio: { type: 'number', description: 'subtitle-band 时保留底部多少比例，默认 0.22（0.08–0.5）' },
        subtitleWindow: {
          type: 'object',
          description:
            '窗口连续硬字幕 OCR（与 ocr 互斥）：对一段窗口按间隔采样字幕带并识别，用于没有平台字幕的硬字幕视频',
          properties: {
            startSeconds: { type: 'number', minimum: 0 },
            endSeconds: { type: 'number' },
            intervalSeconds: { type: 'number', description: '采样间隔，默认 2 秒' },
            bandRatio: { type: 'number' },
          },
          required: ['startSeconds', 'endSeconds'],
          additionalProperties: false,
        },
      },
      required: ['bvid'],
      additionalProperties: false,
    },
    timeoutMs: 180_000,
    isConcurrencySafe: () => false,
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => contentRenderer(value) },
    async execute(args, exec) {
      try {
        const { jar } = await currentJar();
        const video = await getVideo(args?.bvid, { jar, signal: exec?.signal });
        const pageInfo = resolvePage(video, args?.page);
        const durationMs = (pageInfo.duration ?? video.duration ?? 0) * 1000;

        // 工具层用秒，库层用毫秒；两者在这里转换，避免调用方记混。
        const windowArg = args?.subtitleWindow;
        const subtitleWindow = windowArg
          ? {
              startMs: Math.round(Number(windowArg.startSeconds) * 1000),
              endMs: Math.round(Number(windowArg.endSeconds) * 1000),
              ...(windowArg.intervalSeconds !== undefined ? { intervalSeconds: Number(windowArg.intervalSeconds) } : {}),
              ...(windowArg.bandRatio !== undefined ? { bandRatio: Number(windowArg.bandRatio) } : {}),
            }
          : undefined;

        const result = await buildInspection({
          video,
          cid: pageInfo.cid,
          timestampsMs: args?.timestampsMs ?? [],
          intervals: args?.intervals ?? [],
          maxFrames: Number(args?.maxFrames ?? 6),
          source: args?.source ?? 'auto',
          // 用当前分 P 的时长做越界校验，避免把别的分 P 的时间当成这一 P 的。
          durationMs,
          ...(args?.ocr !== undefined ? { ocr: Boolean(args.ocr) } : {}),
          ...(args?.ocrRegion !== undefined ? { ocrRegion: String(args.ocrRegion) } : {}),
          ...(args?.bandRatio !== undefined ? { bandRatio: Number(args.bandRatio) } : {}),
          ...(subtitleWindow ? { subtitleWindow } : {}),
          jar,
          signal: exec?.signal,
        });

        // 窗口连续 OCR 模式没有帧图，只有一个 ocr 结构。
        if (subtitleWindow) {
          return ok(
            {
              video: { bvid: video.bvid, cid: pageInfo.cid, title: video.title, durationMs },
              ocr: result.ocr,
            },
            { source: 'bilibili_inspect' },
          );
        }
        const attached = await attachImages(
          ctx,
          exec,
          [{ kind: 'inspect', ...result.image }],
          video.bvid,
          pageInfo.cid,
        );
        const warnings = [...attached.warnings];
        if (result.fallbackReason) {
          warnings.push({
            code: 'FRAME_SOURCE_FALLBACK',
            message: `ffmpeg 抽帧不可用（${result.fallbackReason.code}：${result.fallbackReason.message}），已降级到故事板；时间误差见 maxErrorMs`,
          });
        }
        return {
          ...ok(
            {
              video: { bvid: video.bvid, cid: pageInfo.cid, title: video.title, durationMs: pageInfo.duration * 1000 },
              frames: result.frames,
              source: result.image.source,
              accuracy: result.image.accuracy,
              maxErrorMs: result.image.maxErrorMs,
              ...(result.image.quality ? { quality: result.image.quality } : {}),
              ...(result.fallbackReason ? { fallbackReason: result.fallbackReason } : {}),
              ...(result.ocr ? { ocr: result.ocr } : {}),
            },
            { source: 'bilibili_inspect', cache: result.image.cached ? 'hit' : 'miss' },
          ),
          images: attached.images,
          imageAttached: attached.imageAttached,
          imageChannel: attached.imageChannel,
          warnings,
        };
      } catch (error) {
        asToolError(error);
      }
    },
  });
}
