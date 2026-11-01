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
lib/tools/    DSH 适配层（唯一接触 ctx 的地方）：18 个工具 + 写操作审批门禁
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
| ffmpeg 配置 | `%USERPROFILE%\.dsh\bilibili\config.json` 的 `ffmpegPath` + `ffmpegCaFile`；也可用 `FFMPEG_PATH` / `FFMPEG_CA_FILE` |
| CA 证书 | `%USERPROFILE%\.dsh\bilibili\cacert.pem`（Mozilla 根证书，来自 certifi） |
| B站登录态 | **本机未登录**（旧 Mac 的凭据不跨机器） |

**为什么 Windows 上必须给 CA**：gyan 的构建是 gnutls，且不读 Windows 证书库，直连 B站 CDN 会报
`Peer certificate failed verification`。给 `-ca_file` 后正常；Node 侧不受影响（undici 自带信任链）。

## 3. 现在能做什么

18 个工具在宿主内全部可见（本会话已实测）。状态以 `docs/capability-matrix.md` 为准。摘要：

- 认证：扫码登录、状态、退出（凭据仅当前用户可读：POSIX 0600 / Windows icacls）
- 读：当前账号、视频元数据与统计、投稿列表、用户主页、搜索（视频/用户）、评论（含楼中楼）、动态（用户/关注流）
- 集合：稍后观看列表、收藏夹与内容
- 写（需审批）：稍后观看增删、收藏/取消、点赞/取消
- 视频理解：
  - `bilibili_extract`：Stage 1 证据包（字幕/弹幕/评论/封面 + 故事板九宫格）
  - `bilibili_inspect`：Stage 2 定向补帧，**默认 ffmpeg 精确抽帧**（误差 ≤100ms），
    没有 ffmpeg / 播放地址失效时自动降级故事板，并返回真实 `maxErrorMs`

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
frames   : ffmpeg exact maxErrorMs 100 count 2
detail   : 10000->10000 60000->60000
image    : 39303 bytes -> ~/.dsh/bilibili/cache/BV1GJ411x7h7/inspect-*.jpg
```

宿主内 `bilibili_inspect({bvid:'BV1GJ411x7h7', timestampsMs:[10000,60000]})`：
`source=ffmpeg`、`accuracy=exact`、`maxErrorMs=100`、`quality=480P`、`imageAttached=true`，
两张真实画面进入主模型上下文（不是故事板缩略图）。

故事板兜底同样如实：`source=storyboard`、`tileGapMs=6000`、`maxErrorMs=3000`
（此前写死的“±1s”是错的，已改为按 index 中位间距计算）。

### 4.3 单测

`npm test` → **32/32**（新增 6 条：playurl 选档/缓存/缺流、故事板间距、ffmpeg 缺失报错）。

### 4.4 未验证

登录态下的完整链路（字幕轨、稍后观看、收藏、写操作）——本机还没扫码。

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

## 6. 还没做的（按顺序）

1. **M8.2 硬字幕 OCR**：无字幕轨时裁底部字幕带拼长图 → OCR → 带时间戳文本行，标 `origin: ocr`。
2. **M8.3 ASR 兜底**：音频流 → 16k wav → 本地转写，标 `origin: asr`；远程转写需单独授权。
3. **账号链路本机验收**：扫码登录 → 字幕轨 / 稍后观看 / 收藏 / 写操作。
4. **计划内但未做**：限流与 412 全局暂停、WBI -403 自动刷新重试、字幕 800 条续取、二阶段强制（`gaps` 字段）。
5. **画质**：未登录只有 480P；1080P 需要登录 + `fourk`。OCR 阶段尤其需要高清帧。

## 7. 环境注意事项

- **ffmpeg 是外部依赖**：换机器要重新放二进制并更新 `config.json`（或设 `FFMPEG_PATH`/`FFMPEG_CA_FILE`）。
  没有它插件照常工作，只是画面降级为故事板（会明确标 `source=storyboard`）。
- **E: 盘只剩约 6.4GB**：模型、二进制、媒体缓存放 D:，不要放仓库盘。
- **sharp 渲染 SVG 文字需要可写的 fontconfig 缓存**：受限进程里会报 `No writable cache directories`；
  宿主内正常。
- **插件改动需要重启 DSH 才生效**（服务端插件没有 HMR）；本轮是因为改了 profile 触发重载才即时可见。

## 8. 复现命令

```powershell
cd E:\Code\dsh-BiliBridge
npm test

# 真抽帧（只用 config.json 里的 ffmpeg 配置）
node tests/manual-frames.mjs BV1GJ411x7h7 auto 10000 60000
node tests/manual-frames.mjs BV1GJ411x7h7 storyboard     # 强制故事板对照

# 匿名证据包（不写账号）
$env:BILI_DATA_DIR="$env:USERPROFILE\.dsh\bilibili"
node tests/manual-evidence.mjs BV1GJ411x7h7

# 只读矩阵（需要登录态）
node tests/manual-read.mjs search "编程" --type video
node tests/manual-read.mjs comments BV1VZWc6dECG --sort hot
```

## 9. 文档地图

| 文件 | 性质 |
| --- | --- |
| `docs/state.md` | **当前状态（本文件）** |
| `docs/capability-matrix.md` | 每个工具的真实 endpoint、验证等级、边界 |
| `docs/plan.md` | 里程碑与门禁 |
| `docs/compatibility.md` | 宿主版本、插件加载方式、平台限制 |
| `docs/risk-probe.md` | 真实账号风控探测记录 + 字幕串台根因 |
| `docs/archive/` | 已归档的一次性文档 |
