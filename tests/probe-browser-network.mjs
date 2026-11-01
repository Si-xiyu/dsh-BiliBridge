/**
 * 探针：抓真实播放页自己发出的 player/v2 请求，看页面拿到的字幕是否也串台。
 */
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require(process.env.PLAYWRIGHT_CORE ?? 'playwright-core'));
} catch {
  console.error('这个探针需要 playwright-core：npm i -D playwright-core，或用 PLAYWRIGHT_CORE 指向它的入口文件');
  process.exit(1);
}

const BVID = process.argv[2] ?? 'BV1pTx76QE8J';
const creds = JSON.parse(await readFile(join(homedir(), '.dsh/bilibili/credentials.json'), 'utf8'));
const cookies = Object.entries(creds.cookies).map(([name, value]) => ({
  name,
  value,
  domain: '.bilibili.com',
  path: '/',
  httpOnly: true,
  secure: true,
}));

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext();
await context.addCookies(cookies);
const page = await context.newPage();

const seen = [];
page.on('response', async (response) => {
  const url = response.url();
  if (!url.includes('/x/player/') && !url.includes('subtitle')) return;
  let summary = { url, status: response.status(), type: response.headers()['content-type'] };
  if (url.includes('subtitle/web/view')) {
    try {
      summary.body = (await response.text()).slice(0, 600);
    } catch {}
  } else {
    try {
      const json = await response.json();
      summary = { ...summary, code: json.code, tracks: json.data?.subtitle?.subtitles?.map((track) => track.lan) };
    } catch {}
  }
  seen.push(summary);
});

await page.goto(`https://www.bilibili.com/video/${BVID}/`, { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForTimeout(2000);
await page.evaluate(() => {
  const video = document.querySelector('video');
  if (video) {
    video.muted = true;
    video.play?.().catch(() => {});
  }
}).catch(() => {});
await page.waitForTimeout(8000);

const cookieNames = (await context.cookies()).map((cookie) => cookie.name).filter((name) => /ticket|buvid|uuid|nut/i.test(name));
console.log('cookies:', JSON.stringify(cookieNames));
console.log('player responses:', JSON.stringify(seen, null, 2));
await browser.close();
