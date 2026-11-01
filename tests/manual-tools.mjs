/**
 * 手工验证工具层（不经过 DSH）：用假 ctx 捕获注册，再直接调用 execute。
 *   BILI_DATA_DIR=./.bili-data node tests/manual-tools.mjs BV1YLHu6zEDp
 */
import { apply } from '../lib/index.js';

const bvid = process.argv[2] ?? 'BV1YLHu6zEDp';
const tools = new Map();
const ctx = {
  tools: { register: (definition) => tools.set(definition.name, definition) },
  on: () => {},
  get: () => undefined,
};
apply(ctx);

console.log('tools:', [...tools.keys()].join(', '));

const exec = {
  agent: { options: { provider: 'deepseek-official', model: 'deepseek-flash' } },
  signal: undefined,
};

const extract = tools.get('bilibili_extract');
const value = await extract.execute(
  { bvid, danmakuLimit: 10, commentLimit: 5 },
  exec,
);
console.log(
  JSON.stringify(
    {
      status: value.status,
      imageChannel: value.imageChannel,
      imageAttached: value.imageAttached,
      images: value.images,
      sources: value.data.sources,
      transcript: value.data.transcript.length,
      danmaku: value.data.danmaku.total,
      comments: value.data.comments.total,
      video: value.data.video.title,
    },
    null,
    2,
  ),
);
const blocks = extract.output.render({}, value);
console.log('render blocks:', blocks.map((block) => block.type).join(','));

const inspect = tools.get('bilibili_inspect');
const iv = await inspect.execute({ bvid, timestampsMs: [125000, 382000], maxFrames: 4 }, exec);
console.log(
  JSON.stringify(
    {
      status: iv.status,
      imageChannel: iv.imageChannel,
      frames: iv.data.frames,
      image: iv.images[0],
    },
    null,
    2,
  ),
);
