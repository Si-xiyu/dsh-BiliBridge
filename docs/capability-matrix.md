# 能力矩阵与只读验收

## 当前补充：2026-11-09/10 dev-op 读写补全

当前代码为 **27 个工具**，保持四个 auth 入口和单一 extract 平台文本入口。新增能力通过 225/225 离线测试；2026-11-10 已用真实账号完成库层写 E2E（稍后观看、收藏、评论、图文动态、私信），但**尚未重启宿主做工具层/审批路径验收**。

| 能力 | 实际 endpoint / 实现 | 本轮验证 |
| --- | --- | --- |
| messages | api.vc get_sessions / fetch_session_msgs | 真实账号只读探测通过；E2E 用它读回私信；工具层待宿主重启 |
| dynamics 详情/原动态 | /x/polymer/web-dynamic/v1/detail；origin 保留原动态 text/title/bvid/pics/url | 真实发布后 detail 回读成功；图片附件（工具层）未验收；删除后 4101152 已映射 NOT_FOUND |
| content_manage | /x/v2/reply/del、api.vc rm_dynamic、dynamic_draft list/rm_draft/publish_now | 真实删除评论/动态成功并回读；定时草稿仍为模拟 |
| 写 E2E | 稍后观看、收藏、评论、图文动态、私信 | 真实账号：add/remove verified；评论 SENT→删除；动态 SENT→删除；私信 SENT→读回；同文再发 DUPLICATE |
| 写错误透传 | sendOnce/check 保留 errorMessage/biliCode/biliMessage/hint；21047→DM_RESTRICTED | 21047 模拟复现通过；本会话对方曾回复，真实 21047 未触发 |
| messages 隐私 | 工具标记 sensitive；devlog 不落正文与结果预览 | 单测通过 |
| 工具预算 | 27 个工具 schema 约 19,145 bytes | 测试上限 20,000 bytes |

## 上一轮：2026-11-03 基础读写 P0/P1

上一轮代码为 25 个工具，保持四个 auth 入口和单一 extract 平台文本入口。详见 [交付记录与验证边界](read-write-rollout.md)。未切换正在运行的宿主路径；以下新增能力的真实验证均为 worktree 内独立 Node 进程。

| 能力 | 实际 endpoint / 实现 | 本轮验证 |
| --- | --- | --- |
| discover | /x/web-interface/popular、search/square、popular/series/list 与 one、ranking/v2 | 热门、热搜、周刊列表/指定期、全站榜单真实成功；其他榜单分区未逐项实测 |
| notifications | /x/msgfeed/unread、reply、at、like；api.vc 的 single_unread / get_sessions | 五种 scope 真实成功；会话不展开正文、不标已读 |
| user/search/favorites | 既有接口增加过滤；/x/space/upstat 补统计 | 投稿 stow、资料统计及收藏夹列表真实通过；其他参数有模拟覆盖，未全部逐项实测 |
| extract | /x/player/wbi/v2 + 原字幕 URL；/x/v1/dm/list.so | 800+776 字幕续取、覆盖率一致、续取不附图；弹幕窗口真实成功 |
| collect | 搜索 + 评论 + 字幕，复用既有客户端 | 单视频真实成功；取消与 512 KB 预算为模拟验证 |
| comment_send | /x/v2/reply/add；check 回读 reply 或 reply/reply | implemented；预览绑定、审批、判重和超时核对模拟通过，未真实发送 |
| message_send | api.vc /web_im/v1/web_im/send_msg；check fetch_session_msgs | implemented；预览与字节限制模拟通过，未真实发送 |
| dynamic_publish | draw/upload_bfs → feed/create/dyn；定时使用 api.vc add_draft | implemented；multipart、JSON、图片变化和定时草稿模拟通过，未真实上传/发布 |
| favorite_set / watch_later_set | 既有写接口 + guardedWrite 回读 | 已授权目标分别 false→true→false，四次 verified，最终恢复 |
| 统一写保护 | 私有 JSONL、账号限流 JSON、previewToken | 并发与子进程判重、未决保护、跨工具暂停模拟通过 |

## 以下为历史验收记录（2026-11-01 至 02）

历史的“尚未实现/尚无续取/未写入”等状态仅描述当时，不覆盖上方最新状态。

本轮验收日期：2026-11-01（Asia/Shanghai），Node v25.8.0。没有新增依赖，没有执行账号写操作，没有重启 DSH。新增四个工具通过注册函数和现有认证层在独立 Node 进程中调用；DSH 重启后的可见性、主模型调用仍待评审方验收。

状态含义：`implemented` 为代码具备但未真实验收；`verified` 为有指定环境中的真实调用证据；`limited` 为可用但有明确功能限制；`unsupported` 为未实现。历史验收来自 docs/handoff.md，不能当作本轮重新验证。

所有路径默认属于 `https://api.bilibili.com`；扫码路径属于 `https://passport.bilibili.com`。

| 工具 | 状态 | 实际 endpoint | 验证证据与边界 |
| --- | --- | --- | --- |
| bilibili_auth_status | verified（历史） | /x/web-interface/nav | 历史真实登录态验收 |
| bilibili_auth_begin | verified（历史） | /x/passport-login/web/qrcode/generate | 历史扫码验收，本轮未生成二维码 |
| bilibili_auth_poll | verified（历史） | /x/passport-login/web/qrcode/poll；nav；/x/frontend/finger/spi | 历史保存登录态验收 |
| bilibili_auth_logout | implemented | 本地清凭据 | 本轮未执行；不撤销远端会话 |
| bilibili_me | verified（历史） | /x/web-interface/nav | 历史 DSH 验收 |
| bilibili_video | verified（历史） | /x/web-interface/view | 本轮评论解析 aid 也实际调用 |
| bilibili_user_videos | verified（历史） | /x/space/wbi/arc/search | 本轮主页投稿计数也实际调用 |
| bilibili_watch_later_list | verified（历史） | /x/v2/history/toview | 历史 DSH 验收 |
| bilibili_watch_later_set | verified（预览；apply 受控） | 写接口 + 写后回读（/x/v2/history/toview、/x/v3/fav/resource、/x/web-interface/archive/like） | 默认 dry-run：只回读当前状态，不发写请求；intent=apply 才写并回读校验；结果不明先回读和解，不盲目重试 |
| bilibili_favorites_list | verified（历史） | /x/v3/fav/folder/created/list-all；/x/v3/fav/resource/list | 历史 DSH 验收 |
| bilibili_favorite_set | verified（预览；apply 受控） | 写接口 + 写后回读（/x/v2/history/toview、/x/v3/fav/resource、/x/web-interface/archive/like） | 默认 dry-run：只回读当前状态，不发写请求；intent=apply 才写并回读校验；结果不明先回读和解，不盲目重试 |
| bilibili_video_like_set | verified（预览；apply 受控） | 写接口 + 写后回读（/x/v2/history/toview、/x/v3/fav/resource、/x/web-interface/archive/like） | 默认 dry-run：只回读当前状态，不发写请求；intent=apply 才写并回读校验；结果不明先回读和解，不盲目重试 |
| bilibili_extract | verified（宿主内） | view；/x/player/wbi/v2；/x/player/videoshot；/x/v2/reply；comment.bilibili.com/{cid}.xml | **Stage 1 Fast Path**：平台字幕（上传优先、其次 AI）/弹幕/评论/封面/九宫格 + `gaps` / `suggestedWindows` / `evidenceLevel`；**不跑 ASR/OCR**；无字幕时 `subtitles.status=empty`。实测 411–831ms，与视频长度无关 |
| bilibili_inspect | verified（宿主内） | view；/x/player/wbi/playurl（DASH）；ffmpeg `-ss` 抽帧；降级时 /x/player/videoshot（多雪碧图）；OCR 走 Windows.Media.Ocr | 宿主内：`source=ffmpeg`、`accuracy=frame-level`、`maxErrorMs=null`（未读 PTS，不声明毫秒上界）、1080P、`imageAttached=true`；多帧按每张最多 6 格（2×3）均分拆图（7→4+3、9→5+4），每张独立附件；故事板兜底跨全部雪碧图；`ocr=true` 对返回帧批量识别（一次 PowerShell），`subtitleWindow` 走窗口连续字幕 OCR（跳过超限长图） |
| bilibili_transcribe | verified（本机进程内） | /x/player/wbi/playurl（音频流）+ 常驻 faster-whisper worker | 冷启 18.0s → 复用 4.1s；20s 窗口 9 段中文、`verdict=ok`、时间戳在原视频轴；缓存命中约 60ms 且不扣音频预算；越界/非法参数取流前报错；已提交请求失败不重放 |
| bilibili_search | verified（独立进程） | /x/web-interface/wbi/search/type | 视频和用户搜索均 20 条；真实用户空结果通过；未重启宿主 |
| bilibili_comments | verified（独立进程）；WBI 降级 limited | view → /x/v2/reply；缺少预览时 /x/v2/reply/reply；必要时 /x/v2/reply/wbi/main | 热门 20 条及楼中楼；最新第二页 3 条。真实调用未触发 WBI 降级，降级只做模拟验证且只支持第一页 |
| bilibili_user_profile | verified（独立进程） | /x/space/wbi/acc/info → /x/relation/stat → /x/space/wbi/arc/search | 真实主页、粉丝、关注、2193 条投稿计数返回；空间风控直接抛错，无重试循环 |
| bilibili_dynamics | verified（独立进程） | /x/polymer/web-dynamic/v1/feed/space 或 /feed/all | 用户流 13 条；关注流 20 条；2+2 小分页不重叠；无凭据关注流明确 AUTH_REQUIRED |

搜索、空间、动态会按需调用 `/x/frontend/finger/spi` 补 buvid3；WBI 密钥取自 nav。全部新增请求通过现有 `request`，没有加入写入 endpoint 或模型服务。

## 指定真实验收命令

前五条均以 `BILI_DATA_DIR=~/.dsh/bilibili node tests/manual-read.mjs` 执行。只记录必要摘要，不保存整包响应或账号凭据。

| 参数 | 本轮真实结果 |
| --- | --- |
| search "编程" --type video | ok；total=1000；20 条；hasMore=true；标题高亮标签已剥离 |
| search "影视飓风" --type user | ok；total=332；20 条；首个用户 mid=946974；头像、签名、等级正常 |
| comments BV1VZWc6dECG --sort hot | ok；total=2233；20 条；实际 endpoint=/x/v2/reply；楼中楼最多 3 条，包含字符串 id 和 ISO 时间 |
| profile 3546637928499654 | ok；fans=60123；following=310；archiveCount=2193 |
| dynamics --mid 3546637928499654 | ok；13 条；hasMore=true；视频动态含 bvid/title，纯图片条目缺少正文时 text="" |

补充真实验收：

| 命令 / 场景 | 结果 |
| --- | --- |
| search "BiliBridgeNoMatch20261101c90e7f32a54d" --type user | ok；total=0；items=[]；hasMore=false |
| 相同关键词 --type video | 上游实际返回 20 条、total=1000；未伪造成空结果。视频搜索可能回退推荐，不能用不常见词保证空结果 |
| node tests/manual-read.mjs dynamics --anonymous | 退出码 1；AUTH_REQUIRED；不读取真实凭据 |
| dynamics（省略 mid） | ok；当前账号关注流 20 条；返回 nextOffset |
| comments BV1VZWc6dECG --sort new --page 2 --page-size 3 --no-replies | ok；page=2；3 条；replies=[]；total=2233 |
| 同进程连续调用 dynamics，mid=3546637928499654，pageSize=2，再传 nextOffset | 两页各 2 条，无 dynamicId 重叠，第二页仍可续取 |
| npm test | 21/21 通过；单测使用模拟网络，与上述真实调用分别记录 |

## 限制与未验证项

没有故意触发真实 412/-352。单测验证 HTTP 412、业务码 -352/-412/-101 原样映射并阻止空成功，真实风控出现时的恢复时间未测；本轮未加自动重试。评论 WBI 降级没有真实触发样本，只验证请求签名、错误选择和第一页限制，无法声称完整页码降级。

动态分页不是平台快照。pageSize 小于上游批次时，游标保存原 offset 和已消费条数，下一次重读该批次；源列表新增或删除可能造成漂移，需要按 dynamicId 去重。大于上游批次时只返回本批次，不自动跨页补齐。文本缺失、删除或权限限制的动态不会凭图片补造文字，未接 OCR/ASR。转发文本与视频字段投影有单测，真实转发样本尚未专门验收；不能将合成测试标为真实转发通过。

既有字幕截断、首次创建凭据目录、写操作超时语义、故事板覆盖范围等问题未在这轮只读扩展中修改。Cookie 自动刷新、私信、关注列表及发布类能力为 `unsupported`。本轮交付不代表完整 B站能力，也不代表宿主集成验收完成。

## 条件验收后的两项修复（2026-11-01）

评论楼中楼补取现在最多 5 次，只对最先遇到的预览不足条目执行；预算耗尽后保留其余评论已有预览。该预算不包含视频元信息、评论主列表、必要的 WBI 密钥读取或降级请求。真实命令 `BILI_DATA_DIR=~/.dsh/bilibili node tests/manual-read.mjs comments BV1VZWc6dECG --sort hot --page-size 20` 返回 ok、20 条、total=2234；单测用 20 条模拟评论确认只补取 5 次，后续预览保持，关闭 replies 时补取为 0 次。

动态 nextOffset 只要非 null 就统一使用 `dsh:` 包装，包含 scope/upstream/skip。整批消费后 upstream 为上游下一页 offset、skip=0；批内续取仍保留原 upstream 和 skip。拒绝裸 offset，以及跨用户、跨关注账号或跨流类型的包装游标；已有裸游标需从第一页重新获取。scope 用于防止误用，不是游标签名或防篡改凭证。

真实命令 `BILI_DATA_DIR=~/.dsh/bilibili node tests/manual-read.mjs dynamics` 默认返回 ok、20 条和 `dsh:` 游标。另对 mid=3546637928499654 默认分页真实调用返回 13 条，解码确认 scope 正确、skip=0、upstream 非空；将解码后的裸 upstream 回传工具时明确返回 INVALID_ARGUMENT。

修复后 `npm test` 为 24/24。没有新增依赖、执行账号写操作或重启 DSH，等待评审方快速回归。搜索 schema 的属性说明与空图片 imageChannel 状态未包含在本次两项修复中。

## 2026-11-02 Windows 平台适配后的匿名回归

环境：Windows 11 / Node 24.16.0 / `BILI_DATA_DIR` 指向仓库内临时目录，**未登录**。

| 来源 | 命令 | 结果 |
| --- | --- | --- |
| 元数据 | `getVideo('BV1GJ411x7h7')` | ok，标题/时长 213s/cid 137649199 |
| 字幕 | `getSubtitles(...)` | `empty`，tracks 0 —— **匿名下 wbi/v2 不给字幕轨，字幕列表需要登录** |
| 弹幕 | `getDanmaku({cid, bvid})` | ok，1200 条，8 个 30s 桶 |
| 故事板 | `getStoryboard(...)` | ok，10×10 网格，`index` 33 格有效 |
| 概览图 | `buildOverview(...)` | ok，封面 651KB + 九宫格 89KB，0 warning |

同一轮修复了媒体请求指纹：图片/字幕/弹幕/故事板现在都走 `lib/bili/http.mjs` 的 `fetchBuffer`，共用一套 UA/Referer，并加域名白名单（bilibili.com / hdslb.com / bilivideo.com / bilivideo.cn / szbdyd.com）与内网地址阻断。`npm run test:single` 24/24。

## 2026-11-02 M8.1：ffmpeg 真抽帧

外部依赖：ffmpeg 9.0.2（gyan essentials，`D:\tools\ffmpeg\...`），配置写在
`%USERPROFILE%\.dsh\bilibili\config.json`（`ffmpegPath` / `ffmpegCaFile`）。

Windows 上必须给 CA：该构建用 gnutls 且不读系统证书库，直连 B站 CDN 会
`Peer certificate failed verification`；`cacert.pem` 放在数据目录即可。

| 场景 | 结果 |
| --- | --- |
| `playurl`（匿名，qn=80） | `dash`，实际 480P，`accept_quality=112/80/64/32/16` |
| `playurl` 选档 | 不超过请求值的最高档；请求值低于全部档位时给最低档；20 分钟内同 key 命中缓存 |
| playurl 无可用流 | `CONTENT_UNAVAILABLE`，不返回空 URL |
| `manual-frames BV1GJ411x7h7 auto 10000 60000` | `source=ffmpeg`、`accuracy=frame-level`、`maxErrorMs=null`、帧图 39KB |
| 宿主内 `bilibili_inspect` | `source=ffmpeg`、`quality=480P`、`imageAttached=true`，两帧真实画面进上下文 |
| 强制 `storyboard` | `source=storyboard`、`tileGapMs=6000`、`maxErrorMs=3000`（按 index 中位间距算，不再写死 ±1s） |
| 补帧目标超过有效格数 | 允许复用但标 `reused: true` |
| ffmpeg 缺失 | `DEPENDENCY_MISSING`；`auto` 自动降级故事板并带 `FRAME_SOURCE_FALLBACK` 警告 |

`npm test` 32/32（新增 6 条媒体单测）。

## 2026-11-02 Windows 登录态全量验收

扫码登录 `四夕羽_`（mid 215407733）后，把 macOS 阶段验过的能力在本机逐项跑通：

| 工具 | 本机结果 |
| --- | --- |
| auth_status / me | 已登录，level 6，VIP，coin 450.6；凭据 ACL 为仅当前用户 |
| user_videos（不传 mid） | 2 条投稿，最新 `BV18n5nz8E6n`，播放 156 |
| watch_later_list | 39 条 |
| favorites_list | 19 个收藏夹 |
| search | total=1000，`<em>` 高亮已剥离 |
| comments | total=2272，热门含 3 条楼中楼 |
| user_profile | fans 60326 / following 310 / archiveCount 2201 |
| dynamics | 关注流，返回 `dsh:` 游标 |
| extract | BV1KDNA6eEgr：字幕 `ai-zh` 190 cues 覆盖 100%、弹幕 213、热评、封面 + 九宫格，`imageAttached=true` |
| extract（长视频） | BV1VZWc6dECG：字幕 `truncated=true`（800 条，覆盖 28:17 / 54:57） |
| inspect | `source=ffmpeg`、`frame-level`、`maxErrorMs=null`、**1080P**、`imageAttached=true` |
| 写操作 | 仅 dry-run：bvid→aid 解析正常，未提交写请求 |

**登录态是字幕的前提**：同一视频匿名请求 `player/wbi/v2` 得到 0 条轨道，登录后 190 条。
此前“匿名没字幕”不能被解读成“这个视频没有字幕”。

与 macOS 阶段的差异只是数据增长（粉丝、评论总数、稍后观看 +1），没有行为差异；
`inspect` 反而从“故事板兜底”升级为“ffmpeg 1080P 真帧”。
## 2026-11-02 管线定稿：Fast Path / Deep Path

Stage 1（`bilibili_extract`）只做低成本收集，**不跑 ASR/OCR**；没有平台字幕就 `empty`。
Stage 2 由 Agent 按需调用（`inspect` 已就绪，`transcribe` 待实现）。

### Stage 1 实测

| 视频 | 字幕 | 覆盖 | evidenceLevel | gaps | 耗时 |
| --- | --- | --- | --- | --- | --- |
| BV1KDNA6eEgr（5.9 分钟） | ok | 0.988 | rich | — | 411ms |
| BV1pTx76QE8J（15.5 分钟） | empty | 0 | text-only | `no_subtitles` | 831ms |

- 覆盖度按**区间并集**计算（`coverageRatio`），中间挖空不会高估。
- `suggestedWindows` 取弹幕密度前 3；`evidenceLevel` = `rich` / `text-only` / `thin`。
- `schemaVersion` 升到 `2`；`insufficient` 从 Stage 1 移除（那是 Stage 2 的结论）。

### 故事板多雪碧图

| 项 | 结果 |
| --- | --- |
| BV1VZWc6dECG 故事板 | `images=4`、`index=397`、480×270/格 |
| 概览覆盖 | 0–3289s（旧实现只到 816s），`spritesUsed=4`，133KB |
| 兜底定位 | 2000s → 第 3 张图；3200s → 第 4 张图；`maxErrorMs=4000`（格间距 8s） |

### ASR：常驻 worker（已接工具）

- `faster-whisper 1.2.1`（venv `D:\tools\asr\.venv`，模型 `D:\tools\asr\models`，默认 `small`，CPU int8，自动语言）。
- 中文 90s 55.7s（`avg_logprob -0.20`）；英文 60s 23.5s（-0.075，识别为 en）。
- 强制 `language=zh` 会把英文旁白解码成乱码 —— 默认已改 `auto`。
- 只有 CLI 能调（`tests/manual-asr.mjs`）；Stage 2 工具、预算、缓存都还没做。
