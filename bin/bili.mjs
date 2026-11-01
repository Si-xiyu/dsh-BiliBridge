#!/usr/bin/env node
/**
 * dsh-BiliBridge 开发 CLI：不经过 DSH，直接验证 B站核心。
 *
 *   node bin/bili.mjs status
 *   node bin/bili.mjs qr             生成二维码 PNG，供聊天里展示
 *   node bin/bili.mjs poll [seconds] 轮询扫码结果
 *   node bin/bili.mjs login          终端二维码 + 阻塞等待（本地开发用）
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import QRCode from 'qrcode';
import {
  currentJar,
  logout,
  qrPoll,
  qrStart,
  renderQr,
  saveLoginFromPoll,
  status,
} from '../lib/bili/auth.mjs';
import { getCurrentUser, getLatestOwnVideo, getVideo, listUserVideos } from '../lib/bili/api.mjs';
import {
  listFavoriteFolders,
  listFavoriteItems,
  listWatchLater,
  setFavorite,
  setVideoLike,
  setWatchLater,
} from '../lib/bili/collections.mjs';
import { dataDir, readJson, writeJsonAtomic } from '../lib/bili/store.mjs';

const argv = process.argv.slice(2);
const command = argv[0];
const rest = argv.slice(1);
const flags = new Set(rest.filter((a) => a.startsWith('--')));
const args = rest.filter((a) => !a.startsWith('--'));
const go = flags.has('--go');

function print(value) {
  console.log(JSON.stringify(value, null, 2));
}

function pendingPath() {
  return join(dataDir(), 'pending-login.json');
}

function usage() {
  console.log(`用法:
  status                         登录态与数据目录
  qr                             生成登录二维码 PNG（print 路径）
  poll [seconds]                 轮询扫码结果（默认 25 秒）
  login                          终端二维码 + 阻塞等待
  logout                         清除本地凭据
  me                             当前账号
  video <bvid>                   视频元数据与统计
  latest                         我最新投稿 + 播放量
  list <mid>                     用户投稿（按发布时间）
  watchlater                     稍后观看列表
  folders                        收藏夹列表
  favitems <mediaId>             收藏夹内容
  like <bvid> <0|1> [--go]       点赞/取消
  wl <bvid> <add|remove> [--go]  加/移除稍后观看
  fav <bvid> <mediaId> <add|remove> [--go]

环境变量:
  BILI_DATA_DIR   凭据目录（默认 ~/.dsh/bilibili）`);
}

/** 把 bvid 解析成 aid（写操作需要）。 */
async function resolveAid(bvid) {
  const { jar } = await currentJar();
  const video = await getVideo(bvid, { jar });
  return { jar, video };
}

async function main() {
  switch (command) {
    case undefined:
    case 'help':
    case '-h':
      return usage();

    case 'status':
      return print(await status());

    case 'qr': {
      const { url, key } = await qrStart();
      await mkdir(dataDir(), { recursive: true, mode: 0o700 });
      // 每次用唯一文件名：聊天/浏览器会按路径缓存图片，复用同名会把旧二维码显示出来。
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const png = join(dataDir(), `login-qr-${stamp}.png`);
      await QRCode.toFile(png, url, { width: 360, margin: 2, errorCorrectionLevel: 'M' });
      await writeJsonAtomic(pendingPath(), { key, createdAt: Date.now(), png }, { mode: 0o600 });
      return print({ png, expiresInSeconds: 180, hint: '把 PNG 展示给用户；扫码确认后运行 poll' });
    }

    case 'poll': {
      const pending = await readJson(pendingPath(), null);
      if (!pending?.key) return print({ status: 'none', hint: '先运行 qr 生成二维码' });
      const { jar } = await currentJar();
      const wait = Math.min(Math.max(Number(args[0] ?? 25), 3), 110);
      const deadline = Date.now() + wait * 1000;
      let last = 'waiting';
      while (Date.now() < deadline) {
        const { status: state, data } = await qrPoll(pending.key, jar);
        if (state === 'expired') {
          await writeJsonAtomic(pendingPath(), { key: null }, { mode: 0o600 });
          return print({ status: 'expired', hint: '重新运行 qr' });
        }
        if (state === 'confirmed') {
          const account = await saveLoginFromPoll(data, jar);
          await writeJsonAtomic(pendingPath(), { key: null }, { mode: 0o600 });
          return print({ status: 'confirmed', account });
        }
        last = state;
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      return print({ status: last, hint: last === 'scanned' ? '已扫码，等待手机确认' : '还没扫码' });
    }

    case 'login': {
      const { jar } = await currentJar();
      const { url, key } = await qrStart();
      console.log(await renderQr(url));
      console.log('\n请用 B站 App 扫码，并在手机上确认登录（约 3 分钟内有效）...\n');
      await new Promise((resolve, reject) => {
        const timer = setInterval(async () => {
          try {
            const { status: state, data } = await qrPoll(key, jar);
            if (state === 'scanned') console.log('已扫码，等待手机确认...');
            if (state === 'expired') {
              clearInterval(timer);
              reject(new Error('二维码已过期，请重新生成'));
            }
            if (state === 'confirmed') {
              clearInterval(timer);
              resolve(await saveLoginFromPoll(data, jar));
            }
          } catch (error) {
            clearInterval(timer);
            reject(error);
          }
        }, 2000);
      });
      return print(await status());
    }

    case 'logout':
      return print(await logout());

    case 'me': {
      const { jar } = await currentJar();
      const me = await getCurrentUser({ jar });
      return print(me ?? { loggedIn: false });
    }

    case 'video': {
      if (!args[0]) throw new Error('缺少 bvid');
      const { jar } = await currentJar();
      return print(await getVideo(args[0], { jar }));
    }

    case 'latest': {
      const { jar } = await currentJar();
      const { latest } = await getLatestOwnVideo({ jar });
      if (!latest) return print({ latest: null, hint: '当前账号还没有投稿' });
      const video = await getVideo(latest.bvid, { jar });
      return print({
        bvid: video.bvid,
        title: video.title,
        publishedAt: video.publishedAt,
        stat: video.stat,
        fetchedAt: video.fetchedAt,
      });
    }

    case 'list': {
      if (!args[0]) throw new Error('缺少 mid');
      const { jar } = await currentJar();
      return print(await listUserVideos(args[0], { jar, ps: 5 }));
    }

    case 'watchlater': {
      const { jar } = await currentJar();
      return print(await listWatchLater({ jar }));
    }

    case 'folders': {
      const { jar } = await currentJar();
      return print(await listFavoriteFolders({ jar }));
    }

    case 'favitems': {
      if (!args[0]) throw new Error('缺少 mediaId');
      const { jar } = await currentJar();
      return print(await listFavoriteItems({ jar, mediaId: args[0] }));
    }

    case 'like': {
      const [bvid, liked] = args;
      if (!bvid || liked === undefined) throw new Error('用法：like <bvid> <0|1>');
      const { jar, video } = await resolveAid(bvid);
      if (!go) return print({ dryRun: true, action: 'like', bvid, aid: video.aid, liked: liked === '1' });
      return print(await setVideoLike({ jar, aid: video.aid, liked: liked === '1' }));
    }

    case 'wl': {
      const [bvid, action] = args;
      if (!bvid || !['add', 'remove'].includes(action)) throw new Error('用法：wl <bvid> <add|remove>');
      const { jar, video } = await resolveAid(bvid);
      const added = action === 'add';
      if (!go) return print({ dryRun: true, action: 'watch-later', bvid, aid: video.aid, added });
      return print(await setWatchLater({ jar, aid: video.aid, added }));
    }

    case 'fav': {
      const [bvid, mediaId, action] = args;
      if (!bvid || !mediaId || !['add', 'remove'].includes(action)) {
        throw new Error('用法：fav <bvid> <mediaId> <add|remove>');
      }
      const { jar, video } = await resolveAid(bvid);
      const added = action === 'add';
      if (!go) return print({ dryRun: true, action: 'favorite', bvid, aid: video.aid, mediaId, added });
      return print(await setFavorite({ jar, aid: video.aid, mediaId, added }));
    }

    default:
      usage();
      process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ code: error?.code ?? 'ERROR', message: error?.message ?? String(error) }, null, 2));
  process.exitCode = 1;
});
