# 设置面板（自定义 settings.section）设计

> 状态：**设计稿，未实现**。目标是在 DSH 设置面板里给本插件加一页「B站工具」，
> 用来查看账号/运行时/预算/缓存，并编辑插件配置。
> 依据：`dsh-bili-whale` 与 `dshmarket` 的线上产物（见文末参考），非猜测。

## 1. 目标

在 **设置 → 「B站工具」** 出现一整页，内容：

| 区块 | 性质 | 内容 |
| --- | --- | --- |
| 账号 | 只读 | 昵称 / mid / 等级 / VIP、凭据路径、数据目录、「重新扫码登录」 |
| 运行时 | 只读 | ffmpeg 路径与检测结果、ASR Python 路径、ASR 模型、worker 是否常驻 |
| 预算 | 只读 | 当前分析任务列表：bvid、轮次 x/6、音频已用 / 上限、过期时间 |
| 缓存 | 只读 + 操作 | 总占用、分类明细（asr / 雪碧图 / 封面）、「清理缓存」 |
| 设置 | 可写 | 预算上限、缓存开关与 TTL、ASR 模型、ffmpeg 路径、OCR 开关 |
| 最近调用 | 只读（P2） | 最近 20 次 transcribe/inspect：时间、参数、耗时、是否命中缓存 |

## 2. 参考实现（已验证的机制）

- `dsh-bili-whale`：`package.json` 里 `exports["./client"] = "./lib/client.js"`、
  `dsh.client = { inject: [], platform: "web" }`；`lib/client.js` 是**手写**的
  `window.__ModuleLoader__.load({ id, factory })` 包装，只 `require("react")`；
  在 `apply(ctx)` 里 `ctx.slots.inject("settings.section", () => ctx.slots.register({...}, Section))`。
  宿主半边 `lib/index.js`：`inject: ['sessionController', 'webServer', 'connection']`，
  用 `ctx.webServer.register({ type: 'exact', path, handler })` 暴露 `/dsh-bili/api/*`。
- `dshmarket`：client bundle 是打包产物，格式相同（`window.__ModuleLoader__.load`）；
  它还额外注册 `plugins.tab`、`shell.overlay`，并引入 `dsh-client-ui-primitives`。
- 结论：**我们的页面不需要宿主 UI 包，也不需要构建链**——手写 client.js + 原生 CSS 变量即可。

## 3. 架构

```
浏览器
  设置面板 → settings.section「B站工具」 → lib/client.js（React，手写）
        │  fetch 同源
        ▼
宿主进程
  ctx.webServer 路由 /bilibili-bridge/api/*   → lib/settings-api.mjs（新）
        │  读写
        ▼
  ~/.dsh/bilibili/config.json（与工具读同一份）+ dataDir()/cache/**
```

原则：**页面不直接读文件**，一律经宿主 HTTP；配置只有一份，工具与页面共享。

## 4. 文件改动

| 文件 | 动作 |
| --- | --- |
| `lib/client.js` | 新增：`settings.section` 注册 + 页面组件（手写，无 JSX） |
| `lib/settings-api.mjs` | 新增：路由处理（GET/POST 合并、信任检查、白名单合并、范围校验） |
| `lib/index.js` | 改：`inject` 增加 `webServer`，挂载路由 |
| `lib/media/budget.mjs` | 改：新增 `listAnalyses()`，供预算区块展示 |
| `lib/media/analysis-config.mjs` | 改：补 `ocr.enabled` 等新字段的读取（如需） |
| `package.json` | 改：`exports["./client"]`、`dsh.client`、`files` |
| `tests/unit/settings-api.test.mjs` | 新增：白名单合并、范围校验、信任检查的纯函数测试 |

不引入新依赖；不打包；不改 `tools/pre-execute` 审批策略。

## 5. 数据契约

前缀：`/bilibili-bridge/api`（下称 `$API`）。所有响应 `application/json`，形如 `{ ok: true, ... }` / `{ ok: false, error }`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `$API/status` | 账号 + 运行时 + 预算 + 缓存占用（一次取全，页面首屏用） |
| GET | `$API/settings` | 当前配置（脱敏：不含凭据内容，只给路径与是否存在） |
| POST | `$API/settings` | 部分更新；白名单 + 范围校验通过才落盘 |
| POST | `$API/cache/clear` | 清空 `dataDir()/cache/**`（不碰 credentials.json） |

### 5.1 信任检查（写接口必须）

```js
function isTrusted(req) {
  const origin = req.headers.origin ?? req.headers.referer ?? '';
  const host = req.headers.host ?? '';
  if (origin && host && !origin.includes(host)) return false;   // 跨站直接拒
  const ip = req.socket?.remoteAddress ?? '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip === '';
}
```

写接口顺序：`GET → 读取`；`非 POST → 405`；`!isTrusted → 403`；然后解析 body。

### 5.2 白名单合并

只接受已知顶层键，未知键忽略（不是报错，避免前端多余字段导致 400）：

```js
const WRITABLE = new Set(['budget', 'cache', 'asrModel', 'ffmpegPath', 'ffmpegCaFile', 'ocr']);
```

合并语义：顶层浅合并（`budget` / `cache` / `ocr` 内部按已知子键合并），未知子键忽略。

### 5.3 范围校验（服务端，不能只靠前端）

| 键 | 规则 |
| --- | --- |
| `budget.roundsLimit` | 整数，1–50 |
| `budget.audioSecondsLimit` | 整数，60–7200 |
| `budget.ttlMs` | 整数，60_000–86_400_000 |
| `cache.enabled` | 布尔 |
| `cache.ttlMs` | 整数，86_400_000–7_776_000_000 |
| `asrModel` | 枚举 `tiny` `base` `small` `medium` |
| `ffmpegPath` / `ffmpegCaFile` | 字符串；写入后调用 `resetFfmpegCache()` |
| `ocr.enabled` | 布尔 |

校验失败返回 400 + 具体字段名；**不写文件**。

## 6. 页面结构

沿用 whale 的「分组标题 + 行」布局，行内左侧 label/hint、右侧控件：

```
B站工具
  账号            昵称 四夕羽_ · mid 215407733 · Lv6
                  凭据 ~/.dsh/bilibili/credentials.json          [重新扫码登录]
  运行时          ffmpeg  D:/tools/ffmpeg/.../ffmpeg.exe  ✓ 可用
                  ASR     D:/tools/asr/.venv/.../python.exe · 模型 small · worker 空闲
  预算            轮次上限 [ 6 ]    音频上限 [ 900 ] 秒    账本 TTL [ 2 ] 小时
                  当前任务  BV1KDNA6eEgr · 1/6 · 20/900s · 23:41 过期
  缓存            总计 8.8 MB（asr 2.8 KB · 画面 8.7 MB）     [清理缓存]
                  保留 [ 30 ] 天   [x] 启用缓存
  最近调用        （P2）
  保存            底部固定：[保存]  [重置未保存的修改]
```

交互约定：只读区块每次打开/点刷新时拉 `$API/status`；可写区块本地编辑，点保存才 POST；
保存成功后提示"已保存，下一次调用生效"（预算/缓存是每次调用读取，不需要重启）。

## 7. 代码骨架

### 7.1 `lib/client.js`（手写，无 JSX）

```js
window.__ModuleLoader__.load({
  id: 'dsh-bilibili-bridge',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    const React = require('react');
    const { createElement: h, useCallback, useEffect, useState } = React;
    const API = '/bilibili-bridge/api';
    const CSS_ID = 'dsh-bilibili-bridge/section.css';

    const CSS = `
      .blb{max-width:760px;display:flex;flex-direction:column;gap:6px;color:var(--dsw-alias-label-primary)}
      .blb-title{margin:0;font-size:16px;font-weight:500;line-height:24px}
      .blb-group{margin-top:14px;font-size:13px;font-weight:600;line-height:20px}
      .blb-row{display:flex;justify-content:space-between;gap:12px 20px;padding:10px 0;
               border-bottom:.5px solid var(--dsw-alias-border-l2);flex-wrap:wrap}
      .blb-row:last-child{border-bottom:none}
      .blb-label{font-size:13px;line-height:19px}
      .blb-hint{color:var(--dsw-alias-label-tertiary);margin-top:3px;font-size:11.5px;line-height:17px}
      .blb-input{background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;
                 color:var(--dsw-alias-label-primary);font-size:12.5px;height:28px;padding:0 8px;min-width:140px}
      .blb-btn{border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:transparent;
               color:var(--dsw-alias-label-primary);height:28px;padding:0 12px;cursor:pointer;font-size:12.5px}
    `;

    function useCss() {
      useEffect(() => {
        if (document.getElementById(CSS_ID)) return;
        const el = document.createElement('style');
        el.id = CSS_ID;
        el.textContent = CSS;
        document.head.appendChild(el);
      }, []);
    }

    const Row = ({ label, hint, children }) => h('div', { className: 'blb-row' },
      h('div', null, h('div', { className: 'blb-label' }, label),
        hint ? h('div', { className: 'blb-hint' }, hint) : null),
      children);

    function Section() {
      useCss();
      const [status, setStatus] = useState(null);
      const [error, setError] = useState('');
      const load = useCallback(async () => {
        try {
          const res = await fetch(`${API}/status`, { headers: { accept: 'application/json' } });
          const json = await res.json();
          if (!json.ok) throw new Error(json.error || '读取失败');
          setStatus(json);
          setError('');
        } catch (e) { setError(String(e.message || e)); }
      }, []);
      useEffect(() => { load(); }, [load]);

      if (error) return h('div', { className: 'blb' }, `读取状态失败：${error}`);
      if (!status) return h('div', { className: 'blb' }, '加载中…');

      return h('div', { className: 'blb' },
        h('h2', { className: 'blb-title' }, 'B站工具'),
        h('div', { className: 'blb-group' }, '账号'),
        h(Row, { label: status.account.loggedIn ? `${status.account.uname} · mid ${status.account.mid}` : '未登录' }),
        h('div', { className: 'blb-group' }, '缓存'),
        h(Row, { label: '总占用', hint: status.cache.summary },
          h('button', { className: 'blb-btn', onClick: async () => {
            await fetch(`${API}/cache/clear`, { method: 'POST', headers: { accept: 'application/json' } });
            load();
          } }, '清理缓存')),
      );
    }

    function apply(ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'bilibili-bridge',
        order: 200,
        label: () => 'B站工具',
      }, Section));
    }

    exports.name = 'dsh-bilibili-bridge';
    exports.inject = [];
    exports.apply = apply;
    return module.exports;
  },
});
```

### 7.2 `lib/settings-api.mjs`（宿主侧）

```js
import { readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { dataDir } from './bili/store.mjs';
import { resetFfmpegCache } from './media/ffmpeg.mjs';

const PREFIX = '/bilibili-bridge/api';
const WRITABLE = new Set(['budget', 'cache', 'asrModel', 'ffmpegPath', 'ffmpegCaFile', 'ocr']);

function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

export function registerSettingsRoutes(ctx) {
  const route = (handler) => ctx.webServer.register({ type: 'exact', path: `${PREFIX}/settings`, handler });
  // 同一 path 的 GET/POST 必须合一（exact 表按 path 唯一，分两次注册后一个收不到请求）
  route(async (req, res) => {
    if (req.method === 'GET') return json(res, 200, { ok: true, config: await readConfig() });
    if (req.method !== 'POST') return json(res, 405, { ok: false });
    if (!isTrusted(req)) return json(res, 403, { ok: false, error: '不受信任的访问来源' });
    const patch = JSON.parse(await readBody(req) || '{}');
    const merged = mergeWritable(await readConfig(), patch);   // 白名单 + 范围校验，失败抛错
    await writeFile(configPath(), JSON.stringify(merged, null, 2), 'utf8');
    if ('ffmpegPath' in patch || 'ffmpegCaFile' in patch) resetFfmpegCache();
    return json(res, 200, { ok: true, config: merged });
  });
}
```

> 具体实现里把 `mergeWritable` / `isTrusted` / 范围校验写成**纯函数**并单测，
> 路由只做 I/O 编排。

### 7.3 `package.json`

```json
"exports": { ".": "./lib/index.js", "./client": "./lib/client.js", "./package.json": "./package.json" },
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": { "inject": [], "platform": "web" }
},
"files": ["lib", "bin", "cordis.patch.yml", "README.md"]
```

### 7.4 `lib/index.js` 接线

```js
export const inject = ['tools', 'webServer'];
// apply(ctx) 内：
registerSettingsRoutes(ctx);
```

## 8. 分阶段任务与验收

### P0 最小 section（半天）— 必须先做

1. 写最小 `lib/client.js`（只注册 section，页面显示一行文字）；
2. `package.json` 加 `exports["./client"]` 与 `dsh.client`；
3. 重启宿主 → 刷新页面。

**验收**：设置面板左侧出现「B站工具」，点开有内容。失败则停下排查格式/注入，不要继续。

### P1 只读仪表盘（1 天）

`$API/status`：账号（复用 `auth.status()`）、运行时（`resolveToolchain` / `resolveAsr`）、
预算（`budget.listAnalyses()`）、缓存（扫 `dataDir()/cache` 统计）。
页面渲染四块 + 刷新按钮。

**验收**：数据与工具实际行为一致；缓存数字与 `du` 结果一致。

### P2 可写设置（1 天）

`GET/POST $API/settings`，白名单 + 范围校验 + 信任检查；
页面表单 + 保存；保存后提示下次调用生效。

**验收**：改 `budget.roundsLimit` → 下一次 `transcribe` 的 `budget.roundsLimit` 变化；
非法值（如 `roundsLimit: 999`）返回 400 且文件未变。

### P3 操作与历史（半天）

清理缓存按钮；「重新扫码登录」调用现有 `qrStart` 流程；
`lib/media/history.mjs` 记录最近调用，页面展示。

**验收**：清理后占用下降；清理不影响进行中的转写（先检查无在飞请求）。

## 9. 坑

1. **同一路径 GET/POST 必须一个 handler**（exact 表按 path 唯一）。
2. **导航图标**：`navIcon(id)` 只给 `models`/`agent-presets` 配了图标，我们的 section 会是齿轮图标；第一版接受。
3. **不要做独立 HTML 页**：whale 试过 `settings.html`，被宿主的信任框挡住；必须在 section 内。
4. **client 包没有 HMR**：改 `lib/client.js` 要刷新页面；重装依赖后需重启宿主。
5. **写接口必须校验来源**：配置文件里没有凭据内容，但能改 ffmpeg 路径等，仍不该允许跨站写。
6. **`analysisConfig()` 每次调用都重读文件**，所以预算/缓存改完即生效；ASR 模型变更会让
   worker 重载模型（下一次转写会慢一次）；ffmpeg 路径变更需 `resetFfmpegCache()`。
7. **DSH 0.2.1 把 Settings 入口挪到账户菜单**，slot 契约不变；文档/截图要按新入口写。

## 10. 不要做

- 不要新增 npm 依赖或引入打包器（手写足够）；真要上 TS/JSX 时再单独评估。
- 不要在页面里直接读写文件或凭据内容。
- 不要改 `tools/pre-execute` 的审批策略（写工具仍需 `intent=apply` 审批）。
- 不要为了图标去改宿主函数或用 MutationObserver hack。

## 11. 参考

- [dsh-bili-whale](https://github.com/Alterssss/dsh-bili-whale)：`lib/client.js`、`lib/index.js`（`/dsh-bili/api/*`）
- [dsh-market](https://github.com/dsh-market/dsh-market)：`package.json` 的 `dsh.client`、打包后的同款包装格式
- [live2d-pets 设置页调研](https://github.com/cyanfish-x/dsh-live2d-pets/blob/main/docs/research/settings-tab.md)：slot 表、`settingsScope` 的 wire 白名单限制
- [settings slot 契约](https://github.com/omdsh-dev/dsh-llm-fallbacks/blob/main/.mstar/knowledge/architecture-patterns/dsh-settings-slot-contract.md)：`settings.section` / `settings.plugin.item` 的注册语义
