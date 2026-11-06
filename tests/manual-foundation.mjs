/** Read-only integration smoke; never posts comments, messages or images. */
import { currentJar } from '../lib/bili/auth.mjs';
import { discover } from '../lib/bili/discover.mjs';
import { notifications } from '../lib/bili/notifications.mjs';
import { listFavoriteFolders, listFavoriteItems } from '../lib/bili/collections.mjs';
import { listUserVideos } from '../lib/bili/api.mjs';
import { userProfile } from '../lib/bili/user.mjs';
import { search } from '../lib/bili/search.mjs';
import { buildEvidence } from '../lib/media/evidence.mjs';
import { collect } from '../lib/bili/collect.mjs';
import { apply } from '../lib/index.js';

const tools = []; apply({ on() {}, tools: { register(d) { tools.push(d); } } });
console.log(JSON.stringify({ tools: tools.length, schemaBytes: Buffer.byteLength(JSON.stringify(tools.map(({ name, description, parameters }) => ({ name, description, parameters })))) }));
const { jar } = await currentJar();
const mode = process.argv[2] ?? 'public';
const jobs = mode === 'public' ? [
  ...['popular', 'hotwords', 'weekly', 'rank'].map(scope => [scope, () => discover({ scope, pageSize: 2, jar })]),
  ['weekly-one', () => discover({ scope: 'weekly', week: 1, pageSize: 2, jar })],
  ['search', () => search({ keyword: '编程', duration: 1, pageSize: 2, jar })],
] : mode === 'account' ? [
  ...['unread', 'replies', 'at', 'likes', 'messages'].map(scope => [scope, () => notifications({ scope, pageSize: 2, jar })]),
  ['folders', () => listFavoriteFolders({ jar })],
  ['user-videos', () => listUserVideos(jar.get('DedeUserID'), { keyword: '', order: 'stow', ps: 2, jar })],
  ['profile', () => userProfile({ mid: jar.get('DedeUserID'), jar })],
] : mode === 'text' ? [
  ['subtitle-pagination', async () => {
    const options = { bvid: 'BV1VZWc6dECG', jar, include: { frames: false, comments: false, danmaku: false } };
    const first = await buildEvidence(options);
    const second = first.bundle.subtitles.nextCursor ? await buildEvidence({ ...options, subtitleCursor: first.bundle.subtitles.nextCursor }) : null;
    return { firstCues: first.bundle.transcript.length, next: Boolean(first.bundle.subtitles.nextCursor), secondCues: second?.bundle.transcript.length, images: second?.images.length, sameCoverage: second?.bundle.subtitles.coverage === first.bundle.subtitles.coverage };
  }],
  ['danmaku-window', () => buildEvidence({ bvid: 'BV1GJ411x7h7', jar, include: { frames: false, subtitles: false, comments: false }, danmakuWindow: { startSeconds: 0, endSeconds: 30 } }).then(r => r.bundle.danmaku)],
  ['collect', () => collect({ keyword: '编程', maxVideos: 1, commentsPerVideo: 2, subtitles: true, jar })],
] : [];
for (const [name, run] of jobs) {
  try {
    const data = await run();
    console.log(JSON.stringify({ name, ok: true, count: data.items?.length ?? data.results?.length ?? null, next: Boolean(data.nextCursor),
      keys: Object.keys(data), sample: mode === 'text' && name === 'subtitle-pagination' ? data : undefined,
      partial: data.partial, errors: data.results?.map(r => r.errors), statsStatus: data.statsStatus,
      folders: name === 'folders' ? data.items.map(f => ({ id: f.mediaId, title: f.title, count: f.mediaCount })).slice(0, 3) : undefined,
    }));
  } catch (e) { console.log(JSON.stringify({ name, ok: false, code: e.code, message: e.message })); process.exitCode = 1; }
}
