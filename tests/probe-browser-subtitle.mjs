/**
 * 探针：用真实 Chrome 页面上下文请求 player/v2，验证“字幕串台”是否与请求上下文有关。
 * 只读，不写账号。
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
const CID = Number(process.argv[3] ?? 43128652480);
const DURATION = Number(process.argv[4] ?? 931);

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
await page.goto(`https://www.bilibili.com/video/${BVID}/`, { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForTimeout(3000);

for (let i = 1; i <= 3; i += 1) {
  const data = await page.evaluate(async ({ bvid, cid }) => {
    const response = await fetch(`https://api.bilibili.com/x/player/v2?bvid=${bvid}&cid=${cid}`, {
      credentials: 'include',
    });
    return response.json();
  }, { bvid: BVID, cid: CID });
  const tracks = data?.data?.subtitle?.subtitles ?? [];
  let info = { code: data?.code, tracks: tracks.map((track) => track.lan) };
  if (tracks[0]?.subtitle_url) {
    const url = tracks[0].subtitle_url.startsWith('//') ? `https:${tracks[0].subtitle_url}` : tracks[0].subtitle_url;
    const body = await (await fetch(url)).json();
    const cues = body.body ?? [];
    info = {
      ...info,
      cues: cues.length,
      cover: Number((((cues.at(-1)?.to ?? 0) / DURATION).toFixed(2))),
      first: (cues[0]?.content ?? '').slice(0, 30),
    };
  }
  console.log(i, JSON.stringify(info));
  await page.waitForTimeout(1200);
}

await browser.close();
