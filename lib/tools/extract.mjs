import { appendHistory } from '../media/history.mjs';
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
import { analysisConfig } from '../media/analysis-config.mjs';
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
  // 一张拼图一个附件；多张时用序号区分，避免同名附件互相覆盖。
  const inspectCount = images.filter((image) => image.kind === 'inspect').length;

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
                  ? inspectCount > 1
                    ? `frames-${image.sheet ?? 1}.jpg`
                    : 'frames.jpg'
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
      // 多张拼图时告诉模型这张覆盖了哪几帧，避免跨图对错号。
      ...(image.sheet ? {
        sheet: image.sheet,
        sheetCount: image.sheetCount,
        frameStart: image.frameStart,
        frameCount: image.frameCount,
      } : {}),
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
        subtitleCursor: { type: 'string', description: 'subtitles.nextCursor；续取不重复附图' },
        danmakuWindow: { type: 'object', properties: { startSeconds: { type: 'number', minimum: 0 }, endSeconds: { type: 'number' } }, required: ['startSeconds', 'endSeconds'], additionalProperties: false },
        danmakuLimit: { type: 'integer', minimum: 0, maximum: 100, description: '弹幕样本上限，默认 60' },
        commentLimit: { type: 'integer', minimum: 0, maximum: 20, description: '评论上限，默认 10' },
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
          subtitleCursor: args?.subtitleCursor,
          danmakuWindow: args?.danmakuWindow,
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
      'selection=adaptive 时自动选择全片或 range 指定区间的代表帧，maxFrames 控制数量；' +
      'ffmpeg 或播放地址不可用时降级 B站故事板，返回里标 source / maxErrorMs —— source=storyboard 时不要声称精确。' +
      '可选 OCR：ocr=true 对取到的帧识别文字（PPT/代码/图表/硬字幕），ocrRegion=frame|subtitle-band；' +
      '或传 subtitleWindow 做窗口连续硬字幕 OCR（与 ocr 互斥，适合整片硬字幕视频）。' +
      '单次最多 9 帧；每 6 帧拼成一张 2×3，超出会拆成多张图（各自一个附件），' +
      '避免细长拼图被宿主整体降采样。只在文本证据不足时调用。',
    parameters: {
      type: 'object',
      properties: {
        bvid: { type: 'string', description: 'BV 号' },
        page: { type: 'integer', description: '分 P 序号，默认 1' },
        selection: { type: 'string', enum: ['targeted', 'adaptive'], description: 'targeted=原有定向取帧（默认）；adaptive=自动选择代表帧' },
        range: { type: 'object', properties: { startMs: { type: 'integer', minimum: 0 }, endMs: { type: 'integer', minimum: 1 } }, required: ['startMs', 'endMs'], additionalProperties: false, description: '仅 adaptive：原视频毫秒区间；省略分析当前分 P 全片，与时间点、intervals、subtitleWindow 互斥' },
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
        maxFrames: { type: 'integer', minimum: 1, maximum: 9, description: '帧数上限 1–9；定向默认 6，自适应默认 9；高度近重复时可能少选。每图最多 2×3' },
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
      const started = Date.now();
      const history = {
        at: new Date().toISOString(), tool: 'bilibili_inspect',
        bvid: /^BV[0-9A-Za-z]{10}$/.test(args?.bvid) ? args.bvid : null,
        page: Number.isInteger(args?.page) ? args.page : 1,
        params: { frames: 0, ocr: args?.ocr === true || args?.subtitleWindow !== undefined },
        cacheHit: false, ok: false, error: null,
      };
      try {
        const { jar } = await currentJar();
        const video = await getVideo(args?.bvid, { jar, signal: exec?.signal });
        const pageInfo = resolvePage(video, args?.page);
        const durationMs = (pageInfo.duration ?? video.duration ?? 0) * 1000;

        // 工具层用秒，库层用毫秒；这里只做单位换算，不替库层“纠正”非法输入。
        const windowArg = args?.subtitleWindow;
        // OCR 硬开关：关掉后连参数都不该被接受，避免“看起来能跑、其实被静默忽略”。
        if ((args?.ocr === true || windowArg !== undefined) && !analysisConfig().ocr.enabled) {
          throw new BiliError('OCR_DISABLED', 'OCR 已在设置中关闭（设置 → B站工具 → 视频理解）');
        }
        let subtitleWindow;
        if (windowArg !== undefined) {
          if (!windowArg || typeof windowArg !== 'object' || Array.isArray(windowArg)) {
            throw new BiliError('INVALID_ARGUMENT', 'subtitleWindow 必须是对象');
          }
          const startSeconds = Number(windowArg.startSeconds);
          const endSeconds = Number(windowArg.endSeconds);
          if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds)) {
            throw new BiliError('INVALID_ARGUMENT', 'subtitleWindow 需要数字类型的 startSeconds / endSeconds');
          }
          subtitleWindow = {
            startMs: Math.round(startSeconds * 1000),
            endMs: Math.round(endSeconds * 1000),
            ...(windowArg.intervalSeconds !== undefined ? { intervalSeconds: Number(windowArg.intervalSeconds) } : {}),
            ...(windowArg.bandRatio !== undefined ? { bandRatio: Number(windowArg.bandRatio) } : {}),
          };
        }

        const result = await buildInspection({
          video,
          cid: pageInfo.cid,
          timestampsMs: args?.timestampsMs ?? [],
          intervals: args?.intervals ?? [],
          maxFrames: args?.maxFrames ?? (args?.selection === 'adaptive' ? 9 : 6),
          selection: args?.selection,
          range: args?.range,
          source: args?.source ?? 'auto',
          // 用当前分 P 的时长做越界校验，避免把别的分 P 的时间当成这一 P 的。
          durationMs,
          // 不做 Boolean()/Number() 强转：字符串 "false" 会被转成 true，反而绕过了库层校验。
          ...(args?.ocr !== undefined ? { ocr: args.ocr } : {}),
          ...(args?.ocrRegion !== undefined ? { ocrRegion: args.ocrRegion } : {}),
          ...(args?.bandRatio !== undefined ? { bandRatio: args.bandRatio } : {}),
          ...(subtitleWindow ? { subtitleWindow } : {}),
          jar,
          signal: exec?.signal,
        });

        history.params.frames = result.frames?.length ?? result.ocr?.sampled ?? 0;
        const sheetImages = result.images ?? [];
        history.cacheHit = sheetImages.some((image) => image.cached);
        // 窗口连续 OCR 模式没有帧图，只有一个 ocr 结构。
        if (subtitleWindow) {
          history.ok = true;
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
          sheetImages.map((image) => ({ kind: 'inspect', ...image })),
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
        history.ok = true;
        // 所有 sheet 共享同一来源/精度；取第一张即可，图数单独报 sheetCount。
        const primary = sheetImages[0] ?? {};
        return {
          ...ok(
            {
              video: { bvid: video.bvid, cid: pageInfo.cid, title: video.title, durationMs: pageInfo.duration * 1000 },
              frames: result.frames,
              source: primary.source ?? result.selection?.source,
              ...(result.selection ? { selection: result.selection } : {}),
              accuracy: primary.accuracy,
              maxErrorMs: primary.maxErrorMs,
              sheetCount: sheetImages.length,
              ...(primary.quality ? { quality: primary.quality } : {}),
              ...(result.fallbackReason ? { fallbackReason: result.fallbackReason } : {}),
              ...(result.ocr ? { ocr: result.ocr } : {}),
            },
            { source: 'bilibili_inspect', cache: sheetImages.some((image) => image.cached) ? 'hit' : 'miss' },
          ),
          images: attached.images,
          imageAttached: attached.imageAttached,
          imageChannel: attached.imageChannel,
          warnings,
        };
      } catch (error) {
        history.ok = false;
        history.error = error instanceof BiliError ? error.code : 'UPSTREAM_ERROR';
        asToolError(error);
      } finally {
        await appendHistory({ ...history, elapsedMs: Date.now() - started });
      }
    },
  });
}
