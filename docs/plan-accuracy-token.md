# 行动计划：识别精度 / Token 消耗 / 性能优化

- 基线：`9d915bc`（v0.1.2 收尾）
- 分支：`research/accuracy-token-plan`
- 状态：**草案，待批准**。本文档批准前不修改任何代码。
- **2026-11-19 范围调整**：OCR 工作流（O1/O3/O4/P3）已从本分支移除，代码回退到基线 OCR；保留 `lib/media/terms.mjs` 供 A1 使用。详见第 12 节。
- 修订：2026-11-18 补充第 9–11 节（已确认事项、T1 范围、ASR 引擎对比）

## 0. 目标与约束

**目标**（按优先级）

1. 在信息量不减的前提下，降低 Stage 1 / Stage 2 返回给主 Agent 的 token。
2. 提高 ASR、OCR、选帧、弹幕线索的识别精度。
3. 降低抽帧、扫描、转写的耗时和下载量。

**沿用的约束**（除非第 6 节单独批准）

- 插件不调用 LLM/VLM；推理只由主 Agent 完成。
- 默认路径不新增 npm 依赖、模型或常驻服务；可选扩展必须能明确降级。
- 所有 B 站请求继续走 `lib/bili/http.mjs` 与风控保护；不提高默认并发。
- 工具数量保持 27 个；schema 总量 < 20,000 bytes。
- 返回值的语义字段（`status`、`coverage`、`truncated`、`nextCursor`、`origin`、`maxErrorMs`…）保持兼容；格式变化通过 `schemaVersion` 标识。

## 1. 阶段 0：基线与度量（所有优化的前提）

没有基线就无法判断改动是否有效。现有 `adaptive-frames.md` 的覆盖率/冗余度用的是选帧时优化的同一套特征，属于自评，不能作为最终依据。

| ID | 任务 | 产出 | 验收 |
|---|---|---|---|
| M1 | Token/耗时基准：在 DSH 内由主 Agent 按固定用例调用工具，用 DSH 会话 token 统计计算每次调用的增量 | [`docs/eval/token-bench-task.md`](eval/token-bench-task.md) + `docs/eval/results/` | 第 2 轮（缓存预热后）结果稳定；baseline 与 candidate 用同一用例表 |
| M2 | 评测视频集：按类别各 4–6 个（口播、PPT/讲座、录屏/代码、游戏、MV/混剪、竖屏、长视频 >30min、无平台字幕） | `docs/eval-set.md`（BV 号 + 类别 + 时长） | ≥ 30 个视频，每类 ≥ 4 |
| M3 | 组件级参考答案：ASR/OCR 用平台官方字幕作参考计算 CER；选帧人工标注关键事件时间点 | `tests/fixtures/eval/*.json` | 至少覆盖 PPT、代码、游戏三类 |
| M4 | 端到端问答集：100–200 题，带答案与证据时间点（题型参考 Video-MME / LongVideoBench） | `tests/fixtures/eval/qa.json`，流程见 [`docs/eval/qa-annotation.md`](eval/qa-annotation.md) | 由用户标注；记录准确率与总 token |

**说明**：M3/M4 需要人工标注，工作量最大；可以先做 M1 + M2，让第 1–2 阶段的改动先有 token 与耗时对照，精度对照随 M3/M4 补齐。

## 2. 阶段 1：快速收益（零依赖，小改动）

| ID | 改动 | 位置 | 验收 / 测试 |
|---|---|---|---|
| T1 | **紧凑渲染**（方案 A，见第 10 节）：返回值结构不变，只改给模型看的渲染文本——去缩进，时间序列字段渲染为带表头的行式文本 | `lib/tools/helpers.mjs:10`、`lib/tools/extract.mjs:32`、`lib/tools/dynamic.mjs:8`，新增 `lib/tools/render.mjs` | 渲染往返单测；M1 显示文本 token 明显下降；先单独验证"去缩进"一步 |
| V1 | **修复画面拉伸**：拼图从 `fit:'fill'` 改为 `contain`（黑边），与 Adaptive 拼图一致；竖屏视频在拼图中保持比例 | `lib/media/inspect.mjs:113`，`lib/media/frames.mjs:261`（故事板格本身是否已带黑边需先核实） | 9:16 视频截图单测：输出 tile 的有效区域宽高比与源一致 |
| O1 | **（已移出，2026-11-19）OCR 多语言 + 领域词表**：`recognitionLanguages` 改为 `[请求语言, "en-US"]`；新增 `-Words` 参数传入标题/tags 作为 `customWords`；设置 `minimumTextHeight` | `lib/media/vision-ocr.swift:97`，`lib/media/vision-ocr.mjs` | 中英混排样例（技术视频）CER 下降；swift 源码 hash 变化会自动触发重编译，需验证 |
| A1 | **（2026-11-20 修正）ASR 上下文偏置**：**hotwords 已禁用**；metadata prompt **默认关闭**（candidate 含 A3/A5 在 6 个 held-out×2 窗口无净收益：0.1528 vs 0.1486；A1 未单独隔离），仅保留显式 opt-in；默认只用 daemon 内置简体引导句 | `lib/media/asr_daemon.py:53`，`lib/media/asr_worker.py:109`，`lib/tools/transcribe.mjs` 传参 | 专有名词样例的命中率提升；prompt 长度上限单测 |
| P2 | **ASR 用低码率音轨**：`getPlayUrls` 同时返回最低码率音轨，转写使用它 | `lib/bili/playurl.mjs:73`，`lib/tools/transcribe.mjs:106` | 下载字节数下降；CER 不变（M3） |

## 3. 阶段 2：中等改动（零依赖）

### 3.1 Token

| ID | 改动 | 位置 | 验收 |
|---|---|---|---|
| T2 | **字幕成段**：相邻 cue 间隔 < 0.8s 且合并后 ≤ N 字时合并，只保留起始时间；分页游标仍以原始 cue 为单位 | `lib/media/subtitles.mjs`（`pageSubtitleCues` 之后）、`evidence.mjs` | 游标续取不重不漏；token 在 T1 基础上继续下降 |
| T3 | 弹幕 `density` 改为数组 + 峰值摘要 | `lib/media/danmaku.mjs` | 长视频 token 下降；`suggestedWindows` 不变 |
| T4 | **弹幕聚类采样**：SimHash 近重复聚类 → 按簇大小排序 → MMR 选样本，输出 `count` | `lib/media/danmaku.mjs:73` | 样本去重率；人工抽检代表性 |
| T6 | **按证据自动省图**：字幕 coverage ≥ 0.9 且 Adaptive `changeScore` 低时，Stage 1 只给 Uniform 图，并在 `frames` 中说明原因 | `lib/media/evidence.mjs`、`lib/media/adaptive-overview.mjs` | 口播类省图；PPT/游戏类不受影响（M2 分类核对） |

### 3.2 精度

| ID | 改动 | 位置 | 验收 |
|---|---|---|---|
| D1 | **弹幕延迟校准**：`suggestedWindows` 整体前移约 3–5s（可配置） | `lib/media/evidence.mjs:46` | M3 关键事件命中率 |
| D2 | **弹幕密度去趋势**：用局部中位数/MAD 的 z-score 取峰，替代原始计数 Top3 | 同上 | 片头偏置下降 |
| O3 | **（已移出，2026-11-19）OCR 模糊合并与投票**：归一化相似度（1 − Levenshtein / 较长串长度）≥ 0.8 视为同一句，多帧字符级投票；swift 输出 `confidence`。实际实现为整行多数表决，且任一行 <4 字时要求完全一致（见 §12） | `lib/media/ocr.mjs`（`mergeDuplicateOcrEntries`）、`vision-ocr.swift` | OCR 条目数下降、CER 下降 |
| O4 | **（已移出，2026-11-19）字幕切换触发 OCR**：对字幕带做 pHash/像素差变化检测，只在变化时识别 | `lib/media/ocr.mjs` | OCR 调用次数下降；起止时间误差下降 |
| A3 | **（2026-11-20 未采用）抑制 ASR 幻觉**：`condition_on_previous_text=False` 在 9 个 held-out 配对无净收益（0.1518 vs 0.1486），恢复默认；`compression_ratio_threshold` 未显式设置（沿用 faster-whisper 默认 2.4），`hallucination_silence_threshold` 未启用 | `asr_daemon.py`、`asr_worker.py` | BGM 类视频重复/幻觉段减少；耗时变化记录 |
| A4 | **ASR 窗口重叠**：相邻窗口重叠 1–2s，按时间戳去重合并 | `lib/media/asr.mjs`、`lib/tools/transcribe.mjs` | 边界断词减少；预算按实际音频秒数计费不重复扣 |
| A5 | **（2026-11-20 保留但未校准）** 内部载荷有 `avg_logprob`/`compression_ratio`/`no_speech_prob`，工具条目只暴露 `lowConfidence`；阈值未用人工标注校准 | `asr_daemon.py`、`asr.mjs` `segmentsToEntries` | 字段单测 |
| V2 | 帧数 ≤ 2 时 inspect 输出原分辨率（受宿主上限约束），否则维持拼图 | `lib/media/inspect.mjs` | 小字可读性抽检 |

### 3.3 性能

| ID | 改动 | 位置 | 验收 |
|---|---|---|---|
| P1 | **优先 AVC 解码**：同画质下优先 `codecid=7`；macOS 可选 `-hwaccel videotoolbox`（失败自动回退软解） | `lib/bili/playurl.mjs:72`、`lib/media/ffmpeg.mjs` | 抽帧/扫描耗时下降；无流时回退 |
| P3 | **（已移出，2026-11-19）连续解码代替逐点 seek**：采样间隔小于阈值时，一次 ffmpeg 解码 `fps+crop` 输出到管道（复用 adaptive 扫描实现） | `lib/media/ocr.mjs` `buildSubtitleStrip`、`inspect.mjs` `buildRealFrames` | 字幕窗口 OCR 总耗时下降；取消语义不变 |
| P6 | OCR 结果缓存：键 `(cid, ms, region, engine, 源码hash)` | `lib/media/cache.mjs` | 重复调用命中 |

## 4. 阶段 3：较大改动（零依赖，需先实测）

| ID | 改动 | 前置 |
|---|---|---|
| T5 | 接入平台结构信号：`player/wbi/v2` 的 `view_points`（章节）与 `/x/web-interface/view/conclusion/get`（AI 总结/提纲），作为 Stage 1 目录，标注 `origin: platform-ai` | **先写探针确认两个接口的可用性、签名要求和风控影响**；不可用则放弃 |
| V3 | 选帧增加结构特征：Sobel 边缘密度、灰度 SSIM、变化像素占比，提升录屏/PPT/代码类的灵敏度 | 需 M3 的关键事件标注做消融；更新特征缓存版本号 |
| V4a | 按问题选窗（无模型）：`inspect`/`extract` 增加可选 `query`，用 BM25 在字幕/ASR/OCR/弹幕上检索，返回 top 时间窗 | 评估是否以参数形式加入现有工具（不新增工具），schema 增量需在预算内 |
| O2 | 字幕区自动定位：基于 Vision `boundingBox` 的时间稳定性推断字幕带位置，失败回退 22% 底部带 | 仅 macOS 可靠；Windows 维持现状 |
| P4 | 长视频 Adaptive 粗扫：`-skip_frame nokey` 粗扫 + 边界附近精扫 | 先统计 B 站常见 GOP；对比选帧结果差异 |

## 5. 评估与回归方式

- 每个 ID 一个提交，提交信息带 ID；单测随改动补齐，`npm test` 与 `npm run test:single` 必须全绿。
- 每阶段结束跑 M1（token、耗时）；M3/M4 就绪后补跑精度对照，结果写入本文档附录。
- 对照表格式：`改动 | 文本 token | 图片张数/像素 | 耗时 | CER | 关键事件召回 | QA 准确率`。
- 无收益或负收益的改动回退，并记录结论（"未证明有效"与"证明无效"分开写）。
- 宿主层：每阶段结束后在 macOS 宿主重启验收一次（27 工具可见、Stage 1/2 正常）。

## 6. 需要你单独决定的事项

以下改动会突破"默认路径不加模型/依赖"的约束，本计划**默认不做**，批准后以可选 Python 扩展形式实现（复用 ASR venv，缺失时降级到现有路径）：

| ID | 内容 | 收益 | 代价 |
|---|---|---|---|
| A2 | 中文 ASR 换 Paraformer-zh / SenseVoice-Small，或 Whisper `large-v3-turbo` | 中文 CER 与速度显著改善；SenseVoice 可输出 BGM/笑声事件 | 新 Python 依赖与模型下载 |
| O5 | Windows 改用 PP-OCR / RapidOCR | Windows 中文 OCR 精度 | 新依赖 |
| V4b | CLIP/SigLIP（Chinese-CLIP / MobileCLIP）按问题选帧 | 语义相关帧召回 | 模型与推理耗时 |
| V5 | TransNetV2 镜头切分 | 切分精度 | ONNX 运行时 |
| A3+ | Demucs 人声分离（BGM 重的视频） | 音乐场景 ASR | 耗时高，仅作开关 |

## 7. 不在本计划范围内

- 写操作、风控、认证相关逻辑。
- 宿主侧图像 token 压缩（由 DSH/模型决定）。
- 当前 `fix/tool-acceptance` 分支上未提交的改动（本 worktree 基于 `9d915bc`，不包含它们；合并时需注意 `README.md` 冲突）。

## 8. 建议执行顺序

1. 阶段 0：M1 + M2（先有 token/耗时基线）
2. 阶段 1：V1 → T1 → A1 → P2（O1 暂缓）
3. 阶段 2：T2、D1/D2、A3/A4/A5、P1，其余按 M1 结果排序（O3/P3 暂缓）
4. 并行推进 M3/M4 标注
5. 阶段 3：先做 T5 探针，再根据标注数据决定 V3/V4a/O2/P4
6. 第 6 节事项按你的决定单独立项

## 9. 已确认事项（2026-11-18）

1. **Token 计量**：使用 DSH 自带的会话 token 统计。M1 改为在 DSH 内由主 Agent 执行固定用例并输出报告，任务见 [`docs/eval/token-bench-task.md`](eval/token-bench-task.md)。
2. **标注**：由用户标注。流程为出题（人工或 LLM 生成候选后人工审核）→ 标注标准答案与证据时间段 → Agent 分别用 baseline / candidate 回答 → 与标准答案比较。格式与提示词见 [`docs/eval/qa-annotation.md`](eval/qa-annotation.md)。
3. **T1 变更范围**：见第 10 节；建议改为"只改渲染层"的方案，不升级 `schemaVersion`。
4. **可选 ASR 引擎**：见第 11 节；建议先不替换，增加可选引擎并用 M3 实测决定。

## 10. T1 变更范围评估

### 10.1 现状

- 所有工具的返回值经 `registerTool` 默认渲染器 `jsonContent`（`lib/tools/helpers.mjs:10`）以 `JSON.stringify(value, null, 2)` 交给模型；`extract`/`inspect`（`extract.mjs:32`）和 `dynamic`（`dynamic.mjs:8`）各有一份同样缩进的 `contentRenderer`，只多了图片块。
- 工具的结构化返回值（`value`）和给模型看的文本（`render`）是两层。`value` 的消费方：设置页/工具卡片（`lib/client.js`，只读图片与状态，**不读 transcript**）、devlog、手工脚本 `tests/manual-evidence.mjs`、`manual-tools.mjs`、`manual-foundation.mjs`（读 `bundle.transcript.length`）。
- 单测没有覆盖渲染输出，也没有断言 `transcript` 的结构。

### 10.2 两种方案

| | 方案 A：只改渲染层（推荐） | 方案 B：改返回值结构 |
|---|---|---|
| 做法 | `value` 不变；渲染器输出紧凑 JSON，并把时间序列字段（`transcript`、collect 的 `cues`、transcribe 的 `segments`、OCR `entries`）渲染成带表头的行式文本 | `bundle.transcript` 改为字符串或列式数组 |
| 涉及文件 | `lib/tools/helpers.mjs`（`jsonContent`）、`lib/tools/extract.mjs`、`lib/tools/dynamic.mjs`（两个 `contentRenderer` 合并为一个共享实现），新增 `lib/tools/render.mjs` 与单测 | `lib/media/evidence.mjs`、`lib/bili/collect.mjs`、`lib/tools/transcribe.mjs`、`lib/media/ocr.mjs`、`inspect.mjs`、3 个手工脚本、文档 |
| `schemaVersion` | 不变 | 升为 `'3'` |
| 影响面 | 全部 27 个工具的模型可见文本变紧凑（去缩进对所有工具都有收益）；UI、devlog、脚本不受影响 | UI 不受影响；手工脚本与外部调用方需同步修改 |
| 回退 | 改一个函数即可 | 多文件回退 |
| 主要风险 | **需确认 DSH 交给模型的是 `render` 输出而不是 `value`**；行式文本需自带表头，避免模型误读 | 返回值不兼容 |

### 10.3 方案 A 的实施要点

1. 新增 `renderForModel(value)`：先把已知时间序列字段替换为行式文本，再 `JSON.stringify(value)`（无缩进）。示例：

   ```text
   transcript (platform, 800 cues, format: start text):
   00:01.2 大家好今天我们来看
   00:04.5 这一段的具体实现
   ```

2. 时间序列字段按"路径白名单"处理，不做通用猜测；其余字段原样保留。
3. `extract`/`inspect`/`dynamic` 共用同一实现，只在末尾追加图片块。
4. 单测：渲染结果可解析回原有时间与文本（往返）；非白名单字段与原 JSON 等价；空数组与缺字段不报错。
5. 验证顺序：先只做"去缩进"（一行改动），用 M1 确认 DSH 的 token 统计确实下降（同时验证上面的主要风险），再做行式文本。

### 10.4 工作量估计

方案 A：约 0.5–1 天（含单测与一次 M1 对照）。方案 B：约 2 天，且需要同步文档与手工脚本。

## 11. 可选 ASR 引擎：与当前 faster-whisper 的对比

### 11.1 当前开销（本机实测，2026-11-18）

| 项 | 大小 |
|---|---|
| `asr-venv`（faster-whisper 1.2.1 及依赖） | 219 MB（其中 onnxruntime 80 MB、PyAV 45 MB、numpy 34 MB、tokenizers 9.6 MB、ctranslate2 6 MB） |
| 模型目录（`faster-whisper-small`） | 464 MB |
| 合计 | 约 683 MB；已是可选依赖，缺失时 `DEPENDENCY_MISSING` 降级 |

### 11.2 对比

| 维度 | faster-whisper small（当前） | SenseVoice-Small | Paraformer-zh | Whisper large-v3-turbo |
|---|---|---|---|---|
| 中文准确率 | 一般；繁简漂移、专名错误多 | 论文报告显著优于 Whisper-small/large 的中文结果 | 中文强 | 优于 small，接近 large-v3 |
| 速度（CPU） | 自回归，慢 | 非自回归，论文称比 Whisper 快一个数量级以上 | 非自回归，快 | 比 small 慢，比 large-v3 快很多 |
| 幻觉/重复 | BGM、静音段易出现 | 非自回归，基本没有重复循环 | 同左 | 同 Whisper |
| 时间戳 | 段级，可开词级 | 需借助运行时/CTC 对齐，粒度依实现而定 | 有（需 VAD 管线） | 同 Whisper |
| 标点 | 自带 | 自带（ITN 可选） | 需额外标点模型 | 自带 |
| 语言 | 多语言 + 翻译 | 中、粤、英、日、韩 | 中文（含中英混说） | 多语言 |
| 上下文偏置 | `initial_prompt`（A1 仅保留 prompt；hotwords 已禁用） | 不支持热词 | SeACo-Paraformer 支持热词 | 同 Whisper |
| 额外能力 | — | 情感与音频事件（BGM、笑声、掌声） | — | — |
| 新增依赖（推荐路线） | — | `sherpa-onnx`（自带 ONNX 运行时）+ int8 模型（约 230 MB 量级） | 同左 | 无新依赖，只换模型（约 1.6 GB 量级） |

表中竞品的准确率与速度来自各自论文/官方报告，测试集不是 B 站内容；包体积为量级估计。**两者都需要在 M3 上实测**后才能下结论。

### 11.3 作为插件的额外开销

- **安装体积**：走 sherpa-onnx 路线时，在现有 683 MB 基础上增加约 250–300 MB（量级估计）；走 FunASR 官方 PyTorch 路线会引入 torch，体积和安装失败率都明显更高，**不建议**。
- **内存**：daemon 现在一次只常驻一个模型（`asr_daemon.py` 切换模型时会先释放）；保持"同一时刻只加载一个引擎"，内存不会翻倍。
- **维护成本**：doctor 检查、设置页选项、安装文档、Windows/macOS 两套 wheel 验证、daemon 协议增加 `engine` 字段。这是主要成本，比体积更值得关注。
- **功能取舍**：换成 SenseVoice 会失去 `hotwords`/`initial_prompt` 偏置（与 A1 冲突）和翻译能力；Paraformer 需要另配标点模型。

### 11.4 建议

1. **默认不替换**。A1/A3 已在 held-out 上评估：metadata prompt 和 `condition_on_previous_text=False` 均无净收益，默认关闭；后续只保留 P2、缓存和 A5 置信度元数据。
2. 在 `asr_daemon.py` 增加可选 `engine` 配置（默认 `faster-whisper`），实现 `sherpa-onnx` + SenseVoice-Small 一个候选；未安装时 doctor 标注、调用降级到 faster-whisper。
3. 用 M3 的 ASR 子集（平台官方字幕作参考）比较 CER、耗时、幻觉段数量，再决定是否改默认值。
4. `large-v3-turbo` 只作为"追求精度、不在意体积"的配置项说明，不做默认。


## 12. 2026-11-19 OCR 工作流移出本分支

审查发现当前 OCR 优化在真实字幕比例下存在准确率回归，决定将 O1、O3、O4、P3 整体移出本分支，回到基线 OCR；非 OCR 的 T1/T2/V1/T4、ASR A1/A3/A5、P1/P2、D1/D2 保留。

- **O4**：160×16/8 格/0.02 阈值在 1080p 常见字号下漏判单字变化；anchor OCR 为空会吞掉整段；复用 confidence 会重复计票；默认开启且无降级开关。
- **O3**：归一化相似度 ≥0.8（即编辑距离/较长串长度 ≤0.2；任一行 <4 字时要求完全一致）会把“真实相邻、只差一个词”的字幕合并（实测相似度 0.867 即合并），丢失第二句。实际实现采用整行多数表决，而计划写的是字符级投票，两者不一致。
- **O1/P3**：随 OCR 工作流一并回退；`terms.mjs` 因 ASR A1 依赖而保留，Vision 词表/最小文字高度不再生效。
- 基线 OCR（整帧/字幕窗口、逐点 seek、精确重复合并）保留；P3 的取消传播修复保留在逐点循环中。
- 复核与回退提交见本分支后续“revert OCR workstream”提交；备份分支 `backup/accuracy-token-plan-32f2f05`。
- **重新进入条件**：先完成 M1/M2/M3；O4 改用文字掩码/更高分辨率并补 1920×237/40px 单字回归；O3 需区分 OCR 噪声与真实换行（字符级投票 + 真实换行不得合并的用例）；O1/P3 分别评估 CER/耗时后再提。


## 13. 基础评测结果（2026-11-19）

最小 M1/M3 探针已落地，见 [`docs/eval/results/asr-cer-20261119.md`](eval/results/asr-cer-20261119.md)。

- **Token（2026-11-20 复算）**：同一 E2 值，原始文本 candidate/baseline = 0.197（DeepSeek tokenizer，10,552→2,075）；但 DSH 默认 tool-result-pruner 把 baseline 裁到 5,159 字符后，模型可见 token 变为 **1,731 vs 2,075（1.199，+19.9%）**。T1/T2 在默认 host 下不是 token 优化，只是信息密度/字幕保留度更高；`dsh-context` 的 chars/4 估算会误判方向。
- **ASR**：`BV1KDNA6eEgr` 180–240s、同一 WAV 下，baseline CER 0.1684；candidate 传 `prompt+hotwords` 时退化为 1 段/CER 0.5907，单独 hotwords 也退化到 0.5699；prompt-only 0.2021、不额外传 0.1891。
- **A1 修复后**：工具不再传 hotwords，缓存 key 补 decoder/hints；60–120s CER 0.1542（baseline 0.3333），180–240s 0.1788（baseline 0.1684），不再出现灾难性退化。
- **M3 held-out（2026-11-20）**：6 个视频×2 窗口、9 个有效配对，candidate（prompt+A3/A5）均值 0.1528 vs baseline 0.1486（3 胜/5 负/1 平），没有净收益。A1 未与 A3/A5 分离；metadata prompt 默认关闭，decoder 升到 4（A3 off 后为 5），仅保留 opt-in 入口。
- **A3/A5 消融（2026-11-20）**：A3 on 0.1518 vs baseline 0.1486（2胜/5负/2平）；A3 off 后 8 个同 WAV 配对 CER/段数逐项完全相等（另 1 个窗口 WAV 准备失败，未计入）。A3 不默认启用，A5 只保留 `lowConfidence` 标注（阈值未校准）。
- **结论**：T1/T2 可以继续；A1/A3 默认都不启用；A3 off 后 8 组 CER/段数相等（未逐字比对），剩余价值是 P2/缓存/A5 元数据。
- 下一步：做 M1 宿主 token 复测；A1/A3 不默认启用，T1/T2 通过后只合并安全项，不整体合并 research。
