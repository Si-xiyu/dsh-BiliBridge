/**
 * 时间轴小工具：字幕覆盖度按**区间并集**算，不是拿最后一条的结束时间去除。
 *
 * 为什么单独一个模块：字幕采集（subtitles.mjs）和证据包（evidence.mjs）都要用，
 * 放在任一方都会造成循环依赖。
 */

/**
 * @param {Array<{startMs:number,endMs:number}>} cues
 * @param {number} durationMs
 * @returns {number} 0..1
 */
export function coverageRatio(cues, durationMs) {
  if (!Array.isArray(cues) || !cues.length || !(durationMs > 0)) return 0;

  const spans = cues
    .map((cue) => [Number(cue?.startMs) || 0, Number(cue?.endMs) || 0])
    .map(([start, end]) => [Math.max(0, Math.min(start, durationMs)), Math.max(0, Math.min(end, durationMs))])
    .filter(([start, end]) => end > start)
    .sort((a, b) => a[0] - b[0]);

  let covered = 0;
  let cursor = 0;
  for (const [start, end] of spans) {
    const from = Math.max(start, cursor);
    if (end > from) {
      covered += end - from;
      cursor = end;
    }
  }
  return Math.min(1, covered / durationMs);
}

/** 按开始时间排序并裁到 [0, durationMs]；乱序/越界字幕轨也能安全消费。 */
export function normalizeCues(cues, durationMs = 0) {
  return (cues ?? [])
    .filter((cue) => Number.isFinite(Number(cue?.startMs)) && Number.isFinite(Number(cue?.endMs)))
    .map((cue) => {
      const start = Math.max(0, Number(cue.startMs));
      const end = durationMs > 0 ? Math.min(durationMs, Number(cue.endMs)) : Number(cue.endMs);
      return { ...cue, startMs: start, endMs: Math.max(start, end) };
    })
    .sort((a, b) => a.startMs - b.startMs);
}
