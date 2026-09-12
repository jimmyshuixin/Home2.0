# xvyin V3：从这里继续

> 2026-09-12 后续视觉修订在完整独立工作副本 `home2-v3-freepaper`、分支 `codex/ui-freepaper` 中进行，包含下述最新文案、枝叶与播放要求；该视觉分支尚未部署。下文首轮实施与云端状态属于历史记录，当前部署应另读实际交付记录并重新核验。

更新于 2026-09-12，Asia/Shanghai。本分支交付目标是可维护的前后端分离项目。当前代码已经包含真实持久化、账号密码适配、媒体处理和内容发布链路；本地验证不能代替远端部署与生产验收。**本次指定发布地址为 `https://test.xvyin.com`，当前尚无成功部署证据。** 先读 [部署依赖与尚未完成的验收](DEPLOYMENT-READINESS.md)，再执行其中已具备前提的步骤。

## 工作副本与需求优先级

正式实施目录为：

```text
C:/Users/lucky/Documents/ChatGPT/web/implementation-2026-09-12/home2-v3
```

这是 `jimmyshuixin/Home2.0` 的完整独立工作副本，实施分支为 `codex/v3-production`。初始检出基线为 `685e73c653e6f6cc08bd4b7e30308bcb376421ab`，不能当作包含后续 V3 改动的部署版本。用 `git rev-parse HEAD` 和 `git status --short` 核对当前工作版本及未提交内容；发布执行器要求实际代码提交、后台 `BUILD_CODE_SHA` 和任务记录一致，发布执行副本保持干净。

原设计基线位于 `C:/Users/lucky/Documents/ChatGPT/web/design-v3-2026-09-11/`。其 `START-HERE.md`、`TECHNICAL-HANDOFF.md`、`UX-ACCEPTANCE.md`、蓝图及六张 V3 图稿仍适用于视觉与交互。用户后来确认的以下约束优先于旧文档：

- 当前工作包含生产前后端实施与测试子域部署；原 V1/V2 图和 README 后半段仍是历史资料。
- 首页原文按用户最新要求改为 `Hello! I am 虚宁`；沿用原头像、纸白/墨色/深绿/朱砂，“虚宁”使用更大的原书法字体。此前旧英文要求已被替代。
- 首页介绍之后立即放音乐播放器与审核后公开的留言弹幕，然后是创作；手机依次排列。访客点击后才播放，站内媒体共享唯一发声协调器。
- 首次优先选择QQ歌单；支持顺序播放、随机播放、单曲循环，歌曲自然结束后自动续播。用户暂停或其他媒体接管后停止续播，切换模式本身不开始播放。
- 自由纸页图稿中的淡墨枝叶和“一些想法，慢慢写下来。”已经确认需要落地；插画须融入页面纸色，不能带白底矩形。
- 创作使用 `/creations` 与 `/creations/:slug`，统一编辑文字、图片、音频、视频及其它已定义内容块。摄影独立保留，健身由后台管理并复用媒体库。
- 健身真实开始日期尚未提供，保持 `startDate:null`。按 Asia/Shanghai 日历天数计算，开始当天为第 1 天；原照片只做格式、方向和等比尺寸处理。
- 只有预设管理员使用普通账号密码，访客不注册。微信登录延期。
- 单个视频上传及播放成品上限为 **512,000,000 字节**，媒体总额为 **10,000,000,000 字节**。MB/GB 采用十进制；代码中 MiB 分片单独标注。
- **坚持 Workers Free，不升级 Paid。** 批量工作拆分为独立可续跑请求，解码、转码和静态生成在 Node/CI 执行。外层旧架构文档中“可考虑 Paid”的文字已被此决定替代。
- 先优化既有境外架构的大陆访问，优先不新增备案；不承诺未知网络条件下的访问性能，不编造访问量、研究成果或内容日期。

`audit-2026-09-11/home2-source` 只有 37 个审查文件，不能作为开发、构建或发布执行器目录。不得拿本目录的旧基线哈希替代下一次远端版本复核。

## 前后端目录与发布关系

| 目录 | 职责与实际产物 |
| --- | --- |
| `apps/web` | Nuxt 4 公共页面。由选定的公开快照生成完整 HTML、hydration 数据及静态资源；无 JavaScript 时仍有正文。 |
| `apps/admin` | 独立 Vue 管理端，包含创作、摄影、健身、歌单、评论审核、媒体、统计、设置及账号管理。通过同域 `/api/v1` 调用后端。 |
| `packages/contracts` | 前后端共享的严格数据结构、混合内容块、媒体大小、URL 与上海日期规则。 |
| `workers/api` | 独立业务 Worker：认证、会话、CSRF、Firestore 适配、上传、审核、公开投影、内容发布与受控媒体读取。 |
| `workers/gateway` | Pages 高级模式网关。服务管理端静态文件，其余请求经 `API` 服务绑定转入业务 Worker。 |
| `scripts/v3` | 可信 Node/CI 内容生成、媒体处理、Pages 打包与只读旧内容迁移工具。 |
| `.github/workflows/v3-content.yml`、`v3-media.yml` | 手动派发的可信执行器入口；使用 GitHub OIDC，与仓库、分支、工作流、运行和实际代码 SHA 绑定。 |
| `.private-build` | Git 忽略的候选快照、运行状态、日志及迁移清单；不能提交、公开缓存或上传为公开构建 artifact。 |

请求走同一个域名便于 Cookie/CSRF 管理，前端构建与后端代码仍分别部署。内容发布采用“固定草稿修订 → 私有快照 → 真实 Nuxt 生成 → R2 不可变文件与清单 → 私密预览 → 条件切换 `active-release.json`”。生成执行器只推进到 `ready`，管理员激活后才成为公开内容。**内容 release ID 与 Pages/Worker 代码部署 ID 分开记录。** 回滚切换公开版本，不覆盖较新的草稿、会话和评论。

## 在正确目录运行

以下命令均在完整工作副本根目录执行，不会部署云资源：

```powershell
Set-Location -LiteralPath 'C:/Users/lucky/Documents/ChatGPT/web/implementation-2026-09-12/home2-v3'
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm run typecheck --workspace @xvyin/admin
npm run typecheck --workspace @xvyin/web
npm test
```

锁定的工作流使用 Node 22.23.2。媒体处理还需要系统 FFmpeg/ffprobe；Windows 当前已检查的版本为 8.1.2。依赖安装通过不等于原生工具可运行，应以实际构建和处理测试为准。

在三个独立终端分别启动本地 API、网页和管理端：

```powershell
npm run dev:api
npm run dev:web
npm run dev:admin
```

本地 API 为 `http://127.0.0.1:8787`，网页为 `http://127.0.0.1:3000`，管理端为 `http://127.0.0.1:5174/admin/`；前后台均把 `/api` 代理到本地 API。业务数据使用 `.local-data/dev-api.sqlite` 和本地 workerd R2 持久化，重启保留数据。入口不会写入示例内容或创建测试密码，未配置真实 Firebase 管理员时登录明确拒绝。按 [本地开发入口说明](../../scripts/v3/README.md) 在忽略的 `.local-data/dev-api.config.json` 中填写私有认证配置；该认证会联系真实 Firebase，业务数据仍留在本地。根 `dev` 与 `preview` 已指向 V3 网页；旧版使用 `dev:legacy` 与 `preview:legacy`。

生成前端、准备测试域的 Pages 静态产物：

```powershell
npm run build
node --import tsx scripts/v3/prepare-gateway.ts
```

`.gateway-output` 仅含管理端静态文件和网关。不要直接把 `apps/web/.output/public`、`.data` 或私有候选上传到 Pages；公开内容须经过受控 release 流程。单独构建一个空快照只说明布局可生成，不等于已迁入真实网站内容。

已创建真实后台任务后，可信本地执行器使用短期管理员会话文件运行：

```powershell
node --import tsx scripts/v3/publish.ts --job <真实候选UUID> --origin https://test.xvyin.com --auth-file <私有会话JSON路径>
node --import tsx scripts/v3/media-runner.ts --asset <真实媒体ID> --origin https://test.xvyin.com --auth-file <私有会话JSON路径>
```

占位参数必须替换为真实后台结果。会话文件仅包含实际登录得到的短期 `cookie` 和 `csrfToken`；不传聊天密码，不使用测试身份。执行器参数、断点续跑与私有日志规则详见 [执行器说明](../../scripts/v3/README.md) 和 [媒体处理说明](../../scripts/v3/MEDIA-PROCESSING.md)。同一工作副本不要并发运行多个 Nuxt generate。

## 真实旧内容与可审阅证据

[迁移说明](MIGRATION.md) 和 `scripts/v3/migrate-legacy.ts` 只读这份完整仓库的原文、原图路径和元数据，输出被 Git 忽略的私有清单。清单保留已检入 QQ 歌单配置、原介绍、本地歌单和可可靠转换的文章/摄影候选；没有媒体映射的候选保持阻塞。必须先经正常媒体流程取得真实 `assetId`，再生成、保存、预览、发布草稿。清单中的技术 ID、文件哈希或 `ready-draft` 状态均不能证明远端媒体已存在或已公开。

没有来源的照片日期、真实健身开始日仍保持空值。研究/履历和不支持的旧嵌入内容保留在未转换清单中，不能通过自动填日期、资产占位符或虚构内容凑齐页面。

本地发布链路记录在 [执行器本地 QA](../../scripts/v3/QA-2026-09-12.md)。其中 SQLite、Miniflare R2、真实 Nuxt 生成与浏览器 fixture 用来验证软件行为；认证身份和内容有明确测试标记。本轮已取得全套测试、本地运行时独立测试、根/公共端类型检查、管理端构建、网关打包和 Worker dry-run 的成功结果；仍应使用对应提交的实际命令输出确认核验范围，不把历史计数相加。远端环境验收及恢复演练的具体缺口见 [部署状态](DEPLOYMENT-READINESS.md)。
