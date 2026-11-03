# 实施计划（v1）

## 视频处理管线（2026-11-02 定稿：Fast Path / Deep Path）

**定位**：这是个 **B站操作插件**，视频理解只是其中一项能力。
把"低成本信息获取"和"高成本深度分析"彻底分开，避免 Stage 1 变成慢查询。

```
Stage 1  bilibili_extract —— Fast Path，秒级、与视频长度基本无关
  元信息 / 平台字幕（UP 主上传优先，其次 AI）/ 弹幕密度+样本 / 热评+最新 / 封面 / 故事板九宫格
  没有平台字幕 → subtitles.status = "empty"（是事实，不是错误）
  附带线索：gaps[] / suggestedWindows[] / evidenceLevel

Stage 2  循环、Agent 主导 —— 每次调用都有明确成本与预算
  bilibili_inspect      定点取真实帧；可选对该帧做 OCR
  bilibili_transcribe   指定窗口 ASR；可选窗口内连续硬字幕 OCR
  返回剩余预算，Agent 自己决定要不要继续
```

### 已确认的架构决策

| 决策 | 内容 |
| --- | --- |
| Stage 1 不做 | ASR、OCR、整片转写；也不因缺字幕而阻塞 |
| ASR 归属（已确认） | **只在 Stage 2**，由 Agent 显式窗口调用；Stage 1 无平台字幕就 `empty`，不自动补 |
| 平台字幕优先级 | UP 主上传字幕 > B站 AI 字幕（`ai-zh`） |
| ASR 默认窗口 | 30 秒；单次最大 300 秒；模型可选更长 |
| ASR 总预算 | 900 秒**未缓存**音频（不硬编码，后续进设置） |
| VAD 前置探针 | 不加入（保留模型自身的 `vad_filter`） |
| 工具形态 | `inspect` 与 `transcribe` 两个独立工具 |
| OCR | 保留两种模式：**指定帧 OCR** 与**窗口连续硬字幕 OCR**，同属 Stage 2 可选能力 |
| 封面 | 不降采样（Stage 1 冷启动约 3.3s 可接受） |
| 预算归属 | `bundleId` + TTL 复用，避免不同分析任务长期共享同一视频预算 |
| 轮次与预算 | 独立计算：轮次防跑飞（默认 6），预算防烧钱（900s 未缓存音频） |
| 缓存 | ASR/OCR 持久化缓存；命中不消耗 ASR 预算 |
| 常驻 worker | 接受：懒启动、空闲退出、崩溃重启、超时与并发控制 |
| 证据字段 | `evidenceLevel`：`rich` / `text-only` / `thin` |
| 字幕覆盖 | 按**区间并集**计算，不是"最后一条字幕的结束时间" |

### 线索字段

- `gaps[]`：`no_subtitles` / `subtitles_partial` / `no_danmaku` / `no_comments` / `no_visual`
- `suggestedWindows[]`：弹幕密度峰值的前 3 个窗口（纯计算，不额外请求；只是候选，不是指令）
- `evidenceLevel`：`rich`（字幕覆盖 ≥80%）/ `text-only`（无字幕但有文字来源）/ `thin`

### 已知风险（保留）

- Stage 2 的 ASR 在 CPU 上 0.3–0.6× 实时；30s 窗口约 20–25s（常驻 worker 可降到 ~12s）。
- 纯画面/无语音内容：ASR 与 OCR 都救不了，靠视觉证据。
- 长视频整片转写不开入口（需要用户显式授权，后续版本）。

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
- [x] M8.5 Stage 1 瘦身：摘掉 ASR/OCR、字幕只留平台、新增 gaps/suggestedWindows/evidenceLevel
- [x] M9 真实写操作：dry-run 预览 + `intent=apply` 写后回读 + 结果不明时的和解（不盲目重试）
- [x] M7 部分：安装、文档、单元测试 97/97；打包发布未做
- [x] M8.0 Windows 平台适配（请求指纹统一、凭据 ACL、跨平台路径；本机匿名回归通过）
- [x] M8.1 ffmpeg 真抽帧（playurl → `-ss` 精确抽帧；宿主内 `source=ffmpeg`）
- [x] M8.6 故事板多雪碧图（长视频概览覆盖全时间轴；故事板兜底跨图定位）
- [ ] M8.1b 概览也用真帧（场景检测）+ `blurdetect` 挑最清晰帧（当前概览仍用故事板九宫格）
- [x] M8.2 OCR（Windows 自带，零安装）——已移到 Stage 2：`inspect` 支持整帧/字幕带 OCR 与窗口连续字幕 OCR
- [x] **M8.3 ASR 适配层**：faster-whisper（CPU int8 / small / 自动语言）已可用，待包成 Stage 2 工具
  - [x] M8.3a 适配器接口 + Python worker（`transcribe(audio)` → 带时间戳的段落）
  - [x] M8.3b `bilibili_transcribe` 工具：窗口化（默认 30s、上限 300s）+ 时间戳回原始轴
  - [x] M8.3c 常驻 worker：懒启动、空闲退出、崩溃重启、并发与超时控制
  - [x] M8.3d 预算（bundleId + TTL）与 ASR 持久化缓存；命中不扣预算（OCR 缓存已备、待接入）

## 基础读写主线（2026-11-03）

P0/P1 实现与验收见 [read-write-rollout.md](read-write-rollout.md)：当前 25 个工具，保留原 19 个入口；视频投稿及其任务模型后置，Opus 已移出范围。合并和宿主重启验收尚未进行。

## 历史 v1 工具（18，早于 transcribe）

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
