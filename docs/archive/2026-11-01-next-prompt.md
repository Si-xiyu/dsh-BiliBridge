# 下一步任务提示词（交给编码 Agent）

把下面整段复制给执行编码的 Agent。评审方（我）只做验收，不改实现。

---

## 任务：补齐 B站只读矩阵（搜索 / 评论 / 用户主页 / 动态）

仓库：`/Users/kairos/Code/agent/dsh-BiliBridge`
先读：`README.md`、`docs/handoff.md`、`docs/plan.md`、`lib/bili/*.mjs`、`lib/tools/*.mjs`，再动手。

### 背景

这是一个 DSH 插件，向主 Agent（DeepSeek）暴露 B站原子工具。当前已有 14 个工具（登录、视频、投稿、稍后观看、收藏、点赞、extract、inspect）。本轮只补**只读**能力，不做任何写操作。

### 硬约束

- ESM JavaScript，无 TypeScript 构建；Node 20+。
- 唯一推理模型是 DSH 主 Agent；**不得调用任何 LLM/VLM/ASR**，不得引入外部模型服务。
- 所有 B站请求走 `lib/bili/http.mjs` 的 `request` / `postForm`；WBI 用 `lib/bili/wbi.mjs` 的 `getWbiKeys` + `signQuery`。
- 工具返回值必须是 lossless JSON：用 `lib/tools/helpers.mjs` 的 `registerTool`（已统一 `sanitizeJson`），不要返回 `undefined` 字段、Buffer、类实例。
- 错误用 `BiliError`：`AUTH_REQUIRED` / `RISK_CONTROLLED` / `RATE_LIMITED` / `NOT_FOUND` / `INVALID_ARGUMENT`。**禁止**把 412/-352 伪装成空列表或成功。
- 凭据在 `~/.dsh/bilibili/credentials.json`；不得读取、打印、提交其内容。手工测试用 `BILI_DATA_DIR=~/.dsh/bilibili`。
- 不新增依赖；如果确实需要，先在报告里说明理由。
- 不提交 `.bili-data/`、`node_modules/`、二维码、日志、凭据。

### 要实现的 4 个工具

#### 1. `bilibili_search`

- 参数：`keyword`（必填）、`type` = `video|user`（默认 video）、`page`（默认 1）、`pageSize`（默认 20，最大 50）、`order` = `totalrank|click|pubdate|dm`（仅 video）。
- Endpoint：`https://api.bilibili.com/x/web-interface/wbi/search/type`，WBI 签名；`search_type=video|bili_user`。
- 返回：
  - video：`items[]` = `{bvid, title, author, play, danmaku, description, pubdate, url}`；
  - user：`items[]` = `{mid, uname, sign, fans, level, avatar}`；
  - 外层：`{total, page, pageSize, hasMore}`。
- 注意：标题里的 `<em class="keyword">` 要剥掉；空结果返回 `ok` + 空数组。

#### 2. `bilibili_comments`

- 参数：`bvid`（必填）、`sort` = `hot|new`（默认 hot）、`page`（默认 1）、`pageSize`（默认 20，最大 20）、`includeReplies`（默认 true，最多 3 条）。
- Endpoint：先试 `https://api.bilibili.com/x/v2/reply`（`type=1&oid=aid&sort=2|0&ps&pn`）；
  如果返回 -400 或要求 WBI，改用 `https://api.bilibili.com/x/v2/reply/wbi/main`，在代码注释里写清楚为什么。
  楼中楼用 `https://api.bilibili.com/x/v2/reply/reply`（`type=1&oid=aid&root=rpid&ps=20&pn=1`）。
- 返回：`{total, page, pageSize, hasMore, items[]}`，item = `{rpid, user, uid, message, like, replyCount, createdAt, replies[]}`。
- 注意：评论创建时间是绝对时间，不是视频时间轴；长评论截断到 600 字。

#### 3. `bilibili_user_profile`

- 参数：`mid`（必填）。
- Endpoint：`https://api.bilibili.com/x/space/wbi/acc/info`（WBI，需 `buvid3`）+ `https://api.bilibili.com/x/relation/stat?vmid=<mid>`。
- 返回：`{mid, name, sign, level, face, fans, following, archiveCount}`；`archiveCount` 可从 `x/space/wbi/arc/search` 的 `page.count` 拿，拿不到就省略。
- 注意：空间接口风控重；遇到 -352 抛 `RISK_CONTROLLED`，不要重试循环。

#### 4. `bilibili_dynamics`

- 参数：`mid`（可选；省略=关注动态）、`offset`（可选 cursor）、`pageSize`（默认 20）。
- Endpoint：
  - 用户动态：`https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space?host_mid=<mid>&offset=<offset>`
  - 关注流：`https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/all?offset=<offset>&type=all`
- 返回：`{items[], nextOffset, hasMore}`，item = `{dynamicId, type, publishedAt, text, bvid, title, author}`。
- 注意：只投影必要字段，不要把整包 `modules` 返回；图文/转发/视频都要能取到文本与 bvid（没有就省略）；-352/412 抛对应错误。

### 代码组织

新增：

```
lib/bili/search.mjs
lib/bili/comments.mjs
lib/bili/user.mjs
lib/bili/dynamics.mjs
lib/tools/search.mjs
lib/tools/comments.mjs
lib/tools/user.mjs
lib/tools/dynamic.mjs
tests/manual-read.mjs
tests/unit/read.test.mjs
```

- 工具统一用 `registerTool(ctx, {name, description, parameters, timeoutMs, execute})`。
- 在 `lib/index.js` 注册 4 个 `registerXxxTools(ctx)`。
- 归一化函数放在 `lib/bili/*.mjs`，不要直接把 API JSON 透传。
- 所有 id 用字符串；时间用 ISO；分页参数校验上限。
- 空间/动态前调用 `ensureBuvid(jar)`；WBI 签名用 `signQuery`。

### 测试与文档

- `tests/manual-read.mjs`：支持 `search` / `comments` / `profile` / `dynamics` 四个子命令。
- `tests/unit/read.test.mjs`：覆盖 HTML 标签清理、分页参数、动态投影、空结果。
- 更新 `docs/capability-matrix.md`（新建）：每个工具标 `implemented / verified / limited / unsupported`，写真实 endpoint 与实测结果。
- 更新 `README.md` 工具表（从 14 个变 18 个）。

### 验收（必须实际跑，不许只写 mock）

```bash
cd /Users/kairos/Code/agent/dsh-BiliBridge
npm test

# 搜索
BILI_DATA_DIR=~/.dsh/bilibili node tests/manual-read.mjs search "编程" --type video
BILI_DATA_DIR=~/.dsh/bilibili node tests/manual-read.mjs search "影视飓风" --type user

# 评论（公开视频）
BILI_DATA_DIR=~/.dsh/bilibili node tests/manual-read.mjs comments BV1VZWc6dECG --sort hot

# 用户主页（公开 UP）
BILI_DATA_DIR=~/.dsh/bilibili node tests/manual-read.mjs profile 3546637928499654

# 用户动态（公开 UP）
BILI_DATA_DIR=~/.dsh/bilibili node tests/manual-read.mjs dynamics --mid 3546637928499654
```

通过标准：

- 每个工具都有真实返回，字段符合上面的形状。
- 空结果 / 未登录 / 风控 分别表现为 `ok` 空列表 / `AUTH_REQUIRED` / `RISK_CONTROLLED`，不能假装成功。
- `npm test` 全绿。
- `git status` 干净；按模块拆 4–6 个 commit，使用 conventional message。
- 不重启 DSH（评审方负责重启与工具可见性验收）。

### 报告格式

1. 改了哪些文件、每个工具实际 endpoint；
2. 每条验收命令的真实输出摘要（不要贴整包 JSON）；
3. 未通过 / 降级的项，及原因；
4. commit hash 列表；
5. 任何需要评审方注意的风险（风控、字段不稳定、接口可能改版）。

### 不要做

- 不要实现点赞/收藏/评论/私信/发布等写操作；
- 不要调用任何 LLM/VLM/ASR；
- 不要新增依赖；
- 不要把 Cookie、SESSDATA、bili_jct、二维码内容写进代码、日志或报告；
- 不要为了“通过验收”伪造空列表或成功状态。
