# 当前状态

> 这是**唯一**的当前状态文档。接手的人/agent 只读这一份就能知道项目在哪、什么能用、什么没做。
> 一次性产物（旧 handoff、任务提示词）在 `docs/archive/` 里，仅作历史参考。

更新时间：2026-11-02（Asia/Shanghai）
阶段：**M8 媒体层**——真抽帧已完成（M8.1）；OCR（M8.2）、ASR（M8.3）未开始。

---

## 1. 这是什么

DSH 插件，把 B站只读能力 + 低风险写操作 + 两阶段视频证据，暴露给主 Agent（DeepSeek）。
主 Agent 是唯一推理模型；插件只做数据获取与证据整理。

```
lib/bili/     B站客户端（不依赖 DSH）：http/wbi/auth/store/api/playurl/collections/comments/dynamics/search/user
lib/media/    证据生产（不调用模型）：subtitles/danmaku/comments/frames/inspect/evidence/ffmpeg
lib/tools/    DSH 适配层（唯一接触 ctx 的地方）：19 个工具 + 写操作审批门禁
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

19 个工具（新增 `bilibili_transcribe`）。状态以 `docs/capability-matrix.md` 为准。摘要：

- 认证：扫码登录、状态、退出（凭据仅当前用户可读：POSIX 0600 / Windows icacls）
- 读：当前账号、视频元数据与统计、投稿列表、用户主页、搜索（视频/用户）、评论（含楼中楼）、动态（用户/关注流）
- 集合：稍后观看列表、收藏夹与内容
- 写（dry-run 默认 + 审批）：稍后观看增删、收藏/取消、点赞/取消
  - 默认 `intent=preview`：只回读当前状态，不发写请求（实测 like=false、watch_later=true 均为只读）
  - `intent=apply`：真写后回读校验；结果不明时先回读和解，不盲目重试；收藏夹必须显式 `mediaId`
- 视频理解（Fast Path / Deep Path，2026-11-02 定稿）：
  - `bilibili_extract`（Stage 1，秒级）：元信息 / 平台字幕 / 弹幕 / 评论 / 封面 / 故事板九宫格
    （跨全部雪碧图，覆盖整条时间轴）+ `gaps[]` / `suggestedWindows[]` / `evidenceLevel`。
    **不跑 ASR、不跑 OCR**；没有平台字幕就 `subtitles.status="empty"`。
  - `bilibili_inspect`（Stage 2）：定点取真实帧，ffmpeg 优先（误差约一帧，不给毫秒上界），
    失败自动降级故事板（多雪碧图定位，如实报 `maxErrorMs`）；可选 `ocr`（整帧/字幕带）与 `subtitleWindow` 窗口连续 OCR。
  - `bilibili_transcribe`（Stage 2）：窗口化 ASR，默认 30s、上限 300s，时间戳落在原视频轴；越界窗口报 INVALID_ARGUMENT。

## 4. 本机验证记录

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

`npm test` → **46/46**（媒体 6 条：playurl 选档/缓存/缺流、故事板间距、ffmpeg 缺失；存储 6 条：BOM 解析、fallback、数据目录优先级、原子写、Windows ACL）。

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


## 5. 本轮完成

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
## 6. 还没做的（按顺序）

1. **真实写操作**：点赞/收藏/稍后观看仍只有 dry-run。
2. **计划内但未做**：限流与 412 全局暂停、WBI -403 自动刷新、字幕 800 条续取、概览用真帧（M8.1b）。
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
| profile 接线 | `desktop/node_modules/dsh-bilibili-bridge` junction + `package.json` 的 `dependencies` / `dsh.profile.bundles` | 宿主里看不到 19 个工具 |
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

# 硬字幕带长图（识别引擎尚未接入）
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
