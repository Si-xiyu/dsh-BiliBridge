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