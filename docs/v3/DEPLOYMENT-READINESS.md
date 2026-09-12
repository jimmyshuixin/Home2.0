# test.xvyin.com 部署依赖与验收状态

更新于 2026-09-12 15:50，Asia/Shanghai。本文件记录代码审查与部署重试收到的证据，不是上线完成证明。此前网络授权阻塞和 Firebase 项目/管理员身份问题已解除，最新成功配置与真实 Google 验证见 [CLOUD-SETUP-2026-09-12.md](CLOUD-SETUP-2026-09-12.md)。**当前仍没有测试域成功响应、云代码部署 ID、活动内容 release 或真实管理员密码登录的完整远端验收记录，不能标记为生产就绪。** 用户已经要求发布当前版本到 `test.xvyin.com`，并明确使用 Workers Free；测试部署授权继续有效，无需重复询问相同偏好。

## 本次重试已解除的阻塞与当前步骤

用户恢复网络后，Wrangler `4.131.1` OAuth 与 `whoami` 已成功，专用 R2 bucket 和 Pages Direct Upload 项目已创建。用户已确认 `Home / home-60305`、`(default)` Standard/Native、`v3_test_`、管理员用户名及邮箱；实际 UID 已取得，Email/Password 已启用。独立服务账号八项权限角色及绑定已核实，私钥已受控保存；`2026-09-12T07:49:49Z` 的真实管理员查询和 Firestore create/read/update/query/delete 验证通过，临时探测记录已清理。

当前下一步是上传已准备的三个必需 Secret，再部署测试 API Worker 与 Pages 网关，验证测试域 DNS、HTTPS、认证及真实内容链路。`GITHUB_TOKEN` 已成为可选自动派发配置；首次云端内容与媒体任务使用真实管理员受控执行器，自动派发仍待独立接入，不能复制本机 `gh` 的广范围 OAuth 凭据替代专用权限配置。详见 [最新云配置记录](CLOUD-SETUP-2026-09-12.md#首次部署的执行器与可选自动派发)。

历史来源保留：此前重试曾在 `dash.cloudflare.com` 授权页遇到 `ERR_CONNECTION_CLOSED`，本机 curl/Node 直连 dashboard/API 遇到 TLS `ECONNRESET`；当时 `ProxyEnable=0`、`127.0.0.1:10808` 未监听。这些是用户恢复网络前的本机观察，不再是当前阻塞，也没有据此认定 Cloudflare 全网故障。此前 Firebase 项目与管理员信息待答状态同样已被本轮用户确认替代。

## 配置、资源与现有代码之间的缺口

| 项目 | 当前证据 | 满足条件与验收结果 |
| --- | --- | --- |
| 独立代码版本 | 实施分支 `codex/v3-production`；初始检出基线为 `685e73c653e6f6cc08bd4b7e30308bcb376421ab`，当前工作版本以 `git rev-parse HEAD` 与 `git status --short` 实时核对。 | 发布执行器的干净 checkout、Worker `BUILD_CODE_SHA`、候选任务与 GitHub 工作流 SHA 必须一致。旧基线哈希不能充当新代码部署版本，本地提交不等于远端部署。 |
| 测试 Worker | `workers/api/wrangler.jsonc` 声明 `xvyin-v3-test-api`，`workers_dev:false`，`PUBLIC_ORIGIN=https://test.xvyin.com`。 | 在目标账户实际部署，保存真实版本/部署 ID。`/api/v1/health` 只证明处理器存活，不能代替数据库与认证检查。 |
| 私有 R2 | 专用 `xvyin-v3-test-private` 已创建，`apac`、`Standard`。 | 完成 `CONTENT` 实际绑定及 API 上传/受控读取验收；保留私有入口，不以资源创建代替链路验证。 |
| Pages 与子域 | Direct Upload 项目 `xvyin-v3-test` 已创建，生产分支 `codex/v3-production`；尚未页面部署。网关配置声明 `.gateway-output` 与 `API` 服务绑定。 | 构建管理端并运行 `prepare-gateway.ts`，部署网关，绑定并核验 `test.xvyin.com` 的 DNS、HTTPS 和服务绑定。不能以项目已创建替代实际响应。 |
| Firestore | 已配置 `home-60305`、`(default)`、`standard`；实际服务账号的数据创建、读取、更新、查询及删除验证通过。 | 上传 Secret 后验证 Worker 运行中的真实访问。当前实现固定使用 `v3_test_` collection prefix；不可复用/覆盖旧 `guestbook` 或 `blog_comments`，也不能声称 IAM 已按集合前缀隔离。 |
| 管理员认证 | 用户名/邮箱已确认、实际 UID 已取得、Email/Password 已启用、管理员权威查询已通过；私有 Auth Secret 文件已准备。 | 上传 Secret 后完成实际密码登录/登出/重置/会话撤销验收；自定义密码恢复 action URL 仍需按整个项目邮件模板范围处理。 |
| 后端 Secrets | `GOOGLE_SERVICE_ACCOUNT`、`FIREBASE_AUTH_CONFIG`、`PRIVACY_SALT` 三个必需 Secret 已准备，尚未上传；`GITHUB_TOKEN` 为可选自动派发 Secret。 | 通过 Cloudflare Secret 写入实际值，不入 Git/静态输出/日志；保留本地身份验证与边缘实际运行的证据区别。 |
| 自动构建与处理 | 两个 `workflow_dispatch` 文件及 OIDC/dispatcher 代码在本地。 | 完成 GitHub 工作流登记、目标分支推送、限仓库的 Actions 派发权限与真实 OIDC 验证。后台排队成功不等于工作流开始，更不等于发布。 |
| 首批真实内容 | 私有迁移清单已生成，部分候选因媒体映射、真实日期或旧内容转换范围而阻塞。 | 经正常媒体库上传、处理和实际 assetId 映射，审阅后保存并发布。先建立一份真实活动 release；不使用 fixture seed 代替原内容。 |

同级工作区的 `FIREBASE-BASELINE.md` 保留配置前的只读历史：`Home / home-60305` 为 Spark，Firestore `(default)` 为 Standard/Native、`asia-east2`，当时仅启用 Anonymous 登录，定期备份未启用。之后的项目选择、Email/Password、V3 IAM 及实际身份验证成功由 [本轮配置记录](CLOUD-SETUP-2026-09-12.md) 补充；这些新增证据仍不代表旧 firebase-proxy 的实际 Secret 已核实，也不代表备份已经配置。

## GitHub 自动派发的具体前提

GitHub 官方要求 `workflow_dispatch` 工作流先存在于默认分支；不能假设只把新文件推入 `codex/v3-production` 就能立即被当前 dispatcher 找到和执行。需要核实默认分支登记及首次运行状态，再对已批准分支派发。本轮尚未完成这一步。[GitHub workflow_dispatch 文档](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_dispatch)

旧 Pages 主站当前与 `main` 的自动部署关联有既有基线证据。不能为了登记 V3 工作流就直接把整套 V3 应用合入 `main`，从而把测试域请求扩大为主站切换。准备最小工作流登记变更、检查现有构建触发关系并完成相应审阅后再实施；真实运行的 `workflow_ref`、`workflow_sha`、`sha`、仓库和分支仍须满足 API 校验。

后台配置的 `GITHUB_TOKEN` 用于派发仓库工作流；执行器回调使用短期 GitHub OIDC，职责不同。执行器不能拿任意分支或 PR 内容运行带云权限的回调。已有本地 `publish.ts`、`media-runner.ts` 可由登录管理员受控运行，但这是运维执行通道，不能把它描述为后台自动处理已经验收。

## Workers Free：已经拆分与仍需实测

用户已决定坚持免费套餐。当前官方限额包括 HTTP 请求 10 ms CPU、每请求 50 次子请求、128 MB 内存及每日请求额度。等待网络的墙钟时间与 CPU 计时不同；本地耗时不能直接作为边缘 CPU 指标。[Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/)

代码已经把候选媒体准备、清单登记、文件/索引校验及激活后的记录同步拆分为多次可续跑请求，并通过 Firestore 批量读取减少逐条外部请求。原始媒体与衍生媒体采用每片 **5 MiB** 上传，Node/CI 负责实际解码、转码、完整 SHA-256/MD5 和 Nuxt 生成；Worker 核验单片字节、摘要、固定计划及 R2 合并证据，不在单请求中重读整个 512 MB 视频。

这些改动尚不能证明最坏情况满足免费 CPU。实际测试需覆盖冷请求认证/签名、5 MiB 分片摘要、较大内容快照的 JSON 校验、候选准备、清单生成和激活回写，并记录 CPU、子请求与失败码。若某步超限，继续缩小可拆工作、增加阶段或改变处理边界；不能自动改套餐。即便每步未超限，也要观察一次完整媒体处理/发布产生的总请求与 R2 操作数。

## 尚未完成的持续运行验收

以下缺口来自当前代码和运行证据，不能仅以一次成功部署关闭：

| 缺口 | 具体影响 | 完成证据 |
| --- | --- | --- |
| 失败媒体、孤立 multipart 与容量回收 | `Media`/`Processing` 为不确定的远端结果保留预占额度；`fail` 不自动释放，失败 run 也不能随意被新 run 接管。尚未有经过验证的恢复/清理操作闭环。 | 有界、可重试、可审计的对账与清理；实际确认对象或 multipart 清除后才释放额度。演练中断、ACK 丢失、失败处理以及配额恢复，保证已发布媒体不会被误删。 |
| 全部 R2 占用的容量口径 | 现有 `media_quota` 核算媒体原件、衍生版本及预留；内容 release、私有快照、保留历史和备份尚未统一纳入该账本。 | 定义并实现全部对象的库存/预留或独立预算，给发布与回滚预留空间。实际占用核对不得把媒体账本的 10 GB 限制称为 bucket 总容量硬上限。 |
| 备份与恢复 | 既有 Firebase 基线显示定期备份未启用；当前仓库未提供完成演练的 Firestore+R2 恢复流程。 | 取得真实数据与媒体备份，在隔离命名空间/存储中恢复，验证引用、公开 release、草稿和审核状态，并记录恢复点和实际恢复结果。不能把本地 SQLite fixture 作为生产备份。 |
| 过期业务记录清理 | Session、限流与幂等过期值保存在 `record_json` 内，不是 Firestore TTL 字段；当前没有部署过定时清理。 | 分页清理或经过审阅的 TTL 投影及实际触发证据。清理保留仍在使用的会话、幂等记录与发布恢复状态。 |
| 统计初始化 | 未初始化统计投影时 API 正确返回 null；不会自动扫描数据库并伪造零值。 | 依照 Store README 在受控维护窗口逐页核对并安装统计投影。只有已确认空的 V3 命名空间才能明确初始化零值；访问流量继续空值，直至接入真实来源。 |
| 实际认证与恢复邮件 | 本地提供方测试使用注入响应/测试身份。 | 用真实单管理员验证 Cookie/CSRF、未授权拒绝、密码恢复邮件目的地与链接、密码变更后的全会话撤销；访客没有注册入口。 |
| 真实发布链路 | SQLite+Miniflare+真实 Nuxt 的本地链路已存在，但还不是 Cloudflare/Firebase/GitHub 联调。 | 在测试子域执行保存 → 私密预览 → 激活 → 无 JS 公开正文 → 隐藏 → 回滚；失败构建保持旧公开内容，回滚保留较新草稿与新评论。保留实际 release/部署 ID 和请求结果。 |
| 原有内容与网络体验 | 迁移清单未实际入库；音乐上游、大陆访问、视频 Range 与真实网络下播放尚未形成完整验收。 | 原头像/文案/歌单与可迁媒体逐项核对；未提供的健身日期保持空值；实际设备检查播放互斥、Range、恢复、空/错误状态与窄屏显示。 |

媒体协议见 [MEDIA-PROCESSING.md](../../scripts/v3/MEDIA-PROCESSING.md)，统计与清理字段限制见 [Store README](../../workers/api/src/store/README.md)，真实账号与恢复模板要求见 [Auth README](../../workers/api/src/auth/README.md)。

## 环境恢复后的执行顺序

1. 网络恢复后复核当前 GitHub/Cloudflare 状态，完成已经获准的 Wrangler OAuth，记录实际账户及 scope；保留 Workers Free。
2. 本轮全套测试与本地运行时独立测试、根/公共端类型检查、管理端构建、网关打包和 Worker dry-run 均已取得成功结果。独立本地 API 入口已补齐并完成重启持久化测试。记录精确代码版本，检查私有目录没有进入 Git；后续改动按影响重新核验。测试日志与代码 SHA 使用实际结果填写。
3. 用户确定 Firebase/管理员信息后配置隔离数据命名空间、真实 Auth 与 Secrets；准备上述测试 Worker、私有 R2、Pages 网关和 `test.xvyin.com`。
4. 先验证 API、认证和受控存储，再经真实媒体与内容流程建立可预览候选。没有活动 release 时的公开未发布状态不能冒充完整网站上线。
5. 激活已审阅候选并进行远端链路、Free CPU/子请求及失败恢复验收。生成含实际代码提交、云部署 ID、内容 release、测试域响应、验证结果与剩余限制的部署记录，再更新本文件状态。

每一步的状态应由实际结果更新。域名已获授权、文件已经构建、工作流返回派发成功和内容已经公开，是不同事实。
