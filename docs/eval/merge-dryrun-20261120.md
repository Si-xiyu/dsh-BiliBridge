# 2026-11-20 合并预演（未提交合并）

## 范围

- 稳定基线：`fix/tool-acceptance` `23c609f`
- 研究分支：`research/accuracy-token-plan` `8a6d8e5`
- 在临时 worktree 执行 `git merge --no-commit --no-ff`；**没有提交合并，也没有改动 fix 分支**。

## 结果

- `lib/media/evidence.mjs` 自动合并；其余文件无冲突。`git merge` 输出：Automatic merge went well。
- 合并后单元测试（日志 `/tmp/merge-test-final.log`、`/tmp/merge-single-final.log`）：
  - `npm test`：**377 个测试，376 通过、1 跳过**
  - `npm run test:single`：**377 个测试，376 通过、1 跳过**
- 27 个工具注册正常。
- 真实只读 smoke（`tests/manual-tool-acceptance.mjs --media`，日志 `/tmp/merge-smoke.log`）：27 个注册；**11 个唯一工具通过**；`bilibili_user_profile`、`bilibili_notifications`、`bilibili_messages` TIMEOUT；`collect` partial；extract/inspect/transcribe 未运行；脚本 exit 1。
- 60s 单工具重跑（日志 `/tmp/merge-recheck-final.log`）：`user_profile` 7.4s 通过；`notifications` 未在 60s 内干净中止，约 16.9 分钟后才返回 timeout；隔离数据目录随后进入 `TRAFFIC_MANUAL_REQUIRED`，`messages` 无法继续。**原始超时原因未查明，不能称为“瞬时网络问题已恢复”。**
- 媒体项未在合并树复跑。

## 结论

- 两个分支可以自动合并，合并后的单测全绿；目前没有发现需要手工解决的代码冲突。
- **不能因此直接合并**：M1 宿主真实 token 仍未测；27 工具 smoke 未通过（3 个 TIMEOUT + collect partial + 媒体未跑）；写操作/审批未在合并树复验；A1/A3 默认关闭、A5 阈值未校准。
- 合并范围也不应是整条 research：计划建议只合并已验证的 T1/T2/V1/P1/P2 等安全项；A1/A3/A5 默认关闭，弹幕优化未验证。
- 建议：先在宿主切到合并后的 worktree，修复/定位 notifications 超时，跑 M1 + 27 工具回归（含写操作测试），再决定是否提交合并。

## 复现

```bash
git worktree add --detach /tmp/bili-merge-dry fix/tool-acceptance
cd /tmp/bili-merge-dry
git merge --no-commit --no-ff research/accuracy-token-plan
npm test
npm run test:single
```
