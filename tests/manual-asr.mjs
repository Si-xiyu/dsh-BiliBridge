/**
 * ASR 质量评估（会联网、会抽音频、会调用 Windows SAPI）。
 *
 *   node tests/manual-asr.mjs BV1KDNA6eEgr 90
 *
 * 只抽前 N 秒音频，避免一次跑整片；输出识别到的句子与起始时间。
 */
import { execFile } from 'node:child_process';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { currentJar } from '../lib/bili/auth.mjs';
import { getVideo } from '../lib/bili/api.mjs';
import { getPlayUrls } from '../lib/bili/playurl.mjs';
import { extractAudio } from '../lib/media/ffmpeg.mjs';
import { videoReferer } from '../lib/media/frames.mjs';

const execFileAsync = promisify(execFile);
const [bvid = 'BV1KDNA6eEgr', secondsArg = '90'] = process.argv.slice(2);
const maxSeconds = Math.max(10, Math.min(600, Number(secondsArg) || 90));

const { jar, credentials } = await currentJar();
console.log('login  :', credentials?.cookies?.SESSDATA ? '已登录' : '未登录');

const video = await getVideo(bvid, { jar });
const cid = video.pages[0].cid;
const play = await getPlayUrls({ bvid, cid, jar, referer: videoReferer(bvid) });
console.log('video  :', video.title.slice(0, 36), `${video.duration}s`, 'quality', play.quality?.label);
if (!play.audioUrl) throw new Error('这个视频没有独立的音频流（durl 老格式），暂时不支持');

const dir = join(tmpdir(), `bili-asr-${bvid}-${Date.now()}`);
await mkdir(dir, { recursive: true });
const wav = join(dir, 'audio.wav');
const out = join(dir, 'asr.json');

try {
  console.log('audio  : 抽', maxSeconds, '秒到', wav);
  await extractAudio({ url: play.audioUrl, outFile: wav, referer: videoReferer(bvid), maxSeconds, timeoutMs: 300_000 });
  const { size } = await import('node:fs').then((fs) => fs.promises.stat(wav));
  console.log('audio  :', (size / 1024 / 1024).toFixed(1), 'MB');

  await execFileAsync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    'lib/media/sapi-asr.ps1',
    '-Wave',
    wav,
    '-Out',
    out,
  ]);
  const parsed = JSON.parse((await readFile(out, 'utf8')).replace(/^\uFEFF/, ''));
  console.log('asr    :', parsed.count, 'segments, culture', parsed.culture);
  for (const item of parsed.results.slice(0, 12)) {
    const mm = String(Math.floor(item.startSec / 60)).padStart(2, '0');
    const ss = String(Math.round(item.startSec % 60)).padStart(2, '0');
    console.log(`  ${mm}:${ss}  ${item.text}`);
  }
} finally {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}
