# 实施计划（v1）

## 里程碑

- [x] M0 项目骨架
- [x] M0 宿主探针：14 个工具已加载；图片通道实测 attached
- [x] M1 认证、凭据存储、HTTP/WBI、CLI
- [x] M1.5 真账号风险探针（空间 8/8，稍后观看/收藏/评论正常；字幕不稳定）
- [x] M2 只读工具 + 最新投稿闭环（DSH 内已验证）
- [x] M3 低风险写（点赞/收藏/稍后观看）+ 审批门禁（仅 dry-run，未真实执行）
- [x] M4 视频提取 Stage 1（字幕/弹幕/评论/封面/九宫格；DSH 内图片已附加）
- [x] M5 定向补帧 Stage 2（故事板，±2s；DSH 内图片已附加）
- [ ] M6 稍后观看摘要 + 原生提醒
- [x] M7 部分：安装、文档、单元测试 24/24；打包发布未做
- [x] M8.0 Windows 平台适配（请求指纹统一、凭据 ACL、跨平台路径；本机匿名回归通过）
- [x] M8.1 ffmpeg 真抽帧（playurl → `-ss` 精确抽帧；宿主内 `source=ffmpeg`、误差 ≤100ms）
- [ ] M8.1b 概览也用真帧（场景检测）+ `blurdetect` 挑最清晰帧（当前概览仍用故事板九宫格）
- [x] M8.2a 硬字幕带抽取（ffmpeg 裁底部 + 竖拼长图；BV1pTx76QE8J 实测 12 行可读）
- [ ] M8.2b OCR 识别（引擎选型后接入，输出标 `origin: ocr`）
- [ ] M8.3 ASR 兜底（本地转写 → `origin: asr`，远程需单独授权）

## v1 工具（18）

auth_status / auth_begin / auth_poll / auth_logout / me / video / user_videos /
watch_later_list / watch_later_set / favorites_list / favorite_set / video_like_set /
extract / inspect / search / comments / user_profile / dynamics

## 已验证

- 扫码登录，凭据 0600，跨进程 `status` 可用
- 空间投稿 8/8（1.2s 间隔，无 412）
- `latest`：BV18n5nz8E6n，播放 156
- 稍后观看 38 条；收藏夹 6 个；评论 17 条
- 字幕：另一视频 438 条 cue；某视频 1/3 命中（已加短重试）
- 故事板九宫格 9 格 + 时间标注；`inspect` req/got 误差 ≤1s
- 单元测试 6/6

## 门禁

- G0 工具可加载、图像链路有实测结论（待重启）
- G1 重启后登录有效、日志无秘密（待重启）
- G1.5 空间接口 412 比例有数据（通过）
- G2 最新投稿播放量闭环（CLI 通过；DSH 待验证）
- G4 无 ffmpeg / 无字幕可降级（通过：empty + storyboard）
- G6 定时可触发（未做）

## 2026-10-31 最终验收

- `auth_status` / `me` / `user_videos`（mid 省略）/ `video` / `watch_later_list` / `favorites_list`：DSH 内通过。
- `extract`：字幕/弹幕/评论/封面/九宫格全部返回；两张图 `imageAttached=true`。
- `inspect`：req/got 标注图片返回，误差 0–1s。
- 字幕完整性：已改用 WBI 的 `/x/player/wbi/v2`；三个样本验证通过（0 条 / 1576 cues / 47 cues）。
- 未做：Workflow 模板、原生提醒示例、真实写操作、ffmpeg 精确抽帧、搜索/评论/动态工具。
