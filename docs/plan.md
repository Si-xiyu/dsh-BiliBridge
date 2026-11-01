# 实施计划（v1）

## 视频处理管线（2026-11-02 定稿）

**定位**：这是个 **B站操作插件**，视频理解只是其中一项能力，不要过度投入。
字幕只是**信息源之一**，不是"视频理解"本身；Stage 1 负责收集，Stage 2 负责判断。

```
Stage 1  extract：多来源收集
  元信息 / 弹幕 / 评论 / 封面 / 故事板九宫格        ← 便宜，永远做
  字幕字段：platform → asr → (可选) ocr → insufficient
  每路独立成败，单独记状态；失败降级为带 note 的空来源

Stage 2  inspect：agent 判断
  读证据包 → 判断这是口播 / 演示 / 纯画面 / PPT
  → 决定要不要定点补帧，或对某一帧再要 OCR
  → 结论区分"字幕说的""画面显示的""评论认为的"
```

### 字幕字段的填法

| 顺序 | 来源 | 默认 | 说明 |
| --- | --- | --- | --- |
| 1 | `platform` | ✅ 自动 | 平台字幕（官方/AI）。**登录才有**，匿名 0 条不代表视频没字幕 |
| 2 | `asr` | ✅ 自动（无平台字幕时） | **本地 faster-whisper**，借鉴 dsh-bili-scroll：CPU `int8`、默认 `small`、`vad_filter`、模型缓存放插件地盘 |
| 3 | `ocr` | ⬜ 仅显式请求 | Windows 自带 `Windows.Media.Ocr`（零安装）。底部字幕带 + 屏幕文字都可以，但不追求"完整台词" |
| 4 | `insufficient` | — | 都拿不到可用文本：如实标记 + 记录试过哪几路、各自失败原因 |

- **可复调用**：`extract(..., subtitleSource)` 允许 Agent 先 `asr`、效果差再以 `ocr` 复调一次；
  同 `(bvid, cid, source)` 命中缓存，不重复付费。
- **`insufficient` 不是错误**：它表示"这个视频确实没有可读文本"（符号动画、纯风景、无配音幻灯片），
  由 Stage 2 决定怎么处理，Stage 1 不猜。
- **OCR 不追求完整**：抽 N 个时间点能读到几行就读几行，读不到就是没有。
  不为"纯文字视频"做整片识别——那是过度投入，交给 Stage 2 定点看帧。

### 已知风险（保留，后续优化）

- 长视频 ASR 慢（`small` ≈ 0.05–0.1× 实时）。先做硬上限 + `partial` + `continuation`，不做复杂调度。
- 纯画面/无语音内容：ASR 与 OCR 都救不了，靠 Stage 2 的视觉证据。

---

## 里程碑

- [x] M0 项目骨架
- [x] M0 宿主探针：14 个工具已加载；图片通道实测 attached
- [x] M1 认证、凭据存储、HTTP/WBI、CLI
- [x] M1.5 真账号风险探针（空间 8/8，稍后观看/收藏/评论正常；字幕不稳定）
- [x] M2 只读工具 + 最新投稿闭环（DSH 内已验证）
- [x] M3 低风险写（点赞/收藏/稍后观看）+ 审批门禁（仅 dry-run，未真实执行）
- [x] M4 视频提取 Stage 1（字幕/弹幕/评论/封面/九宫格；DSH 内图片已附加）
- [x] M5 定向补帧 Stage 2（ffmpeg 真抽帧；DSH 内图片已附加）
- [ ] M6 稍后观看摘要 + 原生提醒
- [x] M7 部分：安装、文档、单元测试 42/42；打包发布未做
- [x] M8.0 Windows 平台适配（请求指纹统一、凭据 ACL、跨平台路径；本机匿名回归通过）
- [x] M8.1 ffmpeg 真抽帧（playurl → `-ss` 精确抽帧；宿主内 `source=ffmpeg`）
- [ ] M8.1b 概览也用真帧（场景检测）+ `blurdetect` 挑最清晰帧（当前概览仍用故事板九宫格）
- [x] M8.2 OCR（Windows 自带，零安装）——**降级为可选能力**，不再自动跑、不再投入底部字幕带优化
- [ ] **M8.3 ASR（当前主线）**：faster-whisper 本地转写
  - [ ] M8.3a 适配器接口 + Python worker（`transcribe(audio)` → 带时间戳的段落）
  - [ ] M8.3b extract 接入：无平台字幕时自动 ASR；`subtitleSource` 参数支持复调用
  - [ ] M8.3c 可靠性：超时/取消/子进程清理、模型缓存、`partial`/`continuation`、失败如实上报
  - [ ] M8.3d 真实验收：中英各一条、长视频一条、无语音一条

## v1 工具（18）

auth_status / auth_begin / auth_poll / auth_logout / me / video / user_videos /
watch_later_list / watch_later_set / favorites_list / favorite_set / video_like_set /
extract / inspect / search / comments / user_profile / dynamics

## 已验证（Windows 本机，2026-11-02）

- 登录 `/x/web-interface/nav`；凭据 icacls 仅当前用户
- 投稿 2 条、最新 `BV18n5nz8E6n` 播放 156；稍后观看 39；收藏夹 19
- 搜索 total=1000；评论 total=2272 含楼中楼；主页 fans 60326 / archive 2201；关注动态 `dsh:` 游标
- 证据包：字幕 190 cues 覆盖 100%、弹幕 213、热评含楼中楼、封面 + 九宫格，`imageAttached=true`
- 真抽帧：`source=ffmpeg`、`bounded`、`maxErrorMs=100`、1080P
- 单元测试 42/42

## 门禁

- G0 工具可加载、图像链路有实测结论（通过）
- G1 重启后登录有效、日志无秘密（通过）
- G1.5 空间接口 412 比例有数据（通过）
- G2 最新投稿播放量闭环（通过）
- G4 无 ffmpeg / 无字幕可降级（通过：empty + storyboard）
- **G8.3 ASR 可用性**：本机 CPU 上 90 秒中文片段能转出可读文本，且失败路径有明确状态

## 历史验收

### 2026-10-31（macOS）

- 认证/投稿/稍后观看/收藏夹在宿主内通过；`extract` 两张图进主模型；`inspect` 故事板补帧。
- 字幕改用 WBI `/x/player/wbi/v2`；样本 0 条 / 1576 cues / 47 cues。

### 2026-11-02（Windows）

见 `docs/state.md` §4；跨平台迁移与登录态全量验收均已通过。
