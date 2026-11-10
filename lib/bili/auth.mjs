/**
 * 登录、登录态与凭据持久化。
 *
 * - 二维码登录走 passport 的 generate/poll，不需要浏览器；
 * - QR 用文本渲染，主模型不需要看图也能把二维码交给用户；
 * - 凭据落在 0600 的 credentials.json，任何工具返回值都不回显。
 */
import QRCode from 'qrcode';
import { BiliError } from './errors.mjs';
import { CookieJar, request } from './http.mjs';
import { clearCredentials, credentialsPath, dataDir, loadCredentials, saveCredentials } from './store.mjs';

const QR_GENERATE = 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate';
const QR_POLL = 'https://passport.bilibili.com/x/passport-login/web/qrcode/poll';
const NAV = 'https://api.bilibili.com/x/web-interface/nav';
const FINGER_SPI = 'https://api.bilibili.com/x/frontend/finger/spi';

/** 从已保存的凭据造一个 CookieJar（不触发 IO）。 */
export function jarFrom(credentials) {
  return new CookieJar(credentials?.cookies ?? {});
}

/** 读凭据并返回可用的 jar；没有登录态时返回空 jar。 */
export async function currentJar() {
  const credentials = await loadCredentials();
  return { jar: jarFrom(credentials), credentials };
}

/** 补 buvid3/buvid4。空间、动态等接口没有它会直接 -352。 */
export async function ensureBuvid(jar, { recovery = false } = {}) {
  if (jar.get('buvid3')) return;
  const data = await request(FINGER_SPI, { jar, recovery });
  if (data?.b_3) jar.set('buvid3', data.b_3);
  if (data?.b_4) jar.set('buvid4', data.b_4);
}

/** 二维码登录第一步：拿二维码内容与 key。 */
export async function qrStart() {
  const data = await request(QR_GENERATE, { query: { source: 'main-fe-header' }, recovery: true });
  if (!data?.url || !data?.qrcode_key) throw new BiliError('UPSTREAM_ERROR', '没有拿到二维码，请稍后重试');
  return { url: data.url, key: data.qrcode_key };
}

/** 把登录 URL 渲染成终端二维码：手动铺模块，无 ANSI 颜色，聊天里可直接扫。 */
export async function renderQr(url) {
  const qr = QRCode.create(url, { errorCorrectionLevel: 'M' });
  const size = qr.modules.size;
  const data = qr.modules.data;
  const border = 2;
  const lines = [];
  for (let y = -border; y < size + border; y += 1) {
    let line = '';
    for (let x = -border; x < size + border; x += 1) {
      const inside = y >= 0 && y < size && x >= 0 && x < size;
      line += inside && data[y * size + x] ? '██' : '  ';
    }
    lines.push(line);
  }
  return lines.join('\n');
}

const QR_STATUS = {
  86101: 'waiting',
  86090: 'scanned',
  86038: 'expired',
  0: 'confirmed',
};

/** 轮询一次扫码状态。 */
export async function qrPoll(key, jar) {
  const data = await request(QR_POLL, { query: { qrcode_key: key, source: 'main-fe-header' }, jar, recovery: true });
  const status = QR_STATUS[data?.code] ?? 'waiting';
  return { status, message: data?.message, data };
}

/**
 * 扫码确认后的收尾：写入 Cookie、补 buvid、校验 nav、落盘。
 * 只返回公开账号信息，绝不返回 Cookie。
 * @param {{url?: string, refresh_token?: string}} data
 * @param {CookieJar} jar
 */
export async function saveLoginFromPoll(data, jar) {
  const params = new URL(data.url ?? '').searchParams;
  for (const name of ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid']) {
    const value = params.get(name);
    if (value) jar.set(name, value);
  }
  await ensureBuvid(jar, { recovery: true });
  const nav = await navInfo(jar, { recovery: true });
  if (!nav.isLogin || String(nav.mid) !== jar.get('DedeUserID')) throw new BiliError('AUTH_REQUIRED', '扫码后的登录态或账号未通过验证，请重新扫码；未保存新凭据');
  const credentials = {
    version: 1,
    accountId: nav?.mid ? String(nav.mid) : jar.get('DedeUserID'),
    cookies: jar.toObject(),
    refreshToken: data.refresh_token,
  };
  await saveCredentials(credentials);
  return { accountId: credentials.accountId, uname: nav?.uname, loggedIn: Boolean(nav?.isLogin) };
}

/**
 * 等待扫码完成。成功时把 Cookie 写入 jar 并持久化。
 * @param {string} key
 * @param {CookieJar} jar
 * @param {{timeoutMs?: number, intervalMs?: number, onStatus?: (s: string) => void}} [options]
 */
export async function qrWait(key, jar, options = {}) {
  const timeoutMs = options.timeoutMs ?? 180_000;
  const intervalMs = options.intervalMs ?? 2000;
  const deadline = Date.now() + timeoutMs;
  let last = '';

  while (Date.now() < deadline) {
    const { status, data } = await qrPoll(key, jar);
    if (status !== last) {
      last = status;
      options.onStatus?.(status);
    }
    if (status === 'expired') throw new BiliError('AUTH_EXPIRED', '二维码已过期，请重新生成');
    if (status === 'confirmed') return saveLoginFromPoll(data, jar);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new BiliError('AUTH_EXPIRED', '等待扫码超时，请重新生成二维码');
}

/** 查询当前登录态（未登录时 isLogin=false，不抛错）。 */
export async function navInfo(jar, { recovery = false } = {}) {
  const data = await request(NAV, { jar, acceptCodes: [-101], recovery });
  return {
    isLogin: Boolean(data?.isLogin),
    face: data?.face,
    mid: data?.mid || undefined,
    uname: data?.uname || undefined,
    level: data?.level_info?.current_level ?? undefined,
    vip: data?.vipStatus === 1,
    coin: data?.money ?? undefined,
  };
}

/** 供工具/CLI 使用的登录摘要；不含任何 Cookie。 */
export async function status() {
  const credentials = await loadCredentials();
  const jar = jarFrom(credentials);
  const nav = await navInfo(jar, { recovery: true });
  return {
    loggedIn: Boolean(nav.isLogin),
    accountId: nav.mid ? String(nav.mid) : undefined,
    uname: nav.uname,
    face: nav.face,
    vip: nav.vip,
    credentialsPath: credentialsPath(),
    level: nav.level,
    hasCredentials: Boolean(credentials?.cookies && Object.keys(credentials.cookies).length > 0),
    dataDir: dataDir(),
    loginExpired: Boolean(credentials?.cookies?.SESSDATA) && !nav.isLogin,
  };
}

/** 退出登录：只清本地，B站端会话是否失效取决于平台。 */
export async function logout() {
  await clearCredentials();
  return { loggedOut: true, note: '已清除本地凭据；如需让 B站端会话失效，请到 B站账号安全页操作' };
}

/** Cookie 刷新尚未实测，明确标记不支持，避免无限重试。 */
export async function refreshSession() {
  throw new BiliError('UNSUPPORTED', 'Cookie 自动刷新尚未验证，请重新扫码登录');
}
