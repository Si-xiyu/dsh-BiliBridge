/**
 * 硬字幕 OCR 验收（会联网、会写缓存、会调用 Windows 自带 OCR）。
 *
 *   node tests/manual-ocr.mjs BV1pTx76QE8J
 *   node tests/manual-ocr.mjs BV1pTx76QE8J 16 0.25
 *
 * 产物：字幕带长图 + 转写 JSON（时间戳来自采样点）。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { currentJar } from '../lib/bili/auth.mjs';
import { getVideo } from '../lib/bili/api.mjs';
import { dataDir } from '../lib/bili/store.mjs';
import { buildSubtitleTranscript, planSamples } from '../lib/media/ocr.mjs';

const [bvid = 'BV1pTx76QE8J', sampleCount = '12', bandRatio = '0.22'] = process.argv.slice(2);
const count = Number(sampleCount) || 12;
const ratio = Number(bandRatio) || 0.22;

const { jar, credentials } = await currentJar();
console.log('login   :', credentials?.cookies?.SESSDATA ? '已登录' : '未登录（多半只有 480P）');

const video = await getVideo(bvid, { jar });
const cid = video.pages[0].cid;
console.log('video   :', video.title.slice(0, 40), `${video.duration}s`, 'cid', cid);
console.log('plan    :', planSamples({ durationMs: video.duration * 1000, count }).map((ms) => `${Math.round(ms / 1000)}s`).join(' '));

const result = await buildSubtitleTranscript({ video, cid, jar, samples: count, bandRatio: ratio, composeStrip: true });

const dir = join(dataDir(), 'cache', video.bvid);
await mkdir(dir, { recursive: true, mode: 0o700 });
const stripFile = join(dir, `subtitle-strip-${cid}.jpg`);
const textFile = join(dir, `subtitle-ocr-${cid}.json`);
// 窗口模式下默认不拼长图（几百行会超 JPEG 高度上限），这里要留一张给人看，所以显式打开。
if (result.strip.buffer) {
  await writeFile(stripFile, result.strip.buffer, { mode: 0o600 });
} else {
  console.log('strip   : （本次没有拼长图，只保留逐帧识别结果）');
}
await writeFile(textFile, `${JSON.stringify({ bvid, cid, ...result, strip: undefined, stripPath: result.strip.buffer ? stripFile : null }, null, 2)}\n`, { mode: 0o600 });

console.log('quality :', result.quality?.label ?? 'unknown');
console.log('ocr     :', `language=${result.language}`, `recognized ${result.recognized}/${result.sampled}`);
console.log('text    :');
for (const entry of result.entries) {
  const total = Math.round(entry.atMs / 1000);
  const mm = String(Math.floor(total / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  console.log(`  ${mm}:${ss}  ${entry.text.slice(0, 90)}`);
}
console.log('strip   :', stripFile);
console.log('json    :', textFile);
