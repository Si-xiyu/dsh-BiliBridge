# 0.1.3 稳定版（2026-11-20）

基于 `fix/tool-acceptance`（0.1.2 / `23c609f`），只带入独立成立、或默认不改变行为的 ASR/缓存修复与评测资产；实验性 token/弹幕/画质优化不进入本稳定版。

## 保留

- **ASR 缓存 key 修复**：`decoder` 与 `hints` 进入 cache key；避免改了解码策略仍命中旧转写。
- **A1 安全修复**：工具不再发送 hotwords；metadata prompt 默认关闭，仅保留显式 opt-in。hotwords 实测会让 180s 窗口退化成 1–3 段、CER 0.57–0.59。
- **A3 默认关闭**：恢复 faster-whisper 默认 `condition_on_previous_text`；held-out 9 对没有净收益（0.1518 vs 0.1486）。
- **A5 元数据**：内部保留 `avg_logprob`/`compression_ratio`/`no_speech_prob`，工具条目只暴露 `lowConfidence`；阈值未校准。
- **评测资产**：M2 视频集、同 WAV CER harness、DeepSeek tokenizer/pruner 分析记录；只用于评测，不改变工具行为。

## 不进入稳定版

- **T1/T2 渲染压缩**：原始文本 -80% token，但 DSH 默认 tool-result-pruner 先把 baseline 裁到 8192 字符内；模型实际可见 token 为 1,731 vs 2,075，candidate 反而 +19.9%。保留为 research 结论，不合并。
- **T4/D1/D2 弹幕优化**：未完成 held-out 验证。
- **P1 AVC 优先、P2 低码率音轨、V1 宽高比**：未纳入本轮稳定版；后续单独验收。
- **OCR 实验**：未进入本分支。

## 验证

- `npm test` / `npm run test:single`：**361 个测试，360 通过、1 跳过**。
- ASR 默认参数：`condition_on_previous_text` 不设置；中文只保留内置简体引导句；无 hotwords。
- 稳定分支基于 `release/stable-20261120`，合并回 `fix/tool-acceptance` 后打 `v0.1.3`。

## 已知限制

- A5 低置信阈值未用人工标注校准。
- M1 结论基于单个 E2 用例 + DeepSeek-V3 tokenizer；provider 实际 token 可能略有差异，但 pruner 触发边界和中文 token 密度问题是确定的。
- 27 工具写操作/审批未在 0.1.3 合并树上重新跑；只读 smoke 已通过。
