# V3 内容执行器与 Pages 打包

`publish.ts` 把后台已经创建的候选快照生成真实 Nuxt 静态文件，逐个上传到私有 R2 并请求服务器校验。它只把候选推进到 `ready`，不调用激活接口。管理员在后台打开受认证的预览，确认后才切换公开版本。历史候选通过同一个带 `expectedReleaseId` 的激活接口回滚。

**内容 release ID 与 Pages code deployment ID 是不同对象。** 内容发布不会声称创建了 Pages deployment。API 运行时的 `codeSha`、后台创建任务时记录的 `codeSha` 和执行器完整工作副本的 `git HEAD` 必须相同。工作副本必须干净；37 文件审查集合不满足发布前提。Pages 网关和管理端升级由独立代码部署完成。

## 启动本地 V3

使用 Node 22.19 以上的 22 LTS 或 Node 24，先运行 `npm ci`，再在三个终端中分别运行：

```powershell
npm run dev:api
npm run dev:web
npm run dev:admin
```

前台为 `http://127.0.0.1:3000`，后台为 `http://127.0.0.1:5174/admin/`，API 为 `http://127.0.0.1:8787/api/v1/health`。前后台开发服务器把 `/api` 代理到本地 API；请统一使用 `127.0.0.1`。`npm run dev` 默认启动 V3 前台；旧版只通过 `npm run dev:legacy` 启动。API 只监听回环地址，本地 Cookie 使用独立名称，生产 Cookie 配置保持 Secure。

业务数据存入忽略的 `.local-data/dev-api.sqlite`；真实 Miniflare/workerd R2 存入 `.local-data/r2/`；限流摘要盐首次随机创建并保存为 `.local-data/privacy-salt`。Ctrl+C 等待请求结束后关闭 SQLite 和 workerd，重启继续读取原数据。此入口不自动写入内容、创建用户、派发远程任务或提供测试密码。没有发布的本地 API 仍返回真实的未发布状态；前台构建默认空内容，需要已授权的真实公开快照时使用 `XVYIN_SNAPSHOT_PATH`。

登录使用真实 Firebase 账号密码认证和管理员 UID 白名单。只有现有项目已启用 Email/Password、管理员账号已创建，且完整凭据填写后才可登录。把 `scripts/v3/local-config.example.json` 复制到忽略的 `.local-data/dev-api.config.json`，在该私有副本中填写同一项目的 Firebase 配置和具有账号查询权限的服务账号。示例中的占位值不能登录。未配置或配置不完整时 API 健康检查正常，登录返回 `AUTH_NOT_CONFIGURED`，后台读写保持拒绝。结构损坏的 JSON 会使启动失败并只记录错误分类。密码不要写入配置文件。

该配置会向所填的真实 Firebase 项目发出认证请求；业务内容和 R2 文件仍留在本地。Windows 中将 `.local-data` 权限限制为本人账户，Unix 使用 `chmod 700 .local-data` 和 `chmod 600 .local-data/dev-api.config.json`。重置邮件链接仍使用配置的 HTTPS 测试域地址。不要提交或上传 `.local-data`。本地启动测试为 `npx vitest run scripts/v3/test/local-runtime.test.ts`。

## 本地执行内容发布

使用完整仓库、已安装锁定依赖的 Node 环境，在私有文件中保存当前管理员的两个短期会话字段：`cookie` 和 `csrfToken`。Cookie 值必须是实际登录产生的 `__Host-xvyin_session=…`，不能放密码、Firebase ID token 或服务账号密钥。会话文件放在忽略的 `.private-build/` 中；Linux/macOS 必须 `chmod 600`，Windows 使用仅账户可读的目录权限。会话失效后重新登录并更新此文件。

```powershell
node --import tsx scripts/v3/publish.ts --job <后台任务UUID> --origin https://test.xvyin.com --auth-file <私有会话JSON路径>
```

执行器只接受 `https://test.xvyin.com` 和 `https://xvyin.com` 根地址；当前部署授权指向测试子域，命令示例因此使用测试子域。它通过本站内部接口发送 Cookie、CSRF、Origin 和持久化运行编号。它不会请求 Google、创建管理员或修改 Git。

续跑使用原命令：`.private-build/<job>/runner.json` 保存候选、网站、代码和运行编号；`public/` 保存已验证的不可变输出。服务器用自己的上传记录和 R2 校验拒绝内容改变。同一发布任务不能换另一个执行器运行编号接管。网络不确定结果保留 `building`；明确的 Nuxt 失败、内容校验失败或完整性错误才调用严格白名单 `/fail`。失败文案由服务端映射，不上传任意日志。

领取后，如果 `snapshotPrepared` 为 false，执行器先重复 `/prepare`，观察 `preparedAssetCount` 至候选准备完成，再读取最终快照和摘要。登记 manifest 返回 `pending` 时，重复发送同一份清单并观察 `processed` 进展；完成后才上传文件。这两个阶段分别最多 1,000 次、10 分钟，连续三次无进展就保留可续跑状态退出。每次 `finish` 的工作量由服务器控制；执行器观察 `verifiedFileCount` 和 `verifiedIndexCount` 进展，最多调用 1,000 次，连续三次无进展就退出。没有写死 Free 套餐内部批次大小。

Nuxt 子进程只收到运行所需的基础环境变量和快照位置，不继承 GitHub/Google/Cloudflare 凭据或 `NODE_OPTIONS`。完整构建 stdout/stderr 仅在 `.private-build/<job>/build.log` 中，公开控制台只输出阶段和文件计数。不要上传 `.private-build/`、`apps/web/.data/`、`.nuxt/`、`.output/` 到公开 CI artifact、cache 或 Pages。

同一个完整工作副本一次运行一个 Nuxt generate（包含集成测试）；两个构建会共用 Nuxt 的 `.data/` 和 `.output/`。并行本地构建应使用独立工作副本。GitHub Actions 的每个工作流运行具有独立检出目录。

## 首次云端部署的受控执行方式

`GITHUB_TOKEN` 是可选的自动派发 Secret，不是管理员登录、媒体上传或本地执行器的必需配置。没有该 Secret 时，Worker 不注入 `dispatchBuild` / `dispatchMedia`：后台可以创建候选、完成上传并返回实际任务状态，随后由管理员运行受控执行器。排队或 `processing` 不代表已有自动任务在运行。首次测试部署使用以下两个命令，凭据文件只包含真实管理员 Cookie 与 CSRF token：

```powershell
node --import tsx scripts/v3/media-runner.ts --asset <媒体ID> --origin https://test.xvyin.com --auth-file <私有会话JSON路径>
node --import tsx scripts/v3/publish.ts --job <后台任务UUID> --origin https://test.xvyin.com --auth-file <私有会话JSON路径>
```

先把所需媒体处理至后端确认的可用状态，再准备内容候选。执行内容命令只推进到可预览状态；实际发布仍由已登录管理员在后台激活。操作必须使用当前批准版本的完整独立工作副本和真实授权会话，不能以测试 Cookie、占位 token 或 fixture 代替。完整操作、续跑与私有文件要求见本文件前文及 [媒体执行器说明](MEDIA-PROCESSING.md)。这是一条需要管理员启动的运维通道，尚不等于后台自动化已接通或首次远端运行已完成。

自动化后续需配置仅限目标仓库、满足 Actions 派发所需权限的专用凭据，再通过 Cloudflare Secret 设置可选的 `GITHUB_TOKEN`。不要把本机 `gh` 登录的广范围 OAuth 凭据复制到 Worker。工作流还需完成默认分支登记及实际派发、OIDC 回调验收；用户未批准扩大权限时不以复用广权限凭据绕过这个配置缺口。

## GitHub Actions

`.github/workflows/v3-content.yml` 使用 `workflow_dispatch`，要求输入任务 UUID、批准的网站地址与精确的代码 SHA。工作流所在提交 `GITHUB_SHA` 必须等于输入 SHA，检出也是该 SHA。OIDC 的 audience 是 `${origin}/v3-runner`；API 还验证仓库、分支、工作流路径、事件和 SHA。凭证只在请求时获得并定期刷新，不写入文件。

GitHub 执行器的逻辑站点为 `https://test.xvyin.com` 时，内部请求固定经同一 Pages 项目的 `https://xvyin-v3-test.pages.dev/api/v1/internal/` 传输。此入口解决测试域浏览器验证对非浏览器执行器的拦截；没有关闭主域安全功能或更改套餐。`Origin` 请求头、OIDC audience、代码/任务校验、快照链接和生成站点仍使用 `https://test.xvyin.com`。后端仍验证每个内部请求的 OIDC，不因来自 Pages 地址就放行。公开接口、管理员 Cookie、本地执行模式及 `https://xvyin.com` 的执行器均不切换地址。

传输地址是代码内固定映射，没有环境变量、CLI 参数或服务端响应可替换主机。只允许规范的 `/api/v1/internal/` 路径，拒绝编码路径穿越、反斜杠、片段和任意绝对 URL；静态文件路径参数仍作为原查询字符串传递。所有请求禁止重定向，调用者注入的 Host/认证头会被移除。遇到 `cf-mitigated: challenge` 返回 `CLOUDFLARE_CHALLENGE`，非 JSON 页面返回 `NON_JSON_RESPONSE`，损坏的 JSON 返回 `INVALID_RESPONSE`。错误不包含响应正文、Cookie 或 token，网络/网关类故障保留可续跑状态。

媒体工作流在 `npm ci --ignore-scripts` 后于 `apps/web` 显式执行 `npm exec -- nuxt prepare`，生成 `apps/web/.nuxt/tsconfig.json` 后再运行共享执行器类型检查与媒体测试。不要依赖开发机残留的 `.nuxt` 或恢复含私有内容的 CI cache 来补该文件。

只声明 `contents: read` 与 `id-token: write`。没有上传 artifacts、缓存构建结果、长效云密钥、PR 触发器或自动激活步骤。`npm ci --ignore-scripts` 使用锁文件；该仓库已验证的原生工具来自已安装的包文件，不在工作流任意运行安装脚本。若后续引入必须运行安装脚本的新依赖，应先审查并明确修改工作流。

在后台创建候选并不等于 GitHub 工作流已经收到派发。生产环境需要实际配置后台 dispatcher，或由管理员运行上述本地命令。缺少 dispatcher / OIDC 配置时应如实保留排队或配置错误状态，不能伪造运行编号、构建进度或 ready 状态。

## Pages 输出

```powershell
npm run build --workspace @xvyin/admin
node --import tsx scripts/v3/prepare-gateway.ts
```

`prepare-gateway.ts` 只把 `apps/admin/dist/index.html`、管理端 JS/CSS 和字体复制到 `.gateway-output/admin/`，把 `workers/gateway/worker.js` 复制为 `_worker.js`，并生成全路由经过 Worker 的 `_routes.json`。它拒绝源代码、日志、会话文件、私有快照、符号链接和任何超出白名单的管理端输出。`.gateway-output/` 已加入 Git 忽略规则。该目录不包含 Nuxt 数据或公开内容候选，真正的 HTML/CSS/JS 由网关按当前 R2 release 提供。

## 已实现验证与边界

```powershell
npx vitest run scripts/v3/test/publish.test.ts
npx vitest run scripts/v3/test/publish-integration.test.ts
```

第一组覆盖地址/文件边界、环境去密、Cookie/CSRF、OIDC 刷新、可重放请求重试、输出脱敏、不可变续跑、响应丢失后的状态确认、失败分类与 Pages 打包白名单。

第二组是明确标记的**本地 fixture**：管理员身份注入；业务数据库是真实磁盘 SQLite；R2 和 HTMLRewriter 使用本地 Miniflare/workerd；调用实际 Hono 接口和实际 Nuxt 生成两套静态文件，再验证私密预览、匿名拒绝、激活、隐藏、回滚以及构建失败保留旧版。结果和构建日志留在忽略的 `.private-build/release-integration-*/`。它没有向 Firebase、Cloudflare、GitHub 或测试域写入数据，也不等同于线上部署、真实账号验收、大陆访问性能或 Free 套餐 CPU 实测。

## 官方依据（2026-09-12 复核）

- [GitHub OIDC token claims](https://docs.github.com/en/actions/reference/security/oidc)：普通工作流使用 `workflow_ref` 与 `workflow_sha`；`job_workflow_ref` 是可复用工作流的附加 claim。
- [GitHub immutable action reference guidance](https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions)：第三方 action 固定完整提交 SHA。
- [actions/checkout v7.0.1](https://github.com/actions/checkout/releases/tag/v7.0.1)：已固定 `3d3c42e5aac5ba805825da76410c181273ba90b1`。
- [actions/setup-node v7.0.0](https://github.com/actions/setup-node/releases/tag/v7.0.0)：已固定 `820762786026740c76f36085b0efc47a31fe5020`，禁用包管理器缓存。
- [Node.js v22.23.2](https://nodejs.org/en/blog/release/v22.23.2)：工作流使用此精确 Node 22 LTS 补丁版本。
- [Cloudflare Pages advanced mode](https://developers.cloudflare.com/pages/functions/advanced-mode/)：部署 `_worker.js` 网关并显式代理静态管理端资源。
- [Cloudflare R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/) 与 [Workers R2 API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)：不可变候选与带条件的活动版本指针分离。
