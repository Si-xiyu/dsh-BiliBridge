# 自适应代表帧

## 使用

`bilibili_extract` 默认返回封面、原有 Uniform 九宫格及最多九帧的 Adaptive 九宫格。`include.frames=false` 和字幕续页保持原有跳过画面逻辑。`adaptive` 字段报告选帧数量、范围、来源、缓存命中和停止原因。Adaptive 为零帧时不生成空图；不足九帧时剩余格留空。

`bilibili_inspect` 默认仍是原有定向模式，接受 `timestampsMs` 或 `intervals`。自适应模式示例：

```json
{
  "bvid": "BV1GJ411x7h7",
  "selection": "adaptive",
  "range": { "startMs": 10000, "endMs": 30000 },
  "maxFrames": 3
}
```

省略 `range` 分析当前分 P 全片；指定 `page` 可切换分 P。`range` 为原视频绝对整数毫秒的半开区间 `[startMs,endMs)`，须在当前分 P 内。`maxFrames` 为 1–9，自适应默认 9，定向模式默认 6。自适应与 `timestampsMs`、`intervals`、`subtitleWindow` 互斥，支持原有逐帧 `ocr=true`。没有新增 Agent 工具。

inspect 复用原有拼图：每张最多 2×3，九帧按 5+4 拆成两张图。Stage 1 单独使用 3×3。图片时间标签 `req` 是 FFmpeg seek 的请求时间，不是实测 PTS；故事板 `got` 是平台 index，不代表经过源视频帧级校验。

## 实现边界

- `adaptive-selection.mjs`：无 I/O 的 HSV/pHash 特征、Haar 分析、候选生成与全局选择。
- `adaptive.mjs`：范围校验、扫描、特征缓存、故事板降级。
- `inspect.mjs`：模式校验，复用现有截图、拼图和 OCR。
- `adaptive-overview.mjs`：获取实际 Uniform 参考帧，生成补充九宫格。

不增加模型、服务、常驻进程或 npm 依赖。FFmpeg 扫描使用一份有界临时 RGB 文件，逐帧读取后提取 32×32 特征，完成后删除；不生成数千张中间 JPEG。扫描本身不会按输出帧率同比减少输入解码成本。

## 选择规则

HSV 使用 8×3×4 的归一化直方图；pHash 使用亮度网格的 63 个低频 AC 系数。相似度为 `0.65 × 直方图交集 + 0.35 × hash相同比例`。

相邻特征差异加 Haar 多尺度重建细节得分，经中位数/MAD 阈值、局部峰和最短 1 秒片段约束得到时间分段。保留原始差异，避免仅用小波细节遗漏持续变化。`changeScore` 是片段内归一化变化得分的平均值。关闭小波仍可使用原始差异峰值。

候选预算先保留约 1/3 均匀锚点，再给边界前后窗口约 1/3，其余用于片段直方图质心附近代表帧及均匀补充。对所有有效扫描帧衡量覆盖，避免候选采样密度直接改变代表性权重。

每步按以下归一化目标的边际增益选择，Uniform 参考帧 U 已计入覆盖：

```text
F(U∪S) = mean_i max_{j∈U∪S} sim(i,j)
C(U∪S) = mean_g (1 − exp(−k_g(U∪S)/tau))
objective = facilityWeight × F + segmentCoverageWeight × C
```

本版片段等权。图像质量仅在收益相同时优先选择较清晰、非黑屏的帧，不硬删暗场或运动帧。时间戳去重后保留不同时间的相似候选，让选择过程仍能考虑其片段位置。

只有直方图交集 ≥0.995 且 63 位 hash 相同比例 ≥0.985，才视为高度近重复并排除。达到帧数上限或没有剩余非重复候选时停止，**不因低边际收益提前停止**。`stopReason` 可为 `frame-limit`、`near-duplicates-or-candidates-exhausted`、`no-valid-candidates`。

这些规则只能估计视觉新增覆盖，不能判断语义无用。代码单行变化、公式、字幕或同版式幻灯片可能被遗漏；还应利用文字证据及 Stage 2 精查。

## 配置、缓存与失败

数据目录的 `config.json` 可增加 `adaptive` 对象；正常使用无需调整内部参数：

| 字段 | 默认值 | 范围／含义 |
| --- | --- | --- |
| adaptiveEnabled | true | 关闭 Stage 1 自动增强；显式 inspect adaptive 仍可用 |
| scanFps | 自动 | ≤5 分钟 2；≤15 分钟 1.5；更长 1；可配置 0.1–4 |
| scanWidth | 160 | 64–320 整数 |
| candidateBudget | 180 | 60–300 整数 |
| waveletEnabled | true | 原始差异 + Haar；关闭则仅原始差异 |
| waveletLevel | 3 | 1–6，实际按序列长度限制 |
| facilityWeight | 1 | 0–10 |
| segmentCoverageWeight | 0.2 | 0–10；0 可做消融 |
| segmentCoverageTau | 1 | 0.1–10 |
| timeoutMs | 60000 | 单次扫描预算，1000–60000 |

小波固定 Haar，不暴露额外类型；不施加强制最小选帧间隔，以免排除短事件。扫描最多 3600 帧，超过时降低扫描 FPS；候选最多 300。特征缓存键包含算法版本、视频、分 P、范围、来源和配置，沿用现有 `cache.enabled/ttlMs`。命中全片缓存时区间重新选择，不是过滤全片最终九帧；会沿用已有扫描密度。损坏或过期缓存作为未命中。临时降级结果不长期缓存，以便下次重试 FFmpeg。最终截图目前重新提取，不声称图片缓存命中。

`source=auto`：扫描失败降级故事板；高清截图失败则在同一区间用故事板重新选择。`source=ffmpeg`：保持失败报错语义。`source=storyboard`：强制平台故事板。故事板在指定区间没有帧时返回不可用，不借用区间外画面。

Stage 1 增强分支将参考帧获取、扫描及截图纳入约 100 秒的整体预算（扣除已有概览耗时），内部超时保留原有结果与警告。inspect 自适应整体预算 165 秒，低于工具 180 秒。用户取消直接传播，不再启动降级。同步特征计算及原有 Uniform 构建不具有硬实时保证。

## 验证记录（2026-11-09）

自动测试：`npm test`，204/204 通过，零跳过。含本地 FFmpeg 真实区间扫描/取消、数学增益、Haar 时间对齐、静态零补帧、短事件、损坏缓存、区间复用、模式互斥、拼图及总预算。生成的九宫格已目视检查。

手工命令（会联网并写正常媒体缓存，不打印凭据或签名 URL）：

```powershell
node tests/manual-adaptive.mjs BV1GJ411x7h7 10 30 3 auto
node tests/manual-adaptive.mjs BV1GJ411x7h7 full 0 9 auto
node tests/manual-adaptive.mjs BV1GJ411x7h7 overview
node tests/manual-adaptive.mjs BV1GJ411x7h7 10 30 3 storyboard
node tests/manual-adaptive-compare.mjs <已有的adaptive特征缓存JSON路径>
```

真实 213 秒样本，cid=137649199：

| 验收 | 观测耗时 | 结果 |
| --- | --- | --- |
| 10–30 秒选 3 帧 | 1.94 秒 | FFmpeg，19.5/23/28 秒，一张拼图 |
| 全片选 9 帧 | 4.28 秒 | FFmpeg，两张拼图 5+4 |
| Stage 1 概览 | 4.10 秒 | 封面 + Uniform + Adaptive；实际 9 个 Uniform 参考，扫描缓存命中 |
| 强制故事板区间选 3 帧 | 0.80 秒 | 11/23/29 秒，均在区间内 |

同一缓存的 424 张扫描帧进行特征对照（此处 Uniform 是扫描锚点，与线上平台 Uniform 有区别）：

| 方案 | 总帧数 | 平均最大特征相似度 |
| --- | --- | --- |
| Uniform 9 | 9 | 0.6426 |
| Uniform 18 | 18 | 0.7077 |
| Uniform 9 + HSV 峰值 9 | 18 | 0.6905 |
| Uniform 9 + Facility 9 | 18 | 0.7356 |
| Uniform 9 + Facility/片段覆盖 9，无 DWT | 18 | 0.7358 |
| Uniform 9 + DWT/Facility 9，无片段奖励 | 18 | 0.7354 |
| Uniform 9 + 完整方案 9 | 18 | 0.7355 |

这是目标特征上的诊断，不能作为独立效果证明；本样本中 DWT 没有表现出明确增益。尚未完成 PPT、代码、游戏、长视频等多类别人工关键事件召回、主 Agent 问答准确率、慢速 CDN 或宿主实际附件端到端评估。主要成本预计在网络读取、视频解码及高清截图，应基于更多实际样本再决定是否调整默认小波或采样密度。
