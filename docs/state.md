# 当前状态

> 这是**唯一**的当前状态文档。接手的人/agent 只读这一份就能知道项目在哪、什么能用、什么没做。
> 一次性产物（旧 handoff、任务提示词）在 `docs/archive/` 里，仅作历史参考。

更新时间：2026-11-03（Asia/Shanghai）
阶段：**基础读写 P0/P1 与 auto-dev 功能已完成集成**；25 个工具，合并后 161/161 测试通过，真实读取与收藏/稍后观看往返通过。保留设置页 P3、开发者模式、十条设置路由及动态图片/原动态索引；未改审批策略，未重启 DSH。交付与限制见 [read-write-rollout.md](read-write-rollout.md)。以下较早的环境和验收记录保留历史日期，不代表新增工具已经完成宿主验收。

---

## 1. 这是什么

DSH 插件，把 B站只读能力 + 低风险写操作 + 两阶段视频证据，暴露给主 Agent（DeepSeek）。
主 Agent 是唯一推理模型；插件只做数据获取与证据整理。

```
lib/bili/     B站客户端（不依赖 DSH）：http/wbi/auth/store/api/playurl/collections/comments/dynamics/search/user
lib/media/    证据生产（不调用模型）：subtitles/danmaku/comments/frames/inspect/evidence/ffmpeg
lib/tools/    DSH 适配层（唯一接触 ctx 的地方）：25 个工具 + 写操作审批门禁
bin/bili.mjs  开发 CLI（登录、latest、watchlater、dry-run 写操作）
```

## 2. 运行环境

| 项 | 值 |
| --- | --- |
| 主机 | Windows 11（NT 10.0.26200），x64 |
| Node | v24.16.0 |
| DSH | desktop runtime 0.2.1-rc.5（asar 内 `dsh/package.json`） |
| 仓库 | `E:\Code\dsh-BiliBridge` |
| 插件安装 | junction：`%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-bilibili-bridge` → 仓库；profile 的 `dependencies` 与 `dsh.profile.bundles` 已登记（备份：`*.bak-20261102`） |
| 数据目录 | `%USERPROFILE%\.dsh\bilibili`（可用 `BILI_DATA_DIR` 覆盖） |
| npm 依赖 | `sharp@0.35.5`、`qrcode@1.5.4`（锁定在 `package-lock.json`） |
| 外部依赖 | **ffmpeg 9.0.2**（gyan essentials 静态包，`D:\tools\ffmpeg\ffmpeg-9.0.2-essentials_build\bin\ffmpeg.exe`） |
| ASR 运行时 | **faster-whisper 1.2.1**（Python 3.12 venv：`D:\tools\asr\.venv`，模型 `D:\tools\asr\models`，默认 `small`） |
| ffmpeg 配置 | `%USERPROFILE%\.dsh\bilibili\config.json` 的 `ffmpegPath` + `ffmpegCaFile`；也可用 `FFMPEG_PATH` / `FFMPEG_CA_FILE` |
| CA 证书 | `%USERPROFILE%\.dsh\bilibili\cacert.pem`（Mozilla 根证书，来自 certifi） |
| B站登录态 | **已登录**：`四夕羽_`（mid 215407733，level 6，VIP）；凭据 `credentials.json` 的 ACL 已收紧为仅 `VERDANT\16832:(F)` |

**为什么 Windows 上必须给 CA**：gyan 的构建是 gnutls，且不读 Windows 证书库，直连 B站 CDN 会报
`Peer certificate failed verification`。给 `-ca_file` 后正常；Node 侧不受影响（undici 自带信任链）。

## 3. 现在能做什么

25 个工具。状态以 `docs/capability-matrix.md` 与本轮 `docs/read-write-rollout.md` 为准。摘要：

- 本轮新增：discover（热门/热搜/周刊/榜单）、notifications（含私信会话摘要）、comment_send、message_send、dynamic_publish、collect。
- extract 是单视频平台文本入口，支持 subtitleCursor 与 danmakuWindow；保留 inspect / transcribe。
- 发送类共用 JSONL 账本、五分钟判重、未决长期保护、预览 token 与只读核对；账号写入统一间隔/退避/风控暂停。

- 认证：扫码登录、状态、退出（凭据仅当前用户可读：POSIX 0600 / Windows icacls）
- 读：当前账号、视频元数据与统计、投稿列表、用户主页、搜索（视频/用户）、评论（含楼中楼）、动态（用户/关注流）
- 集合：稍后观看列表、收藏夹与内容
- 写（dry-run 默认 + 审批）：稍后观看增删、收藏/取消、点赞/取消
  - 默认 `intent=preview`：只回读当前状态，不发写请求（实测 like=false、watch_later=true 均为只读）
  - `intent=apply`：真写后回读校验（3 次退避轮询，容忍最终一致性）；结果不明时先回读和解，不盲目重试；收藏夹必须显式 `mediaId`
  - 实测（BV1KDNA6eEgr）：点赞 → verified → 取消 → verified → 状态还原；期间发现并修掉两个真 bug：取消点赞参数应为 `like=2`（0 会被拒）、写完立刻回读会读到旧值
- 视频理解（Fast Path / Deep Path，2026-11-02 定稿）：
  - `bilibili_extract`（Stage 1，秒级）：元信息 / 平台字幕 / 弹幕 / 评论 / 封面 / 故事板九宫格
    （跨全部雪碧图，覆盖整条时间轴）+ `gaps[]` / `suggestedWindows[]` / `evidenceLevel`。
    **不跑 ASR、不跑 OCR**；没有平台字幕就 `subtitles.status="empty"`。
  - `bilibili_inspect`（Stage 2）：定点取真实帧，ffmpeg 优先（误差约一帧，不给毫秒上界），
    失败自动降级故事板（多雪碧图定位，如实报 `maxErrorMs`）；可选 `ocr`（整帧/字幕带）与 `subtitleWindow` 窗口连续 OCR。
  - `bilibili_transcribe`（Stage 2）：窗口化 ASR，默认 30s、上限 300s，时间戳落在原视频轴；越界窗口报 INVALID_ARGUMENT。

## 4. 历史本机验证记录（2026-11-02）

### 4.1 匿名真实接口（2026-11-02）

```
view        ok  【官方 MV】Never Gonna Give You Up / 213s / cid 137649199
subtitles   empty, tracks 0        ← 匿名不给字幕轨，需要登录
danmaku     ok  total 1200, 8 桶
storyboard  ok  10×10 网格，index 33 格有效
overview    ok  封面 651KB + 九宫格 89KB，0 warning
```

### 4.2 真抽帧（M8.1，2026-11-02）

`node tests/manual-frames.mjs BV1GJ411x7h7 auto 10000 60000`（只靠 `config.json`，不设环境变量）：

```
toolchain: D:/tools/ffmpeg/ffmpeg-9.0.2-essentials_build/bin/ffmpeg.exe
ca       : C:/Users/16832/.dsh/bilibili/cacert.pem
playurl  : dash 480P accept 112/80/64/32/16
frames   : ffmpeg frame-level maxErrorMs null count 2
detail   : 10000->10000 60000->60000
image    : 39303 bytes -> ~/.dsh/bilibili/cache/BV1GJ411x7h7/inspect-*.jpg
```

宿主内 `bilibili_inspect({bvid:'BV1GJ411x7h7', timestampsMs:[10000,60000]})`：
`source=ffmpeg`、`accuracy=frame-level`、`maxErrorMs=null`（不声明毫秒上界）、`quality=480P`、`imageAttached=true`，
两张真实画面进入主模型上下文（不是故事板缩略图）。

故事板兜底同样如实：`source=storyboard`、`tileGapMs=6000`、`maxErrorMs=3000`
（此前写死的“±1s”是错的，已改为按 index 中位间距计算）。

### 4.3 单测

`npm test` → **97/97**（媒体 6 条：playurl 选档/缓存/缺流、故事板间距、ffmpeg 缺失；存储 6 条：BOM 解析、fallback、数据目录优先级、原子写、Windows ACL）。

### 4.5 Stage 2 宿主内验收（2026-11-02 重启后）

| 调用 | 结果 |
| --- | --- |
| `bilibili_transcribe(BV1KDNA6eEgr, 0–20s)` | 缓存命中、瞬时返回；9 段中文、`verdict=ok`；预算 `rounds 1/6`、`audioSecondsUsed 0`（命中不扣音频） |
| `bilibili_inspect(30s, ocr, subtitle-band)` | `source=ffmpeg`、1080P、`accuracy=frame-level`、`maxErrorMs=null`；OCR 文本与画面硬字幕一致 |
| `bilibili_video_like_set`（不带 intent） | dry-run 预览放行、不发写请求；`intent=apply` 才触发审批 |

### 4.4 Windows 登录态全量验收（2026-11-02）

扫码成功（`四夕羽_` / mid 215407733 / level 6 / VIP），随后把 macOS 上验过的链路逐项在本机跑了一遍：

| 能力 | 本机结果 | 与 Mac 记录对比 |
| --- | --- | --- |
| `auth_status` / `me` | 已登录，mid 215407733，coin 450.6 | 一致 |
| `user_videos`（不传 mid） | 2 条投稿，最新 `BV18n5nz8E6n`（播放 156） | 一致 |
| `watch_later_list` | 39 条 | Mac 38（期间新增 1） |
| `favorites_list` | 19 个收藏夹 | 一致 |
| `search` | total=1000，高亮标签已剥离 | 一致 |
| `comments` | total=2272，含楼中楼 | Mac 2234（增长） |
| `user_profile` | fans 60326 / following 310 / archiveCount 2201 | Mac 60152 / 310 / 2193（增长） |
| `dynamics` | 关注流 2 条，`dsh:` 游标 | 一致 |
| `extract`（BV1KDNA6eEgr） | 字幕 `ai-zh` 190 cues 覆盖 100%、弹幕 213、热评含楼中楼、封面 + 九宫格，`imageAttached=true` | 一致 |
| `extract`（BV1VZWc6dECG，55 分钟） | 字幕 `ok` 但 `truncated=true`（800 条，覆盖到 28:17） | 一致（1576 条截断） |
| `inspect` | `source=ffmpeg`、`frame-level`、`maxErrorMs=null`、**1080P**、`imageAttached=true` | Mac 只有故事板，本机更好 |
| 写操作 dry-run（like / wl / fav） | bvid→aid 解析正常，未提交 | 一致 |

**新发现**：匿名请求 `player/wbi/v2` 返回 0 条字幕轨，登录后同一视频有 190 条 —— **字幕列表是登录后才有的**，
所以“匿名没字幕”不能当作“这个视频没有字幕”。


## 5. 既有媒体层与设置页完成记录

### 5.1 Windows 平台适配（M8.0）

| 改动 | 位置 | 原因 |
| --- | --- | --- |
| 请求头统一（一套 UA/Referer） | `lib/bili/http.mjs` | 接口、弹幕、故事板、字幕原先各用一套指纹 |
| `fetchBuffer` + 域名白名单 | `lib/bili/http.mjs` | 媒体下载统一入口；阻断内网/非 B站 地址（SSRF） |
| 故事板改走 `request` | `lib/media/frames.mjs` | 原来裸 `fetch`，无 Referer、无错误码映射 |
| 凭据 ACL 收紧（icacls） | `lib/bili/store.mjs` | NTFS 上 `chmod 0600` 只切只读位，等于没有 |
| `readJson` 剥 BOM | `lib/bili/store.mjs` | Windows 写的配置带 BOM 会让 JSON.parse 失败，配置“悄悄不生效” |
| 临时目录跨平台 | `tests/manual-read.mjs` | `/tmp` 在 Windows 落到当前盘根 |
| 探针不再硬编码外部路径 | `tests/probe-browser-*.mjs` | 原来 require 了另一个 macOS 项目的 playwright |

### 5.2 媒体层 M8.1：真抽帧

- 新增 `lib/bili/playurl.mjs`：WBI 签名的 `player/wbi/playurl`，DASH/durl 双格式，
  按 `qn` 选不超过请求值的最高档（低于全部档位时给最低档），进程内缓存 20 分钟。
  **URL 只留在内存**，绝不进入工具返回值。
- 新增 `lib/media/ffmpeg.mjs`：工具链解析（`FFMPEG_PATH`/config/PATH）、CA 解析、超时与取消、
  stderr 落文件回读、`-ss` 输入侧抽帧、16k 单声道音频抽取。
- `lib/media/inspect.mjs` 重写：`source=auto|ffmpeg|storyboard`；ffmpeg 失败自动降级并带回
  `fallbackReason`；精度不再写死，故事板按 `index` 中位间距算 `maxErrorMs`；补帧目标超出有效格数时标 `reused`。
- 分 P 不存在时**报错**而不是静默用第 1 个分 P（`evidence.mjs` / `extract.mjs`）。

### 5.3 Stage 1 瘦身（M8.5）

- `bilibili_extract` 不再跑 ASR/OCR：删掉 `subtitleSource` / `asrMaxSeconds` / `asrLanguage` / `include.ocr`。
- 字幕只有平台一路：UP 主上传优先，其次 AI 字幕；没有就 `subtitles.status="empty"`（`insufficient` 这个
  Stage 2 结论从 Stage 1 移除）。
- 覆盖度拆成两个指标，别混用：
  - `subtitles.coverage`：**区间并集 / 时长**（句子之间的气口会算进去，正常视频 0.95–0.99）。
  - `subtitles.coveredToMs` 与状态判定用的 extent：**完整字幕轨末端 / 时长**（判"轨道有没有断在中间"）。
- "只返回前 800 条"是第三件事，用 `truncated` + `SUBTITLE_TRUNCATED` 单独提示，不并进 `partial`。
- 新增线索字段：`gaps[]`（`no_subtitles` / `subtitles_partial` / `no_danmaku` / `no_comments` / `no_visual`）、
  `suggestedWindows[]`（弹幕密度峰值前 3，纯计算）、`evidenceLevel`（`rich` / `text-only` / `thin`）。
- `schemaVersion` 升到 `2`。实测：有字幕视频 411ms（level=rich）、无字幕视频 831ms（level=text-only）。

### 5.4 故事板多雪碧图（M8.6）

- B站 长视频的故事板是**多张雪碧图**（55 分钟视频 `images=4`、`index=397`），
  `index[i]` 跨图连续编号：`sprite = floor(i/(cols*rows))`。
- 旧实现只读 `images[0]` 且把格数夹在 100 格 → 九宫格只覆盖前 816s（全片 1/4）；
  `inspect` 兜底更糟——请求 2000s 会静默落到第 99 格（816s）却标成请求时间。
- 现在：`locateStoryboardOrder` 跨全部 index 二分定位，`loadStoryboardSprite` 按图 24h 缓存，
  概览跨全部雪碧图均匀取 9 格并返回 `coverage` / `spritesUsed`。
- 实测：概览 `coverage 0–3289s`、`spritesUsed=4`；2000s/3200s 分别落到第 3/4 张图。

### 5.5 ASR：适配层 + 常驻 worker（M8.3a/M8.3c）

- `lib/media/asr_worker.py` + `lib/media/asr.mjs`：faster-whisper（CPU int8、默认 `small`、自动语言、
  `vad_filter`），绕开 PyAV 解码（用标准库读 16k 单声道 wav 成 numpy 数组）。
- 实测：中文 90s 55.7s（`avg_logprob -0.20`）、英文 60s 23.5s（`-0.075`，自动识别为 `en`）。
- 已接成 Stage 2 工具 `bilibili_transcribe`，并升级成**常驻 worker**：
  - 懒启动、空闲 300s 退出、崩溃后下次调用重启、工具整体 600s；client 单请求 120s 超时（可覆盖）、AbortSignal 取消、串行队列。
  - Windows 坑：stdin 保持打开 + 读线程阻塞时，主线程导入 numpy/onnxruntime 这类 C 扩展会死锁；已改为起线程前预加载。
  - 实测：冷启 18.0s → 同 worker 复用 4.1s；缓存命中约 60ms。
- 预算与缓存：`bundleId` 在 TTL（2h）内按 `(bvid,cid)` 复用，轮次 6 / 音频 900s（可配置）；
  缓存命中只占一轮、不扣音频秒数；失败只退音频、不退轮次；账本只在内存，重启丢失。
## 5.6 设置页 P0（2026-11-02）

- `lib/client.js`：`settings.section` 注册「B站工具」（id `bilibili-bridge`、order 200）。
- `package.json`：`exports["./client"]` + `dsh.client = { inject: [], platform: "web" }`。
- 视觉验收需要**重启 DSH** 后打开设置查看；P1 才接 `/bilibili-bridge/api/*`。

## 5.7 设置页 P1：只读仪表盘（2026-11-02）

- 宿主：`lib/settings-api.mjs`，用 `ctx.inject(['webServer','loader'], …)` 懒注册两条 `kind: 'exact'` 路由：
  - `GET /bilibili-bridge/api/status`：账号（含 face/凭据路径，不含内容）、运行时（ffmpeg/ASR/OCR 探测）、
    预算（`listAnalyses()`）、缓存统计（按真实文件名归类：asr / storyboard / cover / inspect / avatar / 其它）。
  - `GET /bilibili-bridge/api/avatar`：逐跳校验 https + `*.hdslb.com`、最多 3 跳、20s 超时、流式 4MB 上限、
    24h 落盘缓存，不携带账号 Cookie。
- 页面：账号 / 运行时 / 预算 / 缓存四块 + 刷新；每个分区带 `ok/code`，失败显示「读取失败（错误码）」，
  不会把故障画成空数据。
- 实测（宿主进程内直调 handler）：`status` 200 / 604–1121ms，无凭据泄漏；`avatar` 200、56KB，二次 59–63ms 命中缓存；非 GET 405。
- 生效方式：路由在插件加载时注册，**需要重启 DSH**；之后改前端只刷新页面即可。

## 5.8 设置页 P2：可写设置（2026-11-02）

- 新增 `lib/media/settings-merge.mjs`：白名单合并（budget/cache/asr/ocr）、严格类型与范围、
  ASR 两窗口关系校验、`trustedRequest` 来源判定。
- `GET/POST /bilibili-bridge/api/settings`（同一 path 一个 handler）：
  - POST 先做 fail-closed 来源校验（回环远端 + 回环 Host + 同源 Origin/Referer，Host 用来源协议归一化），
    再限 64KB、要求请求体是对象；`revision` 不一致返回 409 `STALE_REVISION`。
  - 保存串行化（进程内队列），校验失败整份不写；配置 JSON 损坏时 409 `CONFIG_CORRUPT` 且拒写。
  - 写入走 `writeJsonAtomic`（临时文件名带 randomUUID），未知键原样保留，响应只投影已知字段。
- 页面新增「设置」表单：预算（轮次/音频额度/TTL）、缓存（开关/保留天数）、视频理解（ASR 开关/模型/默认窗口/单次上限/OCR 开关）；
  只提交改动字段、显示逐条错误、保存成功提示「下一次调用生效」。
- 实测（临时数据目录直调 handler）：非法值 400 且文件不变；跨站 403；合法保存 200 且 `ffmpegPath`/`note` 保留；响应不含未知字段。
- 生效方式：路由需要**重启 DSH**；之后改设置即时生效（analysisConfig 每次调用重读）。

## 5.9 设置页 P3：缓存清理、账号操作与最近调用（2026-11-03）

- 新路由：`POST /cache/clear`（scope `asr|media|all`）、`POST /account/logout`、`POST /account/qr/start`、
  `POST /account/qr/poll`、`GET /history?limit=`。
- 清理只删**已知布局**（asr 的 64 位 hex json、BV 目录下的 cover/storyboard/sprite/inspect），
  跳过 60 秒内修改过的文件，删除前重新 stat 复核；缓存根是符号链接时直接拒绝；头像缓存永远保留。
- 扫码：对外只暴露随机会话 id（B站 qrcode_key 留在服务端），每次 start / logout 都清空旧会话，
  在途 confirmed 不会在退出后把凭据写回。
- 最近调用：`history.jsonl`（保留 200 行，进程内队列 + 跨进程文件锁 + 原子替换），
  `transcribe` 与 `inspect` 各记成功/失败、耗时、缓存命中与关键参数。
- 实测：asr 清 10B / media 清 30B / 不认识的 `notes.txt` 保留 / 跨站 403 / 非法 scope 400 / history 返回 2 条 / qr 返回 data URL。
- 生效方式：路由需要**重启 DSH**。

## 5.10 开发者模式（2026-11-03）

- 开关：`config.json` 的 `dev.enabled`（默认关），设置页「开发者」分组里可改，改完下一次调用生效（开关有 2 秒缓存）。
- 记录：`lib/devlog.mjs` 包住 `registerTool` 的 execute，记录 id / 时间 / 工具 / 脱敏参数 / 成功状态 / 错误码 / 耗时 / 结果字节与 4KB 预览；
  参数限 2KB，超限标 `truncated`；内存 200 条、`devlog.jsonl` 保留 500 行（进程内队列 + 文件锁 + 原子替换 + `restrictFile`）。
- 脱敏：敏感键、`k=v` 文本、URL 编码形式、长不透明串（JWT/base64）、含 `upsig`/`deadline` 的 URL 全部打码；宁多勿少。
- 查看：设置页「最近调用」列表（2 秒轮询，可展开参数与结果）；对话内右下角浮层（`shell.overlay`，注册失败静默跳过，不影响设置页）。
- 接口：`GET /dev/log?since=&limit=`（同样做来源校验，关闭时返回空）、`POST /dev/clear`。
- 记录不阻塞工具返回：内存先记、落盘走后台队列。

## 6. 还没做的（按顺序）

1. **本轮待验收**：新增工具在合并与重启后的宿主调用；评论、私信、图床与动态真实发送。收藏/稍后观看已在 2026-11-03 完成往返并恢复。
2. **计划内但未做**：WBI -403 自动刷新、概览用真帧（M8.1b）。写限流、账号写入 412/429 暂停和字幕续取已实现。
3. **长视频整片转写**：不设默认入口；用户显式授权后再考虑。
4. **`docs/agents.md`**：子任务分工、worktree 流程与评审约定，尚未写。
5. **OCR 缓存接入 inspect**：接口已备（`readOcrCache`/`writeOcrCache`），窗口 OCR 还没用上。
## 7. 环境注意事项

- **ffmpeg 是外部依赖**：换机器要重新放二进制并更新 `config.json`（或设 `FFMPEG_PATH`/`FFMPEG_CA_FILE`）。
  没有它插件照常工作，只是画面降级为故事板（会明确标 `source=storyboard`）。
- **E: 盘只剩约 6.4GB**：模型、二进制、媒体缓存放 D:，不要放仓库盘。
- **sharp 渲染 SVG 文字需要可写的 fontconfig 缓存**：受限进程里会报 `No writable cache directories`；
  宿主内正常。
- **插件改动需要重启 DSH 才生效**（服务端插件没有 HMR）；本轮是因为改了 profile 触发重载才即时可见。

## 8. 换机器迁移清单

代码可以 clone，但**这些不在仓库里**，换一台机器必须重做：

| 项 | 做什么 | 漏了会怎样 |
| --- | --- | --- |
| npm 依赖 | `npm install`（`sharp`、`qrcode`） | 插件加载失败 / 图片合成不可用 |
| ffmpeg | 放二进制，写 `config.json#ffmpegPath`（或 `FFMPEG_PATH`） | 画面降级故事板，`inspect` 精度 ±3s |
| CA 证书 | `cacert.pem` 放数据目录（或 `FFMPEG_CA_FILE`） | Windows 上 ffmpeg 连 CDN 报证书失败，同样降级 |
| B站登录 | 重新扫码（或复制 `credentials.json`，但新 IP 可能触发风控） | 字幕 0 条、稍后观看/收藏全部 `AUTH_REQUIRED` |
| profile 接线 | `desktop/node_modules/dsh-bilibili-bridge` junction + `package.json` 的 `dependencies` / `dsh.profile.bundles` | 宿主无法加载插件；本轮合并后应为 25 个工具 |
| 重启宿主 | 插件没有 HMR | 改动不生效，容易出现“脚本结论和宿主不一致” |

平台差异（Windows）：`chmod 0600` 无效 → 用 icacls；`/tmp` 落到盘根 → 用 `os.tmpdir()`；
ffmpeg 的 gnutls 构建不读系统证书库 → 必须给 `-ca_file`。

## 9. 复现命令

```powershell
cd E:\Code\dsh-BiliBridge
npm test

# 真抽帧（只用 config.json 里的 ffmpeg 配置）
node tests/manual-frames.mjs BV1GJ411x7h7 auto 10000 60000
node tests/manual-frames.mjs BV1GJ411x7h7 storyboard     # 强制故事板对照

# 硬字幕带长图 / OCR 验证
node tests/manual-ocr.mjs BV1pTx76QE8J 12 0.22

# 匿名证据包（不写账号）
$env:BILI_DATA_DIR="$env:USERPROFILE\.dsh\bilibili"
node tests/manual-evidence.mjs BV1GJ411x7h7

# 只读矩阵（需要登录态）
node tests/manual-read.mjs search "编程" --type video
node tests/manual-read.mjs comments BV1VZWc6dECG --sort hot
```

## 10. 文档地图

| 文件 | 性质 |
| --- | --- |
| `docs/state.md` | **当前状态（本文件）** |
| `docs/capability-matrix.md` | 每个工具的真实 endpoint、验证等级、边界 |
| `docs/plan.md` | 里程碑与门禁 |
| `docs/compatibility.md` | 宿主版本、插件加载方式、平台限制 |
| `docs/risk-probe.md` | 真实账号风控探测记录 + 字幕串台根因 |
| `docs/archive/` | 已归档的一次性文档 |
