/**
 * 真实写操作 E2E（手动运行，不进 npm test）。
 *
 * 默认 dry-run：只读状态 + 生成 preview，不发写请求。
 * `--apply` 才执行真实写入；每项写完立即回读，并在 finally 里清理。
 *
 * 覆盖：稍后观看、收藏、评论、动态（图文）、私信（单条）。
 * 不覆盖：私信第二条 21047（需要未回复/未关注账号，单独验证）。
 *
 * 用法：
 *   node tests/manual-op-e2e.mjs
 *   node tests/manual-op-e2e.mjs --apply
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { currentJar } from '../lib/bili/auth.mjs';
import { getCurrentUser, getVideo } from '../lib/bili/api.mjs';
import { listComments } from '../lib/bili/comments.mjs';
import {
  getFavoriteState,
  getWatchLaterState,
} from '../lib/bili/state.mjs';
import {
  listFavoriteFolders,
  listWatchLater,
  setFavorite,
  setWatchLater,
} from '../lib/bili/collections.mjs';
import { guardedWrite } from '../lib/bili/write-guard.mjs';
import { commentSend, messageSend } from '../lib/bili/send.mjs';
import { dynamicPublish } from '../lib/bili/publish.mjs';
import { deleteComment, deleteDynamic } from '../lib/bili/manage.mjs';
import { getDynamicDetail } from '../lib/bili/dynamics.mjs';
import { listMessages } from '../lib/bili/messages.mjs';

const apply = process.argv.includes('--apply');
const arg = (name, fallback) => {
  const prefix = `--${name}=`;
  const hit = process.argv.find((value) => value.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
};
const WATCH_BVID = arg('watch-bvid', 'BV1GJ411x7h7');
const FAV_FOLDER = arg('folder', '3936040233');
const COMMENT_BVID = arg('comment-bvid', 'BV1KDNA6eEgr');
// 不内置任何真实用户 mid：私信只发给显式 --dm-mid 指定的测试账号。
const DM_MID = arg('dm-mid', '');
const COMMENT_TEXT = 'BiliBridge 端到端验收测试评论，稍后删除。';
const DYNAMIC_TEXT = 'BiliBridge 端到端验收测试动态，稍后删除。';
const DM_TEXT = 'BiliBridge 私信读写验收测试，请忽略。';

const report = { mode: apply ? 'apply' : 'dry-run', steps: [], cleanup: [] };
const track = (name, value) => { report.steps.push({ name, ...value }); };
const cleanup = [];

function shortError(error) {
  return {
    code: error?.code ?? 'ERROR',
    ...(Number.isInteger(error?.biliCode) ? { biliCode: error.biliCode } : {}),
    ...(error?.message ? { message: String(error.message).slice(0, 300) } : {}),
    ...(error?.hint ? { hint: error.hint } : {}),
    ...(error?.retryable === true ? { retryable: true } : {}),
  };
}

async function main() {
  const { jar } = await currentJar();
  const me = await getCurrentUser({ jar });
  if (!me) throw Object.assign(new Error('未登录，无法执行真实 E2E'), { code: 'AUTH_REQUIRED' });
  report.account = { mid: me.mid, uname: me.uname };

  // ── 稍后观看 ──────────────────────────────────────────────
  const watchVideo = await getVideo(WATCH_BVID, { jar });
  const watchBefore = await getWatchLaterState({ jar, aid: watchVideo.aid });
  if (watchBefore.state === true) throw new Error(`${WATCH_BVID} 已经在稍后观看里，换个视频再测`);
  track('watchLater.pre', { state: watchBefore.state, count: (await listWatchLater({ jar })).count });
  if (apply) {
    const added = await guardedWrite({
      intent: 'apply', desired: true, target: { bvid: WATCH_BVID, aid: watchVideo.aid },
      read: () => getWatchLaterState({ jar, aid: watchVideo.aid }),
      write: () => setWatchLater({ jar, aid: watchVideo.aid, added: true }),
    });
    track('watchLater.add', { applied: added.applied, verified: added.verified, after: added.after });
    cleanup.push(async () => {
      const removed = await guardedWrite({
        intent: 'apply', desired: false, target: { bvid: WATCH_BVID, aid: watchVideo.aid },
        read: () => getWatchLaterState({ jar, aid: watchVideo.aid }),
        write: () => setWatchLater({ jar, aid: watchVideo.aid, added: false }),
      });
      report.cleanup.push({ name: 'watchLater.remove', verified: removed.verified });
    });
  } else {
    const dry = await guardedWrite({
      desired: true, target: { bvid: WATCH_BVID, aid: watchVideo.aid },
      read: () => getWatchLaterState({ jar, aid: watchVideo.aid }),
      write: async () => { throw new Error('dry-run must not write'); },
    });
    track('watchLater.preview', { dryRun: dry.dryRun, wouldApply: dry.wouldApply, current: dry.current?.state });
  }

  // ── 收藏 ──────────────────────────────────────────────────
  const favVideo = await getVideo(WATCH_BVID, { jar });
  const folders = await listFavoriteFolders({ jar });
  if (!folders.items.some((folder) => String(folder.mediaId) === String(FAV_FOLDER))) {
    throw new Error(`找不到收藏夹 ${FAV_FOLDER}`);
  }
  const favBefore = await getFavoriteState({ jar, aid: favVideo.aid, mediaId: FAV_FOLDER });
  if (favBefore.state === true) throw new Error(`${WATCH_BVID} 已经在该收藏夹里，换个视频再测`);
  track('favorite.pre', { state: favBefore.state, folder: FAV_FOLDER });
  if (apply) {
    const added = await guardedWrite({
      intent: 'apply', desired: true,
      target: { bvid: WATCH_BVID, aid: favVideo.aid, mediaId: FAV_FOLDER },
      read: () => getFavoriteState({ jar, aid: favVideo.aid, mediaId: FAV_FOLDER }),
      write: () => setFavorite({ jar, aid: favVideo.aid, mediaId: FAV_FOLDER, added: true }),
    });
    track('favorite.add', { applied: added.applied, verified: added.verified, after: added.after });
    cleanup.push(async () => {
      const removed = await guardedWrite({
        intent: 'apply', desired: false,
        target: { bvid: WATCH_BVID, aid: favVideo.aid, mediaId: FAV_FOLDER },
        read: () => getFavoriteState({ jar, aid: favVideo.aid, mediaId: FAV_FOLDER }),
        write: () => setFavorite({ jar, aid: favVideo.aid, mediaId: FAV_FOLDER, added: false }),
      });
      report.cleanup.push({ name: 'favorite.remove', verified: removed.verified });
    });
  } else {
    const dry = await guardedWrite({
      desired: true, target: { bvid: WATCH_BVID, aid: favVideo.aid, mediaId: FAV_FOLDER },
      read: () => getFavoriteState({ jar, aid: favVideo.aid, mediaId: FAV_FOLDER }),
      write: async () => { throw new Error('dry-run must not write'); },
    });
    track('favorite.preview', { dryRun: dry.dryRun, wouldApply: dry.wouldApply, current: dry.current?.state });
  }

  // ── 评论 ──────────────────────────────────────────────────
  const commentVideo = await getVideo(COMMENT_BVID, { jar });
  // 评论关闭时提前失败；不要到 apply 才撞 12002。
  await listComments({ bvid: COMMENT_BVID, sort: 'new', pageSize: 1, includeReplies: false, jar });
  track('comment.target', { bvid: COMMENT_BVID, aid: commentVideo.aid });
  if (apply) {
    const preview = await commentSend({ jar, bvid: COMMENT_BVID, text: COMMENT_TEXT });
    const sent = await commentSend({ jar, bvid: COMMENT_BVID, text: COMMENT_TEXT, intent: 'apply', previewToken: preview.previewToken });
    if (sent.status !== 'SENT') throw Object.assign(new Error(`评论发送失败：${sent.status}`), sent);
    const rpid = sent.result?.rpid;
    track('comment.send', { status: sent.status, rpid, operationId: sent.operationId });
    cleanup.push(async () => {
      const deletePreview = await deleteComment({ jar, bvid: COMMENT_BVID, rpid });
      const deleted = await deleteComment({ jar, bvid: COMMENT_BVID, rpid, intent: 'apply', previewToken: deletePreview.previewToken });
      const after = await listComments({ bvid: COMMENT_BVID, sort: 'new', pageSize: 20, includeReplies: false, jar });
      const present = after.items.some((item) => String(item.rpid) === String(rpid));
      report.cleanup.push({ name: 'comment.delete', status: deleted.status, stillPresent: present });
    });
  } else {
    const preview = await commentSend({ jar, bvid: COMMENT_BVID, text: COMMENT_TEXT });
    track('comment.preview', { status: preview.status, expiresInSeconds: preview.expiresInSeconds });
  }

  // ── 动态（图文） ─────────────────────────────────────────
  const dir = await mkdtemp(join(tmpdir(), 'bili-e2e-'));
  const image = join(dir, 'test.png');
  await sharp({ create: { width: 256, height: 256, channels: 3, background: '#c0392b' } }).png().toFile(image);
  try {
    if (apply) {
      const preview = await dynamicPublish({ jar, text: DYNAMIC_TEXT, images: [image] });
      const sent = await dynamicPublish({ jar, text: DYNAMIC_TEXT, images: [image], intent: 'apply', previewToken: preview.previewToken });
      if (sent.status !== 'SENT') throw Object.assign(new Error(`动态发布失败：${sent.status}`), sent);
      const dynamicId = sent.result?.dynamicId;
      const detail = await getDynamicDetail({ dynamicId, jar });
      track('dynamic.send', { status: sent.status, dynamicId, pics: detail.pics?.length ?? 0 });
      cleanup.push(async () => {
        const deletePreview = await deleteDynamic({ jar, dynamicId });
        const deleted = await deleteDynamic({ jar, dynamicId, intent: 'apply', previewToken: deletePreview.previewToken });
        let gone = false;
        try { await getDynamicDetail({ dynamicId, jar }); }
        catch (error) { gone = ['NOT_FOUND', 'CONTENT_UNAVAILABLE'].includes(error?.code) || error?.biliCode === 4101152; }
        report.cleanup.push({ name: 'dynamic.delete', status: deleted.status, gone });
      });
    } else {
      const preview = await dynamicPublish({ jar, text: DYNAMIC_TEXT, images: [image] });
      track('dynamic.preview', { status: preview.status, images: preview.images?.length ?? 0 });
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }

  // ── 私信（单条） ─────────────────────────────────────────
  if (!DM_MID) {
    track('message.skip', { reason: '需要显式 --dm-mid=<测试账号> 才执行私信验收' });
  } else if (apply) {
    const preview = await messageSend({ jar, receiverMid: DM_MID, text: DM_TEXT });
    const sent = await messageSend({ jar, receiverMid: DM_MID, text: DM_TEXT, intent: 'apply', previewToken: preview.previewToken });
    track('message.send', { status: sent.status, ...(sent.error ? shortError(sent) : {}), operationId: sent.operationId });
    if (sent.status === 'SENT') {
      const read = await listMessages({ jar, talkerId: DM_MID, size: 10 });
      const found = read.items.some((item) => item.direction === 'out' && item.text === DM_TEXT);
      track('message.readback', { found, count: read.items.length });
      // 同一正文再 apply：应命中发送账本，不产生第二条消息。
      const duplicate = await messageSend({ jar, receiverMid: DM_MID, text: DM_TEXT, intent: 'apply', previewToken: preview.previewToken });
      track('message.duplicateGuard', { status: duplicate.status, operationId: duplicate.operationId });
    }
  } else {
    const preview = await messageSend({ jar, receiverMid: DM_MID, text: DM_TEXT });
    track('message.preview', { status: preview.status, receiverMid: DM_MID });
  }
}

let failed;
try {
  await main();
} catch (error) {
  failed = error;
  report.error = shortError(error);
}

// 逆序清理，单项失败不影响其它清理。
if (apply) {
  for (const task of cleanup.reverse()) {
    try { await task(); }
    catch (error) { report.cleanup.push({ name: 'cleanup-failed', ...shortError(error) }); }
  }
}

console.log(JSON.stringify(report, null, 2));
if (failed) {
  if (failed.status) console.error(`FAILED: ${failed.status}`);
  process.exitCode = 1;
}
