/**
 * 采样方案对比实验：同一份扫描、同一组指标，一次跑多个视频。
 *
 * 用法：node tests/manual-adaptive-bench.mjs BVxxx BVyyy ...
 *
 * 说明：
 * - Uniform 参考用**扫描帧**的 9 个均匀锚点（与线上平台故事板图不同，但同一特征管线，可公平比较）。
 * - 覆盖率/冗余度按整包 18 帧算；黑屏数与最低清晰度只统计**自适应新增的 9 帧**，
 *   否则会被 Uniform 里的片头/片尾黑帧污染。
 * - 这是算法诊断，不是语义准确率。
 */
import { currentJar } from '../lib/bili/auth.mjs';
import { getVideo } from '../lib/bili/api.mjs';
import { adaptiveConfig, realScan } from '../lib/media/adaptive.mjs';
import { selectAdaptive, similarity } from '../lib/media/adaptive-selection.mjs';

const bvids = process.argv.slice(2);
if (!bvids.length) {
  console.error('usage: node tests/manual-adaptive-bench.mjs <bvid> [bvid...]');
  process.exit(1);
}

const QUALITY = { sharpenWindowMs: 1500, minGapMs: 5000 };

function uniform(frames, count) {
  const size = Math.min(count, frames.length);
  return Array.from({ length: size }, (_, i) => frames[Math.round(i * (frames.length - 1) / Math.max(1, size - 1))]);
}

function hsvPeaks(frames, references, count) {
  const change = frames.map((frame, i) => (i
    ? 1 - frame.feature.histogram.reduce((sum, value, j) => sum + Math.min(value, frames[i - 1].feature.histogram[j]), 0)
    : 0));
  return frames
    .filter((frame, i) => i && !references.includes(frame)
      && change[i] >= (change[i - 1] ?? 0) && change[i] >= (change[i + 1] ?? 0))
    .sort((a, b) => change[frames.indexOf(b)] - change[frames.indexOf(a)])
    .slice(0, count);
}

function metrics(selected, extras, population) {
  const covered = population.reduce((sum, frame) =>
    sum + Math.max(0, ...selected.map((pick) => similarity(frame, pick))), 0) / Math.max(1, population.length);
  let pairSum = 0, pairs = 0;
  for (let i = 0; i < selected.length; i += 1) {
    for (let j = i + 1; j < selected.length; j += 1) { pairSum += similarity(selected[i], selected[j]); pairs += 1; }
  }
  const sharpness = extras.map((frame) => frame.feature?.quality?.sharpness ?? 0);
  const black = extras.filter((frame) => (frame.feature?.quality?.blackRatio ?? 0) > 0.3).length;
  return {
    count: selected.length,
    coverage: Number(covered.toFixed(4)),
    redundancy: Number((pairSum / Math.max(1, pairs)).toFixed(4)),
    black,
    minSharpness: Number(Math.min(...sharpness).toFixed(4)),
  };
}

function variants(frames) {
  const references = uniform(frames, 9);
  const range = { startMs: frames[0].atMs, endMs: frames.at(-1).atMs + 1, references };
  const run = (options) => selectAdaptive(frames, { ...range, ...QUALITY, ...options }).frames;
  const withRefs = (extra) => ({ selected: [...references, ...extra], extras: extra });
  return [
    ['uniform9', () => ({ selected: references, extras: references })],
    ['uniform18', () => { const picked = uniform(frames, 18); return { selected: picked, extras: picked }; }],
    ['uniform9+hsv-peaks9', () => withRefs(hsvPeaks(frames, references, 9))],
    ['uniform9+facility9', () => withRefs(run({ waveletEnabled: false, segmentCoverageWeight: 0 }))],
    ['uniform9+facility-segments9', () => withRefs(run({ waveletEnabled: false }))],
    ['uniform9+dwt-facility9', () => withRefs(run({ segmentCoverageWeight: 0 }))],
    ['uniform9+full9(当前)', () => withRefs(run({}))],
    ['uniform9+full9-无质量后处理', () => withRefs(run({ sharpenWindowMs: 0, minGapMs: 0 }))],
  ];
}

const rows = [];
for (const bvid of bvids) {
  const { jar } = await currentJar();
  const video = await getVideo(bvid, { jar });
  const page = video.pages[0];
  const durationMs = (page.duration ?? video.duration) * 1000;
  const config = await adaptiveConfig();
  const started = Date.now();
  const scan = await realScan({ video, cid: page.cid, jar, startMs: 0, endMs: durationMs, config });
  const scanMs = Date.now() - started;
  console.log(`\n### ${bvid}  ${durationMs / 1000}s  scanFrames=${scan.frames.length}  scan=${scanMs}ms  scanFps=${scan.scanFps ?? '?'}`);
  for (const [name, pick] of variants(scan.frames)) {
    const { selected, extras } = pick();
    const result = metrics(selected, extras, scan.frames);
    rows.push({ bvid, name, ...result });
    console.log(`  ${name.padEnd(30)} n=${String(result.count).padStart(2)}  cov=${result.coverage.toFixed(4)}  red=${result.redundancy.toFixed(4)}  black+${result.black}  minSharp=${result.minSharpness.toFixed(4)}`);
  }
}

console.log(`\n### 汇总（各方案在 ${bvids.length} 个视频上的均值）`);
const names = [...new Set(rows.map((row) => row.name))];
for (const name of names) {
  const list = rows.filter((row) => row.name === name);
  const mean = (key) => (list.reduce((sum, row) => sum + row[key], 0) / list.length).toFixed(4);
  console.log(`  ${name.padEnd(30)} n=${mean('count')}  cov=${mean('coverage')}  red=${mean('redundancy')}  black+${mean('black')}  minSharp=${mean('minSharpness')}`);
}
