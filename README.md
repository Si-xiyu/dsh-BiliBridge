# dsh-BiliBridge

DSH 插件：把 B 站账号的只读能力、低风险写操作和两阶段视频证据提取，暴露给主 Agent（DeepSeek）。

## 当前状态

- 认证、HTTP/WBI、凭据持久化：已用真实账号验证（扫码登录、空间投稿、稍后观看、收藏夹、评论、字幕、弹幕、故事板）。
- 工具层 14 个：已安装进 desktop profile，并在 DSH 内验证通过。
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

重启 DSH 后，新会话里应能看到 14 个 `bilibili_*` 工具。

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
```

## 约束

- 唯一推理模型是 DSH 主 Agent；插件不调用任何 LLM/VLM。
- 凭据只落在 0600 文件；工具返回值、日志、报告不出现 Cookie / CSRF / 刷新凭据。
- 不实现自动刷视频、人格、主动分享。
- 故事板精度约 ±1s；读小字需要 ffmpeg。

## 已知限制

- 字幕必须走 WBI 签名的 `/x/player/wbi/v2`；不带签名的 `/x/player/v2` 会返回别的视频的 AI 字幕，不能使用。
- 官方字幕也可能只有 1 条广告/占位文本，已按 `SUBTITLE_TRIVIAL` 丢弃。

- B站 `player/v2` 的 AI 字幕列表会间歇性返回空，已加 3 次短重试，仍可能为空（返回 `empty`，不编造）。
- 故事板九宫格是“概览”，不是精确抽帧；`bilibili_inspect` 会返回 `req/got` 与 `accuracy`。
- 空间接口目前 8/8 成功，但 B站风控随时可能变化；412 会作为 `RATE_LIMITED` 返回。
- 未登录时 `nav` 返回 `-101`，HTTP 层用 `acceptCodes` 处理。
