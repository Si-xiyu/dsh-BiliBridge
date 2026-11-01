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

## 宿主服务（目标版本）

- 有：`tools`、`attachments`（`saveImage`）、`agents`（`create/resume` + `followup`）、`approval`、`llm`（`resolveModelInfo`）
- 无：`sessionController`（Whale 依赖的旧服务）
- 调度：`schedule` 是会话级提醒工具，不是 cron 服务；停机只补最近一次

## 插件加载

- `package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`
- profile 的 `package.json` 里登记依赖，`dsh.profile.bundles` 增加本包
- 开发时用 symlink 挂到 `~/.dsh/profiles/node_modules/`
- **改动 bundle 层后需要重启 DSH**；仅改插件 JS 是否热更新取决于宿主 HMR，未验证

## 已知限制

- 无系统钥匙串：凭据只能用 0600 文件
- 未登录时 `nav` 返回 `code:-101`，但响应仍带 `wbi_img`；HTTP 层必须 `acceptCodes: [-101]`
- 空间/动态/私信接口风控重，需在 M1.5 用真实账号探测
- 本机没有 ffmpeg；Stage 1 的画面部分需要先做依赖体检
