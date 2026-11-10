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

test('apply 把 section 注册到 settings.section，标签名是「BiliBridge」', async () => {
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
  assert.equal(options.label(), 'BiliBridge');
  assert.equal(component, exports.Section);
  assert.deepEqual(calls.filter(([kind]) => kind === 'inject').map(([, name]) => name),
    ['settings.section', 'tool.call.toolview', 'tool.call.toolview']);
  const tools = calls.filter(([kind, options]) => kind === 'register' && options.name === 'tool.call.toolview');
  assert.deepEqual(tools.map(([, options]) => options.key), ['bilibili_extract', 'bilibili_inspect']);
  assert.ok(tools.every(([, , component]) => component === exports.BiliToolCard));
});

function treeNodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(treeNodes);
  if (!tree || typeof tree !== 'object') return [];
  return [tree, ...treeNodes(tree.children)];
}

const imageBlock = () => ({ kind: 'settled', content: [{ type: 'image', attachment: {
  attachmentId: 'sha256:abc', name: 'storyboard.jpg', mediaType: 'image/jpeg',
} }] });

test('工具图片预览：点击打开，遮罩、按钮和 Esc 关闭并清理监听', async () => {
  const loadImage = () => '/img/zoom.jpg';
  loadImage.peek = loadImage;
  const harness = await toolCardHarness({ block: imageBlock(), loadImage });
  const listeners = new Map();
  window.addEventListener = (name, fn) => listeners.set(name, fn);
  window.removeEventListener = (name, fn) => {
    assert.equal(listeners.get(name), fn);
    listeners.delete(name);
  };
  const overlay = () => treeNodes(harness.render()).find(node => node.props.style?.position === 'fixed');
  assert.equal(overlay(), undefined);
  for (const close of ['overlay', 'button', 'escape']) {
    const thumbnail = treeNodes(harness.render()).find(node => node.type === 'img');
    assert.equal(thumbnail.props.title, '点击放大');
    assert.equal(thumbnail.props.style.cursor, 'zoom-in');
    thumbnail.props.onClick();
    const dialog = overlay();
    assert.ok(dialog);
    const image = treeNodes(dialog).find(node => node.type === 'img');
    assert.equal(image.props.src, '/img/zoom.jpg');
    assert.equal(image.props.style.maxHeight, '86vh');
    assert.equal(image.props.style.maxWidth, '94vw');
    assert.match(JSON.stringify(dialog), /封面/);
    await harness.flush();
    assert.equal(listeners.has('keydown'), true);
    if (close === 'escape') listeners.get('keydown')({ key: 'Escape' });
    else if (close === 'button') treeNodes(dialog).find(node => node.type === 'button').props.onClick();
    else dialog.props.onClick();
    assert.equal(overlay(), undefined);
    await harness.flush();
    assert.equal(listeners.size, 0);
  }
});

async function toolCardHarness(props) {
  const states = [], dependencies = [], cleanups = [], effects = [];
  let cursor = 0, effectCursor = 0;
  const react = {
    ...fakeReact(),
    useState(initial) {
      const index = cursor++;
      if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial;
      return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value; }];
    },
    useEffect(effect, deps) {
      const index = effectCursor++;
      if (!dependencies[index] || deps.some((dep, i) => !Object.is(dep, dependencies[index][i]))) {
        dependencies[index] = deps;
        effects.push(() => { cleanups[index]?.(); cleanups[index] = effect(); });
      }
    },
  };
  const exports = (await loadClient()).factory(() => react);
  return {
    render(next = props) { cursor = 0; effectCursor = 0; return exports.BiliToolCard(next); },
    async flush() {
      effects.splice(0).forEach(effect => effect());
      // Let the real promises and allSettled completion update state before re-rendering.
      await new Promise(resolve => queueMicrotask(resolve));
      await new Promise(resolve => setImmediate(resolve));
    },
  };
}

test('工具图片卡片：effect 解析 Promise 后渲染真实 URL 和封面标签', async () => {
  const block = imageBlock();
  const calls = [];
  const harness = await toolCardHarness({ block, loadImage(attachment) {
    calls.push(attachment); return Promise.resolve('/img/a.jpg');
  } });
  assert.equal(treeNodes(harness.render()).filter(node => node.type === 'img').length, 0);
  await harness.flush();
  const tree = harness.render();
  assert.equal(treeNodes(tree).find(node => node.type === 'img')?.props.src, '/img/a.jpg');
  assert.deepEqual(calls, [block.content[0].attachment]);
  assert.match(JSON.stringify(tree), /封面/);
});

for (const [name, loader] of [
  ['拒绝', () => Promise.reject(new Error('image unavailable'))],
  ['undefined', () => undefined],
  ['同步抛错', () => { throw new Error('loader failed'); }],
  ['缺失', undefined],
]) {
  test(`工具图片卡片：loadImage ${name} 时保留文字且不抛错`, async () => {
    const harness = await toolCardHarness({ block: imageBlock(), loadImage: loader });
    assert.doesNotThrow(() => harness.render());
    await harness.flush();
    const tree = harness.render();
    assert.equal(treeNodes(tree).filter(node => node.type === 'img').length, 0);
    assert.match(JSON.stringify(tree), /封面/);
  });
}

test('工具图片卡片：peek 缓存立即显示、默认展开并可收起', async () => {
  const loadImage = () => Promise.resolve('/img/new.jpg');
  loadImage.peek = () => '/img/cached.jpg';
  const harness = await toolCardHarness({ block: imageBlock(), loadImage });
  const tree = harness.render();
  assert.equal(treeNodes(tree).find(node => node.type === 'img')?.props.src, '/img/cached.jpg');
  const button = treeNodes(tree).find(node => node.type === 'button');
  assert.equal(button.props['aria-expanded'], true);
  button.props.onClick();
  assert.equal(treeNodes(harness.render()).filter(node => node.type === 'img').length, 0);
});

test('工具图片卡片：无 kind 的运行阶段与无图结果安全显示文字', async () => {
  const harness = await toolCardHarness({ block: { content: [] } });
  assert.match(JSON.stringify(harness.render()), /运行中|准备中/);
  const block = { kind: 'settled', content: [{ type: 'text', text: 'ok' },
    { type: 'image', attachment: { attachmentId: ' ' } }, { type: 'image' }] };
  assert.match(JSON.stringify(harness.render({ block })), /本次调用没有产出图片/);
});

test('工具图片卡片：标签映射和渲染异常降级', async () => {
  const exports = await loadExports();
  for (const [name, label] of [['storyboard.jpg', '封面 + 故事板九宫格'], ['adaptive.jpg', '自适应九宫格'],
    ['frames-12.jpg', '抽帧拼图 12'], ['cover.jpg', '封面'], ['other.png', 'other.png']]) {
    assert.equal(exports.imageLabel(name), label);
  }
  const props = { get block() { throw new Error('bad props'); } };
  // 取 block 抛错时：hooks 仍然执行，组件降级为「运行中」文案，不把异常抛给 React。
  assert.doesNotThrow(() => exports.BiliToolCard(props));
  assert.match(JSON.stringify(exports.BiliToolCard(props)), /运行中|准备中/);
});

test('工具图片卡片：注入和延迟注册抛错均不影响 apply', async () => {
  const exports = await loadExports();
  const callbacks = [];
  assert.doesNotThrow(() => exports.apply({ slots: {
    inject(name, callback) { if (name === 'tool.call.toolview') callbacks.push(callback); },
    register() { throw new Error('register failed'); },
  } }));
  assert.equal(callbacks.length, 2);
  callbacks.forEach(callback => assert.doesNotThrow(callback));
  assert.doesNotThrow(() => exports.apply({ slots: { inject() { throw new Error('inject failed'); } } }));
});
test('客户端源码保留中文文案（防止再次被写成问号占位）', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../../lib/client.js', import.meta.url), 'utf8');
  for (const word of ['BiliBridge', '账号', '运行时', '预算', '缓存', '刷新',
    '视频取数（节能模式）', '获取平台字幕', '获取评论', '获取弹幕',
    '获取画面（封面/故事板）', 'Adaptive 补充九宫格', '节能（仅字幕）', '标准（全量）']) {
    assert.ok(source.includes(word), `client.js 缺少中文文案：${word}`);
  }
  assert.ok(!/[?？]{3,}/.test(source), 'client.js 不应该出现连续问号占位');
});

test('设置页：取数开关默认开启，预设清理自动保存并携带 revision 提交', async (t) => {
  const descriptor = await loadClient();
  const states = [], refs = [], effects = [], requests = [], timers = new Map();
  let cursor = 0, refCursor = 0, timerId = 0, respond;
  const react = {
    ...fakeReact(),
    useState(initial) {
      const index = cursor++;
      if (!(index in states)) states[index] = initial;
      return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value; }];
    },
    useRef(initial) {
      const index = refCursor++;
      return refs[index] ??= { current: initial };
    },
    useEffect(fn) { effects.push(fn); },
  };
  t.mock.method(globalThis, 'setTimeout', fn => { timers.set(++timerId, fn); return timerId; });
  t.mock.method(globalThis, 'clearTimeout', id => timers.delete(id));
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, options });
    if (!options) return { ok: true, json: async () => ({ ok: true, config: {}, revision: 'r1' }) };
    return new Promise(resolve => { respond = resolve; });
  });
  const exports = descriptor.factory(() => react);
  const render = () => { cursor = 0; refCursor = 0; return exports.SettingsForm(); };
  const nodes = tree => {
    if (Array.isArray(tree)) return tree.flatMap(nodes);
    if (!tree || typeof tree !== 'object') return [];
    return [tree, ...nodes(tree.children)];
  };
  render();
  await effects[0]();
  await new Promise(resolve => setImmediate(resolve));
  let tree = render();
  const labels = ['获取平台字幕', '获取评论', '获取弹幕', '获取画面（封面/故事板）', 'Adaptive 补充九宫格'];
  for (const label of labels) {
    const input = nodes(tree).find(node => node.props?.['aria-label'] === label);
    assert.equal(input.props.type, 'checkbox');
    assert.equal(input.props.checked, true);
  }
  const text = JSON.stringify(tree);
  assert.ok(text.indexOf('视频理解') < text.indexOf('视频取数（节能模式）'));
  assert.ok(text.indexOf('视频取数（节能模式）') < text.indexOf('开发者'));
  assert.ok(text.includes('关闭后只影响 extract/collect 的默认采集；显式 comments/inspect 仍可用。画面关闭时 Adaptive 不生效。'));

  for (const [label, full] of [['节能（仅字幕）', false], ['标准（全量）', true]]) {
    nodes(tree).find(node => node.props?.['aria-label'] === '获取评论').props.onChange({ target: { checked: false } });
    assert.equal(timers.size, 1);
    tree = render();
    const button = nodes(tree).find(node => node.type === 'button' && node.children.includes(label));
    assert.equal(button.props.disabled, false);
    const saving = button.props.onClick();
    assert.equal(timers.size, 0);
    const request = requests.at(-1);
    assert.equal(request.url, '/bilibili-bridge/api/settings');
    assert.deepEqual(JSON.parse(request.options.body), {
      extract: { subtitles: true, comments: full, danmaku: full, frames: full },
      adaptive: { adaptiveEnabled: full }, revision: full ? 'r2' : 'r1',
    });
    assert.ok(nodes(render()).filter(node => node.type === 'button').every(node => node.props.disabled));
    respond({ ok: true, json: async () => ({ ok: true, config: {
      extract: { subtitles: true, comments: full, danmaku: full, frames: full },
      adaptive: { adaptiveEnabled: full },
    }, revision: 'r2' }) });
    await saving;
    tree = render();
    assert.ok(JSON.stringify(tree).includes('已保存'));
    for (const field of labels) {
      assert.equal(nodes(tree).find(node => node.props?.['aria-label'] === field).props.checked, field === labels[0] || full);
    }
  }
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
  // 旧形状必须连任务一起渲染出来，不能静默显示“没有任务”。
  const legacy = renderOf(exports, { budget: [{ bundleId: 'b9', bvid: 'BV9', rounds: 2, roundsLimit: 6, audioSecondsUsed: 40, audioSecondsLimit: 900, expiresAt: '2026-11-02T01:00:00.000Z' }] });
  assert.ok(legacy.includes('BV9'));
  assert.ok(legacy.includes('2/6 轮'));
});
test('右侧 dock：tab 类型与 body 的 key 一致，且带「开始」页卡片', async () => {
  const descriptor = await loadClient();
  const exports = descriptor.factory(() => fakeReact());
  const tabs = [];
  const registered = [];
  const ctx = {
    slots: { inject(name, callback) { return callback(); }, register(options) { registered.push(options); } },
    // 模拟宿主：服务就绪后才回调
    inject(names, callback) { assert.deepEqual(names, ['sidebarRightTabs']); callback(ctx); },
  };
  ctx.sidebarRightTabs = { register(definition) { tabs.push(definition); } };
  exports.apply(ctx);

  assert.equal(tabs.length, 1);
  const definition = tabs[0];
  assert.match(definition.id, /^dsh-bilibili-bridge\//);
  assert.equal(definition.kind, 'bilibili-devtools');
  assert.equal(definition.title(), 'BiliBridge');
  assert.equal(definition.guide.length, 1);
  assert.equal(definition.guide[0].order, 40);

  // body 必须用同一个 id 作为 key，否则宿主找不到这个 tab 的内容
  const body = registered.find((item) => item.name === 'sidebar.right.pane.tab');
  assert.equal(body.key, definition.id);
});

test('右侧栏服务缺失时：注册设置页和工具卡片，不抛错', async () => {
  const descriptor = await loadClient();
  const exports = descriptor.factory(() => fakeReact());
  const registered = [];
  const ctx = {
    slots: { inject(name, callback) { return callback(); }, register(options) { registered.push(options); } },
    // 服务永远不会就绪
    inject() {},
  };
  assert.doesNotThrow(() => exports.apply(ctx));
  assert.deepEqual(registered.map((item) => item.name), ['settings.section', 'tool.call.toolview', 'tool.call.toolview']);
});

test('访问右侧栏服务就抛错时，apply 也不能把宿主启动拖垮', async () => {
  const descriptor = await loadClient();
  const exports = descriptor.factory(() => fakeReact());
  const registered = [];
  const ctx = {
    slots: { inject(name, callback) { return callback(); }, register(options) { registered.push(options); } },
    inject(names, callback) { callback(ctx); },
  };
  Object.defineProperty(ctx, 'sidebarRightTabs', { get() { throw new Error('service not injected'); } });
  assert.doesNotThrow(() => exports.apply(ctx));
  assert.deepEqual(registered.map((item) => item.name), ['settings.section', 'tool.call.toolview', 'tool.call.toolview']);
});

test('apply 本身同步返回，不等待右侧栏服务（否则 entry 会 pending）', async () => {
  const descriptor = await loadClient();
  const exports = descriptor.factory(() => fakeReact());
  const registered = [];
  const ctx = {
    slots: { inject(name, callback) { return callback(); }, register(options) { registered.push(options); } },
    inject() { /* 宿主还没就绪，回调不调用 */ },
  };
  const returned = exports.apply(ctx);
  assert.equal(returned, undefined);
  assert.deepEqual(registered.map((item) => item.name), ['settings.section', 'tool.call.toolview', 'tool.call.toolview']);
});
test('所有导出的组件都能渲染（防止删掉中间组件导致整页空白）', async () => {
  const exports = await loadExports();
  const cases = [
    ['Section', undefined],
    ['SettingsForm', undefined],
    ['History', { version: 1 }],
    ['DevTab', {}],
    ['renderDashboard', { data: null, error: '', loading: false, refresh: () => {} }],
  ];
  for (const [name, args] of cases) {
    assert.equal(typeof exports[name], 'function', `${name} 必须导出`);
    assert.ok(exports[name](args), `${name} 渲染不能返回空`);
  }
  // 侧边栏图标与整页都要能渲染（整页在关闭态也有内容）。
  assert.equal(typeof exports.DevIcon, 'function');
  assert.ok(exports.DevIcon({ size: 16 }));
  assert.equal(typeof exports.DevTab, 'function');
  assert.ok(exports.DevTab({}));
});
test('访问右侧栏服务就抛错时，apply 也不能把宿主启动拖垮', async () => {
  const descriptor = await loadClient();
  const exports = descriptor.factory(() => fakeReact());
  const registered = [];
  const hostile = {
    slots: {
      inject(name, callback) { return callback(); },
      register(options) { registered.push(options); },
    },
  };
  // 模拟 cordis 未注入服务时的 getter 抛错（真实崩溃就是这么发生的）
  Object.defineProperty(hostile, 'sidebarRightTabs', { get() { throw new Error('service not injected'); } });
  assert.doesNotThrow(() => exports.apply(hostile));
  assert.deepEqual(registered.map((item) => item.name), ['settings.section', 'tool.call.toolview', 'tool.call.toolview']);
});
