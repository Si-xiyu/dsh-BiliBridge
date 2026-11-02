# 开工提示词：设置面板（拷进新 session 即可）

下面整段是给新会话的提示词。粘贴时保持原样即可。

---

你是本仓库的实现 agent。工作目录 `E:\Code\dsh-BiliBridge`（DSH 的 B站插件）。

## 任务
按 `docs/settings-panel.md` 实现「设置 → B站工具」这一页（DSH `settings.section`）：
先做 P0 最小可用的 section，验收通过后依次做 P1（只读仪表盘）、P2（可写设置）、P3（操作与历史）。

## 开工前必读
1. `docs/settings-panel.md`（设计、路由契约、字段表、代码骨架、坑）
2. `docs/state.md`（项目现状与既有约定）
3. `lib/index.js`（apply 入口、`WRITE_TOOLS` 与 `tools/pre-execute` 审批钩子）
4. `lib/bili/store.mjs`（`dataDir()`、`readJson` / `writeJsonAtomic`）
5. `lib/media/analysis-config.mjs`（config.json 的 budget/cache/asrModel 读取方式）
6. `lib/media/budget.mjs`、`lib/media/ffmpeg.mjs`（`resetFfmpegCache`）、`lib/bili/auth.mjs`（`status`）

## 分支
从 `auto-dev` 切一个 `feat/settings-panel`，所有工作在该分支完成。

## P0（先做这个，做完停下来汇报）
- 新增 `lib/client.js`：手写 `window.__ModuleLoader__.load({ id, factory })` 包装，
  只 `require('react')`，在 `apply(ctx)` 里 `ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'bilibili-bridge', order: 200, label: () => 'B站工具' }, Section))`。
  页面先只渲染标题 + 一行说明文字。
- `package.json` 加 `exports["./client"]` 与 `"dsh": { "client": { "inject": [], "platform": "web" } }`（`bundle.patch` 保持不变）。
- 不要动宿主路由，不要动其它模块。

## P1 起（P0 通过后）
按设计的顺序做：`lib/settings-api.mjs` 的 `/bilibili-bridge/api/status`、页面四块只读信息、
`GET/POST /settings`、`POST /cache/clear`；`budget.mjs` 补 `listAnalyses()`。

## 硬性约束
- 不新增 npm 依赖，不引入打包器；client 用手写 `createElement` + 内联 CSS（宿主 CSS 变量）。
- 不改 `tools/pre-execute` 的审批策略；写工具仍然只有 `intent=apply` 才审批。
- 页面不直接读写文件、不暴露凭据内容（只给路径与"是否已登录"）。
- 同源写接口必须做信任检查（loopback + origin），并做服务端范围校验。
- 同一路径的 GET/POST 必须注册成一个 handler（`exact` 表按 path 唯一）。
- 代码风格跟仓库一致：中文注释解释"为什么"、错误用 `BiliError`、返回值必须可 JSON 序列化。
- 每完成一个阶段：更新 `docs/state.md`，用中文写 commit body，然后跑 `npm run test:single`。

## 验证
- 单测：`npm run test:single`（基线 97/97 必须保持，可新增）。
- 宿主验证：告诉用户"请重启 DSH"，重启后由我或用户确认设置面板出现；你负责把需要重启的原因写清楚。
- P0 的验收标准只有一个：**设置左侧出现「B站工具」，点开有内容**。不通过就停下排查，不要继续写 P1。

## 汇报格式
每个阶段结束给：改了哪些文件、关键决策、验收结果（含截图/数据）、没验证的部分、下一步。
