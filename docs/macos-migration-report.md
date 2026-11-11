# macOS 迁移与安装体验报告

采集时间：2026-11-11（Asia/Shanghai）
目标：在一台干净的 macOS arm64 上装好 dsh-BiliBridge，并记录所有"换机就会踩"的安装/迁移问题。
最初只改了本机安装与工具路径；随后合并 `auto-dev-macos` 后，部分平台修复已进入分支代码（见 5.1–5.11 的「合并后状态」）。

> **更新（2026-11-11 晚）**：本文写于 `main`（0f4a203）。随后 `feat/platform-bootstrap` 合入了
> `auto-dev-macos` 的平台实现，5.1 / 5.2 / 5.4 / 5.8 已由代码修复（系统 CA 探测、ASR 数据目录默认值、
> OCR 平台分派、`__pycache__` 不再跟踪）。下表"合并后"列以合并后代码为准，历史观察保留。

## 1. 结论

- 插件本身可移植：纯 Node ESM，依赖只有 `qrcode`（纯 JS）与 `sharp`（darwin-arm64 预编译已在），没有原生编译步骤。
- 但"装好"到"能用"之间有三处硬伤，全部与平台假设有关：**ffmpeg 在 macOS 上同样需要 CA**、**ASR 默认路径写死 Windows**、**OCR 只有 Windows 实现**。
- 另有一个会静默跑旧代码的安装陷阱：pnpm 的 `file:` 依赖是**拷贝**，仓库改了、profile 里还是 11-09 的旧快照，本会话因此只有 24 个工具（仓库 27 个）。

## 2. 环境基线

| 项 | 值 |
| --- | --- |
| 系统 | macOS 26.6.2（arm64） |
| DSH 桌面版 | 0.2.2-rc.1（Info.plist）；runtime.json 记 0.2.1-rc.3 / node 24.21.0 |
| 宿主运行时 Node | v24.21.0（`~/.dsh/dsh-runtimes/dsh-primary-runtime`） |
| 本地 Node / npm | v25.8.0 / 11.11.0 |
| pnpm（宿主自带） | 11.28.5 |
| profile | `~/.dsh/profiles/desktop`（pnpm workspace） |
| ffmpeg | Homebrew 9.0.2（`/opt/homebrew/bin/ffmpeg`，`--enable-openssl`） |
| ASR venv | `~/.dsh/bilibili/asr-venv`（Python 3.12.16，faster-whisper 1.2.1，ctranslate2 4.8.5，av 19.0.2，无 torch） |
| ASR 模型 | `~/.dsh/bilibili/models` 下 faster-whisper-small，464 MB |
| sharp | 0.35.5 + libvips darwin-arm64（仓库 node_modules 可用） |
| 登录态 | `四夕羽_` / mid 215407733，凭据 2026-10-31 保存，本轮校验仍有效 |

## 3. 本轮对当前安装做的修复（工作区外，可回滚）

1. **把 profile 里的旧拷贝换成符号链接**

   ```
   ~/.dsh/profiles/desktop/node_modules/dsh-bilibili-bridge -> /Users/kairos/Code/agent/dsh-BiliBridge
   ```

   旧拷贝是 2026-11-09 的快照，缺 `lib/bili/messages.mjs`、`manage.mjs`、`traffic-guard.mjs`、`adaptive*.mjs`，只注册 24 个工具。
   换掉后从该路径导入得到 **27 个工具**。

2. **`~/.dsh/bilibili/config.json` 补四个路径配置**（原文件只有 `hfEndpoint`）

   ```json
   {
     "hfEndpoint": "https://hf-mirror.com",
     "ffmpegPath": "/opt/homebrew/bin/ffmpeg",
     "ffmpegCaFile": "/etc/ssl/cert.pem",
     "asrPython": "/Users/kairos/.dsh/bilibili/asr-venv/bin/python",
     "asrModelDir": "/Users/kairos/.dsh/bilibili/models"
   }
   ```

   备份写在 `~/.dsh/bilibili/config.json.bak-20261111`；未设置前 ASR 不可用、ffmpeg 抽帧 TLS 失败（见 5.1、5.2）。

3. **未做**：没有重启 DSH。宿主进程里仍是启动时加载的 24 工具版本，重启后才会看到 27 个。

## 4. 本机验证结果

| 检查 | 结果 |
| --- | --- |
| 单元测试（本地 Node 25.8.0） | 287 tests / 286 pass / 1 skip / 0 fail（6.7s） |
| 单元测试（宿主 Node 24.21.0） | 285 pass / **1 fail**（`feature-integration`，见 5.11） |
| 插件装配（宿主 Node，经 profile 符号链接） | 27 个工具，含 `bilibili_messages`、`bilibili_content_manage` |
| 真实工具调用（宿主 Node） | `bilibili_me` → 已登录；`bilibili_video` → ok，播放数 108,399,743 |
| ffmpeg 抽帧（真实登录、1080P） | `source=ffmpeg`、`accuracy=frame-level`、2 帧拼 1280×360；画面内容正确（8:10 / 8:30） |
| ffmpeg 缺 CA 时 | 直接失败：`SSL routines::certificate verify failed`（修复前） |
| 故事板降级 | `source=storyboard`，同尺寸拼图正常 |
| ASR worker（一次性子进程） | 8.6s 语音 → 11.7s，中文识别正确 |
| ASR daemon（stdio 常驻） | 8.6s，协议正常，复用后第二次更快 |
| 设置状态接口 `readStatus()` | ffmpeg ok（含 caFile）、asr ok、ocr `available:false`（darwin） |
| 真实二进制抓取（宿主 Node 24） | 封面 651,508 字节，JPEG magic 正确 |
| 凭据权限 | `credentials.json` 为 0600（POSIX 分支生效） |

真实画面证据（`bilibili_inspect` 同款拼图）：本轮生成在 `/tmp/bili-verify-sheet.jpg`。

### 4.1 重启后宿主验收（2026-11-11 16:12，新构建）

| 项 | 结果 |
| --- | --- |
| 工具集 | 新工具 `bilibili_messages`、`bilibili_content_manage` 已在会话中可调用（27 个） |
| 设置路由 `GET /bilibili-bridge/api/status` | 200；账号/ffmpeg（含 caFile）/ASR（含 modelDir）均 ok，ocr `available:false` |
| 设置保存（POST /settings） | 200；保存 `asr.model` 后 `hfEndpoint` / `ffmpegPath` / `asrPython` / `asrModelDir` / `ffmpegCaFile` 全部保留 |
| `bilibili_me` | ok，`四夕羽_` / Lv6 / 大会员 |
| `bilibili_extract`（默认全量） | ok：47 条平台字幕（覆盖 87%）、1200 条弹幕、热门+最新评论、故事板九宫格、ffmpeg 自适应 9 帧；`evidenceLevel: rich` |
| `bilibili_inspect`（timestamps，1080P） | ok：`source=ffmpeg`、`frame-level`、图片已附加 |
| `bilibili_transcribe`（20s 窗口） | ok：英文旁白 5 段，时间戳落在原始时间轴（起点 15s → 首段 `atMs=15000`），`verdict.usable=true` |
| `bilibili_messages`（sessions） | ok，3 条会话，`nextCursor` 正常 |
| `bilibili_content_manage`（list_drafts） | ok，0 条草稿 |
| `bilibili_search`（WBI） | ok，`total 1000`，返回 3 条 |
| 写工具 preview（`watch_later_set`） | ok，`dryRun:true`，未产生写入 |

补充观察：对**纯音乐视频**（如 MV）调 `bilibili_transcribe` 会返回 0 段、`verdict.empty`。原因是 faster-whisper 的 `vad_filter=True` 把歌声当非语音过滤（同一段音频关掉 VAD 能识别出 7 段歌词）。这是预期行为，不是 macOS 故障，但"音乐视频转写为空"容易被当成坏掉，建议在返回值里区分"VAD 过滤掉了全部音频"和"没人说话"。


### 4.2 依赖体检（本机实测）

| 依赖 | 状态 | 备注 |
| --- | --- | --- |
| Node ≥ 20 | ✅ | 宿主 24.21.0；本地 25.8.0 |
| `sharp` | ✅ 0.35.5 | `@img/sharp-darwin-arm64` 预编译，渲染/拼图可用 |
| `qrcode` | ✅ 1.5.4 | 纯 JS |
| ffmpeg | ✅ 9.0.2 | Homebrew；**必须配合 `ffmpegCaFile`**（5.1） |
| ffmpeg 的 CA | ✅ `/etc/ssl/cert.pem` | 需显式配置，不配则 TLS 失败 |
| Python（ASR venv） | ✅ 3.12.16 | `~/.dsh/bilibili/asr-venv` |
| `faster-whisper` | ✅ 1.2.1 | `import faster_whisper` 通过 |
| `ctranslate2` | ✅ 4.8.5 | CPU int8 |
| `av` / `tokenizers` / `numpy` | ✅ 19.0.2 / 0.23.3 / 2.5.4 | |
| `torch` | ❌ 不需要 | faster-whisper 不依赖 torch，缺它不是问题 |
| 模型 | ✅ small，464 MB | `models--Systran--faster-whisper-small` |
| PowerShell OCR | ❌ 不适用 | macOS 无 Windows.Media.Ocr（5.4） |
| `playwright-core` | ❌ 未装 | 仅抓包探针需要，非运行依赖 |
| `bili-ocr-vision` | ⚠️ 孤儿 | 别的项目留下的 arm64 Vision 助手，本仓库未引用 |


## 5. 问题清单

严重度：P0 = 换机必挂或静默错；P1 = 需要手工绕行/会误导；P2 = 卫生问题。

| # | 级别 | 问题 | 合并后状态 |
| --- | --- | --- | --- |
| 5.1 | P0 | macOS 上 ffmpeg 也缺 CA，README 说"通常自带信任链" | ✅ 已修：`ffmpeg.mjs` 增加系统 CA 候选；剩余可选：状态里暴露 `caSource` |
| 5.2 | P0 | ASR 默认 Python/模型路径写死 Windows `D:/tools/asr` | ✅ 已修：数据目录 venv + PATH 兜底；剩余：python 与 modelDir 的 env/config 优先级不一致 |
| 5.3 | P0 | pnpm `file:` 依赖是拷贝，仓库更新不会生效 | ❌ 仍开放：README 已改 `link:` 语义（本次），但版本/loadedFrom 仍未暴露 |
| 5.4 | P0 | OCR 只有 Windows 实现 | ✅ 已修：`ocrEngineFor()` 分派 + Apple Vision 助手 + UI 文案 |
| 5.5 | P1 | 设置面板不能写 ffmpeg/asr 路径，且静默丢弃 | ❌ 仍开放：`settings-merge.mjs` 白名单未含路径 |
| 5.6 | P1 | 没有 doctor/自检命令，验收脚本已腐化 | ❌ 仍开放：`manual-frames.mjs` 已修字段，doctor 未做 |
| 5.7 | P1 | 依赖引导（venv/模型/CA）全靠手工 | ⚠️ 部分：`docs/macos-setup.md` 有步骤；无预取/安装脚本 |
| 5.8 | P1 | `__pycache__/*.pyc` 被 git 跟踪 | ✅ 已修：文件已移除，`.gitignore` 覆盖 |
| 5.9 | P1 | 文档与代码漂移（设置白名单、macOS 安装段） | ⚠️ 部分：安装段已改；`settings-panel.md`、`compatibility.md` 仍旧 |
| 5.10 | P2 | 平台文案与死文件 | ⚠️ 部分：OCR 文案已改；`sapi-asr.ps1` 等仍在 |
| 5.11 | P2 | 测试在 Node 24 上不可移植（mock Response） | ❌ 仍开放：mock 仍用 `new Response(Buffer)` |

### 5.1 ffmpeg：macOS 也需要 CA（P0）

- 现象：Homebrew ffmpeg 9.0.2（openssl 构建）直连 `*.bilivideo.com` 报
  `[tls] error:0A000086:SSL routines::certificate verify failed`，`buildInspection({source:'ffmpeg'})` 抛 `UPSTREAM_ERROR`。
- 原因：ffmpeg 的 openssl TLS 不读 macOS 钥匙串，默认 CA 路径在这套构建里不可用；`[ffmpeg.mjs](../lib/media/ffmpeg.mjs)` 的 `resolveCaFile()` 只查 `FFMPEG_CA_FILE` → `config.ffmpegCaFile` → `<数据目录>/cacert.pem`，**不探测 macOS 系统证书**。
- 证据：同一 URL 加 `-ca_file /etc/ssl/cert.pem` 立即成功（43 KB JPEG）；`/opt/homebrew/etc/openssl@3/cert.pem` 也指向 `ca-certificates/cert.pem`，同样可用。
- 影响：新机器上用户只会看到"抽帧失败/自动降级故事板"，精度从"一帧"掉到 6–8 秒一格，而且 README 明确说 macOS 不需要 CA，排障会走错方向。
- 建议：`resolveCaFile()` 增加平台默认候选（macOS `/etc/ssl/cert.pem`、`/opt/homebrew/etc/ca-certificates/cert.pem`；Linux `/etc/ssl/certs/ca-certificates.crt`；Windows 仍要求显式配置），并在 `status.runtime.ffmpeg` 里暴露 `caSource`；README 修正"macOS 通常不需要 CA"的说法。

### 5.2 ASR：默认路径写死 Windows（P0）

- 代码：`[asr.mjs:29-30](../lib/media/asr.mjs#L29-L30)`
  `DEFAULT_PYTHON = 'D:/tools/asr/.venv/Scripts/python.exe'`、`DEFAULT_MODEL_DIR = 'D:/tools/asr/models'`。
- 解析顺序（注意三者不一致）：`BILI_ASR_PYTHON` → `config.asrPython` → 默认值；但 `asrModel` / `asrModelDir` 是 **config → 环境变量 → 默认值**（`[asr.mjs:71](../lib/media/asr.mjs#L71)`、`[asr.mjs:78-79](../lib/media/asr.mjs#L78-L79)`）。同一个函数里 python 优先 env、模型优先 config，属于实现不一致。
- 影响：macOS/Linux 上新装必得 `DEPENDENCY_MISSING: 没有可用的 faster-whisper 运行时`，即使本机已有 venv 和模型（本机正是如此：venv 在 `~/.dsh/bilibili/asr-venv`，模型在 `~/.dsh/bilibili/models`）。
- 建议：默认值改为数据目录内的约定位置（`<dataDir>/asr-venv/bin/python` / `Scripts/python.exe`、`<dataDir>/models`），再退回 PATH 上的 `python3` 探测 `import faster_whisper`；错误信息给出可直接执行的修复命令。

### 5.3 `file:` 依赖是拷贝，静默跑旧代码（P0）

- 现象：`~/.dsh/profiles/desktop/package.json` 里是 `"dsh-bilibili-bridge": "file:/Users/kairos/Code/agent/dsh-BiliBridge"`，pnpm 把它**复制**进 `node_modules`（按 `files` 字段打包：lib/bin/README/patch），不会跟随仓库改动。
- 证据：拷贝目录 mtime 2026-11-09，`lib/index.js` 只 `register*Tools` 12 组；仓库为 14 组、27 个工具；`diff -rq` 缺 6 个文件。
- 后果：本会话的宿主只有 24 个工具，且没有 `traffic-guard`/自适应选帧/新工具，但 UI 与文档都按 27 个描述——**没有任何地方能看出来装的是旧的**（插件 `version` 从 0.1.0 起没变过）。
- 附带现象：本轮换符号链接后约 2 分钟（15:57），profile 的 `pnpm-lock.yaml` / `.modules.yaml` 被重写，我放在 `node_modules` 里的 `.bak` 备份目录也随之消失（很可能是 pnpm 重装时清理了非受管目录）；符号链接本身存活，重新导入仍是 27 个工具。说明**外部安装流程会改 `node_modules`**，符号链接不是最终解。
- 建议：
  - 开发态用 `link:`（或直接 `ln -s`），发布态用打包产物 + 显式版本号；
  - `status`/`doctor` 暴露 `loadedFrom`、插件版本、git commit、注册工具数，与期望值比对；
  - 安装流程写清两种安装形态的更新语义：拷贝安装必须先重装再重启，链接安装更新后只需重启；并给出检测手段。

### 5.4 OCR 只有 Windows 实现（P0，功能缺口）

- 硬门禁：`[ocr.mjs:224](../lib/media/ocr.mjs#L224)` `process.platform !== 'win32'` 直接抛 `UNSUPPORTED`；实现依赖 `[win-ocr.ps1](../lib/media/win-ocr.ps1)` + `powershell.exe`（`ocr.mjs:357`）。
- 连带：`[settings-api.mjs:81-82](../lib/settings-api.mjs#L81-L82)` 用 `process.platform === 'win32'` 判 `available`；`[client.js:609](../lib/client.js#L609)` 文案写死"Windows 自带 OCR 引擎"；`ocr.enabled` 开关在 macOS 上仍可打开。
- 影响：`bilibili_inspect` 的 `ocr:true` / `subtitleWindow` 在 macOS 不可用；这属于可选能力，但会影响硬字幕视频。
- 现场发现：`~/.dsh/bilibili/bin/bili-ocr-vision`（arm64 Mach-O，带 `.stamp`）是另一个项目留下的 **macOS Vision OCR 助手**，本仓库代码没有引用它。可作为 macOS 后端的现成起点。
- 建议：把 OCR 抽象成 backend 接口（`recognizeImageDir`），实现 `windows-powershell` / `macos-vision`（VNRecognizeTextRequest）/ `tesseract` 三种探测；`available` 由 backend 自报；UI 文案按平台取。

### 5.5 设置面板不能写路径，而且静默丢弃（P1）

- 白名单在 `[settings-merge.mjs:2](../lib/media/settings-merge.mjs#L2)`：只有 `budget/cache/asr/ocr/dev/extract/adaptive` 分段；**没有** `ffmpegPath`、`ffmpegCaFile`、`asrPython`、`asrModelDir`。
- 实测 `mergeWritable({}, patch)`：传 `{ffmpegPath}`、`{ffmpegCaFile}`、`{asrPython}` 都返回 `{}` 且 `errors: 0`——**不报错、不生效**。
- 文档说反了：`[docs/settings-panel.md:92](settings-panel.md#L92)` 把 `ffmpegPath`/`ffmpegCaFile` 列为可写；`[settings-api.mjs:305](../lib/settings-api.mjs#L305)` 的 `resetFfmpegCache()` 分支因此是死代码。
- `[client.js](../lib/client.js)` 里根本没有这几个输入框；面板只把 `runtime.asr.python` 当只读文本显示。
- 影响：换机后只有两条路——手改 `config.json`（本轮这么做的），或设环境变量（`FFMPEG_PATH` / `FFMPEG_CA_FILE` / `BILI_ASR_PYTHON` / `BILI_ASR_MODEL_DIR`）；两者都不在 UI 里，普通用户不会知道。若通过 API "保存"会以为已经改好。
- 好消息（本轮实测）：设置接口保存时**不会丢**这些手工键——POST `asr.model` 后 `hfEndpoint`/`ffmpegPath`/`asrPython`/`asrModelDir`/`ffmpegCaFile` 全部保留，风险只是"写不进去"而不是"被清掉"。
- 建议：要么把 runtime 段纳入可写并在 UI 提供路径输入 + "测试"按钮，要么在 UI 明确显示"以下路径需手动编辑配置文件"并提供打开目录的入口。

### 5.6 没有 doctor，验收脚本已腐化（P1）

- `bin/bili.mjs` 只有 `status/qr/poll/login/logout/me/video/latest/list/.../traffic`，没有聚合自检。
- README 推荐的验收命令 `node tests/manual-frames.mjs BV… auto` 直接崩：`[tests/manual-frames.mjs:40](../tests/manual-frames.mjs#L40)` 读 `result.image.source`，而 `buildInspection` 现在返回 `images[]`（`inspect.mjs` 的 `buildRealFrames` 返回 `{frames, images}`），`result.image` 恒为 `undefined` —— 本轮实测 `TypeError: Cannot read properties of undefined (reading 'source')`，第 42/45/46 行同样引用旧字段。
- 建议：修脚本（或删掉，改由 doctor 覆盖）；`bili doctor` 输出：平台、Node、ffmpeg 路径+CA、python+faster-whisper+模型、sharp/平台绑定、OCR backend、数据目录权限、插件 loadedFrom/版本/工具数，每项给出"怎么修"。

### 5.7 依赖引导缺失（P1）

- 仓库没有任何**预取/安装**脚本：创建 venv、装 faster-whisper、提前拉模型、装 ffmpeg/CA 都只在 docs 与聊天记录里。首次使用模型时 `WhisperModel` 会自行下载（`asr_worker.py`、`asr_daemon.py`），但那是隐式的、不可预期耗时的。
- 本机现状是历史手工产物（venv、模型、`bin/bili-ocr-vision`），换机无法复现。
- 建议：`bili doctor --fix`（创建 venv、`pip install faster-whisper`、可选预拉模型）+ 安装完成后的自检；模型下载要显示大小/进度，并说明 `HF_ENDPOINT` 镜像。

### 5.8 `__pycache__` 被跟踪（P1）

- `lib/media/__pycache__/asr_worker.cpython-312.pyc` 在 git 里；本轮跑一次 ASR 后 `git status` 立刻显示该文件被修改（已 `git checkout` 还原）。
- 影响：daemon 启动导入 worker 时，Python 可能生成或更新这个被跟踪的 pyc（本轮跑一次 ASR 即观察到变化）；一旦发生就污染工作区，且跨平台 pyc 是无意义二进制。
- 建议：`git rm -r --cached lib/media/__pycache__`，`.gitignore` 加 `__pycache__/`、`*.pyc`；worker/daemon 启动加 `-B` 或 `PYTHONDONTWRITEBYTECODE=1`。

### 5.9 文档与代码漂移（P1）

- `settings-panel.md` 的白名单是旧设计（扁平 `asrModel`/`ffmpegPath`），与 `settings-merge.mjs` 的分段实现不一致。
- README「安装（开发版）」只写 Windows：`mklink /J`、`%USERPROFILE%`、`D:\tools\...`；macOS 只有一行 `ln -sfn`。
- 兼容性文档写的还是 10-30 的 macOS 环境与 11-02 的 Windows 环境，没有"换回 macOS"的记录。

### 5.10 平台文案与死文件（P2）

- `client.js:609` "Windows 自带 OCR 引擎"；README 通篇 Windows 路径。
- `lib/media/sapi-asr.ps1` 无任何引用；`win-ocr.ps1` 仅 Windows 用；`tests/probe-windows-*.ps1` 同样只在 Windows 有意义。
- `windowsHide: true` 散落在 spawn 调用（POSIX 下无害，但暴露了单一平台假设）。

### 5.11 测试在宿主 Node 24 上不可移植（P2，测试本身）

- 在宿主 Node **v24.21.0** 下跑单测：285 pass / 1 fail。失败点 `tests/unit/feature-integration.test.mjs:54`（`normal.images.length` 期望 1，实际 0），warning 为 `storyboard ERROR: Input buffer contains unsupported image format`。
- 根因是测试 mock：`new Response(jpegBuffer)` 在 Node 24.21.0 里把 Buffer 当文本重新编码——
  输入 287 字节 JPEG → 取出 331 字节且以 `efbfbd` 开头；改用 `new Uint8Array(b)` 则正常。**生产路径不受影响**：本轮用宿主 Node 24 通过 `fetchBuffer` 抓到真实封面 651,508 字节、magic `ffd8ff` 正确。
- 建议：测试里构造二进制响应统一用 `new Uint8Array(...)`；CI 至少覆盖宿主同版本的 Node。

## 6. 供讨论的改造方向（未实施）

1. **一个 `bili doctor` + 一个 `bili setup`**：探测 → 报错 → 一键修；把"路径从哪来"写进结果（env / config / 平台默认 / PATH）。
2. **平台路径解析下沉到 `lib/platform.mjs`**：`asrPython`/`asrModelDir` 默认值、CA 候选、OCR backend 全部按 `process.platform` 决策，业务代码不再出现 `win32` 判断之外的分支。
3. **安装形态**：开发用 `link:`，分发用打包产物；`status` 暴露 `loadedFrom + version + git commit + toolCount`，并提供"期望工具清单"对比。
4. **设置面板补 runtime 段**：路径可写/可测，或明确只读 + 打开配置目录。
5. **OCR 抽象 + macOS Vision 后端**：复用 `bili-ocr-vision` 的思路，`available` 由 backend 探测。
6. **验收脚本现代化**：修 `manual-frames.mjs`，把散落的 `manual-*.mjs` 收进 `doctor`/`verify` 子命令，避免再腐化。
7. **CI/自检基线**：宿主 Node 版本 + 二进制 mock 修复，保证"宿主里能跑"和"测试里能过"一致。

## 7. 复现命令

```bash
# 环境
sw_vers; uname -m; node -v; ~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node -v
ffmpeg -version | head -1

# 安装态（应为符号链接 + 27 工具）
ls -ld ~/.dsh/profiles/desktop/node_modules/dsh-bilibili-bridge
node --input-type=module -e '
const names=[]; const m=await import("file://" + process.env.HOME + "/.dsh/profiles/desktop/node_modules/dsh-bilibili-bridge/lib/index.js");
m.apply({ tools:{ register:t=>names.push(t.name) }, on(){}, inject(){} }); console.log(names.length);'

# 测试（宿主 Node 与本地 Node 各跑一次）
node --test --test-isolation=none tests/unit/*.test.mjs
~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node --test --test-isolation=none tests/unit/*.test.mjs

# 工具链
node --input-type=module -e 'const f=await import("./lib/media/ffmpeg.mjs"); console.log(await f.resolveToolchain({force:true}));'
node --input-type=module -e 'const a=await import("./lib/media/asr.mjs"); console.log(await a.resolveAsr({force:true}));'

# 真实抽帧（用 source:"ffmpeg" 强制暴露 CA 失败；auto 会静默降级故事板并只留 fallbackReason）
node --input-type=module -e '
import { currentJar } from "./lib/bili/auth.mjs";
import { getVideo } from "./lib/bili/api.mjs";
import { buildInspection } from "./lib/media/inspect.mjs";
const { jar } = await currentJar();
const v = await getVideo("BV1GJ411x7h7", { jar });
const r = await buildInspection({ video: v, cid: v.pages[0].cid, timestampsMs: [10000,30000], source: "ffmpeg", jar });
console.log(r.images[0].source, r.images[0].accuracy, r.fallbackReason ?? null);'
```

## 8. 已知未验证

- 设置面板在 macOS 上的实际渲染（本轮只验证了 `/bilibili-bridge/api/status`、`/settings` 两个接口；面板需要打开 DSH 设置页目测）。
- OCR 在 macOS 上的替代实现（Vision）尚无代码接入；`ocr.enabled` 开关在 macOS 上仍可打开，但实际会失败。
- 长时间 ASR daemon 空闲回收（`BILI_ASR_IDLE_SECONDS`）未做压测；本轮只验证了两次连续调用复用 daemon。
- 写操作 `intent=apply` 的完整审批链路未在本轮触发（只测了 preview，避免产生真实写入）。
