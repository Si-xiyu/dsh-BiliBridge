# 当前状态

> 这是**唯一**的当前状态文档。接手的人/agent 只读这一份就能知道项目在哪、什么能用、什么没做。
> 一次性产物（旧 handoff、任务提示词）在 `docs/archive/` 里，仅作历史参考。

更新时间：2026-11-02（Asia/Shanghai）
阶段：**M8 媒体层**（真抽帧 → OCR → ASR 进行中），平台适配已完成。

---

## 1. 这是什么

DSH 插件，把 B站只读能力 + 低风险写操作 + 两阶段视频证据，暴露给主 Agent（DeepSeek）。
主 Agent 是唯一推理模型；插件只做数据获取与证据整理。

```
lib/bili/     B站客户端（不依赖 DSH）：http/wbi/auth/store/api/collections/comments/dynamics/search/user
lib/media/    证据生产（不调用模型）：subtitles/danmaku/comments/frames/inspect/evidence
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
| 数据目录 | `%USERPROFILE%\.dsh\bilibili`（可用 `BILI_DATA_DIR` 覆盖） |
| 运行时依赖 | `sharp@0.35.5`、`qrcode@1.5.4`（已安装） |
| 外部依赖 | **ffmpeg：未装**；OCR：未装；ASR：未装（见第 6 节） |
| B站登录态 | **本机未登录**（凭据在旧 Mac 上，不跨机器） |

## 3. 现在能做什么

18 个工具已实现；状态以 `docs/capability-matrix.md` 为准。摘要：

- 认证：扫码登录、状态、退出（凭据 0600 / Windows 走 icacls）
- 读：当前账号、视频元数据与统计、投稿列表、用户主页、搜索（视频/用户）、评论（含楼中楼）、动态（用户/关注流）
- 集合：稍后观看列表、收藏夹与内容
- 写（需审批）：稍后观看增删、收藏/取消、点赞/取消
- 视频理解：`bilibili_extract`（字幕/弹幕/评论/封面/九宫格）、`bilibili_inspect`（故事板定向补帧）

## 4. 本机验证记录（2026-11-02，匿名真实接口）

```
view        ok  【官方 MV】Never Gonna Give You Up / 213s / cid 137649199
subtitles   empty, tracks 0        ← 匿名不给字幕列表，需要登录
danmaku     ok  total 1200, 8 桶
storyboard  ok  10×10 网格，index 33 格有效
overview    ok  封面 651KB + 九宫格 89KB，0 warning
```

单测：`npm run test:single` → 24/24。
（`npm test` 用 `node --test` 的子进程隔离，在受限沙箱里会 EPERM；本机用 `test:single`。）

**尚未验证**：登录态下的完整链路（字幕轨、稍后观看、收藏、注入宿主的 18 个工具）。
原因见第 7 节。

## 5. 本轮完成：Windows 平台适配

| 改动 | 位置 | 原因 |
| --- | --- | --- |
| 请求头统一（一套 UA/Referer） | `lib/bili/http.mjs` | 原来接口、弹幕、故事板、字幕各用一套指纹，同一视频一次提取露出 4 种客户端 |
| 新增 `fetchBuffer` + 域名白名单 | `lib/bili/http.mjs` | 媒体下载统一走这里；顺带阻断内网/非 B站 地址（SSRF） |
| 故事板改走 `request` | `lib/media/frames.mjs` | 原来裸 `fetch`，无 Referer、无错误码映射 |
| 凭据 ACL 收紧（icacls） | `lib/bili/store.mjs` | NTFS 上 `chmod 0600` 只切只读位，等于没有 |
| 临时目录跨平台 | `tests/manual-read.mjs` | `/tmp` 在 Windows 落到 `E:\tmp` |
| 探针不再硬编码外部路径 | `tests/probe-browser-*.mjs` | 原来 require 了另一个 macOS 项目的 playwright |
| `test:single` 脚本 | `package.json` | 受限环境下跑得动单测 |
| 忽略临时目录 | `.gitignore` | `.tmp-*/`、`.cache/` |

## 6. 还没做的（按顺序）

1. **M4a ffmpeg 真抽帧**（下一步）：`player/wbi/playurl` 取 DASH 流 → `ffmpeg -ss` 精确抽帧；场景检测做概览、`blurdetect` 挑清晰帧；ffmpeg 缺失时回落故事板并标明 `origin`。
2. **M4b 硬字幕 OCR**：无字幕轨时裁底部字幕带拼长图 → OCR → 带时间戳文本行，标 `origin: ocr`。
3. **M4c ASR 兜底**：音频流 → wav → 本地转写，标 `origin: asr`；远程转写需单独授权。
4. **账号链路本机验收**：登录 → 字幕轨 / 稍后观看 / 收藏 / 宿主内 18 工具。
5. **计划内但未做**：限流与 412 全局暂停、WBI -403 自动刷新重试、字幕 800 条续取、二阶段强制机制（`gaps` 字段）。
6. **历史遗留**：`docs/next-prompt.md` 里的只读矩阵任务已完成（18 工具），该文件已归档。

## 7. 环境注意事项

- **本机 shell 写既有文件会被沙箱拒绝**（只有新建文件可写）。改动源码请用编辑工具；`git add/commit` 需要一次 `danger-full-access` 授权。编辑前先重新读取文件，否则会报 "file changed since it was read"。
- **E: 盘只剩约 6.4GB**：模型、二进制、媒体缓存不要放 E:，建议 `D:\tools`、`D:\models`。
- **sharp 渲染 SVG 文字需要可写的 fontconfig 缓存**：受限进程里会报 `No writable cache directories`；插件在宿主里运行不受影响。
- **插件改动需要重启 DSH 才生效**（服务端插件没有 HMR）。

## 8. 复现命令

```powershell
cd E:\Code\dsh-BiliBridge
npm run test:single

# 匿名真实接口自检（不写账号）
$env:BILI_DATA_DIR="E:\Code\dsh-BiliBridge\.tmp-bili-data"
node tests/manual-evidence.mjs BV1GJ411x7h7

# 只读矩阵（需要登录态）
$env:BILI_DATA_DIR="$env:USERPROFILE\.dsh\bilibili"
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
