/** Real read-only tool checks. Credentials are used only by the existing auth layer. */
import { parseArgs } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../lib/index.js';

const definitions = new Map();
apply({ tools: { register: (def) => definitions.set(def.name, def) }, on() {}, get() {} });

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    type: { type: 'string' }, sort: { type: 'string' }, mid: { type: 'string' },
    page: { type: 'string' }, 'page-size': { type: 'string' }, order: { type: 'string' },
    offset: { type: 'string' }, 'no-replies': { type: 'boolean' }, anonymous: { type: 'boolean' },
  } });
  // Anonymous verification uses an empty temporary credential location without writing it.
  if (values.anonymous) process.env.BILI_DATA_DIR = join(tmpdir(), `bili-anonymous-${process.pid}`);
  const [command, value] = positionals;
  const names = { search: 'bilibili_search', comments: 'bilibili_comments', profile: 'bilibili_user_profile', dynamics: 'bilibili_dynamics' };
  if (!names[command]) throw new Error('用法: node tests/manual-read.mjs search <keyword> | comments <BV> | profile <mid> | dynamics [--mid mid]');
  const args = command === 'search' ? { keyword: value } : command === 'comments' ? { bvid: value } : command === 'profile' ? { mid: value } : {};
  for (const key of ['type', 'sort', 'mid', 'order', 'offset']) if (values[key] !== undefined) args[key] = values[key];
  if (values.page !== undefined) args.page = Number(values.page);
  if (values['page-size'] !== undefined) args.pageSize = Number(values['page-size']);
  if (values['no-replies']) args.includeReplies = false;
  const result = await definitions.get(names[command]).execute(args, { signal: AbortSignal.timeout(120_000) });
  const { items, ...pagination } = result.data;
  console.log(JSON.stringify({ tool: names[command], status: result.status, ...pagination,
    ...(items ? { itemCount: items.length, sample: items.slice(0, 2) } : {}) }, null, 2));
} catch (error) {
  // Known BiliError messages do not include response payloads or credentials.
  console.error(String(error.message));
  process.exitCode = 1;
}
