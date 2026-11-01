/**
 * 开发辅助：把一条视频的前 N 秒音频抽成 wav，方便单独调 ASR worker。
 *
 *   node tests/dump-audio.mjs BV1KDNA6eEgr 20 D:\tools\asr\test.wav
 */
import { currentJar } from '../lib/bili/auth.mjs';
import { getVideo } from '../lib/bili/api.mjs';
import { getPlayUrls } from '../lib/bili/playurl.mjs';
import { extractAudio } from '../lib/media/ffmpeg.mjs';
import { videoReferer } from '../lib/media/frames.mjs';

const [bvid = 'BV1KDNA6eEgr', seconds = '20', outFile = 'audio.wav'] = process.argv.slice(2);
const { jar } = await currentJar();
const video = await getVideo(bvid, { jar });
const play = await getPlayUrls({ bvid, cid: video.pages[0].cid, jar, referer: videoReferer(bvid) });
if (!play.audioUrl) throw new Error('没有独立音频流');
await extractAudio({
  url: play.audioUrl,
  outFile,
  referer: videoReferer(bvid),
  maxSeconds: Number(seconds) || 20,
});
console.log('wrote', outFile, 'quality', play.quality?.label);
