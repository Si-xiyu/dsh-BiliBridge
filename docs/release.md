# 维护者发布清单（npm）

面向维护者，不是用户安装文档。用户安装见 INSTALL.md。

## 前置

- npm 账号对 `dsh-bilibili-bridge` 有发布权限（首次发布需在 npm 上确认包名可用）。
- 仓库 Settings → Secrets and variables → Actions 添加 `NPM_TOKEN`。
  npm 已退役 classic Automation token；请使用 **Granular Access Token**：
  npm → Access Tokens → Generate New Token → Granular，权限选 Read and write，
  勾选允许绕过 2FA（CI 用），包范围首次发布时选 All packages，发布成功后收窄到
  `dsh-bilibili-bridge`。也可以改用本机 `npm login` 交互发布（支持 2FA）。
- `package.json` 的 `private` 为 `false`，`publishConfig.access` 为 `public`。

## 发布 0.1.2（当前版本）

发布前必须确认：HEAD 就是 `v0.1.2` 指向的提交。工作流会校验
`git tag --points-at HEAD`，不匹配直接失败；本机发布时请先 `git checkout v0.1.2`。


二选一：

1. GitHub Actions（推荐，不需要本机 npm 登录）
   - Actions 网页的 Run workflow 只能选分支；要针对 tag 运行，用 GitHub CLI：
     `gh workflow run publish-npm.yml --ref v0.1.2`。
   - 工作流会跑 `npm ci`、全量单测、tag/版本校验，再 `npm publish --access public`。
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
- README Quickstart 的 `dsh plugin ... add <tarball>` 与按包名安装至少各验证一次。

## 版本与 tag 对齐

- npm 版本号必须与 `vX.Y.Z` tag 一致。
- 发新版本时：改 `package.json` 与 `package-lock.json` → 更新 CHANGELOG → 提交 →
  打 annotated tag 并推送（触发 release 构建 tarball）→ 再跑 publish-npm。
- release tarball 与 npm tarball 内容可能略有差异（workflow/docs 不在 npm 包内），
  但运行时文件必须一致；发布前可在本机 `npm pack --dry-run` 核对 `files`。

## 回滚

- npm 允许 72 小时内 `npm unpublish dsh-bilibili-bridge@X.Y.Z`；之后只能发新版本。
- 撤回前先在 GitHub Release 说明原因，避免用户继续安装坏版本。
