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

故事板模式的误差标注分两个概念：`matchOffsetMs` 是“请求时间与平台索引时间的匹配偏差”（可能为 0，只说明正好落在格上）；`maxErrorMs` 是“该格相对源视频真实帧的时间误差”，我们没有测量手段，**固定返回 `null`**，不把零匹配偏差当成零误差。

## 实现边界

- `adaptive-selection.mjs`：无 I/O 的 HSV/pHash 特征、Haar 分析、候选生成与全局选择。
- `adaptive.mjs`：范围校验、扫描、特征缓存、故事板降级。
- `inspect.mjs`：模式校验，复用现有截图、拼图和 OCR。
- `adaptive-overview.mjs`：给出 Uniform 的 9 个时间点（特征由扫描帧就地取），生成补充九宫格。

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
| sharpenWindowMs | 1500 | 0–5000；选点后在 ±1s（硬上限）内找更清晰的同片段帧 |
| minGapMs | 5000 | 0–60000；软间隔，越近折扣越大，不硬排除 |
| timeoutMs | 60000 | 单次扫描预算，1000–60000 |

小波固定 Haar，不暴露额外类型；不施加强制最小选帧间隔，以免排除短事件。扫描最多 3600 帧，超过时降低扫描 FPS；候选最多 300。特征缓存键包含算法版本、视频、分 P、范围、来源和配置，沿用现有 `cache.enabled/ttlMs`。命中全片缓存时区间重新选择，不是过滤全片最终九帧；会沿用已有扫描密度。损坏或过期缓存作为未命中。临时降级结果不长期缓存，以便下次重试 FFmpeg。最终截图目前重新提取，不声称图片缓存命中。

质量处理（2026-11-09 修订）：

- **代表性时间点先定，再在附近找更清晰的一帧**：窗口硬限制 ±1s、必须在同一时间片段内、与原点内容相似度 ≥ 0.75、清晰度至少提升 10% 才替换。避免跨场景或吃掉短事件。
- **黑屏不硬过滤**：明显黑屏（`blackRatio > 0.6`）的候选在选得满时不占名额；只有选不满时才放宽（两轮贪心）。片尾卡本身可能是有意义的信息，只是不该挤掉更有内容的画面。
- **冗余**：`nearDuplicate` 仍用严格阈值（直方图交 ≥ 0.995 且 hash 一致率 ≥ 0.985）；另加软间隔折扣控制近距离重复，但从不硬性禁止。
- **Uniform 参考改为时间点**：原来用故事板格自己的特征，和视频扫描帧同一时刻的 HSV 相似度实测只有 0.17–0.68（低清/压缩/裁切差异），"与 Uniform 互补"这一项会算错。现在只取故事板给的 9 个时间点，特征从扫描帧就地取，保证同一特征管线。

`source=auto`：扫描失败降级故事板；高清截图失败则在同一区间用故事板重新选择。`source=ffmpeg`：保持失败报错语义。`source=storyboard`：强制平台故事板。故事板在指定区间没有帧时返回不可用，不借用区间外画面。

Stage 1 增强分支将参考帧获取、扫描及截图纳入约 100 秒的整体预算（扣除已有概览耗时），内部超时保留原有结果与警告。inspect 自适应整体预算 165 秒，低于工具 180 秒。用户取消直接传播，不再启动降级。同步特征计算及原有 Uniform 构建不具有硬实时保证。

## 验证记录（2026-11-09，含质量修订）

自动测试：`npm test`，**210/210 通过，零跳过**（`test:single` 也全绿）。含本地 FFmpeg 真实区间扫描/取消、数学增益、Haar 时间对齐、静态零补帧、短事件、损坏缓存、区间复用、模式互斥、拼图、总预算，以及本轮新增的黑屏两轮贪心、清晰度替换、参考时间映射与故事板误差继承。

评审补充修复（第二轮）：

- `refineForSharpness` 的资格线改为**相对 base 固定**（原实现拿不断抬高的 best×1.1 比较，先遇到 1.11 倍后会把更清晰的 1.20 倍拒掉；且恰好 +10% 因浮点被拒）。
- `mapReferenceFrames` 保留 `atMs`：片段覆盖计数按时间归段，只传裸特征会让 Uniform 参考全部落空。
- Stage 1 重组 adaptive 图时继承 `accuracy` / `maxErrorMs` / `matchOffsetMs` / `typicalGapMs`，故事板降级不再丢误差语义。

手工命令（会联网并写正常媒体缓存，不打印凭据或签名 URL）：

```powershell
node tests/manual-adaptive.mjs BV1GJ411x7h7 10 30 3 auto
node tests/manual-adaptive.mjs BV1GJ411x7h7 full 0 9 auto
node tests/manual-adaptive.mjs BV1GJ411x7h7 overview
node tests/manual-adaptive.mjs BV1GJ411x7h7 10 30 3 storyboard
node tests/manual-adaptive-compare.mjs <已有的adaptive特征缓存JSON路径>
```

质量修订前后对照（`BV19px46aEo8`，cid=43238034562，134 秒，扫描缓存命中）：

| 指标 | 修订前 | 修订后 |
| --- | --- | --- |
| 选中帧 | 17/25/53/62.5/72/83/92.5/115/**128.5（黑屏 0.94）** | 16/25/53/62.5/72/83/92.5/101.5/115（**无黑屏**） |
| 最低清晰度 | 0.0235 | 0.0845 |
| 最高两两相似度 | 0.664 | 0.664 |

同一缓存的扫描帧特征对照（Uniform 用扫描锚点，与线上平台 Uniform 有区别）：

| 方案 | 总帧数 | 平均最大特征相似度 | 平均两两相似度 |
| --- | --- | --- | --- |
| Uniform 9 | 9 | 0.6924 | 0.3165 |
| Uniform 18 | 18 | 0.7445 | 0.3518 |
| Uniform 9 + HSV 峰值 9 | 18 | 0.7329 | 0.3412 |
| Uniform 9 + Facility 9 | 18 | 0.7843 | 0.3826 |
| Uniform 9 + Facility/片段覆盖 9，无 DWT | 18 | 0.7820 | 0.3757 |
| Uniform 9 + DWT/Facility 9，无片段奖励 | 18 | 0.7846 | 0.3837 |
| Uniform 9 + 完整方案 9 | 18 | 0.7823 | 0.3766 |

Facility 相对 Uniform 18 仍提升覆盖率；黑屏两轮贪心会牺牲一点覆盖率（深色帧不再被"覆盖"），换取可用画面。本样本中 DWT 与片段覆盖的差异在 0.002 量级内，**属于尚未证明有额外收益，而不是证明无效**。

其他实测（模块级，非宿主工具调用）：`BV19px46aEo8` Stage 1 双九宫格冷启动约 4.7–6.2 秒；`BV1REx46NEc4`（50 分钟）冷启动扫描 11.4 秒、完整 Stage 1 约 40.9 秒；扫描缓存命中后选帧 < 1 秒。

未完成：PPT、代码、游戏、长视频等多类别人工关键事件召回；主 Agent 问答准确率；慢速 CDN；宿主内自动降级与取消的端到端验证。
