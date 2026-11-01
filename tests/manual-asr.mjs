/**
 * ASR 真实验收（会联网、抽音频、首次会下载模型）。
 *
 *   node tests/manual-asr.mjs BV1KDNA6eEgr 90
 *   node tests/manual-asr.mjs BV1KDNA6eEgr 90 en
 *
 * 输出：运行时、模型、耗时、置信度、带时间戳的段落。
 */
import { currentJar } from '../lib/bili/auth.mjs';
import { getVideo } from '../lib/bili/api.mjs';
import { getPlayUrls } from '../lib/bili/playurl.mjs';
import { judgeTranscript, segmentsToEntries, transcribeUrl } from '../lib/media/asr.mjs';
import { videoReferer } from '../lib/media/frames.mjs';

const [bvid = 'BV1KDNA6eEgr', secondsArg = '90', langArg] = process.argv.slice(2);
const maxSeconds = Math.max(10, Math.min(1800, Number(secondsArg) || 90));
const language = langArg || 'zh';

const { jar, credentials } = await currentJar();
console.log('login  :', credentials?.cookies?.SESSDATA ? '已登录' : '未登录');

const video = await getVideo(bvid, { jar });
const cid = video.pages[0].cid;
const play = await getPlayUrls({ bvid, cid, jar, referer: videoReferer(bvid) });
console.log('video  :', video.title.slice(0, 36), `${video.duration}s`, 'quality', play.quality?.label);
if (!play.audioUrl) {
  console.error('这个视频没有独立音频流，无法转写');
  process.exit(1);
}

const started = Date.now();
const payload = await transcribeUrl({
  audioUrl: play.audioUrl,
  referer: videoReferer(bvid),
  maxSeconds,
  language,
  timeoutMs: 1_800_000,
});

const entries = segmentsToEntries(payload);
const verdict = judgeTranscript(payload);
console.log('asr    :', payload.engine, payload.model, `lang=${payload.language}`, `wall=${((Date.now() - started) / 1000).toFixed(1)}s`);
console.log('audio  :', payload.duration_sec, 's →', entries.length, '段', `avgLogprob=${payload.confidence?.avg_logprob}`, `lowRatio=${payload.confidence?.low_confidence_ratio}`);
console.log('verdict:', verdict.level, verdict.usable ? '(可用)' : `(不可用：${verdict.reason})`);
for (const entry of entries.slice(0, 14)) {
  const total = Math.round(entry.atMs / 1000);
  console.log(`  ${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}  ${entry.text}`);
}
if (entries.length > 14) console.log(`  … 共 ${entries.length} 段`);
