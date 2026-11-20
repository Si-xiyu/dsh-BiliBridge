> 注：本文记录的 render-bench/渲染代码未进入 0.1.3 stable，只保留在 research 分支；stable 只保留结论。

# 2026-11-19 T1/T2 渲染层 token 代理

## 方法

固定一批返回值（extract：190 条字幕 + 60 条弹幕 + 40 条评论；transcribe：30 段；inspect：9 帧），分别用：

- baseline `9d915bc`：`JSON.stringify(value, null, 2)`
- candidate `e2aec97`：`lib/tools/render.mjs` 的 `renderText`（紧凑 JSON + 时间序列段落）

统计模型可见文本的字符、字节和字符级粗略 token。**这不是 DSH 会话 token**；最终 M1 仍需按 [token-bench-task.md](../token-bench-task.md) 在宿主内复测。

## 结果

| 指标 | baseline | candidate | 比例 |
| --- | ---: | ---: | ---: |
| 字符 | 47,704 | 15,937 | **0.334** |
| 字节 | 62,984 | 31,427 | **0.499** |
| 粗略 token | 15,802 | 10,933 | **0.692** |

字符降幅约 66.6%，但粗略 token 只降约 30.8%——紧凑 JSON 的英文键名/标点仍占 token，行式文本也保留表头。**这不是真实 token 的上下界**，只是字符级启发式估算；真实 token 可能高于或低于 30.8%，必须由 DSH 统计确认。

## 结论与边界

- T1/T2 的渲染压缩明确；结构化返回值不变，UI/脚本不受影响。但模型可见文本**主动省略了 cue 的 id、endMs**（cue 只保留开始时间）以及逐条对象键名；这是 token 压缩的取舍，模型不再逐条看到完整结束时间，需要完整时间请用结构化值/其他工具。
- 代理图是固定合成数据，不代表所有真实工具输出；E1/E2 的真实返回值需要宿主 M1 复测。
- 宿主复测需要在 DSH 中切换 baseline/candidate worktree、重启并读取会话 token，当前会话无法在不重启的情况下完成。
- 下一步：M1 宿主任务（`docs/eval/token-bench-task.md`）由用户在 DSH 内执行；在此之前不把 0.334 当作最终 token 收益。
