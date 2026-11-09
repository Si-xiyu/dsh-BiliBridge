/** Pure, serializable classical-CV selection. No decoding, filesystem or model dependencies. */
import { BiliError } from '../bili/errors.mjs';

const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
const featureOf = (frame) => frame.feature ?? frame;
const DCT_COS = Array.from({ length: 8 }, (_, frequency) => Array.from({ length: 16 }, (_, pixel) => Math.cos((2 * pixel + 1) * frequency * Math.PI / 32)));
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
};

/** RGB bytes, no alpha. HSV histogram: 8 hue × 3 saturation × 4 value bins. */
export function frameFeature(rgb, width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || rgb.length !== width * height * 3) {
    throw new BiliError('INVALID_ARGUMENT', 'frameFeature requires packed RGB pixels');
  }
  const histogram = Array(96).fill(0);
  const gray = new Float64Array(width * height);
  let brightness = 0;
  let black = 0;
  for (let i = 0; i < gray.length; i += 1) {
    const r = rgb[i * 3] / 255, g = rgb[i * 3 + 1] / 255, b = rgb[i * 3 + 2] / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
    let h = 0;
    if (delta > 0) h = max === r ? ((g - b) / delta + 6) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
    const s = max ? delta / max : 0;
    histogram[(Math.min(7, Math.floor(h / 6 * 8)) * 3 + Math.min(2, Math.floor(s * 3))) * 4 + Math.min(3, Math.floor(max * 4))] += 1 / gray.length;
    gray[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    brightness += gray[i] / gray.length;
    if (max < 0.04) black += 1;
  }
  // Area-average to a 16×16 luminance grid before taking 63 low-frequency AC coefficients.
  const grid = new Float64Array(256), counts = new Uint32Array(256);
  let sharpness = 0;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const i = y * width + x, cell = Math.floor(y * 16 / height) * 16 + Math.floor(x * 16 / width);
    grid[cell] += gray[i]; counts[cell] += 1;
    if (x && y) sharpness += Math.abs(gray[i] - gray[i - 1]) + Math.abs(gray[i] - gray[i - width]);
  }
  for (let y = 0; y < 16; y += 1) for (let x = 0; x < 16; x += 1) {
    const i = y * 16 + x;
    grid[i] = counts[i] ? grid[i] / counts[i] : gray[Math.min(height - 1, Math.floor((y + 0.5) * height / 16)) * width + Math.min(width - 1, Math.floor((x + 0.5) * width / 16))];
  }
  const coefficients = [];
  for (let v = 0; v < 8; v += 1) for (let u = 0; u < 8; u += 1) {
    if (!u && !v) continue;
    let sum = 0;
    for (let y = 0; y < 16; y += 1) for (let x = 0; x < 16; x += 1) {
      sum += grid[y * 16 + x] * DCT_COS[u][x] * DCT_COS[v][y];
    }
    coefficients.push(Math.abs(sum) < 1e-9 ? 0 : sum);
  }
  const threshold = median(coefficients);
  return { histogram, hash: coefficients.map((v) => v > threshold ? 1 : 0), quality: { brightness, blackRatio: black / gray.length, sharpness: sharpness / gray.length } };
}

function histogramSimilarity(a, b) {
  return clamp(a.histogram.reduce((sum, value, i) => sum + Math.min(value, b.histogram[i]), 0));
}
function hashSimilarity(a, b) {
  return a.hash.length ? 1 - a.hash.reduce((sum, value, i) => sum + (value === b.hash[i] ? 0 : 1), 0) / a.hash.length : 0;
}
export function similarity(a, b) {
  a = featureOf(a); b = featureOf(b);
  return 0.65 * histogramSimilarity(a, b) + 0.35 * hashSimilarity(a, b);
}
/** Conservative: both colour and low-frequency structure must be almost identical. */
export function nearDuplicate(a, b) {
  a = featureOf(a); b = featureOf(b);
  return histogramSimilarity(a, b) >= 0.995 && hashSimilarity(a, b) >= 0.985;
}

/** Decimated Haar details reconstructed onto the original signal, with symmetric end padding. */
export function haarScores(signal, requestedLevels = 3) {
  const scores = Array(signal.length).fill(0);
  let approximation = [...signal];
  const levels = Math.min(Math.max(1, requestedLevels), Math.floor(Math.log2(signal.length || 1)));
  for (let level = 0; level < levels; level += 1) {
    const next = [];
    const block = 2 ** (level + 1);
    for (let i = 0; i < approximation.length; i += 2) {
      const left = approximation[i], right = approximation[i + 1] ?? left;
      next.push((left + right) / 2);
      const detail = Math.abs(left - right) / 2;
      for (let j = i / 2 * block; j < Math.min(scores.length, (i / 2 + 1) * block); j += 1) scores[j] += detail / (level + 1);
    }
    approximation = next;
  }
  return scores;
}

export function temporalSegments(frames, { startMs, endMs, waveletEnabled = true, waveletLevel = 3, minSegmentMs = 1000 } = {}) {
  if (!frames.length) return [];
  startMs ??= frames[0].atMs;
  endMs ??= frames.at(-1).atMs + 1;
  const differences = frames.map((frame, i) => i ? 1 - similarity(frame, frames[i - 1]) : 0);
  const wavelet = waveletEnabled ? haarScores(differences, waveletLevel) : differences.map(() => 0);
  // Raw differences retain sustained activity and anchor timestamps; Haar adds multiscale evidence.
  const scores = differences.map((value, i) => clamp(value + wavelet[i]));
  const center = median(scores), mad = median(scores.map((v) => Math.abs(v - center)));
  const threshold = Math.max(0.12, center + 2.5 * mad);
  const peaks = [];
  for (let i = 1; i < frames.length; i += 1) {
    if (differences[i] > 0.08 && scores[i] >= threshold && scores[i] >= (scores[i - 1] ?? 0) && scores[i] >= (scores[i + 1] ?? 0)) peaks.push(i);
  }
  const boundaries = [startMs];
  for (const i of [...peaks].sort((a, b) => scores[b] - scores[a] || a - b)) {
    const time = frames[i].atMs;
    if (time - startMs >= minSegmentMs && endMs - time >= minSegmentMs && boundaries.every((b) => Math.abs(b - time) >= minSegmentMs)) boundaries.push(time);
  }
  boundaries.push(endMs);
  boundaries.sort((a, b) => a - b);
  return boundaries.slice(0, -1).map((start, i) => {
    const end = boundaries[i + 1];
    const inside = scores.filter((_, j) => frames[j].atMs >= start && frames[j].atMs < end);
    return { startMs: start, endMs: end, changeScore: inside.length ? inside.reduce((a, b) => a + b, 0) / inside.length : 0 };
  });
}

/** Normalized facility-location marginal gain, useful independently in tests. */
export function facilityGain(similarities, covered) {
  return similarities.reduce((sum, value, i) => sum + Math.max(0, value - covered[i]), 0) / (covered.length || 1);
}

function candidateFrames(frames, segments, budget) {
  const picked = new Set();
  const add = (index) => { if (index >= 0 && index < frames.length && picked.size < budget) picked.add(index); };
  // Reserve a third for uniform anchors even when rapid cuts generate many boundaries.
  const anchors = Math.max(1, Math.floor(budget / 3));
  for (let i = 0; i < anchors; i += 1) add(Math.round(i * (frames.length - 1) / Math.max(1, anchors - 1)));
  const eventLimit = Math.max(anchors, Math.floor(budget * 2 / 3));
  // Before/after boundary windows preserve short events; cap their share of the pool.
  for (const segment of [...segments].sort((a, b) => b.changeScore - a.changeScore)) {
    if (picked.size >= eventLimit) break;
    const index = frames.findIndex((frame) => frame.atMs >= segment.startMs);
    for (const candidate of [index, index - 1, index + 1]) {
      if (picked.size >= eventLimit) break;
      add(candidate);
    }
  }
  for (const segment of segments) {
    const indices = frames.flatMap((frame, i) => frame.atMs >= segment.startMs && frame.atMs < segment.endMs ? [i] : []);
    if (!indices.length) continue;
    // Centroid of normalized histograms: cheap representative, not a temporal midpoint.
    const mean = Array(96).fill(0);
    for (const i of indices) featureOf(frames[i]).histogram.forEach((value, j) => { mean[j] += value / indices.length; });
    indices.sort((a, b) => histogramSimilarity(featureOf(frames[b]), { histogram: mean }) - histogramSimilarity(featureOf(frames[a]), { histogram: mean }) || a - b);
    add(indices[0]);
  }
  // Fill uniformly with finer spacing rather than biasing the start of the video.
  for (let i = 0; i < Math.min(budget, frames.length); i += 1) add(Math.round(i * (frames.length - 1) / Math.max(1, Math.min(budget, frames.length) - 1)));
  return [...picked].sort((a, b) => a - b).map((i) => frames[i]);
}

export function selectAdaptive(input, options = {}) {
  const { maxFrames = 9, references = [], candidateBudget = 180, facilityWeight = 1, segmentCoverageWeight = 0.2, segmentCoverageTau = 1 } = options;
  if (!Number.isInteger(maxFrames) || maxFrames < 1 || maxFrames > 9 || !Number.isInteger(candidateBudget) || candidateBudget < 1 || candidateBudget > 300 || ![facilityWeight, segmentCoverageWeight].every((v) => Number.isFinite(v) && v >= 0) || !Number.isFinite(segmentCoverageTau) || segmentCoverageTau <= 0) {
    throw new BiliError('INVALID_ARGUMENT', 'Invalid adaptive selection budget or weights');
  }
  const validFeature = (feature) => feature?.histogram?.length === 96 && feature.histogram.every((value) => Number.isFinite(value) && value >= 0 && value <= 1) && Math.abs(feature.histogram.reduce((a, b) => a + b, 0) - 1) < 1e-6 && feature?.hash?.length === 63 && feature.hash.every((value) => value === 0 || value === 1);
  if (!references.every((frame) => validFeature(featureOf(frame)))) throw new BiliError('INVALID_ARGUMENT', 'Invalid adaptive reference feature');
  const frames = [...input].filter((frame) => Number.isFinite(frame.atMs) && validFeature(frame.feature)).sort((a, b) => a.atMs - b.atMs).filter((frame, i, all) => !i || frame.atMs !== all[i - 1].atMs);
  const segments = temporalSegments(frames, options);
  if (!frames.length) return { frames: [], segments, candidateCount: 0, stopReason: 'no-valid-candidates' };
  const candidates = candidateFrames(frames, segments, candidateBudget);
  const selected = [];
  const segmentOf = (frame) => segments.findIndex((segment) => frame.atMs >= segment.startMs && frame.atMs < segment.endMs);
  const counts = segments.map((_, i) => references.filter((frame) => segmentOf(frame) === i).length);
  const covered = frames.map((frame) => references.reduce((best, reference) => Math.max(best, similarity(frame, reference)), 0));
  // Reference population remains uniformly scanned frames, independent of candidate density.
  const similarities = candidates.map((candidate) => frames.map((frame) => similarity(frame, candidate)));
  while (selected.length < maxFrames) {
    let best = -1, bestGain = -Infinity, bestQuality = -Infinity;
    for (let i = 0; i < candidates.length; i += 1) {
      const candidate = candidates[i];
      if (selected.includes(i) || [...references, ...selected.map((j) => candidates[j])].some((frame) => nearDuplicate(frame, candidate))) continue;
      const segment = segmentOf(candidate);
      const count = counts[segment] ?? 0;
      const coverageGain = segment < 0 ? 0 : Math.exp(-count / segmentCoverageTau) * (1 - Math.exp(-1 / segmentCoverageTau)) / segments.length;
      const gain = facilityWeight * facilityGain(similarities[i], covered) + segmentCoverageWeight * coverageGain;
      const quality = featureOf(candidate).quality;
      const qualityScore = quality ? (1 - quality.blackRatio) + quality.sharpness : 0;
      if (gain > bestGain + 1e-12 || Math.abs(gain - bestGain) <= 1e-12 && qualityScore > bestQuality) { best = i; bestGain = gain; bestQuality = qualityScore; }
    }
    if (best < 0) break;
    selected.push(best);
    const segment = segmentOf(candidates[best]);
    if (segment >= 0) counts[segment] += 1;
    for (let i = 0; i < covered.length; i += 1) covered[i] = Math.max(covered[i], similarities[best][i]);
  }
  return { frames: selected.map((i) => candidates[i]).sort((a, b) => a.atMs - b.atMs), segments, candidateCount: candidates.length, stopReason: selected.length >= maxFrames ? 'frame-limit' : 'near-duplicates-or-candidates-exhausted' };
}
