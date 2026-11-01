/**
 * 字幕字段来源验收：platform / asr / ocr / auto 各跑一遍，打印状态与尝试记录。
 *
 *   node tests/manual-subtitle-source.mjs BV1pTx76QE8J asr 60
 *   node tests/manual-subtitle-source.mjs BV1KDNA6eEgr platform
 */
import { currentJar } from '../lib/bili/auth.mjs';
import { buildEvidence } from '../lib/media/evidence.mjs';

const [bvid = 'BV1pTx76QE8J', source = 'auto', secondsArg = '60'] = process.argv.slice(2);
const asrMaxSeconds = Math.max(10, Math.min(900, Number(secondsArg) || 60));

const { jar } = await currentJar();
const started = Date.now();
const { bundle } = await buildEvidence({
  bvid,
  page: 1,
  subtitleSource: source,
  jar,
  limits: { asrMaxSeconds },
});

console.log('video          :', bundle.video.title.slice(0, 40), `${Math.round(bundle.video.durationMs / 1000)}s`);
console.log('subtitleSource :', bundle.subtitleSource);
console.log('subtitleStatus :', bundle.subtitleStatus);
console.log('transcript     :', bundle.transcript.length, '条');
console.log('attempts       :', JSON.stringify(bundle.attempts, null, 2));
if (bundle.asr?.status && bundle.asr.status !== 'skipped') {
  console.log('asr            :', bundle.asr.status, bundle.asr.model ?? '', `audio=${bundle.asr.audioSeconds}s`, `verdict=${bundle.asr.verdict?.level}`);
}
console.log('wall           :', ((Date.now() - started) / 1000).toFixed(1), 's');
for (const entry of bundle.transcript.slice(0, 6)) {
  const t = Math.round(entry.startMs / 1000);
  console.log(`  ${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}  [${entry.origin}] ${entry.text.slice(0, 60)}`);
}
