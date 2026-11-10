# 设置面板（自定义 settings.section）设计

> 状态：前文保留历史设计与调研；设置页已实现，最新节能模式实现见第 13 节。原设计目标是在 DSH 设置面板里给本插件加一页「B站工具」，
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
---

## 12. 2026-11-02 追加确认（实现以此为准）

### 12.1 参战角色与决策

| 决策 | 结果 |
| --- | --- |
| 关闭 ASR / OCR 的语义 | **硬禁用**：`transcribe` 抛 `ASR_DISABLED`，`inspect(ocr|subtitleWindow)` 抛 `OCR_DISABLED` |
| ASR 失败自动试 OCR | **不做**，OCR 仍然只能显式开启 |
| 窗口旋钮 | **两个**：`asr.defaultWindowSeconds`（10–120）+ `asr.maxWindowSeconds`（30–600）；任务总额度复用 `budget.audioSecondsLimit`，不再单开 |
| 账号操作 | 退出登录 + 重新扫码；**不单独做**“切换账号”按钮（它等于退出后扫码） |
| 头像 | **服务端代理 + 缓存**：`GET $API/avatar`，宿主带 Referer 拉图并落盘 |

### 12.2 配置契约（已实现在 `lib/media/analysis-config.mjs`）

```jsonc
{
  "budget": { "ttlMs": 7200000, "roundsLimit": 6, "audioSecondsLimit": 900 },
  "cache":  { "enabled": true, "ttlMs": 2592000000 },
  "asr":    { "enabled": true, "model": "small", "defaultWindowSeconds": 30, "maxWindowSeconds": 300 },
  "ocr":    { "enabled": true }
}
```

- 旧顶层 `asrModel` 仍兼容（等价于 `asr.model`）。
- `maxWindowSeconds < defaultWindowSeconds` 时读取端会自动抬高，避免“不传窗口就必然越界”。
- 生效时机：预算/缓存/开关/窗口都是**每次调用重读**，改完即生效；`asr.model` 变更会让常驻 worker 下次重载模型。

### 12.3 设置页最终字段表

| 分组 | 字段 | 类型 / 范围 | 默认 |
| --- | --- | --- | --- |
| 账号（只读） | 昵称 / mid / 等级 / VIP / 头像 / 凭据路径 / 是否已登录 | — | — |
| 账号（操作） | 退出登录、重新扫码登录 | 按钮 | — |
| 运行时（只读） | ffmpeg 路径与可用性、ASR Python、ASR 模型、worker 状态、OCR 引擎 | — | — |
| 预算 | `budget.roundsLimit` | 整数 1–50 | 6 |
| 预算 | `budget.audioSecondsLimit` | 整数 60–7200 | 900 |
| 预算 | `budget.ttlMs` | 1–24 小时 | 2 |
| 缓存 | `cache.enabled` | 布尔 | 开 |
| 缓存 | `cache.ttlMs` | 1–90 天 | 30 |
| 视频理解 | `asr.enabled` | 布尔 | 开 |
| 视频理解 | `asr.model` | tiny/base/small/medium | small |
| 视频理解 | `asr.defaultWindowSeconds` | 整数 10–120 | 30 |
| 视频理解 | `asr.maxWindowSeconds` | 整数 30–600 | 300 |
| 视频理解 | `ocr.enabled` | 布尔 | 开 |
| 维护 | 清理缓存（asr / 画面 / 全部） | 按钮 | — |

### 12.4 参考实现（实机读过，非猜测）

`dsh-bili-whale` 的 `lib/client.js`（仓库 `Alterssss/dsh-bili-whale`）确认了这些细节：

- 包装：`window.__ModuleLoader__.load({ id, factory })`，`factory(require)` 里 `require("react")`，**无 JSX**。
- 注册：`const inject = ["slots"]`；`ctx.effect(() => ctx.slots.inject("settings.section", () => ctx.slots.register({ name, id, order, label }, Section), "..."), "...")`。
- 数据：全部走同源 `fetch("/dsh-bili/api/*")`；保存时提交**整份配置**（宿主浅合并，未显示字段不会被抹掉）。
- CSS：只用宿主变量 `--dsw-alias-label-primary` / `-border-l2` / `-label-tertiary` / `-brand-primary` / `-label-primary-foreground`。
- 扫码登录：`POST /auth/qr/start` → 轮询 `POST /auth/qr/poll {id}` → `POST /auth/qr/cancel`，成功后用返回的 account 刷新页面状态。
- 主按钮文字色要用 `--dsw-alias-label-primary-foreground`（深色主题下 `brand-primary` 近白，写死 `#fff` 会白底白字）。

## 13. 节能模式（2026-11-10 实现）

入口：DSH 账户菜单 → 设置 →「BiliBridge」→「视频取数（节能模式）」。settings-merge / settings-api 支持以下字段读写与 reset，analysisConfig() / extractConfig() 提供读取。

| 字段 | 类型 | 默认值 | 作用 |
| --- | --- | --- | --- |
| `extract.subtitles` | 布尔 | true | extract / collect 平台字幕 |
| `extract.comments` | 布尔 | true | extract / collect 评论 |
| `extract.danmaku` | 布尔 | true | Stage 1 弹幕 |
| `extract.frames` | 布尔 | true | Stage 1 画面（封面、Uniform 与 Adaptive 九宫格） |
| `adaptive.adaptiveEnabled` | 布尔 | true | Stage 1 自动补充 Adaptive 九宫格 |

### 13.1 预设定义

| 预设 | subtitles | comments | danmaku | frames | adaptiveEnabled |
| --- | --- | --- | --- | --- | --- |
| 节能（仅字幕） | true | false | false | false | false |
| 标准（全量） | true | true | true | true | true |

总结视频推荐「节能（仅字幕）」。预设只修改这五项，不修改预算、ASR/OCR 等其他配置；reset 恢复这五项默认全开值。「仅字幕」不保证存在平台字幕，也不会自动运行 ASR。

### 13.2 优先级、作用范围与边界

- extract 设置是 `bilibili_extract` / `bilibili_collect` 的默认取数上限。collect 在已有评论、字幕采集范围内遵守对应设置，不因此新增画面或弹幕采集。
- 有效来源为设置开启 **AND** 调用方未用 `include=false` 关闭；`include=true` 不能越过设置。全开也不强制每次取全量，字幕续取等既有规则仍适用。
- 主动关闭的来源在 sources 中为 `status='skipped'`，标记 `skippedBy='settings'` 或 `'caller'`；两者都关闭时设置原因优先。主动跳过不误报缺失 gaps，`bundle.danmaku.status` / `bundle.comments.status` 与 sources 一致。
- `subtitleCursor` / `danmakuWindow` 与对应字幕或弹幕来源被设置或 include 关闭冲突时，返回 `INVALID_ARGUMENT`，不会重新启用来源。
- `extract.frames=false` 关闭 Stage 1 画面，即使 adaptive 开启也不能恢复；frames 开启、adaptive 关闭时仍可取封面与 Uniform 九宫格。adaptive 开关只影响 Stage 1 自动补充九宫格。
- 显式 `bilibili_comments`、`bilibili_inspect`、`bilibili_transcribe` 不受这五项限制，包括 inspect 的显式自适应选帧；仍遵守各自预算及 ASR/OCR 硬禁用设置。
- **设置保存后下一次调用生效；代码更新需重启 DSH。**

自动测试：`npm.cmd run test:single` 250/250；不代表真实 B 站取数或 DSH 宿主设置页验收完成。
