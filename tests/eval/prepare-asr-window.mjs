/** 抽取一个 ASR 窗口的低码率音频，供 baseline/candidate 复用同一 WAV。 */
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
const { values } = parseArgs({ options: {
  root: { type: 'string' }, bvid: { type: 'string' }, start: { type: 'string', default: '0' },
  duration: { type: 'string', default: '60' }, out: { type: 'string' },
  force: { type: 'boolean', default: false },
} });
if (!values.out) throw new Error('需要 --out');
if (existsSync(values.out) && !values.force) throw new Error(`输出已存在，拒绝覆盖：${values.out}（加 --force 明确覆盖）`);
const root = values.root;
const importRoot = (path) => import(pathToFileURL(join(root, path)).href);
const { currentJar } = await importRoot('lib/bili/auth.mjs');
const { getVideo } = await importRoot('lib/bili/api.mjs');
const { getPlayUrls } = await importRoot('lib/bili/playurl.mjs');
const { extractAudio } = await importRoot('lib/media/ffmpeg.mjs');
const { jar } = await currentJar();
const video = await getVideo(values.bvid, { jar });
const page = video.pages[0];
const play = await getPlayUrls({ bvid: values.bvid, cid: page.cid, jar });
const audioUrl = play.audioUrlLow ?? play.audioUrl;
if (!audioUrl) throw new Error('没有可用音轨');
await mkdir(dirname(values.out), { recursive: true });
await extractAudio({ url: audioUrl, outFile: values.out, referer: `https://www.bilibili.com/video/${values.bvid}`, startSeconds: Number(values.start), maxSeconds: Number(values.duration), timeoutMs: 120000 });
console.log(values.out);
