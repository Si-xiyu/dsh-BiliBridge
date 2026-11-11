# 变更记录

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
- 定时草稿**创建**仍返回平台错误 `4120015`（未验收）；列表/删除/立即发布已实现，立即发布不受该错误影响。
- Windows 真机本轮未复验；Linux 未在真实机器验证（OCR 未接入，其余能力走同一套代码）。
- CI 稳定性：Windows runner 曾出现一次 traffic-guard 时序断言偶发失败（重跑即绿）；
  已改 `--test-concurrency=1` 降低概率，未根除。
