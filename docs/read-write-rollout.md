# 基础读写扩展：P0 / P1

日期：2026-11-03（Asia/Shanghai）。工作分支：`dev/codex`；worktree：`.worktree/codex`。本轮不包含视频投稿、投稿任务模型、独立分区工具或 Opus。初次交付 aa9abb8 时尚未 merge；随后与 auto-dev 集成，见下方记录。没有修改 desktop profile 或重启 DSH。

## 与 auto-dev 集成

在 dev/codex 中以 no-ff 合入 auto-dev 7e820fb，自动合并无冲突。保留双方 state.md 章节、开发者日志及可选浮层、十条设置路由、dev.enabled 配置，以及动态图片/原动态索引；lib/index.js 审批策略保持原样。合并后 npm run test:single 为 **161/161**，注册工具 **25 个且无重名**。随后将此集成结果以 no-ff 合回 auto-dev；新增工具的真实宿主验收仍需重启 DSH。

## 工具预算

保留原有 19 个工具及四个认证入口。新增 6 个，共 **25 个**；模型可见的名称、说明和参数 schema 序列化约 **16.3 KB**，不是 tokenizer 实测 token 数。测试约束工具数为 25、上述序列化体积小于 20 KB。

| 新工具 | 范围 |
| --- | --- |
| `bilibili_discover` | popular / hotwords / weekly / rank；周刊列表与指定期；17 个榜单类别 |
| `bilibili_notifications` | unread / replies / at / likes / messages；私信只返回会话摘要，不读取或标记正文已读 |
| `bilibili_comment_send` | 新评论、一级回复、楼中楼；preview / apply / check |
| `bilibili_message_send` | 文字私信；preview / apply / check |
| `bilibili_dynamic_publish` | 文字、图片、话题或平台定时草稿；preview / apply / check |
| `bilibili_collect` | 搜索后批量读主评论和平台字幕，不触发 ASR / OCR |

新增查询和发送分开；没有万能 action 工具，也没有 auth 别名迁移。

## 已有工具扩展

- `search`：视频时长、分区过滤；保留用户搜索、分页和排序。
- `user_videos`：投稿内 keyword；pubdate / click / stow 排序。
- `favorites_list`：mid 指定用户收藏夹；mediaId 读取内容；keyword 与 mtime / view / pubtime 排序。
- `user_profile`：获赞、视频与文章播放数。可选统计不可得时返回 null 和 statsStatus；认证、限流、风控错误继续报错。
- `extract` 仍为单视频平台文本入口：subtitleCursor 续取；danmakuWindow 指定半开时间窗口，返回可获取集合内的计数、密度和样本。

字幕每页最多 800 条。nextCursor 绑定 bvid、cid、语言和完整字幕指纹；跨分 P、跨视频、字幕变化或消失都会拒绝续取。coverage 始终表示完整轨道覆盖率；returnedRange 表示本次页，cumulativeRange 表示按游标顺序至本页的累计范围。续取不重复获取评论、封面或故事板；可同时显式请求弹幕窗口。游标不是访问权限凭证，也不证明调用方确实读取过前页。

## 写入规则

现有三个状态写入工具仍默认 preview，apply 才审批并写后回读。新增发送工具必须先 preview；返回的 previewToken 有效期 10 分钟，绑定账号、类型、目标、正文和图片清单。apply 时任何变化都要求重新预览。

DSH `tools/pre-execute` 对六种 apply 操作统一返回 ask；发送类 check 只读，不审批。动态图片的确认信息包含本机路径、大小、SHA-256、宽高和格式。图片只接受本机绝对路径或现有白名单内的 HTTPS URL，每张最多 10 MB、最多 9 张，仅 JPG / PNG / GIF；不接受 UNC 路径。受宿主文件权限限制的路径会报错，不绕过权限。

### 本地发送账本

`<dataDir>/sends-<account>.jsonl`，仅当前用户访问。先落盘预留，再提交网络请求；判重和记录更新通过文件锁串行化，网络等待不占账本锁。

- 判重维度：账号、操作类型、目标、正文 SHA-256；动态目标另含图片指纹、话题和定时时间。
- 五分钟内重复返回 DUPLICATE，带原 operationId 和状态。
- 超时、断线或缺少有效返回 ID：PENDING_CONFIRM，禁止自动重发。
- 未决 SUBMITTING / PENDING_CONFIRM 超过五分钟仍保留保护。
- check 使用 operationId，从当前账号最近内容中比对作者、目标、时间、正文及必要的图片/话题。未匹配继续 PENDING_CONFIRM，不当作“未发送”。
- 核对只扫描最近一批内容，不保证找到旧内容；平台压缩图片会让字节哈希无法匹配，宁可保留未决。
- 不保存完整正文或 Cookie。已完成记录保留 30 天并在后续访问时清理；未决记录保留。预览文件只保存摘要，过期后在生成新预览时清理。

### 账号级写限流

所有经统一 HTTP 入口发出的账号写请求共用 `write-rate-<account>.json`：最小间隔 3 秒；412 / 429 和已识别风控码暂停 5 分钟；其他失败指数退避，最长 192 秒。状态跨进程保留。只等待正常间隔，不自动重发失败的写请求；暂停状态返回 WRITE_PAUSED 和恢复时间。预览和读取不消耗写额度。

### 动态图片与定时

图片先经 multipart 上传 `/x/dynamic/feed/draw/upload_bfs`，随后以 JSON 发布动态。上传失败停止发布，不降级为纯文字。上传成功不代表动态发布成功。

定时使用平台 draft，不创建本地定时器。当前定时接口不支持与话题组合，明确返回 UNSUPPORTED。图床、话题、定时和私信真实发送本轮均未执行，只完成源码核对与模拟测试，不能标记为真实验收通过。

## 批量采集边界

硬上限：10 个视频，每视频 20 条主评论，不补楼中楼；顺序请求，110 秒内部截止，结果数据约 512 KB 上限。不做 ASR / OCR。取消、超时或预算耗尽保留已完成结果，返回 stopped、unprocessed；来源失败记录在每个视频的 errors。字幕未读完时返回 nextCursor，可用 extract 继续。

## 验证记录

| 层级 | 结果 |
| --- | --- |
| 全量离线测试 | 151/151，通过 Node 24 单进程执行；覆盖原有设置页、ASR/OCR 等回归 |
| 写入安全模拟 | 并发判重、子进程重启后判重、未决长期保护、回读核对、预览变化、账号暂停、图片失败不发布、multipart→JSON、平台定时草稿 |
| 真实公开读取 | 热门、热搜、周刊列表/指定期、全站榜单、时长过滤搜索成功 |
| 真实账号读取 | 未读、回复、@、点赞、私信会话摘要；收藏夹列表；投稿收藏排序；主页统计 statsStatus=ok |
| 字幕与弹幕 | BV1VZWc6dECG：800 + 776 条，覆盖率一致、第二页无图；BV1GJ411x7h7：0–30s 弹幕窗口成功 |
| 批量采集 | 单视频、2 条主评论与平台字幕成功，partial=false，errors=[] |
| 已授权真实写入 | BV1GJ411x7h7 在 research（3936040233）收藏夹及稍后观看分别 false→true→false；四次写后校验均成功 |
| DSH | 注册函数确认 25 个唯一工具、审批钩子与输出 JSON；未切换运行中的安装路径，合并后仍需重启宿主验收 |

没有真实发送评论、动态、私信，也没有真实上传图片或创建定时草稿。榜单不伪造三日/七日历史维度。普通私信会话可能没有昵称，使用 talkerId 定位。Cookie 自动刷新、关注管理、投币、观看历史不在本轮范围。

复现命令：

```powershell
npm run test:single
node tests/manual-foundation.mjs public
node tests/manual-foundation.mjs account
node tests/manual-foundation.mjs text
node tests/manual-write-roundtrip.mjs            # 只读预览
# 以下仅在用户确认脚本中的具体目标后运行：
node tests/manual-write-roundtrip.mjs --apply
```

接口参考：[对照仓库源码](https://github.com/adoresever/bilibili-mcp/blob/main/mcp_server.py)、[动态发布与图床](https://github.com/pskdje/bilibili-API-collect/blob/main/docs/dynamic/publish.md)、[通知](https://github.com/pskdje/bilibili-API-collect/blob/main/docs/message/msg.md)、[私信](https://github.com/pskdje/bilibili-API-collect/blob/main/docs/message/private_msg.md)、[榜单](https://github.com/pskdje/bilibili-API-collect/blob/main/docs/video_ranking/ranking.md)、[历史定时动态实现](https://github.com/StudyWithJeffrey/bilibili-api/blob/main/bilibili_api/dynamic.py)。历史接口参考不能代替真实写入验收。
