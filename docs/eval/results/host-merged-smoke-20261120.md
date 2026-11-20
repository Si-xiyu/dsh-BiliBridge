# 2026-11-20 DSH 宿主合并验收 smoke

## 加载确认

- DSH profile `~/.dsh/profiles/desktop` 的 `dsh-bilibili-bridge` 已指向
  `.agents/worktrees/merged-acceptance`（分支 `acceptance/merged-20261120`，合并提交 `c550c43`）。
- 宿主实际行为确认加载的是合并代码：
  - `bilibili_extract` 返回 T4 的弹幕聚类字段（`×27`、`×94`、`×174`），fix 分支没有；
  - 同一结果用 T1/T2 紧凑 JSON + `§data.danmaku.*` 段落渲染，fix 分支没有；
  - `suggestedWindows` 带 D1 的 `lagCalibratedSec`；
  - `bilibili_content_manage list_drafts` 的 provenance 是 `timing/draft/list + dynamic_draft/get_drafts`；
  - `bilibili_dynamics` 详情返回 Opus 正文与图片 URL。

## 合并树代码侧验收

在合并 worktree 用隔离数据目录跑：

```bash
node tests/manual-tool-acceptance.mjs --media
```

结果：27 个工具注册，**18 个只读入口通过，exit 0**；包含真实抽帧、窗口 ASR、收藏夹内容、动态、通知、私信、草稿列表、采集。

合并后单元测试：`npm test` / `npm run test:single` 均 **377 个、376 通过、1 跳过**。

## 宿主真实调用

已验证：

- `bilibili_auth_status`：登录正常。
- `bilibili_extract`：元信息、T4 弹幕聚类、D1 窗口、T1/T2 渲染。
- `bilibili_dynamics`（Opus 详情）：正文/图片 URL。
- `bilibili_content_manage list_drafts`：新版/旧版草稿列表。
- `bilibili_notifications unread`：未读计数。
- 图片附件：`bilibili_dynamics` + `includeImages=true` 返回 `imageAttached=true`、`imageChannel=attached`，模型实际收到 1 张图片。

未验证：

- 写操作/审批：本轮未授权，且不是合并新增路径。
- 图片附件真实入模已在合并宿主验证 1 张；多图/OCR 画面路径仍可补测。
- M1 精确 token：没有逐调用 token 读取接口；需要从 DSH 界面/会话统计读取，或单独做宿主基准会话。

## 结论

合并代码在宿主的只读路径上可用；没有发现合并导致的 27 工具注册或读取回归。**仍不能提交合并**：M1 精确 token、写操作/审批、图片入模和完整 27 工具宿主回归未完成。
