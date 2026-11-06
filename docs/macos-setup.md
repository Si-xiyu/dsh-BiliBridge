# macOS 上的安装与验证

代码在 Windows 与 macOS 上走同一套路径，差异只集中在**三个外部依赖**：

| 能力 | Windows | macOS | 是否必须 |
| --- | --- | --- | --- |
| 精确抽帧 | ffmpeg 静态包 + 自带 cacert.pem | `brew install ffmpeg`，CA 自动用系统包 | 建议装；没有则降级故事板 |
| OCR（硬字幕/画面文字） | Windows.Media.Ocr（系统自带） | Apple Vision（系统自带，首次编译一个 Swift 助手） | 可选 |
| ASR（无字幕时转写） | faster-whisper + Python 3.12 | 同左，独立 venv | 可选 |

三者都缺失时插件照常工作，只是画面降级为故事板、不能 OCR/转写，且**降级是可见的**
（`source=storyboard`、`available=false`、`DEPENDENCY_MISSING`），不会伪装成空结果。

---

## 0. 前置

| 项 | 要求 | 检查命令 |
| --- | --- | --- |
| Node | ≥ 20 | `node -v` |
| Xcode Command Line Tools | OCR 需要 `swiftc` | `xcode-select -p`（没有就 `xcode-select --install`） |
| Homebrew | 装 ffmpeg / python | `brew --version` |

仓库本身只需要 `npm install`（`sharp`、`qrcode` 两个依赖）。

---

## 1. ffmpeg

```bash
brew install ffmpeg
```

**查找顺序**（`lib/media/ffmpeg.mjs#resolveToolchain`）：

1. 环境变量 `FFMPEG_PATH`
2. `~/.dsh/bilibili/config.json` 的 `ffmpegPath`
3. `/opt/homebrew/bin/ffmpeg`、`/usr/local/bin/ffmpeg`（macOS 内置候选）
4. `PATH` 里的 `ffmpeg`

第 3 条不是冗余：**DSH 桌面版作为 GUI 进程启动，PATH 通常不含 `/opt/homebrew/bin`**。
终端里 `which ffmpeg` 正常、宿主里却报"找不到 ffmpeg"，就是这个原因。

### 证书

macOS 上**不需要**手工放 `cacert.pem`。Homebrew 的 ffmpeg 用 `--enable-openssl` 编译，
自己不带 Mozilla 根证书，直连 B站 CDN 会报：

```
[tls] error:0A000086:SSL routines::certificate verify failed
```

插件会自动把 `-ca_file` 指向系统 CA 包（`/etc/ssl/cert.pem`），实测 macOS 26 + ffmpeg 9.0.2 可用。
如果你的 ffmpeg 来自别处且系统包里没有对应根证书，可以显式配置 `ffmpegCaFile`。

### 验证

```bash
cd /Users/kairos/Code/agent/dsh-BiliBridge
BILI_DATA_DIR=~/.dsh/bilibili node tests/manual-frames.mjs BV1GJ411x7h7 auto 10000 60000
```

期望看到：

```
toolchain: /opt/homebrew/bin/ffmpeg
ca       : /etc/ssl/cert.pem
frames   : ffmpeg frame-level maxErrorMs null count 2
```

`maxErrorMs=null` 是**刻意**的：ffmpeg 路径误差约一帧，不给毫秒上界；
故事板路径才会给出按 `index` 中位间距算出来的 `maxErrorMs`。

---

## 2. OCR：Apple Vision

零安装。第一次真正用到 OCR 时，插件会把 `lib/media/vision-ocr.swift` 用
`swiftc -O` 编译成：

```
~/.dsh/bilibili/bin/bili-ocr-vision        # 可执行文件
~/.dsh/bilibili/bin/bili-ocr-vision.stamp  # 源码 sha256，变了才重编
```

之后每次调用是直接跑这个二进制（单图约 160ms），不再碰编译器。
没有 Command Line Tools 时 OCR 报 `available=false` 并说明缺 `swiftc`，其它能力不受影响。

接口与 Windows 版完全一致（`-Dir <目录> -Out <json> -Language zh-Hans`），
输出 `{language, results:[{file,width,height,lines[]}]}`，**都不返回坐标**——
时间轴来自调用方的采样点，所以是"抽样对齐"，不是逐句对齐。

### 验证

```bash
BILI_DATA_DIR=~/.dsh/bilibili node tests/manual-ocr.mjs BV1pTx76QE8J 6 0.22
```

期望看到 `ocr : language=zh-Hans recognized N/6`，以及若干条"时间 → 文本"。
产物：字幕带长图 + 转写 JSON，落在 `~/.dsh/bilibili/cache/<bvid>/`。

单独检查引擎是否可用（不联网）：

```bash
node -e "
const { ocrAvailability } = await import('./lib/media/ocr.mjs');
console.log(await ocrAvailability());
"
# { platform: 'darwin', engine: 'apple-vision', available: true, reason: null }
```

---

## 3. ASR：faster-whisper

ASR 需要一个能 `import faster_whisper` 的 Python。**装法不影响代码**——
`resolveAsr()` 只认一个解释器路径，所以 venv / uv tool / 独立发行版都只是换配置值。

### 3.1 建 venv

```bash
brew install python@3.12
/opt/homebrew/bin/python3.12 -m venv ~/.dsh/bilibili/asr-venv
~/.dsh/bilibili/asr-venv/bin/pip install -U pip \
  -i https://pypi.tuna.tsinghua.edu.cn/simple
~/.dsh/bilibili/asr-venv/bin/pip install faster-whisper==1.2.1 \
  -i https://pypi.tuna.tsinghua.edu.cn/simple
```

版本与 Windows 机器对齐（1.2.1），便于横向比对结果。

### 3.2 解释器的解析顺序

`lib/media/asr.mjs#asrCandidates`：

1. `BILI_ASR_PYTHON`
2. `config.json#asrPython`
3. `~/.dsh/bilibili/asr-venv/bin/python`（Windows 是 `Scripts\python.exe`）
4. Windows 历史路径 `D:/tools/asr/.venv/Scripts/python.exe`（仅 Windows，且目录存在时）
5. `PATH` 里的 `python3` / `python`

第 3 条按平台拼，第 5 条允许"裸命令名"，两者合起来意味着**装在别处也能用**，只要写进配置。

### 3.3 模型镜像

`huggingface.co` 在国内网络下经常完全不可达（本机实测 15s 超时），
所以模型下载地址做成了配置项，写在 `config.json`：

```json
{ "hfEndpoint": "https://hf-mirror.com" }
```

等价的环境变量是 `HF_ENDPOINT`。插件启动 daemon 与一次性 worker 时都会注入这个值，
不会覆盖用户已经设好的同名变量，其余环境变量原样继承。

模型落在 `~/.dsh/bilibili/models`（`HF_HOME` 也指到这里），不散落到 `~/.cache`。
默认 `small`（约 484MB），可用 `asrModel` 改成 `base` / `tiny` / `medium`。

**如果 hub 下载卡死**（本机遇到过两次：`.incomplete` 停在 0 字节，或长到 290MB 后连接被对端断开）：

```bash
# 关掉 Xet 传输，并只用一个 worker
HF_ENDPOINT=https://hf-mirror.com HF_HUB_DISABLE_XET=1 \
  ~/.dsh/bilibili/asr-venv/bin/python -c "
from huggingface_hub import snapshot_download
print(snapshot_download('Systran/faster-whisper-small',
                        cache_dir='/Users/<你>/.dsh/bilibili/models'))
"
```

仍然不行就直接用 curl 断点续传写进 HF 缓存布局（`git` 之外的位置，不污染仓库）：
把 `model.bin` 下到 `models/models--Systran--faster-whisper-small/blobs/<sha256>`，
再在 `snapshots/<rev>/model.bin` 建一个指回 `../../blobs/<sha256>` 的软链。
加 `--speed-limit 51200 --speed-time 20` 可以让卡住的连接自己断开重试。

### 3.4 验证

```bash
BILI_DATA_DIR=~/.dsh/bilibili node tests/manual-asr.mjs BV1KDNA6eEgr 20
```

本机（macOS 26 / arm64 / `small` / 机器同时跑着别的程序）实测：

| 场景 | 耗时 |
| --- | --- |
| 20s 窗口，新进程（含取流、抽音频、模型加载） | 11–14s |
| 40s 窗口，新进程 | ~109s |
| 40s 窗口，同进程冷启 / 复用 | 118s / 94s |

也就是说这台机器大约 **0.4× 实时**，比 Windows 机器（90s 音频 55.7s，约 1.6× 实时）慢不少。
原因是负载与参数都还没调优（`beam_size=5`、`cpu_threads` 默认），**不要把这些数字当成
模型的性能上界**。要提速可以先把 `beam_size` 降到 3，或确认 `cpu_threads` 是否吃满性能核。

---

## 4. config.json

位置：`~/.dsh/bilibili/config.json`（可用 `BILI_DATA_DIR` 覆盖整个数据目录）。
所有键都是可选的，按需写：

```json
{
  "ffmpegPath": "/opt/homebrew/bin/ffmpeg",
  "ffmpegCaFile": "/etc/ssl/cert.pem",
  "asrPython": "/Users/<你>/.dsh/bilibili/asr-venv/bin/python",
  "asrModel": "small",
  "asrModelDir": "/Users/<你>/.dsh/bilibili/models",
  "hfEndpoint": "https://hf-mirror.com",
  "dev": { "enabled": false }
}
```

本机上 `ffmpegPath` 与 `asrPython` **实际不需要写**：前者能命中内置候选，
后者能命中数据目录默认位置。只有装在非常规路径时才需要。

---

## 5. 数据目录布局

```
~/.dsh/bilibili/
├── credentials.json          # 0600，只存 cookie
├── config.json               # 0600，可写设置在这里
├── cacert.pem                # 可选，给了就优先于系统 CA
├── bin/bili-ocr-vision       # macOS OCR 助手（自动编译）
├── asr-venv/                 # ASR 解释器
├── models/                   # whisper 权重
└── cache/
    ├── asr/                  # 转写缓存（按片段的 sha 命名）
    └── <bvid>/               # cover / storyboard / sprite / inspect / 本地产物
```

---

## 6. 与 Windows 的差异

| 项 | Windows | macOS |
| --- | --- | --- |
| 凭据权限 | `icacls`（`chmod` 只切只读位） | `chmod 0600` |
| 临时目录 | 必须用 `os.tmpdir()`，`/tmp` 会落到当前盘根 | `/tmp` 或 `os.tmpdir()` 均可 |
| ffmpeg TLS | gnutls 构建，必须显式给 CA | openssl 构建，自动用 `/etc/ssl/cert.pem` |
| ffmpeg 发现 | 静态包路径写进 `config.json` | 命中 Homebrew 内置候选 |
| OCR 引擎 | Windows.Media.Ocr（PowerShell 5.1 调用） | Apple Vision（Swift 助手，首次编译） |
| ASR 解释器 | `.venv\Scripts\python.exe` | `.venv/bin/python` |
| 宿主 PATH | 通常包含安装目录 | GUI 进程 PATH 很精简，靠内置候选兜底 |

---

## 7. 换机器迁移清单（macOS）

代码 clone 即可，这些**不在仓库里**：

| 项 | 做什么 | 漏了会怎样 |
| --- | --- | --- |
| npm 依赖 | `npm install` | 插件加载失败 |
| ffmpeg | `brew install ffmpeg` | 抽帧降级故事板（`source=storyboard`） |
| Command Line Tools | `xcode-select --install` | OCR `available=false` |
| Python + venv | 见 §3.1 | `bilibili_transcribe` 报 `DEPENDENCY_MISSING` |
| 模型 | 首次转写自动下载，或手工预拉 | 首次调用卡在下载 |
| `hfEndpoint` | `config.json` 写镜像 | HF 不可达时下载超时 |
| B站登录 | 重新扫码 | 字幕 0 条、稍后观看/收藏全部 `AUTH_REQUIRED` |
| profile 接线 | `node_modules/dsh-bilibili-bridge` 软链 + `dependencies` / `bundles` | 宿主里看不到工具 |
| 重启宿主 | 插件没有 HMR | 改动不生效 |
