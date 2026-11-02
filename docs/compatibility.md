# 兼容性记录

采集时间：2026-10-30（Asia/Shanghai）

| 项 | 值 |
| --- | --- |
| 桌面版 | 0.2.1-rc.3（Info.plist） |
| primary-runtime | 0.2.1-rc.5 |
| profile 内 core 包 | 0.1.0-rc.6 |
| Node（runtime） | 24.21.0 |
| 系统 | macOS arm64 |
| profile | desktop |
| 当前模型路由 | deepseek-official / deepseek-flash |
| 图像输入 | 已用内置 `read_image` 实测：图片进入主 Agent 上下文并可描述 |

## 2026-11-02：迁移到 Windows

| 项 | 值 |
| --- | --- |
| 桌面版 runtime | `@deepseek-ai/dsh-desktop-runtime@0.2.1-rc.5`（asar 内 `dsh/package.json` 读出） |
| Node | v24.16.0 |
| 系统 | Windows 11（NT 10.0.26200），x64 |
| 仓库 | `E:\Code\dsh-BiliBridge` |
| profile | `%USERPROFILE%\.dsh\profiles\desktop`（pnpm workspace，`bundles` 里含 `dshmarket`） |
| 模型路由 | `deepseek-account / deepseek-flash`（profile 的 `agent-default-model`） |
| 运行时依赖 | `sharp@0.35.5`、`qrcode@1.5.4`，已 `npm install` |

平台相关差异（已在代码里处理）：

- 凭据权限：NTFS 上 `chmod 0600` 只切只读位 → 改为 `icacls /inheritance:r /grant:r <当前用户>:(F)`，失败时只告警不阻断。
- 临时目录：`/tmp` 在 Windows 落到当前盘根 → 统一用 `os.tmpdir()`。
- 媒体请求：图片/字幕/弹幕/故事板原先各用一套请求头或无 Referer → 统一走 `http.mjs`（一套 UA/Referer + 域名白名单）。
- sharp 渲染 SVG 文字依赖可写的 fontconfig 缓存；受限进程里会打印 `No writable cache directories`，宿主内正常。
- ffmpeg 9.0.2（gyan essentials，gnutls）**不读 Windows 证书库**：直连 B站 CDN 报 `Peer certificate failed verification`，
  必须传 `-ca_file`（轮机用 `%USERPROFILE%\.dsh\bilibili\cacert.pem`）。路径与 CA 写在
  `~/.dsh/bilibili/config.json` 的 `ffmpegPath` / `ffmpegCaFile`。
- 插件安装方式：`desktop/node_modules/dsh-bilibili-bridge` 目录联接（junction）→ 仓库；
  profile `package.json` 的 `dependencies` 与 `dsh.profile.bundles` 均已登记（备份 `*.bak-20261102`）。
  改 profile 后宿主动态重载，轮轮 18 个工具已在轮会话可见。
- `readJson` 会剥掉 UTF-8 BOM：Windows 工具写出的配置常带 BOM，否则配置会“悄悄不生效”。

## 宿主服务（目标版轮）

- 有：`tools`、`attachments`（`saveImage`）、`agents`（`create/resume` + `followup`）、`approval`、`llm`（`resolveModelInfo`）
- 无：`sessionController`（Whale 依赖的旧服务）
- 调度：`schedule` 是会话级提醒工具，不是 cron 服务；停机只补最近一次

## 插件加载

- `package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`
- profile 的 `package.json` 里登记依赖，`dsh.profile.bundles` 增加轮包
- 开发时用 symlink 挂到 `~/.dsh/profiles/node_modules/`
- **改动 bundle 层后需要重启 DSH**；仅改插件 JS 是否热更新取决于宿主 HMR，未验证

## 已知限制

- 无系统钥匙串：凭据只能用 0600 文件
- 未登录时 `nav` 返回 `code:-101`，但响应仍带 `wbi_img`；HTTP 层必须 `acceptCodes: [-101]`
- 空间/动态/私信接口风控重，需在 M1.5 用真实账号探测
- 轮机没有 ffmpeg；Stage 1 的画面部分需要先做依赖体检
