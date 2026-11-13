# 安装与自检

面向第一次安装的用户。命令只使用真实存在的工具（`npm`、`pnpm`、`ln`、`mklink`、`brew`、`pip`、`xcode-select`、`swiftc`）。
DSH 专有的安装动作若尚未验证，会明确写「由插件管理器完成（待发布后补充）」。

## 1. 前置

| 项 | 要求 | 说明 |
| --- | --- | --- |
| DSH 桌面版 | `engines.dsh`: `>=0.1.0-rc.6 <0.3.0` | 插件随宿主加载；版本不满足时宿主会拒绝 |
| Node.js | ≥ 20 | **只有**仓库 CLI 与 `doctor` 需要；宿主自带运行时，不共用这个 Node |
| 仓库依赖 | `npm install` | 运行时依赖为 `sharp`、`qrcode` |

## 2. 外部依赖矩阵

| 能力 | macOS | Windows | Linux | 必需性 | 缺失时会发生什么 |
| --- | --- | --- | --- | --- | --- |
| ffmpeg | `brew install ffmpeg` | 解压静态包（如 gyan），配 `ffmpegPath` | 发行版包管理器 | 建议装 | 抽帧降级为故事板（`source=storyboard`，约 6–8 秒一格），精度以 `maxErrorMs` 为准 |
| CA 证书 | 自动用 `/etc/ssl/cert.pem` | **必须**配 `ffmpegCaFile` 或放 `cacert.pem` | 自动探测常见系统 CA 包 | 仅 Windows 必需 | Windows 上报 `certificate verify failed`，HTTPS 抽帧/音频失败 |
| Python + faster-whisper | venv + `pip install faster-whisper` | 同左（`Scripts\python.exe`） | 同左 | 可选 | `bilibili_transcribe` 报 `DEPENDENCY_MISSING`；无字幕时不自动转写 |
| Xcode CLT（OCR） | `xcode-select --install`（用 `swiftc` 编译 Vision 助手） | 不需要（系统自带 Windows.Media.Ocr） | 未接入 OCR 引擎 | 可选 | macOS 首次 OCR 编译失败、OCR `available=false`；Linux 报 `UNSUPPORTED` |

三者都缺时插件照常启动：只是画面降级、不能 OCR/转写，且降级在返回值里可见。

这些路径与解释器位置可以在 设置 →「BiliBridge」→「运行时路径」里直接填写（ffmpeg、CA 证书、
ASR Python、模型目录），留空表示自动探测；保存后下一次调用生效。也可以写 `config.json` 的
`runtime` 段（旧版顶层 `ffmpegPath` 等仍兼容），或设环境变量（优先级最高）。

## 3. 安装方式（三种，注意状态）

### a. 插件市场 / `plugin_manager` 按包名安装 —— **待发布**

包还不在 registry，当前**没有**可执行的安装命令。发布后请在宿主里用插件管理器按包名
`dsh-bilibili-bridge` 安装，profile 的 `dependencies` 与 `dsh.profile.bundles` 由插件管理器完成（待发布后补充）。
不要在没有包的情况下照搬其它插件的命令。

### b. 从本仓库开发态链接安装（推荐给当前用户）

先装依赖：

```bash
cd /Users/<你>/Code/dsh-BiliBridge
npm install
```

编辑当前生效的 profile（macOS/Linux 为 `~/.dsh/profiles/desktop/package.json`，Windows 为
`%USERPROFILE%\.dsh\profiles\desktop\package.json`），**只追加、不覆盖**已有内容：

```json
{
  "dependencies": {
    "dsh-bilibili-bridge": "link:/Users/<你>/Code/dsh-BiliBridge"
  },
  "dsh": { "profile": { "bundles": ["…已有 bundle…", "dsh-bilibili-bridge"] } }
}
```

然后在 profile 目录安装，让 pnpm 生成符号链接：

```bash
cd ~/.dsh/profiles/desktop && pnpm install
```

> **依赖必须写 `link:`（pnpm 生成符号链接），不要写 `file:`。** `file:` 会让 pnpm 按 `files`
> 字段把仓库拷贝进 `node_modules`，之后改仓库不生效，必须重新安装。
> 没有全局 pnpm 时，可以直接建手工链接（目录联接），但**建完后不要再对这个 profile 跑
> `pnpm install` / `dsh plugin add`**：pnpm 可能把链接换成拷贝，仓库改动从此失效。

Windows 上 `link:` 路径写成 `"link:E:/Code/dsh-BiliBridge"`，其余相同。若不想跑 `pnpm install`，
也可以直接建链接：

```bash
# macOS / Linux
ln -sfn /Users/<你>/Code/dsh-BiliBridge ~/.dsh/profiles/desktop/node_modules/dsh-bilibili-bridge
# Windows（目录联接，不需要管理员）
cmd /c mklink /J "%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-bilibili-bridge" "E:\Code\dsh-BiliBridge"
```

完成后重启 DSH。链接安装改代码只需再重启，不必重装。

验证装的是链接而不是拷贝：打开 `/bilibili-bridge/api/status`（设置页「BiliBridge」同样显示），
`identity.modulePath` 必须等于仓库绝对路径；若指向 `node_modules` 下的拷贝，按上面的 `link:` 重装。

### c. 从 GitHub Release 的 tarball 安装（推荐给外部用户）

每个 tag（如 `v0.1.0`）会自动构建 GitHub Release，并附带 `dsh-bilibili-bridge-<version>.tgz`。
用 DSH 插件管理器直接装（macOS / Linux / Windows 同一条命令；需要 `dsh` 在 PATH 或下文 shim）：

```bash
dsh plugin --profile desktop add https://github.com/Si-xiyu/dsh-BiliBridge/releases/download/v0.1.0/dsh-bilibili-bridge-0.1.0.tgz
```

> 普通 shell 里 `dsh` 可能不在 PATH（Windows 尤其常见）。Windows 用桌面版自带 shim：
> `<DSH 安装目录>\resources\runtime\cli\bin\dsh.cmd`；拿不到就退回 **b** 的手工链接安装（不需要 `dsh`）。

也可以在下载后按 pnpm 语义安装（插件管理器不在时的手工方式）：

```bash
cd ~/.dsh/profiles/desktop
pnpm add /path/to/dsh-bilibili-bridge-0.1.0.tgz
```

无论哪种方式，都要确认 `dsh.profile.bundles` 里有 `dsh-bilibili-bridge`（插件管理器会自动加；
手工 pnpm 时自己加），然后重启 DSH。

### d. 从本地 tarball 安装

```bash
cd /Users/<你>/Code/dsh-BiliBridge
npm pack                          # 产出 dsh-bilibili-bridge-0.1.0.tgz
cd ~/.dsh/profiles/desktop
pnpm add /Users/<你>/Code/dsh-BiliBridge/dsh-bilibili-bridge-0.1.0.tgz
```

`npm install /path/to/dsh-bilibili-bridge-0.1.0.tgz` 语义相同。tarball 里有 `lib/`、`bin/`、
`cordis.patch.yml`、README、INSTALL、CHANGELOG、LICENSE，**不含** `docs/` 与测试。
安装后仍需把 `dsh-bilibili-bridge` 加进 `dsh.profile.bundles`（由插件管理器完成时无需手工加），然后重启 DSH。tarball 是拷贝，升级必须重装。

## 4. 安装后验证

```bash
node bin/bili.mjs doctor          # 人读表格
node bin/bili.mjs doctor --json   # 机器可读
```

- **必需项**：`runtime`（Node ≥ 20、插件身份、工具数）与 `storage`（数据目录可写、凭据 0600、config 可解析）。
- **可选项**：`ffmpeg`、`asr`、`sharp`、`ocr`、`login`。缺失只标注、不阻断；`login` 未登录也算通过。
- **退出码**：`0` 必需项全部通过；`1` 必需项失败或参数非法（抛错）；`2` 未知子命令（打印用法）。

重启 DSH 后，新会话应看到 **27 个 `bilibili_*` 工具**；设置页「BiliBridge」显示版本、模块路径与工具数，可确认宿主加载的是哪一份代码。宿主重启验收仍待执行（见 CHANGELOG）。

## 5. 升级与重装

| 安装方式 | 改代码后要做什么 |
| --- | --- |
| `link:` / 符号链接 / 目录联接 | 只需要**重启 DSH**；`npm install` 仅在依赖变化时需要 |
| `file:` 拷贝 / 本地 tarball / 市场包 | 必须**重新安装**（`pnpm add` 或 `pnpm install`）再重启，否则宿主跑的是旧拷贝 |

设置页里的取数开关保存后下一次调用生效；`lib/` 代码没有 HMR，必须重启宿主。

## 6. 排障

- **ffmpeg `certificate verify failed`（Windows）**：gnutls 构建不读系统证书库。在
  `~/.dsh/bilibili/config.json` 写 `{ "ffmpegCaFile": "C:/Users/<你>/.dsh/bilibili/cacert.pem" }`，
  或设 `FFMPEG_CA_FILE`，或把 Mozilla 根证书存成数据目录下的 `cacert.pem`。macOS 一般自动命中系统 CA；
  自备 ffmpeg 仍失败时同样显式配 `ffmpegCaFile`。
- **ASR `DEPENDENCY_MISSING`**：找不到能 `import faster_whisper` 的 Python。建 venv 后把解释器写进
  `config.json#asrPython` 或设 `BILI_ASR_PYTHON`；默认位置是 `<数据目录>/asr-venv`。模型首次转写会下载，
  国内网络可配 `hfEndpoint`（如 `https://hf-mirror.com`）。
- **OCR `NOT_BUILT`**：空数据目录下 `bin/bili-ocr-vision` 尚未编译，这是正常状态（干净基线探针会这样报）。
  首次真正 OCR 时才用 `swiftc` 编译；若 `swiftc` 不存在，先 `xcode-select --install`。doctor 对应
  `BUILD_PENDING`（可编译）或 `DEPENDENCY_MISSING`（缺 swiftc 且无可用二进制）。
- **doctor 的 `IDENTITY_UNKNOWN`**：插件入口导入失败，通常是没跑 `npm install`（缺 `sharp`）或 Node < 20。
  doctor 仍标 runtime 通过，但工具数与模块路径会显示未知；补依赖后重跑。
