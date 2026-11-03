/** Run only after the user approves these exact targets. Never publishes content. */
import { currentJar } from '../lib/bili/auth.mjs';
import { getVideo } from '../lib/bili/api.mjs';
import { getFavoriteState, getWatchLaterState } from '../lib/bili/state.mjs';
import { setFavorite, setWatchLater } from '../lib/bili/collections.mjs';
import { guardedWrite } from '../lib/bili/write-guard.mjs';

const bvid = 'BV1GJ411x7h7', mediaId = '3936040233';
const { jar } = await currentJar();
const video = await getVideo(bvid, { jar });
for (const kind of ['favorite', 'watch_later']) {
  const read = () => kind === 'favorite' ? getFavoriteState({ jar, aid: video.aid, mediaId }) : getWatchLaterState({ jar, aid: video.aid });
  const write = added => kind === 'favorite' ? setFavorite({ jar, aid: video.aid, mediaId, added }) : setWatchLater({ jar, aid: video.aid, added });
  const before = await read();
  console.log(JSON.stringify({ kind, bvid, mediaId: kind === 'favorite' ? mediaId : undefined, before }));
  if (process.argv[2] !== '--apply') continue;
  if (before.state !== false) throw new Error('目标初始状态不再为空；停止，请重新确认');
  try {
    const added = await guardedWrite({ intent: 'apply', desired: true, target: { bvid, mediaId }, read, write: () => write(true) });
    console.log(JSON.stringify({ kind, step: 'add', verified: added.verified }));
  } finally {
    const restored = await guardedWrite({ intent: 'apply', desired: false, target: { bvid, mediaId }, read, write: () => write(false) });
    console.log(JSON.stringify({ kind, step: 'restore', verified: restored.verified, after: restored.after }));
  }
}
