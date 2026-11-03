import { currentJar } from '../bili/auth.mjs';
import { collect } from '../bili/collect.mjs';
import { asToolError, ok, registerTool } from './helpers.mjs';

export function registerCollectTools(ctx) {
  registerTool(ctx, { name: 'bilibili_collect', description: '搜索后批量采集评论与平台字幕。≤10 视频，每条≤20 主评论，不补楼中楼、不跑 ASR/OCR；支持取消并保留部分结果。',
    parameters: { type: 'object', properties: { keyword: { type: 'string', minLength: 1 }, maxVideos: { type: 'integer', minimum: 1, maximum: 10 }, commentsPerVideo: { type: 'integer', minimum: 1, maximum: 20 }, subtitles: { type: 'boolean' } }, required: ['keyword'], additionalProperties: false },
    timeoutMs: 120000, isConcurrencySafe: () => false,
    async execute(args, exec) { try {
      const { jar } = await currentJar(); const data = await collect({ ...args, jar, signal: exec?.signal });
      return { ...ok(data), status: data.partial ? 'partial' : 'ok' };
    } catch (e) { asToolError(e); } },
  });
}
