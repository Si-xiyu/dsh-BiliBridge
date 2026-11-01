/**
 * 硬字幕带长图验收（会联网、会写缓存）。
 *
 *   node tests/manual-ocr.mjs BV1pTx76QE8J
 *   node tests/manual-ocr.mjs BV1pTx76QE8J 16 0.25
 *
 * 输出：字幕带长图的落盘路径、尺寸、采样点。识别引擎尚未接入。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { currentJar } from '../lib/bili/auth.mjs';
import { getVideo } from '../lib/bili/api.mjs';
import { buildSubtitleStrip, planSamples } from '../lib/media/ocr.mjs';
import { dataDir } from '../lib/bili/store.mjs';

const [bvid = 'BV1pTx76QE8J', sampleCount = '12', bandRatio = '0.22'] = process.argv.slice(2);
const count = Number(sampleCount) || 12;
const ratio = Number(bandRatio) || 0.22;

const { jar, credentials } = await currentJar();
console.log('login   :', credentials?.cookies?.SESSDATA ? '已登录' : '未登录（多半只有 480P）');

const video = await getVideo(bvid, { jar });
const cid = video.pages[0].cid;
console.log('video   :', video.title.slice(0, 40), `${video.duration}s`, 'cid', cid);
console.log('plan    :', planSamples({ durationMs: video.duration * 1000, count }).map((ms) => `${Math.round(ms / 1000)}s`).join(' '));

const strip = await buildSubtitleStrip({ video, cid, jar, samples: count, bandRatio: ratio });
const dir = join(dataDir(), 'cache', video.bvid);
await mkdir(dir, { recursive: true, mode: 0o700 });
const file = join(dir, `subtitle-strip-${cid}.jpg`);
await writeFile(file, strip.buffer, { mode: 0o600 });

console.log('quality :', strip.quality?.label ?? 'unknown');
console.log('band    :', strip.band.note, '| 原图高约', strip.band.originalHeightPx);
console.log('strip   :', `${strip.width}x${strip.height}`, strip.buffer.byteLength, 'bytes');
console.log('ok      :', strip.samples.filter((s) => s.ok).length, '/', strip.samples.length);
console.log('path    :', file);
