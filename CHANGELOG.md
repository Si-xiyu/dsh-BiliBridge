# 变更记录

## 0.1.1（2026-11-13）

安装体验与 Windows 验收修复版本。

### Added

- 设置页新增「运行时路径」：ffmpeg、CA 证书、ASR Python、模型目录可直接编辑；
  留空表示自动探测，保存后下一次调用生效。配置写入 `config.json` 的 `runtime` 段，
  旧版顶层 `ffmpegPath` 等键继续兼容，嵌套优先。
- 新增 `AGENT-INSTALL.md`：面向 AI Agent 的安装与验收说明。
- README 增加 Quickstart（Release tarball / 仓库安装两条路径）。
- 发布工作流：push tag 时自动构建 GitHub Release 并附 tarball。

### Changed

- 收藏夹成员判断优先调用 `/x/v3/fav/resource/ids`：一次请求返回全部条目
  （696 项实测约 1.5 秒），替代逐页扫描；异常或畸形响应回退到原分页逻辑。
- 搜索结果过滤掉没有合法 bvid 的广告/推荐行；`total` 等上游计数语义不变。
- 安装文档明确 profile 依赖使用 `link:`、禁止 `file:`；手工 junction 后不要再跑
  `pnpm install` / `dsh plugin add`；补充 `dsh` 不在 PATH 时使用桌面版 shim 的说明。
- 设置保存时按生效值重置运行时缓存；ASR 路径变化会重启常驻 daemon；
  解析器增加代际，reset 期间完成的探测不会写回旧缓存。

### Fixed

- Windows 收藏夹预览 30 秒超时（大收藏夹）。
- Windows 原生环境单测因 `PATH` / `Path` 大小写失败。
- Windows 搜索结果混入空 bvid / 1970 时间戳的广告条目。
- 设置页把旧版顶层运行路径显示为空、误判为自动探测。
- `settings/reset` 403 分支调用未定义函数导致的 500。

### 已知边界

- DSH 宿主重启后的工具级复核（Windows）仍在进行；库层与 tool handler 层已通过。
- 未发布到 npm registry；插件市场按包名安装待发布后补充。
- Windows 上单测预期 336 项、2 项 POSIX 专用 skip。

## 0.1.0（2026-11-11）

首个面向早期用户的可分发版本，以开发态链接安装与本地 tarball 安装为主。

### Added

- 27 个 `bilibili_*` 工具：登录与账号状态、视频/用户/动态/收藏夹/稍后观看/通知/私信读取、搜索与发现、
  评论/弹幕/字幕采集；写操作含评论、私信、动态、点赞、收藏、稍后观看，以及删除自己的评论/动态和定时草稿管理。
- 两阶段视频证据：`bilibili_extract`（文本 + 封面/九宫格）、`bilibili_inspect`（定向/全片/区间自适应选帧）、
  `bilibili_transcribe`（窗口化 ASR）、可选 OCR。
- 视频取数节能模式：设置页五个开关与「节能（仅字幕）/ 标准（全量）」预设；`extract` 默认取数受设置约束，
  设置与调用参数 `include` 为 AND 关系。
- 统一请求风控保护：跨进程最小间隔、账号小时/日额度、平台暂停与人工恢复、失败退避；批量采集遇风控停止；
  `node bin/bili.mjs traffic status` 可离线查看预算与暂停状态。
- macOS 平台实现：Apple Vision OCR（首次 OCR 时用 `swiftc` 编译助手）、按平台解析 ASR 与 ffmpeg、
  自动使用系统 CA。
- `node bin/bili.mjs doctor`：离线自检 7 项并支持 `--json`；必需项失败时退出码为 1。
- 设置页新增「运行时路径」：ffmpeg、CA 证书、ASR Python、模型目录可直接编辑；留空=自动，
  保存后下一次调用生效（`config.json` 的 `runtime` 段，旧版顶层键仍兼容）。
- macOS/Windows 双平台 CI（`.github/workflows/platform-ci.yml`）：干净安装、sharp 原生模块、
  Windows 系统集成（pwsh/icacls）与单测。
- `INSTALL.md`、`CHANGELOG.md` 加入包内 `files` 白名单；补充 `repository` 元数据。

### Changed

- 工具数从 25 增至 27：新增 `bilibili_messages`、`bilibili_content_manage`；`bilibili_dynamics` 增加
  `dynamicId` 详情与可选图片附件。
- ffmpeg 在非 Windows 平台自动选择系统 CA；ASR 支持 `config.json#hfEndpoint` 模型镜像。
- 安装语义明确区分「链接安装」与「拷贝安装」：链接改代码只需重启，`file:`/tarball 拷贝必须重装。
- README 安装段指向 `INSTALL.md`，面向用户的步骤与开发态细节分开。

### Fixed

- 定时草稿列表改用 `get_drafts` 端点。
- 动态图片附件不可用时跳过下载，不再拖垮整条动态读取。
- `bilibili_inspect` 的故事板匹配偏差透传到返回值。
- macOS GUI 进程能找到 Homebrew 的 ffmpeg；ffmpeg 缺失用例改为注入空安装位置。
- Windows 凭据权限用 `icacls` 收紧；临时目录统一走 `os.tmpdir()`。
- 字幕读取走 WBI 签名的 `/x/player/wbi/v2`，避免拿到其它视频的 AI 字幕。

### 未完成 / 未验证（不在本版本承诺内）

- **DSH 宿主验收未完成**：重启宿主后的 27 工具显示、设置页与审批路径尚未验收。
- **未发布到 npm registry**：`private: true` 保持不变，插件市场安装方式待发布后补充。
- GitHub Release：tag 触发 `.github/workflows/release.yml` 自动构建并附 tarball。
- 定时草稿**创建**仍返回平台错误 `4120015`（未验收）；列表/删除/立即发布已实现，立即发布不受该错误影响。
- Windows 真机本轮未复验；Linux 未在真实机器验证（OCR 未接入，其余能力走同一套代码）。
- CI 稳定性：Windows runner 的 traffic-guard 时序断言曾偶发失败；根因是间隔按“预留时刻”
  计算、实际 dispatch 在落盘后（Windows 写盘抖动会吃掉少量时间）。断言已改为容忍
  dispatch 抖动（≥60ms，预留语义仍是 80ms），并把 CI 测试改为文件级串行。
