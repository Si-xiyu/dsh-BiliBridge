/** Feature-only ablation on one existing scan cache; no network or model calls.
 * node tests/manual-adaptive-compare.mjs <adaptive-cache.json>
 * These diagnostics reuse the selector's features: they are NOT independent semantic evaluation.
 */
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { selectAdaptive, similarity } from '../lib/media/adaptive-selection.mjs';

const record = JSON.parse(await readFile(process.argv[2], 'utf8'));
const frames = record.scan.frames;
const uniform = (count) => Array.from({ length: Math.min(count, frames.length) }, (_, i) => frames[Math.round(i * (frames.length - 1) / Math.max(1, Math.min(count, frames.length) - 1))]);
const references = uniform(9);
const range = { startMs: frames[0].atMs, endMs: frames.at(-1).atMs + 1, references };
const hsvChange = (i) => i ? 1 - frames[i].feature.histogram.reduce((sum, value, j) => sum + Math.min(value, frames[i - 1].feature.histogram[j]), 0) : 0;
const changes = frames.map((_, i) => hsvChange(i));
const peaks = frames.filter((frame, i) => i && changes[i] >= (changes[i - 1] ?? 0) && changes[i] >= (changes[i + 1] ?? 0) && !references.includes(frame))
  .sort((a, b) => changes[frames.indexOf(b)] - changes[frames.indexOf(a)]).slice(0, 9);
const variants = {
  uniform9: () => references,
  uniform18: () => uniform(18),
  'uniform9+hsv-peaks9': () => [...references, ...peaks],
  'uniform9+facility9': () => [...references, ...selectAdaptive(frames, { ...range, waveletEnabled: false, segmentCoverageWeight: 0 }).frames],
  'uniform9+facility-segments9': () => [...references, ...selectAdaptive(frames, { ...range, waveletEnabled: false }).frames],
  'uniform9+dwt-facility9': () => [...references, ...selectAdaptive(frames, { ...range, segmentCoverageWeight: 0 }).frames],
  'uniform9+full9': () => [...references, ...selectAdaptive(frames, range).frames],
};
const results = [];
for (const [variant, run] of Object.entries(variants)) {
  const started = performance.now(), selected = run();
  const selectionMs = +(performance.now() - started).toFixed(2);
  let sum = 0, pairs = 0;
  for (let i = 0; i < selected.length; i++) for (let j = i + 1; j < selected.length; j++) { sum += similarity(selected[i], selected[j]); pairs++; }
  results.push({ variant, count: selected.length, selectionMs,
    featureCoverage: +(frames.reduce((total, frame) => total + Math.max(...selected.map((s) => similarity(frame, s))), 0) / frames.length).toFixed(4),
    meanPairSimilarity: +(sum / Math.max(1, pairs)).toFixed(4) });
}
console.log(JSON.stringify({ scanFrames: frames.length, note: 'Feature-only diagnostic; no semantic or event-recall claims. Uniform references here are scan anchors, not platform storyboard images.', results }, null, 2));
