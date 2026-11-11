# 干净 macOS 安装基线（实测）

> 手工诊断脚本，不是单元测试：`tests/clean-baseline.mjs` 不在 `tests/unit/*.test.mjs` 里，`npm run test:single` 不会收集。
> 全程只使用 `mkdtemp` 临时数据目录，不写 `~/.dsh/bilibili`，不联网、不调 B站接口、不跑 ASR/OCR 推理。

## 环境（2026-11-11 实测）

| 项 | 值 |
| --- | --- |
| 系统 | macOS 26.6.2 (25G83)，arm64 |
| Node | v25.8.0 |
| ffmpeg | 9.0.2（`/opt/homebrew/bin/ffmpeg`，Homebrew 安装） |
| Swift | Apple Swift 6.2.4（`/usr/bin/swiftc`，Xcode Command Line Tools 已装） |
| sharp | 0.35.5 / libvips 8.18.7，`darwin/arm64`，jpeg 输入可用 |
| ASR | **没有** faster-whisper 运行时、没有 venv、没有模型——与全新机器一致 |
| 数据目录 | 每阶段一个空临时目录，默认运行结束即删除（`--keep` 可保留） |

## 运行方式

```bash
node tests/clean-baseline.mjs          # 人类可读表格
node tests/clean-baseline.mjs --json   # 机器可读，含完整错误消息
node tests/clean-baseline.mjs --keep   # 保留临时数据目录用于排查
```

退出码恒为 0：失败只记录，不当作断言。三个阶段：`installed`（当前 PATH/环境 + 空数据目录）、
`no-homebrew`（`PATH=/usr/bin:/bin:/usr/sbin:/sbin`，清掉 `FFMPEG_PATH`/`BILI_ASR_*`/`FFMPEG_CA_FILE`）、
`no-tools`（再注入 `/nonexistent/python`、`/nonexistent/ffmpeg`）。

## 实测输出（节选；`…` 处省略了过长的临时路径与重复项）

```text
installed   ffmpeg-resolve            ok    OK                    ffmpeg=/opt/homebrew/bin/ffmpeg ca=/etc/ssl/cert.pem
installed   ffmpeg-version            ok    OK                    ffmpeg version 9.0.2 ... @ /opt/homebrew/bin/ffmpeg
installed   asr-resolve               FAIL  DEPENDENCY_MISSING    没有可用的 faster-whisper 运行时：设置 BILI_ASR_PYTHON，或在 …/config.json 里写 asrPython
installed   sharp-load                ok    OK                    sharp 0.35.5 libvips 8.18.7 darwin/arm64 jpeg=true
installed   ocr-engine                ok    OK                    apple-vision (platform=darwin)
installed   vision-binary             FAIL  NOT_BUILT             …/bin/bili-ocr-vision (空数据目录，未编译)
installed   swiftc                    ok    OK                    Apple Swift version 6.2.4 (swiftlang-6.2.4.1.4 clang-1700.6.4.2)
no-homebrew ffmpeg-resolve            ok    OK                    ffmpeg=/opt/homebrew/bin/ffmpeg ca=/etc/ssl/cert.pem [not on PATH]
no-homebrew ffmpeg-resolve-path-only  FAIL  DEPENDENCY_MISSING    没有找到 ffmpeg：…（macOS 可用 `brew install ffmpeg`）
no-homebrew asr-resolve               FAIL  DEPENDENCY_MISSING    没有可用的 faster-whisper 运行时…
no-tools    ffmpeg-resolve            ok    OK                    … [not on PATH] (env 指向 /nonexistent/ffmpeg，已被忽略)
no-tools    ffmpeg-missing-forced     FAIL  DEPENDENCY_MISSING    没有找到 ffmpeg：…（macOS 可用 `brew install ffmpeg`）
no-tools    asr-resolve               FAIL  DEPENDENCY_MISSING    没有可用的 faster-whisper 运行时…
no-tools    asr-missing-forced        FAIL  DEPENDENCY_MISSING    同上（PATH 抽空后仍走同一错误分支）

installed: 5/7 ok, 2 failed
no-homebrew: 5/8 ok, 3 failed
no-tools: 1/4 ok, 3 failed
```

`no-homebrew` 的 `sharp-load`/`ocr-engine`/`vision-binary`/`swiftc` 与 `installed` 相同，此处省略。

## 全新 Mac 需要的步骤

1. **ffmpeg**：`brew install ffmpeg`，或设 `FFMPEG_PATH` / `config.json#ffmpegPath`。
   `no-homebrew` 阶段仍能解析，因为 `lib/media/ffmpeg.mjs` 把 `/opt/homebrew/bin`、`/usr/local/bin` 作为已知前缀兜底（GUI 进程 PATH 常缺它们）；只允许 PATH 时实测 `DEPENDENCY_MISSING`。
2. **CA 证书**：macOS 自带 `/etc/ssl/cert.pem`，实测被自动选中，`FFMPEG_CA_FILE` 非必需；Homebrew ffmpeg 不内置 Mozilla 根证书，无系统 CA 的环境需要补。
3. **ASR**：`python3 -m venv <数据目录>/asr-venv && <venv>/bin/pip install faster-whisper`；解释器解析顺序为
   `BILI_ASR_PYTHON` → `config.json#asrPython` → 数据目录 venv → PATH 里 `python3`。模型（默认 `small`）首次下载需要网络。
4. **Xcode Command Line Tools**：`xcode-select --install`。`swiftc` 实测可用；Vision OCR 助手只在首次真正 OCR 时编译到 `<数据目录>/bin/`，
   探针只查存在性，所以 `vision-binary` 在空目录下恒为 `NOT_BUILT`。
5. **sharp**：随 npm 依赖安装，无需系统库。

## 探针覆盖不到的部分

- **DSH 宿主集成**：插件加载、client bundle、工具注册与真实宿主 PATH 的差异；本探针直接 import `lib/`。⚠️ 未验证
- **真实 Windows**：脚本按 POSIX `PATH` 写死，`Scripts\python.exe`、`icacls`、`FFMPEG_CA_FILE` 语义未覆盖。⚠️ 未验证
- **headless / 非 GUI 环境**：SSH、launchd、无桌面会话下的 PATH 与权限差异；本机是桌面终端。⚠️ 未验证
- **网络相关**：ffmpeg 到 B站 CDN 的证书链、ASR 模型下载、真实转写与 OCR 推理。⚠️ 未验证
- **模型质量与性能**：不在探针范围。⚠️ 未验证
- 脚本局限：`resolveToolchain` 的二进制探测没有超时，PATH 里若有挂起的 ffmpeg shim，探针会卡住。⚠️ 未验证（本机未复现）
