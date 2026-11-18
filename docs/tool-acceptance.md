# 27 个工具验收（稳定版）

基线：`main` 的 `9d915bc`，验收分支 `fix/tool-acceptance`，验收时间 2026-11-18（Asia/Shanghai）。
目标：保留全部 27 个入口，逐个做端到端验收。工具注册成功、返回 `ok`、或只做了 preview，都不算对应功能通过。

## 结论

- 离线回归：`npm run test:single` → **353 个测试，352 通过、1 跳过、0 失败**。
- 真实只读工具层：18 个入口通过（`node tests/manual-tool-acceptance.mjs --media`），覆盖搜索、视频/用户/收藏夹/稍后观看、动态、评论、通知、私信、草稿列表、批量采集、抽取、抽帧和窗口 ASR。
- 图片入模：在 DSH 宿主里用真实图文动态取详情，2 张图片真实下载并作为附件进入模型；模型实际看到了两张图。
- 登录：真实手机扫码确认成功；新进程读取临时凭据验证 `loggedIn=true`；本地登出清空凭据。临时数据目录，未动日常凭据。
- 账号写入：本轮 4 次写入全部用于定时草稿验收（今日 30/30 已用尽）。收藏、稍后观看、点赞、评论、图文动态、私信沿用同分支上一轮的真实发布/读回/恢复证据。
- 新版定时草稿：**创建 → 响应缺 ID → check 核对 → 列表读回 → 删除 → 确认消失** 全链路通过；**立即发布 → 动态 ID → 正文读回 → 草稿消失 → 删除动态 → NOT_FOUND** 全链路通过。
- 宿主审批：宿主已加载本分支（`list_drafts` 的 provenance 是新接口）；当前 profile 启用了自动审批，`intent=apply` 的允许路径执行到了工具处理器（用无效收藏夹触发 `INVALID_ARGUMENT`，没有发生写入）。人工“拒绝”分支未能在当前配置下直接观察。

## 本轮修复

| 问题 | 修复 |
| --- | --- |
| 新版定时草稿只能列、不能删/立即发布 | `lib/bili/drafts.mjs` 新增 `timing_dyn/delete`、`timing_dyn/publish`，按草稿内容重建 `dyn_req`；旧版 ID 仍走 `dynamic_draft/*`，两套 ID 不再串用。 |
| 发布接口返回成功但不给草稿/动态 ID | 定时创建：`PENDING_CONFIRM` + `check` 从草稿列表核对，不重发。立即发布：没有动态 ID 时只报 `PENDING_CONFIRM`，要求用动态列表核对。 |
| Opus 图文在列表/详情里正文和图片丢失 | 详情和 `feed/space`、`feed/all` 都显式带 `features=itemOpusStyle`；`projectDynamic` 从 `opus.summary` 取正文，并带出 `topicId`。 |
| 定时发送的 check 可能把旧草稿当成新发送 | 提交前记录已存在草稿 ID 基线（`existingDraftIds`），check 只确认基线下新出现的唯一匹配；去重 key 用 `keyTarget` 保持稳定。 |
| 定时发布绕过 120 秒发布冷却 | `trafficKind` 把 `/x/dynamic/feed/timing_dyn/publish` 归为 `publish`。 |
| 草稿删除缺少 CSRF | 旧版 `rm_draft` 补 `csrf_token`。 |
| 删除草稿的 token 只绑定 ID | token 里加入正文指纹和计划时间；审批后网页改了草稿会要求重新预览。 |
| 同一 previewToken 可重复提交草稿发布/删除 | 提交前消费 previewToken；立即发布即使返回“成功但无 ID”也不能用同一 token 重发。 |
| 旧账本里的未决定时发送没有发送前基线 | check 对缺少基线的旧行保持 `PENDING_CONFIRM`，不自动确认。 |
| 审批框看不到草稿正文 | `content_manage` 的 `delete_draft`/`publish_draft_now` 在 `tools/pre-execute` 里只读一次草稿，理由中带完整正文、图片数、计划时间、来源。 |
| 点赞通知 `latest` 被 `pageSize` 截断 | 整批返回上游 `latest`（上限 50），不再只给第一页。 |
| `extract` 忽略 `include.metadata=false` 和 `commentLimit=0` | 关闭元信息时只保留 bvid/aid/cid/时长；评论上限 0 时不再发评论请求。 |

## 真实只读与媒体证据

- `node tests/manual-tool-acceptance.mjs --media`：18 个入口通过，包含真实 ffmpeg 抽帧和窗口 ASR；脚本只输出状态，不输出正文。
- Opus 列表修复的线上对照：同一关注流在无 `itemOpusStyle` 时多条图文正文为空；修复后 20 条中有 11 条带正文、3 条带图。公开动态 `1272009540335829046` 详情读回正文与 2 张图。
- 图片附件：宿主调用 `bilibili_dynamics` 读同一条动态并 `includeImages=true`，返回 `imageAttached=true`、`imageChannel=attached`，2 个图片块真实进入本轮模型上下文（一张 1280×756，一张 1061×1096）。
- OCR：`node tests/manual-ocr.mjs BV1pTx76QE8J 6 0.22`，1080P 硬字幕，6/6 采样点识别成功。
- 私信/通知/评论只验证分页与结构，不在验收记录里保留正文。

## 登录

- `tests/manual-auth-png-acceptance.mjs` 生成 PNG 二维码；真实手机扫码后返回 `status=confirmed`，临时数据目录保存凭据。
- 新进程读取同一临时目录：`loggedIn=true`、`accountId=215407733`（子进程断言脚本的 argv 写法有误，但实际输出已证明复用成功；无需重扫）。
- 用真实凭据的副本验证本地登出：`hasCredentials=false`、`loggedIn=false`；日常凭据未改。
- 未验收：DSH 宿主内的 `bilibili_auth_begin/poll` 界面流程（CLI/库层已真实验收）。

## 账号写入

本轮可用的 4 次写入全部用于定时草稿：

| 场景 | 结果 |
| --- | --- |
| 新版草稿创建 | `dynamic_publish` 返回 `PENDING_CONFIRM`（接口业务成功但没有草稿 ID）；`check` 从 `timing/draft/list` 找到唯一新草稿 `1272036957234397201`，列表读回正文一致。 |
| 新版草稿删除 | `delete_draft` preview → apply → 再列列表确认已消失；草稿 ID 仅发给 `timing_dyn/delete`。 |
| 立即发布 | 网页创建的 23:00 `test` 草稿 `1272064518058410003` → `PUBLISHED`，动态 `1272022090241802249`；详情读回正文 `test`；草稿列表已无该 ID。 |
| 发布后清理 | `delete_dynamic` → `DELETED`，再读详情返回 `NOT_FOUND`。 |

上一轮同分支的真实写入证据仍有效：稍后观看/收藏/点赞切换并恢复；评论发表、按 rpid 读回、删除；图文动态发表、正文逐字一致、1 张图、删除；一条获准的测试私信发送并读回（未重发）。

## 27 个入口状态

| 工具 | 状态 | 证据 |
| --- | --- | --- |
| `bilibili_auth_status` | 通过 | 真实宿主与临时目录 |
| `bilibili_auth_begin` | 通过（真实扫码） | PNG 二维码 + 手机确认 |
| `bilibili_auth_poll` | 通过（真实扫码） | `waiting → confirmed` |
| `bilibili_auth_logout` | 通过 | 临时凭据清空、日常凭据未改 |
| `bilibili_me` | 通过 | 只读脚本 |
| `bilibili_video` | 通过 | 只读脚本 |
| `bilibili_user_videos` | 通过 | 只读脚本（含置顶/created 字段约定） |
| `bilibili_watch_later_list` | 通过 | 只读脚本 |
| `bilibili_watch_later_set` | 通过（上一轮真实 apply） | 切换、读回、恢复 |
| `bilibili_favorites_list` | 通过 | 只读脚本（列表 + 内容） |
| `bilibili_favorite_set` | 通过（上一轮真实 apply） | 切换、读回、恢复 |
| `bilibili_video_like_set` | 通过（上一轮真实 apply） | 切换、读回、恢复 |
| `bilibili_extract` | 通过 | 只读脚本 + 本轮 `include/limit` 修复测试 |
| `bilibili_inspect` | 通过 | 真实 ffmpeg 抽帧；OCR 6/6 |
| `bilibili_transcribe` | 通过 | 窗口 ASR `verdict.usable=true` |
| `bilibili_search` | 通过 | 只读脚本 |
| `bilibili_comments` | 通过 | 只读脚本 |
| `bilibili_user_profile` | 通过 | 只读脚本 |
| `bilibili_dynamics` | 通过 | 关注流/空间/详情；Opus 修复；2 张图入模 |
| `bilibili_discover` | 通过 | 只读脚本（rank） |
| `bilibili_notifications` | 通过 | 只读脚本；`latest` 修复仅离线夹具 |
| `bilibili_messages` | 通过 | 只读脚本（会话/正文结构） |
| `bilibili_content_manage` | 通过 | 评论/动态删除（上一轮）；草稿列表/删除/立即发布（本轮真实） |
| `bilibili_comment_send` | 通过（上一轮真实 apply） | 发表、rpid 读回、删除 |
| `bilibili_message_send` | 通过（上一轮真实 apply） | 一条获准测试私信、读回、未重发 |
| `bilibili_dynamic_publish` | 通过 | 上一轮图文真实发布；本轮定时创建真实通过 |
| `bilibili_collect` | 通过 | 只读脚本（1 视频、1 评论） |

## 未完成项与风险

- 宿主“拒绝审批”分支未直接观察：当前 profile 的自动审批会放行 `ask`。需要在关闭自动审批的 profile 里人工点一次拒绝，并确认没有写请求。
- 宿主内的草稿删除/立即发布没有直接通过工具界面执行（今日写入额度用尽、且测试草稿已清理）；本轮用同一工具处理器的真实调用验收。
- 立即发布的线上样本是纯文字；富文本（@/BV/表情）和图片草稿只做了离线映射测试，未真实发布。
- 旧版草稿的删除/立即发布本轮未重复真实验收；代码路径除补 CSRF 外未变，离线测试覆盖。
- 点赞 `latest` 的修复只有离线夹具；线上账号当前没有可读的 `latest` 数据。
- 今日写入额度 30/30 已用尽，不要再发起真实写操作。测试草稿与测试动态均已清理。

## 复现命令

```bash
npm run test:single
node tests/manual-tool-acceptance.mjs --media
node tests/manual-auth-png-acceptance.mjs --png .bili-data/login-qr-scan.png
node tests/manual-write-acceptance.mjs draft --apply
node tests/manual-publish-draft-acceptance.mjs --apply --draft-id <可处置的 test 草稿 ID>
node tests/manual-ocr.mjs BV1pTx76QE8J 6 0.22
```

写操作脚本都会先检查剩余额度；`check` 只读核对，不自动重发。不要记录 Cookie/Token，不要把新版草稿 ID 交给旧版 `dynamic_draft/*` 接口。
