# 维护者发布清单（npm）

面向维护者，不是用户安装文档。用户安装见 INSTALL.md。

## 前置

- npm 账号对 `dsh-bilibili-bridge` 有发布权限。
- 仓库 Settings → Secrets and variables → Actions 添加 `NPM_TOKEN`。
  npm 已弃用 classic token，请使用 **Granular Access Token**：Access Tokens → Generate New Token → Granular，
  权限 Read and write，勾选 **Bypass two-factor authentication**（CI 必需），
  首次发布包范围选 All packages，之后收窄到 `dsh-bilibili-bridge`。
  也可以用本机 `npm login` 交互发布（支持 2FA）。
  注意：bypass 2FA 只免除验证码，**不代表立即上线**；新包或暂存模式下仍需批准。
- `package.json` 的 `private` 为 `false`，`publishConfig.access` 为 `public`。

## 当前状态

- `0.1.2` 已于 2026-11-18 发布并成为 `latest`。
- 首次发布走了 **staged publishing**：npm 先创建 `0.0.0-stage` 占位版本，真实的
  0.1.2 进入 Staged Packages 队列，维护者用 2FA 批准后才上线。占位版本保留是正常的，
  **不要安装或引用 `0.0.0-stage`**。

## 暂存发布与批准

本次 0.1.2 是首次发布，实际观察到 npm 先创建 `0.0.0-stage` 占位并暂存 0.1.2。
**不要假设所有发布都会自动暂存**：后续版本可能直接上线，也可能进入队列。判断方式：
- `npm view dsh-bilibili-bridge version` 能查到目标版本 = 已上线；
- `npm stage list`（npm ≥ 11.15，已登录）能看到 = 在暂存队列待批准；
- 两边都看不到 = 发布可能失败，去查 workflow 日志。

批准方式二选一：

1. 网页：https://www.npmjs.com/package/dsh-bilibili-bridge → **Staged Packages** →
   审核版本 → Approve → 输入 2FA。
2. CLI（npm ≥ 11.15，Node ≥ 22.14）：
   ```bash
   npm install -g npm@latest
   npm login
   npm stage list
   npm stage approve <stage-id>     # 会要求 2FA
   ```

判断是否真的上线：

```bash
npm view dsh-bilibili-bridge version            # 期望与 package.json 一致
npm view dsh-bilibili-bridge dist.tarball
```

如果 `npm view` 仍是 `0.0.0-stage` 或 404，先不要断定失败：可能是暂存待批准，
也可能是真的没上传。用 `npm stage list` 区分；队列为空时检查 workflow 日志与 token 权限。

## 发布 0.1.2（当前版本）

发布前必须确认：HEAD 就是 `v0.1.2` 指向的提交。工作流会校验
`git tag --points-at HEAD`，不匹配直接失败；本机发布时请先 `git checkout v0.1.2`。

二选一：

1. GitHub Actions（推荐，不需要本机 npm 登录）
   - Actions 网页的 Run workflow 只能选分支；要针对 tag 运行，用 GitHub CLI：
     `gh workflow run publish-npm.yml --ref v0.1.2`。
   - 工作流会跑 `npm ci`、全量单测、tag/版本校验，再 `npm publish --access public`。
     **注意**：`--ref v0.1.2` 使用的是 tag 当时的 workflow；后来新增的 registry 检查
     只在更新的提交里。要使用最新检查逻辑，需要对包含该步骤的提交打新 tag，
     或发布后手动执行上面的 `npm view` / `npm stage list`。
2. 本机发布
   ```bash
   git checkout v0.1.2
   npm login
   npm publish --access public
   npm view dsh-bilibili-bridge version
   ```

## 发布后验证

- `npm view dsh-bilibili-bridge@0.1.2 dist.tarball` 可访问。
- 插件市场 / `plugin_manager` 按包名 `dsh-bilibili-bridge` 安装可用。
- 全新 profile 安装后 `doctor` 退出 0，重启 DSH 后 27 个工具。
- README Quickstart 的 tarball 安装与按包名安装至少各验证一次。

## 版本与 tag 对齐

- npm 版本号必须与 `vX.Y.Z` tag 一致。
- 发新版本时：改 `package.json` 与 `package-lock.json` → 更新 CHANGELOG → 提交 →
  打 annotated tag 并推送（触发 release 构建 tarball）→ 再跑 publish-npm。
- release tarball 与 npm tarball 内容可能略有差异（workflow/docs 不在 npm 包内），
  但运行时文件必须一致；发布前可在本机 `npm pack --dry-run` 核对 `files`。

## 回滚

- npm 允许 72 小时内 `npm unpublish dsh-bilibili-bridge@X.Y.Z`；之后只能发新版本。
- 撤回前先在 GitHub Release 说明原因，避免用户继续安装坏版本。

## 2027 迁移提示

npm 正在收紧带 2FA bypass 的 granular token 直接 publish 的能力，具体时间表以官方公告为准。
届时需要改用 staged publishing（CI 暂存 + 维护者批准）或 Trusted Publishing（OIDC），
本工作流会随那次迁移调整。
