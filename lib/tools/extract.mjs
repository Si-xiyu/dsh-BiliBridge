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

function contentRenderer(value) {
  const { images, ...rest } = value ?? {};
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
    storyboard: join(dir, `storyboard-${cid}.jpg`),
    inspect: null,
  };
  const out = [];
  const warnings = [];

  for (const image of images) {
    const path = image.kind === 'cover' ? paths.cover : image.kind === 'storyboard' ? paths.storyboard : image.path;
    let attachment;
    if (capability.ok) {
      const limits = capability.attachments.imageLimits;
      if (!limits || image.buffer.byteLength <= limits.maxImageBytes) {
        try {
          attachment = await capability.attachments.saveImage({
            data: image.buffer,
            mediaType: image.mediaType,
            name: image.kind === 'cover' ? 'cover.jpg' : 'storyboard.jpg',
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
      '提取一个视频的 Stage 1 证据包：元信息、平台字幕（官方/AI）、弹幕密度与代表样本、热门/最新评论、封面、' +
      '故事板九宫格（每格带约 mm:ss 时间）。返回文本证据 + 最多 2 张图。' +
      '先读证据包再判断：需要确认图表、演示或画面细节时，用 bilibili_inspect 指定时间点/区间补帧；不需要就基于现有证据回答。' +
      '字幕为 empty 时不要编造台词；部分来源失败时 status=partial。',
    parameters: {
      type: 'object',
      properties: {
        bvid: { type: 'string', description: 'BV 号' },
        page: { type: 'integer', description: '分 P 序号，默认 1' },
        include: {
          type: 'object',
          description: '可选：关闭某些来源以省时间/预算',
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
        const sources = bundle.sources.filter((source) => source.status === 'failed');
        const value = {
          ...ok(bundle, { source: 'bilibili_extract', cache: images.some((image) => image.cached) ? 'hit' : 'miss' }),
          status: sources.length ? 'partial' : 'ok',
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
      '对已提取的视频做 Stage 2 定向补帧：按时间点或区间取画面，返回带 req/got 标注的图片。' +
      '当前实现走 B站故事板，时间精度约 ±1s，适合确认“这一刻画面里有什么”；不适合读小字或精确动作。' +
      '只在文本证据不足时调用，单次最多 9 帧。',
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
        const video = await getVideo(args?.bvid, { jar, signal: exec?.signal });
        const pageInfo = video.pages.find((item) => item.page === Number(args?.page ?? 1)) ?? video.pages[0];
        if (!pageInfo) throw new BiliError('CONTENT_UNAVAILABLE', '视频没有可用的分 P');
        const result = await buildInspection({
          video,
          cid: pageInfo.cid,
          timestampsMs: args?.timestampsMs ?? [],
          intervals: args?.intervals ?? [],
          maxFrames: Number(args?.maxFrames ?? 6),
          signal: exec?.signal,
        });
        const attached = await attachImages(
          ctx,
          exec,
          [{ kind: 'inspect', ...result.image }],
          video.bvid,
          pageInfo.cid,
        );
        return {
          ...ok(
            {
              video: { bvid: video.bvid, cid: pageInfo.cid, title: video.title, durationMs: pageInfo.duration * 1000 },
              frames: result.frames,
              accuracy: result.image.accuracy,
              source: result.image.source,
            },
            { source: 'bilibili_inspect', cache: result.image.cached ? 'hit' : 'miss' },
          ),
          images: attached.images,
          imageAttached: attached.imageAttached,
          imageChannel: attached.imageChannel,
          warnings: attached.warnings,
        };
      } catch (error) {
        asToolError(error);
      }
    },
  });
}
