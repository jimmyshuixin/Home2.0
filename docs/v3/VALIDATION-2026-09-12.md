# V3 本地验证与部署重试记录

日期：2026-09-12（Asia/Shanghai）。这些结果属于当前独立工作副本，不能当作 `test.xvyin.com` 已部署或 Cloudflare 生产验收。

## 此次执行结果

| 检查 | 结果 |
| --- | --- |
| `npm test` | 19 个测试文件、261 项通过；完整运行耗时 108.82 秒。未把其他独立复跑计数加到这一结果。 |
| `npm run typecheck` | 通过，包含 Worker、共享契约、Node 执行器及新增本地入口。 |
| `npm run typecheck --workspace @xvyin/web` | 通过。 |
| `npm run build --workspace @xvyin/admin` | 通过；最终网关打包仅含 5 个管理员静态文件、网关与路由配置，无私有快照。 |
| Worker `wrangler deploy --dry-run` | 通过；打包 1063.68 KiB，gzip 188.16 KiB。只打包，没有部署。 |
| 本地入口独立回归 | 1 项通过；实际 HTTP、缺配置登录关闭、不可信 Origin 拒绝、SQLite/R2 关闭重开持久化、摘要盐保持。 |

真实发布集成证据保存在 Git 忽略的 `.private-build/release-integration-KfTJ8I/result.json`：101 个明确标注的测试资产跨候选准备/清单分批边界；真实 Nuxt 分别生成 45 和 43 个文件；通过私密 HTML/JS 预览、匿名拒绝、激活、隐藏 404、回滚、固定失败分类、错误执行器拒绝，以及 SQLite 多 handle 持久化。此测试的远端账户请求数为 0。该目录及当前测试生成的 `.output` 不可直接当正式发布内容上传。

更早的响应式图片证据在工作副本外 `../qa-public-web/` 与 `../admin-ui-qa/`。公开页面检查为真实空数据状态，管理端含醒目标注的本地 fixture；均不表示云功能已配置。

## 本轮 Cloudflare 重试

- 用户已授权 `test.xvyin.com` 的 Wrangler 账户读取、Workers/Pages 部署与域名读取；坚持 Workers Free，不购买 Paid。
- `wrangler whoami` 实际返回未认证。新 OAuth 请求已生成，但没有完成授权或写入凭据的成功结果。
- 浏览器控制在本轮恢复；`dash.cloudflare.com/oauth2/auth` 的实际错误为 `ERR_CONNECTION_CLOSED`，刷新后仍失败。
- 系统 curl 对 Cloudflare 后台和 API 都在 TLS 握手失败；Node fetch 对两者均返回 `ECONNRESET`。
- 只读检查显示系统代理关闭；原配置的本地代理端口没有连接成功。未修改系统代理、TLS 校验或网络安全设置。
- 未创建远端 R2/Worker/Pages，未绑定 DNS，未推送 GitHub，未取得任何成功的云部署 ID。

网络恢复后须重新验证授权及账户当前状态。Firebase 项目选择、管理员用户名/恢复邮箱和真实凭据仍需补齐；这些不能由模拟身份替代。其余真实运行验收缺口见 [DEPLOYMENT-READINESS.md](DEPLOYMENT-READINESS.md)。
