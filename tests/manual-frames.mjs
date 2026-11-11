/**
 * 真实抽帧验收（会联网、会写缓存目录）。
 *
 *   node tests/manual-frames.mjs BV1GJ411x7h7                 # auto：优先 ffmpeg
 *   node tests/manual-frames.mjs BV1GJ411x7h7 ffmpeg 10000 60000
 *   node tests/manual-frames.mjs BV1GJ411x7h7 storyboard
 *
 * 期望：
 * - ffmpeg 可用 → source=ffmpeg, maxErrorMs≈100，帧图落盘
 * - 没有 ffmpeg → auto 自动降级 storyboard，并给出真实 maxErrorMs（不是写死的 ±1s）
 */
import { currentJar } from '../lib/bili/auth.mjs';
import { getVideo } from '../lib/bili/api.mjs';
import { getPlayUrls } from '../lib/bili/playurl.mjs';
import { buildInspection } from '../lib/media/inspect.mjs';
import { resolveToolchain } from '../lib/media/ffmpeg.mjs';

const [bvid = 'BV1GJ411x7h7', source = 'auto', ...rest] = process.argv.slice(2);
const timestamps = (rest.length ? rest : ['10000', '60000']).map((value) => Number(value)).filter(Number.isFinite);

const toolchain = await resolveToolchain().catch((error) => ({ error }));
console.log('toolchain:', toolchain.error ? `MISSING(${toolchain.error.code})` : toolchain.ffmpeg);
if (!toolchain.error) console.log('ca       :', toolchain.caFile ?? '(未设置，非 Windows 可忽略)');

// 用真实登录态：未登录只有 480P，和宿主里的行为对不上。
const { jar, credentials } = await currentJar();
console.log('login    :', credentials?.cookies?.SESSDATA ? '已登录（可用高清档）' : '未登录（多半只有 480P）');
const video = await getVideo(bvid, { jar });
const cid = video.pages[0].cid;
console.log('video    :', video.title.slice(0, 30), `${video.duration}s`, 'cid', cid);

try {
  const play = await getPlayUrls({ bvid, cid, jar });
  console.log('playurl  :', play.format, play.quality.label, 'accept', play.acceptQuality.slice(0, 5).join('/'));
} catch (error) {
  console.log('playurl  : FAIL', error.code ?? '', error.message);
}

const result = await buildInspection({ video, cid, timestampsMs: timestamps, source, jar });
const image = result.images?.[0];
if (!image) throw new Error(`没有返回图片：${JSON.stringify(result.fallbackReason ?? null)}`);
console.log('frames   :', image.source, image.accuracy, 'maxErrorMs', image.maxErrorMs, 'count', result.frames.length);
console.log('detail   :', result.frames.map((frame) => `${frame.requestedMs}->${frame.actualMs}${frame.reused ? '(reused)' : ''}`).join(' '));
console.log('image    :', image.buffer?.byteLength ?? '?', 'bytes ->', image.path ?? '(inline)');
if (result.fallbackReason) console.log('fallback :', result.fallbackReason.code, result.fallbackReason.message);

if (source === 'ffmpeg' && image.source !== 'ffmpeg') {
  console.error('期望 ffmpeg 抽帧，实际降级到了', image.source);
  process.exitCode = 1;
}
