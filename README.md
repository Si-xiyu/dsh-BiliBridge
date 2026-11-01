# dsh-BiliBridge

DSH 插件：把 B 站账号的只读能力、低风险写操作和两阶段视频证据提取，暴露给主 Agent（DeepSeek）。

## 当前状态

完整状态见 [docs/state.md](docs/state.md)，工具的真实 endpoint 与验证等级见 [docs/capability-matrix.md](docs/capability-matrix.md)。

- 认证、HTTP/WBI、凭据持久化：已在旧 macOS 环境用真实账号验证（扫码登录、投稿、稍后观看、收藏夹、评论、字幕、弹幕、故事板）。
- 工具层 18 个：**已装进本机 Windows 的 desktop profile，宿主内 18 个工具全部可见**；搜索/评论/用户主页/动态有独立进程真实验收。
- 视频理解：Stage 1（文本 + 封面 + 故事板九宫格）可用；Stage 2 已接 **ffmpeg 精确抽帧**（误差 ≤100ms，宿主内实测），没有 ffmpeg 时降级故事板并如实报 `maxErrorMs`。
- 写操作：代码与审批门禁已实现，仅做过 dry-run，未在真实账号上执行。

## 外部依赖：ffmpeg（可选，但决定画面质量）

`bilibili_inspect` 优先用 ffmpeg 从播放流精确抽帧；没有它，画面自动降级为 B站故事板（约 6–8 秒一格，读小字不行）。

```powershell
# 1) 放二进制（示例：gyan essentials 静态包）
#    D:\tools\ffmpeg\ffmpeg-9.0.2-essentials_build\bin\ffmpeg.exe

# 2) 让插件找到它（二选一）
#    a. 写配置文件 %USERPROFILE%\.dsh\bilibili\config.json
#       { "ffmpegPath": "D:/tools/ffmpeg/.../bin/ffmpeg.exe", "ffmpegCaFile": "C:/Users/<你>/.dsh/bilibili/cacert.pem" }
#    b. 设环境变量 FFMPEG_PATH / FFMPEG_CA_FILE

# 3) Windows 必须给 CA：该构建用 gnutls，不读系统证书库
#    把 Mozilla 根证书存成 %USERPROFILE%\.dsh\bilibili\cacert.pem
```

Linux/macOS 通常自带信任链，可以只设 `FFMPEG_PATH`。验证：`node tests/manual-frames.mjs BV1GJ411x7h7 auto`。

## 工具

| 工具 | 性质 |
| --- | --- |
| `bilibili_auth_status` / `bilibili_auth_begin` / `bilibili_auth_poll` / `bilibili_auth_logout` | 登录 |
| `bilibili_me` | 当前账号 |
| `bilibili_video` | 视频元数据 + 统计 |
| `bilibili_user_videos` | 投稿列表（mid 省略=自己） |
| `bilibili_watch_later_list` / `bilibili_watch_later_set` | 稍后观看 |
| `bilibili_favorites_list` / `bilibili_favorite_set` | 收藏夹 |
| `bilibili_video_like_set` | 点赞 |
| `bilibili_extract` | Stage 1 证据包（文本 + 2 张图） |
| `bilibili_inspect` | Stage 2 定向补帧 |
| `bilibili_search` | 视频 / 用户搜索（WBI） |
| `bilibili_comments` | 热门 / 最新评论与最多 3 条楼中楼 |
| `bilibili_user_profile` | 用户主页、粉丝 / 关注数、可取得时的投稿数 |
| `bilibili_dynamics` | 用户动态 / 当前账号关注动态 |

三个写工具在代码层走 `tools/pre-execute` 的 `ask`，无人值守时由 DSH fail closed。

## 安装（开发版）

Windows（当前环境）：

```powershell
# 1) 把插件挂进 profile 的 node_modules
#    推荐在 profile 里用 file: 依赖，让 pnpm 建链接；也可手工建目录联接：
cmd /c mklink /J "$env:USERPROFILE\.dsh\profiles\node_modules\dsh-bilibili-bridge" "E:\Code\dsh-BiliBridge"
```

在 `%USERPROFILE%\.dsh\profiles\desktop\package.json` 里：

```json
"dependencies": { "dsh-bilibili-bridge": "file:E:/Code/dsh-BiliBridge" },
"dsh": { "profile": { "bundles": [..., "dsh-bilibili-bridge"] } }
```

macOS/Linux：把上面的 `mklink /J` 换成 `ln -sfn <仓库> ~/.dsh/profiles/node_modules/dsh-bilibili-bridge`。

重启 DSH 后，新会话里应能看到 18 个 `bilibili_*` 工具。**插件没有 HMR，改 `lib/` 必须重启宿主。**

## 开发 CLI

```powershell
$env:BILI_DATA_DIR=".\.bili-data"
node bin/bili.mjs status
node bin/bili.mjs qr          # 生成二维码 PNG
node bin/bili.mjs poll 30     # 轮询
node bin/bili.mjs latest      # 我最新投稿 + 播放量

npm run test:single           # 单进程跑单测（受限沙箱里 npm test 的子进程会 EPERM）
node tests/manual-evidence.mjs BV1YLHu6zEDp
node tests/manual-read.mjs search "编程" --type video
node tests/manual-read.mjs comments BV1VZWc6dECG --sort hot
```

macOS/Linux 用 `BILI_DATA_DIR=./.bili-data node ...` 的写法。

只读工具的 endpoint、真实验收摘要与限制见 [能力矩阵](docs/capability-matrix.md)。手工脚本只输出分页信息和前两条样本；`--page` / `--page-size` 控制列表分页，动态用 `--offset` 续取，`--no-replies` 关闭楼中楼，`--anonymous` 验证无凭据状态。

抓包探针需要 `playwright-core`（未列入依赖）：`npm i -D playwright-core`，或用 `PLAYWRIGHT_CORE` 指向它的入口文件。

## 约束

- 唯一推理模型是 DSH 主 Agent；插件不调用任何 LLM/VLM。OCR 只做文字识别、ASR 只做语音转写，两者都只是证据来源，输出必须标 `origin`。
- 凭据只允许当前用户访问（POSIX 0600；Windows 用 icacls 关继承、只授权当前用户）；工具返回值、日志、报告不出现 Cookie / CSRF / 刷新凭据。
- 所有 B站请求（含图片/字幕/弹幕/DASH 流）走 `lib/bili/http.mjs`：一套 UA/Referer，域名白名单，禁止内网地址。
- 不实现自动刷视频、人格、主动分享。
- 故事板精度约 ±1s；读小字需要 ffmpeg。

## 已知限制

- 字幕必须走 WBI 签名的 `/x/player/wbi/v2`；不带签名的 `/x/player/v2` 会返回别的视频的 AI 字幕，不能使用。
- 当前字幕代码没有旧的标题匹配、最小质量过滤或短重试；长字幕默认只返回前 800 条，尚无续取入口。
- 评论常规分页使用 `/x/v2/reply`。每次最多补取前 5 个预览不足的楼中楼，其余保留已有预览。只有 -400 或明确要求 WBI 时才降级；WBI 降级仅支持第一页，不把风控错误当作降级理由。
- 动态 pageSize 是单次上限（1–50）；nextOffset 有下一页时始终为绑定 scope 的 `dsh:` 游标，裸 offset 会返回 INVALID_ARGUMENT，旧的裸游标需重新从第一页获取。较小分页保留同一上游批次的尾部。不是快照，源列表变化时可能重复或漂移，调用方宜按 dynamicId 去重。纯图片动态没有文本时返回空 text，不做 OCR。
- 故事板九宫格是“概览”，不是精确抽帧；`bilibili_inspect` 会返回 `req/got` 与 `accuracy`。
- 空间接口目前 8/8 成功，但 B站风控随时可能变化；412 会作为 `RATE_LIMITED` 返回。
- 未登录时 `nav` 返回 `-101`，HTTP 层用 `acceptCodes` 处理。
