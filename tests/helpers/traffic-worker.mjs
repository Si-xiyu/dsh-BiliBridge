// Local-only child process fixture: never opens a network connection.
import { createTrafficGuard } from '../../lib/bili/traffic-guard.mjs';
const [root] = process.argv.slice(2);
const guard = createTrafficGuard({ root, policy: { gapMs: 80, readHourly: 2 } });
try {
  await guard.run({ url: 'https://api.bilibili.com/x/test' }, async () => {
    console.log(JSON.stringify({ dispatchedAt: Date.now() }));
    return { response: new Response(''), payload: { code: 0 } };
  });
} catch (e) { console.log(JSON.stringify({ code: e.code, submission: e.submission })); }
