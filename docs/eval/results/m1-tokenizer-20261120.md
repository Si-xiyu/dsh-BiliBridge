# 2026-11-20 M1：DeepSeek tokenizer + DSH pruner 复算

## 方法

同一份 `bilibili_extract` 结构化值（BV161nZ6JE6b，关闭 frames/comments/danmaku）：

1. candidate 模型可见文本：`renderText(value)`（T1/T2）
2. baseline 模型可见文本：`JSON.stringify(value, null, 2)`
3. 应用 DSH 默认 `tool-result-pruner`：
   - `thresholdChars=8192`
   - `headChars=4096`
   - `tailChars=1024`
   - 超出时保留 head + `\n\n[... tool result middle pruned ...]\n\n` + tail
4. 用 DeepSeek 官方 tokenizer（`deepseek-ai/DeepSeek-V3` 的 `tokenizer.json`，`add_special_tokens=false`）计数。

这不是 provider 账单数字，但比字符/4 启发式更接近真实模型 token；差异主要来自中文 tokenization。

## 结果

| 文本 | 字符 | DeepSeek tokens |
| --- | ---: | ---: |
| baseline 原始 pretty JSON | 32,463 | 10,552 |
| candidate 原始 renderText | 4,549 | 2,075 |
| **baseline 经 pruner（模型实际可见）** | **5,159** | **1,731** |
| **candidate（未触发 pruner）** | **4,549** | **2,075** |

- 原始文本：candidate/baseline = **0.197**（-80.3%）
- **默认 host pruner 后：candidate/baseline = 1.199（+344 tokens，+19.9%）**

## 解释

DSH 默认 pruner 先把 baseline 32,463 字符裁到 5,159 字符（丢失 27,304 字符），再做模型请求。candidate 的紧凑文本只有 4,549 字符，不触发 pruner；但中文/紧凑文本的 token 密度更高，DeepSeek tokenizer 下反而比被裁剪的 baseline 多 344 tokens。

因此：

- 以“省 token”为目标的 T1/T2 在**默认 host 行为下不成立**；原始文本的 80% 压缩被 pruner 的字符上限抵消。
- candidate 确实保留了完整 39 行合并字幕；baseline 只保留 head/tail，信息大量丢失。T1/T2 是**信息密度/保留度**的收益，不是默认 host 下的 token 收益。
- `dsh-context` 的 1.1k/1.3k 接近 `chars/4`，会给出“candidate 省 12%”的错误方向；真实 tokenizer 显示 candidate 多 20%。

## 限制

- 单个 E2 用例；不同长度/内容比例可能不同。
- DeepSeek-V3 tokenizer 与 `deepseek-flash` 的 provider tokenizer 可能有小差异；方向性结论由中文密度解释，预计稳定。
- 未计入 system prompt/tool schema（两臂相同），也未使用 provider 账单 usage。

## 决策建议

- **不把 T1/T2 作为 token 优化合并**；如果保留，应定位为“在 pruner 上限内保留更多字幕”的信息密度选项。
- 若要获得原始 80% 压缩收益，需要评估提高/关闭 tool-result pruner 的全局影响，而不是只改 T1/T2。
- 下一步应至少再取 2 个不同长度用例，确认 pruner 触发边界两侧的结论。
