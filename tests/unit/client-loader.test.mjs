import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * lib/client.js 是给浏览器用的：它在模块顶层直接调 window.__ModuleLoader__.load。
 * 这里用假的 window + 假的 react 把它跑一遍，验证“加载器 id / 注入项 / section 注册”三件事，
 * 避免改错包装格式后只能靠重启宿主才发现。
 */
function fakeReact() {
  const createElement = (type, props, ...children) => ({ type, props: props ?? {}, children });
  return {
    createElement,
    useEffect: () => {},
    useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
    useCallback: (fn) => fn,
    useRef: (value) => ({ current: value }),
  };
}

async function loadClient() {
  let captured;
  globalThis.window = {
    __ModuleLoader__: {
      load(descriptor) {
        captured = descriptor;
      },
    },
  };
  await import('../../lib/client.js?test=' + Math.random());
  assert.ok(captured, 'lib/client.js 必须调用 window.__ModuleLoader__.load');
  return captured;
}

test('client bundle 用稳定的 id 与手写 factory 注册', async () => {
  const descriptor = await loadClient();
  assert.equal(descriptor.id, 'dsh-bilibili-bridge');
  assert.equal(typeof descriptor.factory, 'function');

  const exports = descriptor.factory((name) => {
    assert.equal(name, 'react');
    return fakeReact();
  });
  assert.equal(exports.name, 'dsh-bilibili-bridge');
  assert.ok(exports.inject.includes('slots'), '客户端必须注入 slots，否则 ctx.slots 不可用');
  assert.equal(typeof exports.apply, 'function');
  assert.equal(typeof exports.Section, 'function');
});

test('apply 把 section 注册到 settings.section，标签名是「B站工具」', async () => {
  const descriptor = await loadClient();
  const exports = descriptor.factory(() => fakeReact());

  const calls = [];
  const ctx = {
    slots: {
      inject(name, register) {
        calls.push(['inject', name]);
        return register();
      },
      register(options, component) {
        calls.push(['register', options, component]);
        return { options, component };
      },
    },
  };
  exports.apply(ctx);

  assert.deepEqual(calls[0], ['inject', 'settings.section']);
  const [, options, component] = calls[1];
  assert.equal(options.name, 'settings.section');
  assert.equal(options.id, 'bilibili-bridge');
  assert.equal(options.order, 200);
  assert.equal(options.label(), 'B站工具');
  assert.equal(component, exports.Section);
});
test('客户端源码保留中文文案（防止再次被写成问号占位）', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../../lib/client.js', import.meta.url), 'utf8');
  for (const word of ['B站工具', '账号', '运行时', '预算', '缓存', '刷新']) {
    assert.ok(source.includes(word), `client.js 缺少中文文案：${word}`);
  }
  assert.ok(!/[?？]{3,}/.test(source), 'client.js 不应该出现连续问号占位');
});
async function loadExports() {
  const descriptor = await loadClient();
  return descriptor.factory(() => fakeReact());
}

const statusFixture = {
  ok: true,
  account: { ok: true, loggedIn: true, uname: '四夕羽_', accountId: '215407733', level: 6, vip: true, credentialsPath: 'C:/x/credentials.json' },
  runtime: { ffmpeg: { ok: true, ffmpeg: 'D:/ffmpeg.exe' }, asr: { ok: true, python: 'D:/py.exe', model: 'small' }, ocr: { ok: true, available: true } },
  budget: { ok: true, items: [] },
  cache: { ok: true, totalBytes: 2048, totalFiles: 3, buckets: [{ name: 'asr', bytes: 1024, files: 1, }, { name: 'cover', bytes: 0, files: 0 }] },
  generatedAt: '2026-11-02T00:00:00.000Z',
};

function renderOf(exports, patch) {
  const data = { ...statusFixture, ...patch };
  return JSON.stringify(exports.renderDashboard({ data, error: '', loading: false, refresh: () => {} }));
}

test('渲染：账号、运行时、缓存数字都能出来', async () => {
  const exports = await loadExports();
  const html = renderOf(exports, {});
  for (const expected of ['四夕羽_', 'Lv 6', '大会员', 'D:/ffmpeg.exe', 'D:/py.exe', '3 个文件', '2.0 KB']) {
    assert.ok(html.includes(expected), `缺少渲染内容：${expected}`);
  }
});

test('渲染：预算为空显示空态，有任务时显示轮次与秒数', async () => {
  const exports = await loadExports();
  assert.ok(renderOf(exports, {}).includes('（没有进行中的分析）'));

  const withItem = renderOf(exports, {
    budget: { ok: true, items: [{ bundleId: 'b1', bvid: 'BV1', rounds: 1, roundsLimit: 6, audioSecondsUsed: 20, audioSecondsLimit: 900, expiresAt: '2026-11-02T01:00:00.000Z' }] },
  });
  assert.ok(withItem.includes('BV1'));
  assert.ok(withItem.includes('1/6 轮'));
  assert.ok(withItem.includes('20/900 秒'));
});

test('渲染：分区失败显示错误码，不画成空数据', async () => {
  const exports = await loadExports();
  assert.ok(renderOf(exports, { budget: { ok: false, code: 'BUDGET_FAILED', items: [] } }).includes('读取失败（BUDGET_FAILED）'));
  assert.ok(renderOf(exports, { cache: { ok: false, code: 'CACHE_FAILED' } }).includes('读取失败（CACHE_FAILED）'));
  assert.ok(renderOf(exports, { account: { ok: false, code: 'AUTH_FAILED' } }).includes('读取失败（AUTH_FAILED）'));
});

test('渲染：未登录与旧形状（budget 是数组）都不崩', async () => {
  const exports = await loadExports();
  assert.ok(renderOf(exports, { account: { ok: true, loggedIn: false } }).includes('未登录'));
  assert.ok(renderOf(exports, { budget: [] }).includes('（没有进行中的分析）'));
});