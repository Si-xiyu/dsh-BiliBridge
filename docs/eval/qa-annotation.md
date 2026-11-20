# M3/M4 问答评测：标注与评测流程

标注由用户完成；本文档给出流程、数据格式和发给 Agent 的提示词。

## 1. 流程

1. **选视频**：按 `plan-accuracy-token.md` M2 的类别选 30 个左右，记入 `tests/fixtures/eval/videos.json`。
2. **出题**（二选一或混用）：
   - 自己观看视频后设计问题；
   - 用 LLM 根据完整视频内容（字幕全文 + 关键画面）生成候选问题，**由你审核**后入库。提示词见第 3.1 节。
3. **标注标准答案**：你确认每道题的正确答案，并记录答案对应的视频时间段和证据类型。
4. **评测回答**：Agent 分别使用 baseline 与 candidate 版本的 BiliBridge 回答同一批问题（每题一个新会话），提示词见第 3.2 节。
5. **判分**：按第 4 节规则将回答与标准答案比较；可先用 LLM 预判分，你对有争议的题目复核。

## 2. 数据格式

`tests/fixtures/eval/qa.json`：

```json
[
  {
    "id": "q001",
    "bvid": "BV1KDNA6eEgr",
    "page": 1,
    "category": "讲解",
    "question": "作者在演示中使用的第二个命令是什么？",
    "type": "visual-text",
    "answer": "git rebase -i HEAD~3",
    "acceptable": ["rebase -i HEAD~3"],
    "evidence": [{ "startMs": 125000, "endMs": 131000, "source": "frame" }],
    "difficulty": "hard",
    "source": "human",
    "reviewedBy": "user",
    "notes": ""
  }
]
```

| 字段 | 取值 |
|---|---|
| `type` | `speech`（只在台词里）、`visual-text`（屏幕文字/代码/PPT）、`visual-scene`（画面内容）、`danmaku`（观众反应）、`comment`、`temporal`（顺序/时间点）、`global`（整体概括） |
| `evidence.source` | `subtitle`、`audio`、`frame`、`danmaku`、`comment`、`metadata` |
| `source` | `human` 或 `llm-reviewed` |
| `difficulty` | `easy` / `medium` / `hard` |

建议题型配比：speech 30%、visual-text 25%、visual-scene 15%、temporal 15%、global 10%、danmaku/comment 5%。每题答案应可客观判定（短答案或选项），避免开放式评价。

## 3. 提示词

### 3.1 候选题生成（LLM 出题，你审核）

```text
下面是一个 B 站视频的完整字幕（带时间戳）和若干关键画面描述。请生成 8 道问答题，用于评测"视频理解工具"的效果。

要求：
1. 答案必须能从视频中客观确定，给出简短标准答案。
2. 题型覆盖：只在台词里出现的信息、只在屏幕文字里出现的信息、画面内容、事件先后顺序、整体概括。
3. 每题给出证据时间段（startMs、endMs）和证据来源（subtitle/audio/frame/danmaku/comment/metadata）。
4. 不要出仅凭标题或简介就能回答的题。
5. 输出 JSON 数组，字段与以下示例一致：<粘贴第 2 节示例>
```

### 3.2 评测回答（每题一个新 DSH 会话）

```text
请使用 bilibili 工具回答下面关于视频 {bvid}（第 {page} P）的问题。

问题：{question}

要求：
1. 可以按需调用 bilibili_extract、bilibili_inspect、bilibili_transcribe，自行决定调用顺序与参数。
2. 最后一行输出 "ANSWER: <你的简短答案>"；无法确定时输出 "ANSWER: UNKNOWN"。
3. 再输出一行 "EVIDENCE: <你依据的时间点或来源>"。
```

每题记录：答案、证据、工具调用次数、会话总 token、耗时。

### 3.3 预判分（可选）

```text
判断"模型回答"是否与"标准答案"一致。标准答案：{answer}；可接受变体：{acceptable}；模型回答：{model_answer}。
只输出 CORRECT、PARTIAL 或 WRONG，以及一句理由。UNKNOWN 记为 WRONG。
```

## 4. 判分与统计

- 计分：CORRECT=1，PARTIAL=0.5，WRONG/UNKNOWN=0。
- 主指标：总体准确率；按 `type` 与类别分组的准确率；平均每题 token；平均工具调用次数。
- 对比方式：baseline 与 candidate 逐题配对；报告准确率差、token 差，以及"baseline 对、candidate 错"的题目清单，逐题复查原因。
- 样本量提示：100 题时，准确率差小于约 5 个百分点不宜下结论；需要更强结论时扩大题量或重复运行。
