/**
 * M3 最小 ASR CER 探针：同一视频窗口，分别用指定插件根目录执行 bilibili_transcribe，
 * 以平台字幕在窗口内的文本为参考，计算字符错误率（CER）。
 *
 *   BILI_DATA_DIR=/tmp/... node tests/eval/asr-cer.mjs \
 *     --root /path/to/plugin --bvid BV1KDNA6eEgr --start 60 --duration 60
 *
 * 参考字幕优先用平台轨道（AI 轨道会标注 ai=true，报告里必须注明）。
 * 不输出 Cookie/Token；只输出 CER、条数和 80 字样例。
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  root: { type: 'string' },
  bvid: { type: 'string' },
  start: { type: 'string', default: '0' },
  duration: { type: 'string', default: '60' },
  'min-cues': { type: 'string', default: '5' }, 'min-ref-chars': { type: 'string', default: '100' },
  language: { type: 'string', default: 'zh' },
} });
assert.ok(values.root, '需要 --root');
assert.match(values.bvid ?? '', /^BV[0-9A-Za-z]{10}$/);
const start = Number(values.start);
const duration = Number(values.duration);
assert.ok(Number.isFinite(start) && start >= 0);
assert.ok(Number.isFinite(duration) && duration > 0 && duration <= 300);

const root = values.root;
const importRoot = (path) => import(pathToFileURL(join(root, path)).href);
const { currentJar } = await importRoot('lib/bili/auth.mjs');
const { getVideo } = await importRoot('lib/bili/api.mjs');
const { getSubtitles } = await importRoot('lib/media/subtitles.mjs');
const { registerTranscribeTools } = await importRoot('lib/tools/transcribe.mjs');

const normalize = (text) => String(text ?? '')
  .normalize('NFKC')
  .toLowerCase()
  .replace(/[\s\p{P}\p{S}]+/gu, '');

function levenshtein(a, b) {
  const left = [...a];
  const right = [...b];
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[right.length];
}

try {
  const { jar } = await currentJar();
  const video = await getVideo(values.bvid, { jar });
  const page = video.pages[0];
  // 分页直到覆盖窗口，避免只拿到前 800 条就评分错误文本。
  let subtitle; let cues = []; let cursor;
  do {
    subtitle = await getSubtitles({ bvid: values.bvid, aid: video.aid, cid: page.cid, durationMs: video.duration * 1000, jar, subtitleCursor: cursor });
    cues.push(...(subtitle.cues ?? []));
    cursor = subtitle.nextCursor;
  } while (cursor && (cues.at(-1)?.endMs ?? 0) < (start + duration) * 1000);
  assert.ok(/zh/i.test(subtitle.track?.lan ?? ''), `参考字幕不是中文轨：${subtitle.track?.lan}`);
  const windowCues = cues.filter((cue) => cue.endMs > start * 1000 && cue.startMs < (start + duration) * 1000);
  const reference = normalize(windowCues.map((cue) => cue.text).join(' '));
  const minCues = Number(values['min-cues']);
  const minRefChars = Number(values['min-ref-chars']);
  if (windowCues.length < minCues || [...reference].length < minRefChars) {
    console.log(JSON.stringify({ root: values.root, bvid: values.bvid, start, duration, skipped: 'sparse_reference',
      cues: windowCues.length, referenceChars: [...reference].length, minCues, minRefChars }));
    process.exit(0);
  }
  assert.ok([...reference].length, '窗口内没有平台字幕，不能作为 CER 参考');

  const tools = new Map();
  registerTranscribeTools({ tools: { register(tool) { tools.set(tool.name, tool); } } });
  const tool = tools.get('bilibili_transcribe');
  const started = Date.now();
  const result = await tool.execute({ bvid: values.bvid, startSeconds: start, durationSeconds: duration, language: values.language }, { signal: AbortSignal.timeout(600_000) });
  const elapsedMs = Date.now() - started;
  const segments = result.data.segments ?? [];
  const hypothesis = normalize(segments.map((segment) => segment.text).join(' '));
  const distance = levenshtein(reference, hypothesis);
  // 统一按 Unicode 码点计数；参考字符数也用码点，避免 UTF-16 代理对。
  const referenceChars = [...reference].length;
  const cer = referenceChars ? distance / referenceChars : null;

  console.log(JSON.stringify({
    root,
    bvid: values.bvid,
    title: video.title.slice(0, 60),
    start,
    duration,
    subtitle: {
      track: subtitle.track ? { lan: subtitle.track.lan, isAi: subtitle.track.isAi } : null,
      cues: windowCues.length,
      referenceChars: [...reference].length,
    },
    asr: {
      segments: segments.length,
      firstSegments: segments.slice(0, 2).map((segment) => ({ atMs: segment.atMs, text: String(segment.text).slice(0, 30) })),
      lastSegmentAtMs: segments.at(-1)?.endMs ?? null,
      lowConfidence: segments.filter((segment) => segment.lowConfidence === true).length,
      hypothesisChars: [...hypothesis].length,
      elapsedMs,
      language: result.data.language,
      confidence: result.data.confidence,
    },
    cer: Number(cer.toFixed(4)),
    editDistance: distance,
    referenceSample: reference.slice(0, 80),
    hypothesisSample: hypothesis.slice(0, 80),
  }));
} catch (error) {
  console.log(JSON.stringify({ root, bvid: values.bvid, start, duration, error: error.code ?? 'ERROR', message: String(error.message).slice(0, 200) }));
  process.exitCode = 1;
}
