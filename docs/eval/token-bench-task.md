# M1 Token / 耗时基准：DSH 内执行任务

用途：在 DSH 里让主 Agent（DeepSeek）按固定参数调用工具，记录每次调用的 token 增量、耗时和返回结构，生成可对比的报告。同一任务分别在 **baseline** 与 **candidate** 两个插件版本上各跑一次。

## 1. 准备（用户操作）

1. 插件以**链接安装**指向要测的代码目录（见 README「安装（开发版）」）：
   - baseline：指向 `9d915bc` 的 worktree（或主仓库在该提交上）
   - candidate：指向 `research/accuracy-token-plan` 的 worktree
2. 重启 DSH。打开 设置 → BiliBridge，确认状态接口 `identity.modulePath` 是要测的目录。
3. 设置页选择「标准（全量）」预设；`config.json` 中 `cache.enabled` 保持默认。
4. 先在命令行预热一次缓存（避免第一次网络/扫描耗时干扰）：任务第 1 轮视为预热，第 2 轮计入结果。

## 2. 计量方式

- **首选**：Agent 能读取 DSH 的会话用量时，在每次工具调用前后各读一次，`Δtoken = 调用后 − 调用前`（包含工具调用参数、工具结果、Agent 那句"OK"）。
- **备选**：Agent 读不到用量时，每个用例开一个新会话：先记空会话发送"只回复 OK"后的 token `T0`，再在另一个新会话执行用例并记录 `T1`，`Δ = T1 − T0`。由用户从界面填写。
- 图片 token 单独记录（若 DSH 分开统计）；否则在报告里注明"含图片"。

## 3. 用例

视频集先用下列 6 个（与 `docs/adaptive-frames.md` 已有实测重叠，便于对照），M2 评测集完成后替换为完整集。

| 视频 | 时长 | 类别 | 备注 |
|---|---|---|---|
| BV19px46aEo8 | 134s | 游戏 MV | |
| BV1i24P6rEmt | 100s | 录屏演示 | |
| BV1KDNA6eEgr | 352s | 讲解 | |
| BV1REx46NEc4 | 3041s | 长教程 | |
| BV1VZWc6dECG | — | AI 字幕 1576 条 | 测试字幕分页 |
| BV1pTx76QE8J | — | 无字幕 | 用于 ASR |

| 用例 | 工具与参数（固定，不得改动） | 适用视频 |
|---|---|---|
| E1 | `bilibili_extract {bvid}` | 前 5 个 |
| E2 | `bilibili_extract {bvid, include:{comments:false, danmaku:false, frames:false}}` | 前 5 个 |
| E3 | 对 E1 返回的 `subtitles.nextCursor` 续取一次：`bilibili_extract {bvid, subtitleCursor}` | BV1VZWc6dECG |
| I1 | `bilibili_inspect {bvid, selection:"adaptive", maxFrames:9}` | BV1i24P6rEmt、BV1KDNA6eEgr |
| I2 | `bilibili_inspect {bvid, timestampsMs:[30000], ocr:true, ocrRegion:"frame"}` | BV1i24P6rEmt |
| R1 | `bilibili_transcribe {bvid, startSeconds:0, durationSeconds:60, language:"zh"}` | BV1pTx76QE8J |

## 4. 发给 DeepSeek 的任务（复制以下全部内容到 DSH 新会话）

```text
你是 BiliBridge 插件的基准测试执行者。目标是测量工具返回值的 token 与耗时，不是理解视频。

规则：
1. 严格按下表顺序调用工具，参数原样使用，不增删任何参数，不调用表外的工具。
2. 每次调用后不要总结视频内容，不要解读画面。
3. 如果你能读取本会话的 token 用量统计，在每次调用前后各记录一次；读不到就在报告里写"不可读"，不要估算。
4. 工具报错时记录错误码与 message 前 80 字，继续下一项，不要重试。
5. 全部执行两轮：第 1 轮为预热，只记录是否成功；第 2 轮记录完整指标。
6. 报告中不得出现 Cookie、签名 URL、本地绝对路径以外的凭据信息。

用例表：
（此处粘贴第 3 节的"用例"表，并把 {bvid} 替换成具体视频）

每次调用（第 2 轮）记录：
- 用例 ID、bvid
- 调用前 token、调用后 token、Δtoken（或"不可读"）
- 工具结果中的：images 数量、imageAttached、warnings 的 code 列表
- extract：transcript 条数、subtitles.cuesTotal、subtitles.truncated、danmaku.samples 条数、danmaku.density 条数、comments.hot + latest 条数、adaptive.selected 数量（若有）
- inspect：返回帧数、source、ocr entries 条数（若有）
- transcribe：segments 条数、语言、confidence 字段
- 工具返回中若有耗时字段（elapsedMs 等）一并记录

最后输出一份 Markdown 报告：
1. 环境：插件版本、identity.modulePath（可从 bilibili 设置状态或工具结果 provenance 读取；读不到写"未知"）、执行日期
2. 明细表：每行一个用例×视频
3. 汇总：按用例求 Δtoken 的总和与均值
4. 异常：失败用例与原因
```

## 5. 结果归档

- 报告保存为 `docs/eval/results/token-<variant>-<YYYYMMDD>.md`（variant = baseline / candidate-<提交短哈希>）。
- 对比时只比较第 2 轮；Δtoken 差异小于 2% 视为噪声。
