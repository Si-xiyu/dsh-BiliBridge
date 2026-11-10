import { beforeEach, afterEach, mock } from 'node:test';
import { trafficGuard } from '../../lib/bili/traffic-guard.mjs';

// Existing endpoint tests exercise normalization/error mapping, not traffic
// persistence. Never let their fake responses change a real user's state.
// Imported by each HTTP fixture suite, including when run directly.
// traffic-http.test explicitly installs real guards backed by temporary dirs.
beforeEach(() => {
  mock.method(trafficGuard, 'run', async (_options, effect) => effect());
  mock.method(trafficGuard, 'check', async () => {});
});
afterEach(() => mock.restoreAll());
