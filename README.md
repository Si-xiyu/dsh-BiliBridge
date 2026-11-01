# dsh-BiliBridge

DSH 插件：把 B 站账号的只读能力、低风险写操作和两阶段视频证据提取，暴露给主 Agent（DeepSeek）。

## 当前状态

- 认证、HTTP/WBI、凭据持久化：已用真实账号验证（扫码登录、空间投稿、稍后观看、收藏夹、评论、字幕、弹幕、故事板）。
- 工具层 18 个：原有 14 个已有宿主验收记录；新增搜索、评论、用户主页和动态已通过独立 Node 进程的真实只读验收，待评审方重启 DSH 验证可见性。
- 视频理解：Stage 1（文本 + 封面 + 故事板九宫格）与 Stage 2（故事板定向补帧，±1s）已实现；本机没有 ffmpeg，精确抽帧待补。
- 写操作：代码与审批门禁已实现，仅做过 dry-run，未在真实账号上执行。

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

```bash
ln -sfn /Users/kairos/Code/agent/dsh-BiliBridge ~/.dsh/profiles/node_modules/dsh-bilibili-bridge
```

在 `~/.dsh/profiles/desktop/package.json` 里：

```json
"dependencies": { "dsh-bilibili-bridge": "file:/Users/kairos/Code/agent/dsh-BiliBridge" },
"dsh": { "profile": { "bundles": [..., "dsh-bilibili-bridge"] } }
```

重启 DSH 后，新会话里应能看到 18 个 `bilibili_*` 工具。本轮没有重启宿主。

## 开发 CLI

```bash
BILI_DATA_DIR=./.bili-data node bin/bili.mjs status
BILI_DATA_DIR=./.bili-data node bin/bili.mjs qr        # 生成二维码 PNG
BILI_DATA_DIR=./.bili-data node bin/bili.mjs poll 30   # 轮询
BILI_DATA_DIR=./.bili-data node bin/bili.mjs latest
BILI_DATA_DIR=./.bili-data node bin/bili.mjs watchlater
node tests/manual-evidence.mjs BV1YLHu6zEDp
node tests/manual-tools.mjs BV1YLHu6zEDp
npm test
BILI_DATA_DIR=~/.dsh/bilibili node tests/manual-read.mjs search "编程" --type video
BILI_DATA_DIR=~/.dsh/bilibili node tests/manual-read.mjs search "影视飓风" --type user
BILI_DATA_DIR=~/.dsh/bilibili node tests/manual-read.mjs comments BV1VZWc6dECG --sort hot
BILI_DATA_DIR=~/.dsh/bilibili node tests/manual-read.mjs profile 3546637928499654
BILI_DATA_DIR=~/.dsh/bilibili node tests/manual-read.mjs dynamics --mid 3546637928499654
```

只读工具的 endpoint、真实验收摘要与限制见 [能力矩阵](docs/capability-matrix.md)。手工脚本只输出分页信息和前两条样本；`--page` / `--page-size` 控制列表分页，动态用 `--offset` 续取，`--no-replies` 关闭楼中楼，`--anonymous` 验证无凭据状态。

## 约束

- 唯一推理模型是 DSH 主 Agent；插件不调用任何 LLM/VLM。
- 凭据只落在 0600 文件；工具返回值、日志、报告不出现 Cookie / CSRF / 刷新凭据。
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
