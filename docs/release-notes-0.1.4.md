# 0.1.4 稳定版（2026-11-20）

## 安全修复

`/bilibili-bridge/api/*` 的 HTTP 路由此前只做本地同源校验，没有走 DSH connection 的 Host/Origin + 浏览器认证检查；任意网页都能请求这些本机接口。

修复：

- `registerSettingsRoutes` 的注入增加 `connection`；
- 所有 11 个路由在 handler 最开头调用 `ctx.connection.requestRejection(req)`；
- `401`/`403` 直接返回 JSON，不进入任何业务逻辑；
- 原有 `trustedRequest`/`explainTrust` 同源校验保留，两层叠加；
- 缺失 `connection` 时失败关闭，不静默放行。

## 验证

- `tests/unit/settings-api.test.mjs`：新增 401/403 拦截与放行测试；
- `npm test` / `npm run test:single`：**361 个测试，360 通过、1 跳过**。

## 说明

- 本次只改 HTTP 路由访问控制，不改工具行为。
- 0.1.3 的 ASR 安全/缓存修复与评测资产保持不变。
