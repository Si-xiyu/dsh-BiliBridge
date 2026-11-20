/**
 * M3 ASR CER 对照（直连 transcribeUrl）：两边使用相同的低码率音轨和窗口，
 * 只让 A1/A3/A5 等解码/提示差异生效，避免 P2 音轨选择干扰。
 *
 *   BILI_DATA_DIR=/tmp/... node tests/eval/asr-cer-direct.mjs \
 *     --root /path/to/plugin --bvid BV1KDNA6eEgr --start 60 --duration 60
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  root: { type: 'string' }, bvid: { type: 'string' },
  start: { type: 'string', default: '0' }, duration: { type: 'string', default: '60' },
  'min-cues': { type: 'string', default: '5' }, 'min-ref-chars': { type: 'string', default: '100' },
  hints: { type: 'string', default: 'both' }, wav: { type: 'string' },
} });
assert.ok(values.root && /^BV[0-9A-Za-z]{10}$/.test(values.bvid ?? ''));
const start = Number(values.start);
const duration = Number(values.duration);
assert.ok(Number.isFinite(start) && start >= 0);
assert.ok(Number.isFinite(duration) && duration > 0 && duration <= 300);

const root = values.root;
const importRoot = (path) => import(pathToFileURL(join(root, path)).href);
const { currentJar } = await importRoot('lib/bili/auth.mjs');
const { getVideo } = await importRoot('lib/bili/api.mjs');
const { getSubtitles } = await importRoot('lib/media/subtitles.mjs');
const { request } = await importRoot('lib/bili/http.mjs');
const { getWbiKeys, signQuery } = await importRoot('lib/bili/wbi.mjs');
const { segmentsToEntries, transcribeFile, transcribeUrl } = await importRoot('lib/media/asr.mjs');

const normalize = (text) => String(text ?? '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
function levenshtein(a, b) {
  const left = [...a]; const right = [...b];
  let previous = Array.from({ length: right.length + 1 }, (_, i) => i);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1));
    previous = current;
  }
  return previous[right.length];
}
const absolute = (url) => (url ? (url.startsWith('//') ? `https:${url}` : url) : null);

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
  assert.ok([...reference].length, '窗口内没有平台字幕');

  // 固定用最低码率音轨，避免不同版本选到不同音轨导致窗口错位。
  const keys = await getWbiKeys(jar);
  const query = signQuery({ bvid: values.bvid, cid: page.cid, qn: 80, fnval: 4048, fourk: 1, platform: 'pc' }, keys.imgKey, keys.subKey);
  const data = await request(`https://api.bilibili.com/x/player/wbi/playurl?${query}`, { jar, referer: `https://www.bilibili.com/video/${values.bvid}` });
  const audios = [...(data.dash?.audio ?? [])].sort((a, b) => Number(b.bandwidth) - Number(a.bandwidth));
  const audioUrl = absolute(audios.at(-1)?.baseUrl ?? audios.at(-1)?.base_url);
  assert.ok(audioUrl, '没有可用音轨');

  let hints = {};
  const mode = values.hints;
  if (!['both', 'prompt', 'hotwords', 'none'].includes(mode)) throw new Error(`未知 --hints：${mode}`);
  if (mode !== 'none') {
    let terms;
    try { terms = await importRoot('lib/media/terms.mjs'); }
    catch { throw new Error('请求了提示但该 root 没有 terms.mjs；baseline 请用 --hints none'); }
    hints = {
      ...(mode === 'both' || mode === 'prompt' ? { prompt: terms.asrPrompt(video, 'zh') } : {}),
      ...(mode === 'both' || mode === 'hotwords' ? { hotwords: terms.domainTerms(video, { limit: 20 }).join(', ') } : {}),
    };
  }
  const appliedHints = Object.keys(hints).sort();

  if (values.wav) {
    const info = await stat(values.wav);
    // prepare-asr-window 生成 16k/mono/s16le；头约 44 字节。
    const wavSeconds = Math.max(0, info.size - 44) / 32000;
    if (Math.abs(wavSeconds - duration) > 2) {
      throw new Error(`--wav 时长 ${wavSeconds.toFixed(1)}s 与 --duration ${duration}s 不匹配`);
    }
  }

  const started = Date.now();
  const payload = values.wav
    ? await transcribeFile({ wavPath: values.wav, offsetSeconds: start, model: 'small', language: 'zh', ...hints, signal: AbortSignal.timeout(600_000) })
    : await transcribeUrl({ audioUrl, referer: `https://www.bilibili.com/video/${values.bvid}`, startSeconds: start, durationSeconds: duration, model: 'small', language: 'zh', ...hints, signal: AbortSignal.timeout(600_000) });
  const elapsedMs = Date.now() - started;
  const segments = segmentsToEntries(payload);
  const hypothesis = normalize(segments.map((segment) => segment.text).join(' '));
  const distance = levenshtein(reference, hypothesis);
  console.log(JSON.stringify({
    root, bvid: values.bvid, start, duration, hints: values.hints, appliedHints, wav: Boolean(values.wav),
    subtitle: { lan: subtitle.track?.lan ?? null, isAi: subtitle.track?.isAi ?? null, cues: windowCues.length, referenceChars: [...reference].length },
    asr: { segments: segments.length, firstSegments: segments.slice(0, 2).map((s) => ({ atMs: s.atMs, text: String(s.text).slice(0, 30) })), lastSegmentAtMs: segments.at(-1)?.endMs ?? null,
      lowConfidence: segments.filter((s) => s.lowConfidence === true).length, hypothesisChars: [...hypothesis].length, elapsedMs, language: payload.language, confidence: payload.confidence },
    cer: Number((distance / [...reference].length).toFixed(4)), editDistance: distance,
  }));
} catch (error) {
  console.log(JSON.stringify({ root, bvid: values.bvid, start, duration, error: error.code ?? 'ERROR', message: String(error.message).slice(0, 200) }));
  process.exitCode = 1;
}
