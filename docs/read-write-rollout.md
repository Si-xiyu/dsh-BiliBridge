# 基础读写扩展：P0 / P1

## 2026-11-09/10 dev-op 增量

工作分支：`dev-op`；worktree：`.agents/worktrees/dev-op`。在 auto-dev `49a2a61` 基础上增加：

- `bilibili_messages`：私信会话/正文读取（只读、不标记已读、正文截断、图片只给 URL）。
- `bilibili_dynamics` 扩展：`dynamicId` 详情、`includeImages`；`origin` 保留原动态正文/标题/bvid/图片/URL。
- `bilibili_content_manage`：删除自己的评论/动态、定时草稿列表/删除/立即发布；preview/apply + 审批。
- 发送失败透传平台原话与 `biliCode`；21047→`DM_RESTRICTED`（不可重试），21046/21020 带暂停时长；未知业务码也保留 `message/msg`。
- 私信读取与发送标记为 sensitive，devlog 不落正文/结果预览。
- Codex review 修复：`publish_draft_now` 的 token 绑定草稿 `requestHash`；`delete_comment` 预览先校验评论作者属于当前账号；`delete_dynamic` apply 不再把 4101152 当“已删除”，直接按绑定 id 尝试删除、只认 500404；附件能力不可用时跳过图片下载。

验证：`npm run test:single` **235/235**；27 个工具 schema **19,187 bytes**（测试上限 20,000）。私信读库层已用真实账号只读探测 `get_sessions`/`fetch_session_msgs` 通过。宿主已加载 27 工具；`bilibili_messages` 与 `bilibili_dynamics(dynamicId)` 已真实调用成功，`tools/pre-execute` 审批路径仍待验证。

2026-11-10 真实库层 E2E（账号 四夕羽_，脚本 `tests/manual-op-e2e.mjs --apply`，每项写完回读并清理）：

| 项 | 结果 |
| --- | --- |
| 稍后观看 `BV1GJ411x7h7` | add verified → remove verified |
| 收藏 `research`（3936040233） | add verified → remove verified |
| 评论 `BV1KDNA6eEgr` | SENT rpid 323485773824 → 删除，列表不存在 |
| 图文动态 | SENT id 1268744613532794883（1 图）→ detail 回读 → 删除，feed 不含；删除后详情 4101152 已映射 NOT_FOUND |
| 私信 260118260 | SENT → `bilibili_messages` 读回 found；同文再发 DUPLICATE；不重发 |
| 定时草稿 | 列表真实端点为 `dynamic_draft/get_drafts`（空列表通过）；`add_draft` 真实返回 4120015，定时创建未验收 |
| 21047 | 该会话对方曾回复，未真实触发；仍由模拟复现与历史真实报错覆盖 |
| 未清理 | 私信测试消息保留一条；评论/动态/收藏/稍后观看均已恢复 |

以下为 2026-11-03 历史记录。

日期：2026-11-03（Asia/Shanghai）。工作分支：`dev/codex`；worktree：`.worktree/codex`。本轮不包含视频投稿、投稿任务模型、独立分区工具或 Opus。初次交付 aa9abb8 时尚未 merge；随后与 auto-dev 集成，见下方记录。没有修改 desktop profile 或重启 DSH。

## 与 auto-dev 集成

在 dev/codex 中以 no-ff 合入 auto-dev 7e820fb，自动合并无冲突。保留双方 state.md 章节、开发者日志及可选浮层、十条设置路由、dev.enabled 配置，以及动态图片/原动态索引；lib/index.js 审批策略保持原样。合并后 npm run test:single 为 **161/161**，注册工具 **25 个且无重名**。随后将此集成结果以 no-ff 合回 auto-dev；新增工具的真实宿主验收仍需重启 DSH。

## 工具预算

保留原有 19 个工具及四个认证入口。新增 6 个，当时共 **25 个**（当前 27 个，见上）；模型可见的名称、说明和参数 schema 序列化约 **16.3 KB**，不是 tokenizer 实测 token 数。测试约束工具数为 25、上述序列化体积小于 20 KB。

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

### 统一请求保护（2026-11-10）

统一 HTTP 入口改用私有 `traffic-state.json`：跨进程串行，API 最小发送间隔 1.5 秒；每账号读 600/小时、3000/天，写 12/小时、30/天。认证流程显式申请且命中白名单的登录恢复请求有独立、同上限的读取额度，防止普通额度用尽后无法扫码；普通工具的 nav/buvid 请求不享受此例外。旧 `write-rate-<account>.json` 不删除，已有写暂停和退避继续生效。

普通写间隔 3 秒；评论、动态及草稿发布 120 秒，私信 60 秒；高影响写入交替时遵守更严格的冷却。普通短间隔会等待，长冷却和失败退避直接拒绝；失败退避最多 192 秒，不自动重发。上传和最终发布分别消耗写额度，preview 的读取不消耗写额度。

HTTP 412/429、明确业务风控及非 JSON 成功响应会全局暂停 5/10/20/30 分钟，尊重更长的 Retry-After；私信 21020/21046 只暂停私信 5 分钟/24 小时。验证码要求人工处理，登录失效需要新扫码并校验。请求发出但结果未落盘就退出的进程会留下中断屏障，需人工核对后恢复。暂停期间 check 也不绕过读取限制，未决发送仍保留。

`node bin/bili.mjs traffic status` 离线查询；`traffic resume --go` 只确认人工处理，不清预算和平台暂停。图片/字幕/弹幕下载服从暂停但不计 API 额度；ffmpeg 只检查启动前的全局暂停，不接管其内部切片。最终全量离线测试 260/260 通过，未做真实账号风控或宿主重启验收。完整策略、review 修正与限制见 [交付总结](risk-control-summary.md)。

### 动态图片与定时

图片先经 multipart 上传 `/x/dynamic/feed/draw/upload_bfs`，随后以 JSON 发布动态。上传失败停止发布，不降级为纯文字。上传成功不代表动态发布成功。

定时使用平台 draft，不创建本地定时器。当前定时接口不支持与话题组合，明确返回 UNSUPPORTED。图床、话题、定时和私信真实发送本轮均未执行，只完成源码核对与模拟测试，不能标记为真实验收通过。

## 批量采集边界

硬上限：10 个视频，每视频 20 条主评论，不补楼中楼；顺序请求，110 秒内部截止，结果数据约 512 KB 上限。不做 ASR / OCR。取消、超时或预算耗尽保留已完成结果，返回 stopped、unprocessed；来源失败记录在每个视频的 errors。字幕未读完时返回 nextCursor，可用 extract 继续。

遇到风控、统一暂停、额度耗尽、人工验证、异常响应或登录失效会立即停止，跳过后续字幕和视频请求。`incomplete` 指出已返回但未完成的当前视频，`unprocessed` 列出尚未返回的视频，`stopDetails` 保留停止原因和可用的恢复时间。普通单条内容错误仍允许继续。

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
