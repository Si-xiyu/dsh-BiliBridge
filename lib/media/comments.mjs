/**
 * 评论：热门 + 最新，各自独立采集。
 */
import { request } from '../bili/http.mjs';

const REPLY = 'https://api.bilibili.com/x/v2/reply';

function projectReply(reply) {
  return {
    rpid: String(reply.rpid),
    user: reply.member?.uname,
    uid: reply.member?.mid ? String(reply.member.mid) : undefined,
    message: String(reply.content?.message ?? '').slice(0, 600),
    like: reply.like,
    replyCount: reply.rcount,
    createdAt: reply.ctime ? new Date(reply.ctime * 1000).toISOString() : undefined,
    replies: (reply.replies ?? []).slice(0, 3).map((child) => ({
      user: child.member?.uname,
      message: String(child.content?.message ?? '').slice(0, 300),
      like: child.like,
    })),
  };
}

async function fetchPage({ aid, jar, sort, ps, pn, signal }) {
  const data = await request(REPLY, {
    query: { type: 1, oid: aid, sort, ps, pn },
    jar,
    signal,
  });
  const replies = data?.replies ?? [];
  return {
    total: Number(data?.page?.count ?? replies.length),
    items: replies.map(projectReply),
  };
}

/**
 * @returns {Promise<{status:string, hot:object[], latest:object[], total:number}>}
 */
export async function getComments({ aid, jar, signal, limit = 10 } = {}) {
  const hot = await fetchPage({ aid, jar, sort: 2, ps: Math.min(limit, 20), pn: 1, signal });
  let latest = { items: [], total: hot.total };
  try {
    latest = await fetchPage({ aid, jar, sort: 0, ps: Math.min(limit, 20), pn: 1, signal });
  } catch {
    // 最新评论失败不影响热门
  }
  const dedupe = new Set();
  const latestItems = latest.items.filter((item) => {
    if (dedupe.has(item.rpid)) return false;
    dedupe.add(item.rpid);
    return true;
  });
  return {
    status: hot.items.length || latestItems.length ? 'ok' : 'empty',
    total: Math.max(hot.total, latest.total ?? 0),
    hot: hot.items,
    latest: latestItems,
    note: '评论发布时间不是视频时间轴',
  };
}
