# V3 测试站云资源配置记录

## 2026-09-12 16:57 更新：真实部署与登录已完成

本节替代下面 15:50 历史快照中的待部署状态。测试资源已运行，**当前仍在构建包含真实媒体的首次公开内容版本，不能把私有预览称为公开上线或生产验收通过**。

| 项目 | 实际结果 |
| --- | --- |
| 授权 | 用户另行批准 `workers_scripts:write`、`workers_tail:read`，现有 OAuth 共八项 scope。继续使用 Workers Free。 |
| API Worker | `xvyin-v3-test-api` 已部署，仅通过 Pages 服务绑定访问；当前版本 `f79716ee-9df3-4f45-8149-74bfde19c76d`，代码 `8867dd4496186e922b65b2fdd6ade03a330ae646`。后续代码版本以实际部署记录为准。 |
| 后端 Secret | 三项必需 Secret 已写入测试 Worker，真实值不入 Git、静态产物或日志。 |
| Pages | 网关已部署至 `https://aab2b592.xvyin-v3-test.pages.dev`，代码 `33ebcfae7cf555ffa6ba44fcbfb96de472fd8b1a`。后续管理端构建将另行部署。 |
| 测试域 | Cloudflare 显示绑定活动、SSL 已启用；实际 HTTPS API/管理页已响应。`/admin/`、`/admin/creations`、`/admin/reset-password` 均为 200。 |
| 真实认证 | 用户本人输入密码并确认登录；实际密码登录、会话查询、后台统计读取均为 200。错误账号 401；坏 CSRF 与外部 Origin 写请求分别 403。没有收集或保存密码。 |
| 真实数据 | 原首页介绍与关于正文、空值健身设置及原 QQ 歌单通过正式管理员 API 保存。原头像与设计包原照 SHA-256 一致。 |
| 首个私有预览 | `1f8c0b0c-9616-4cca-a303-1eedaaa76373` 已 ready，43 个静态文件校验通过；代码 `ec758ba041331ac514c4db1250517b71111b268d`。仅登录浏览器可预览，匿名首页尚为未发布 503。 |
| 真实媒体 | 7 个既有原件已通过分片上传进入私有 R2。摄影和首首音频已 ready，其余按顺序处理。超过 512,000,000 字节的视频声明已被 422 拒绝。 |

实际边缘联调修复：Pages 管理入口重定向循环；当前 workerd 拒绝 `redirect:error`，改为 `manual` 并显式拒绝重定向；服务账号仅缓存完成的短期 token；Firestore 明确冲突最多重试两次；R2 multipart 完成后读取实际 HEAD 元数据再验证。没有放松尺寸、摘要、分片顺序或对象来源检查。新增 R2 回归及既有处理协议测试 13 项通过，根 TypeScript 检查通过。

实际 QQ 音乐上游能返回歌单，但 URL 接口返回无法直接播放的中间协议字符串；不修改主站音乐 Worker。测试首页改用仓库既有本地三首歌作为默认歌单，原 QQ 配置保留。日期、研究结果与访客统计没有补造。

真实日志中观察到部分冷认证/写入/完成请求 CPU 超过 10 ms，当前请求 outcome 为 ok；这不构成 Workers Free 最坏情况验收。自动 GitHub 派发、完整密码恢复、备份恢复及持续运行缺口仍按 [DEPLOYMENT-READINESS.md](DEPLOYMENT-READINESS.md) 记录，不能称为全部完成。最终公开 release、版本与浏览器验收另见实施目录的实际部署交付记录。

## 15:50 历史快照（后续进度以上节为准）

记录更新：2026-09-12 15:50，Asia/Shanghai。本记录汇总部署主任务本轮实际工具结果和用户已确认的信息。它补充此前网络失败时的记录，不把旧失败状态继续当作当前状态，也不代表测试域已完成部署或生产验收。

## 已核实和完成

| 项目 | 本轮结果 | 证据边界 |
| --- | --- | --- |
| Wrangler 授权 | Wrangler `4.131.1` OAuth 已成功，随后 `whoami` 已确认身份和权限。 | 浏览器已登录与 CLI 已授权是不同事实；本轮已取得 CLI 成功结果。 |
| 实际 OAuth scopes | `user:read`、`offline_access`、`account:read`、`workers:write`、`pages:write`、`zone:read`，共六项。 | 这是实际 OAuth 权限列表，不代表已部署 Worker、已有 R2 完整读写验收或新增 DNS 写权限。 |
| 凭据保存 | Wrangler 使用加密的 `default.enc` 保存授权数据，解密密钥保存在 Windows 凭据管理器。 | 不在本文件、仓库或构建产物记录令牌、密钥或授权回调代码。 |
| 私有 R2 | 已创建专用 bucket `xvyin-v3-test-private`；创建结果为 `apac`、`Standard`。 | 资源已创建；尚不能据此宣称 `CONTENT` 绑定、受控上传、实际存储计量或公开媒体链路已验收。 |
| Pages 项目 | 已创建 Direct Upload 项目 `xvyin-v3-test`，生产分支设置为 `codex/v3-production`。 | 项目创建成功；截至本记录尚未执行该项目的页面部署。生产分支名称是 Pages 配置，不代表主域已切换。 |
| 测试子域绑定 | 已按控制台显示的新记录提交 CNAME `test → xvyin-v3-test.pages.dev`。 | 提交成功不等于 DNS 解析、证书、HTTPS 或网站响应已验证。 |
| Firebase 登录提供方 | `Home / home-60305` 的 Email/Password 已启用。 | 提供方启用不等于管理员用户创建完成或已登录。 |
| 管理员身份 | 已取得实际管理员 UID，具体值仅供受控配置使用，不写入本记录。 | UID 已取得不等于测试站实际登录、密码恢复或会话撤销已验收。 |
| 运行时 IAM 角色与绑定 | 用户已授权下文列明的八项权限及服务账号密钥配置；`xvyinV3TestRuntime` 角色已创建，部署主任务已核实 IAM 政策更新及独立服务账号角色授予成功。 | 角色及绑定成功；本轮另有下述真实身份访问验证，不以 IAM 页面状态代替实际请求。 |
| 服务账号密钥 | 用户将密钥文件放置到桌面后，部署主任务核对 `project_id`、`client_email` 和 `private_key_id`，移入受 ACL 保护且被 Git 忽略的 `.private-build/cloud-setup/google-service-account.json`。 | 本记录只记文件用途及路径，不记录密钥内容、密钥 ID 或管理员 UID。 |
| 真实 Google 验证 | `2026-09-12T07:49:49Z` 完成管理员 `adminLookup` 和 Firestore create/read/update/query/delete 验证；`v3_test_deployment_probes` 中的临时记录已清理。 | 证明本地受控验证可使用实际服务账号访问 Google；不代表 Worker 边缘运行、密码登录或会话撤销已验收。 |
| 后端 Secret 准备 | 三项必需 Secret 的私有配置文件已准备：`GOOGLE_SERVICE_ACCOUNT`、`FIREBASE_AUTH_CONFIG`、`PRIVACY_SALT`。 | 截至本记录尚未上传到 Cloudflare，不能称为 Worker 已配置可用。 |

本轮沿用用户已批准的测试域部署授权及 Workers Free 决定；没有以套餐升级替代请求拆分。测试目标为 `https://test.xvyin.com`，不是现有 `https://xvyin.com` 主站切换。

## 已确认的 Firebase 与管理员配置

| 配置项 | 已确认值 |
| --- | --- |
| Firebase 项目显示名 / ID | `Home / home-60305` |
| Firestore 数据库 | `(default)` |
| Firestore 类型 | Standard edition，Native mode |
| V3 测试集合前缀 | `v3_test_` |
| 管理员登录用户名 | `xvyin` |
| 管理员与密码恢复邮箱 | `jimmyai3132@gmail.com` |
| 计划使用的密码恢复页面 | `https://test.xvyin.com/admin/reset-password` |

用户已确认上述项目、隔离方案、用户名和邮箱，不再把它们列为待回答问题。**管理员实际 UID 和运行时服务账号私钥已取得，并完成上述真实 Google 验证；三个必需 Secret 尚未上传 Cloudflare。** 密码由用户在受保护的账号流程中处理，不通过聊天收集，不写入配置或日志。自定义密码恢复页面地址是部署配置目标，不是其 HTTPS、邮件模板或真实恢复流程已验收的证据。

## 运行时 IAM 配置与绑定进度

[firebase-runtime-role.json](firebase-runtime-role.json) 是可审阅的 Google Cloud 自定义角色配置，包含以下八项运行时权限。用户已授权这些权限及密钥配置，部署主任务已创建角色、核实独立服务账号绑定并完成真实管理员查询和 Firestore 数据操作验证；**截至本记录，Secret 尚未上传，不能称为 Worker 已有可用 IAM 凭据。**

| 权限 | 现有代码使用目的 |
| --- | --- |
| `datastore.databases.get` | 开始和回滚 Firestore 事务。 |
| `datastore.entities.get` | `batchGet` 与查询结果读取。 |
| `datastore.entities.list` | 有界分页查询。 |
| `datastore.entities.create` | 新建业务记录、会话及任务。 |
| `datastore.entities.update` | 更新现有记录和事务状态。 |
| `datastore.entities.delete` | 删除操作所需的数据权限。 |
| `firebaseauth.users.get` | 查询配置的管理员 UID、邮箱、禁用及撤销状态。 |
| `firebaseauth.users.update` | 更新管理员 `validSince` 以撤销旧会话。 |

Firestore 权限与代码实际调用的 `beginTransaction`、`batchGet`、`runQuery`、`commit`、`rollback` 对应，见 [Google Firestore 方法权限表](https://docs.cloud.google.com/firestore/native/docs/security/iam)。管理员查询及撤销分别需要 [accounts.lookup 权限](https://docs.cloud.google.com/identity-platform/docs/reference/rest/v1/projects.accounts/lookup) 和 [accounts.update 权限](https://docs.cloud.google.com/identity-platform/docs/reference/rest/v1/projects.accounts/update)。OAuth scope 本身不授予这些 IAM 权限。

以下命令展示从仓库根目录用配置文件创建同一角色的方式，不是本轮实际操作日志。角色已创建，不应重试此创建命令；后续先读取现有角色及绑定再决定是否需要变更：

```powershell
gcloud iam roles create xvyinV3TestRuntime --project=home-60305 --file=docs/v3/firebase-runtime-role.json
```

该角色不包含项目 Owner、数据库管理、用户创建/删除、密码哈希读取或 IAM 管理权限。管理员初始化属于受控配置步骤，不应为此把用户创建权限长期加入 Worker 运行时身份。

**`v3_test_` 是应用代码执行的命名空间隔离，不是 IAM 对集合前缀的访问隔离。** 当前 [Worker 入口](../../workers/api/src/index.ts) 固定使用该前缀，[FirestoreStore](../../workers/api/src/store/firestore.ts) 负责生成记录路径；现有服务账号 OAuth 数据路径使用 IAM 授权。不能把这个角色描述为“服务账号只能访问 V3 集合”，也不能把旧的浏览器 Firestore Security Rules 当作服务账号权限边界。

## 首次部署的执行器与可选自动派发

当前没有仅限目标仓库的专用 Actions 派发 token；不能把本机 `gh` 登录的广范围 OAuth 凭据复制到 Worker。已从 `workers/api/wrangler.jsonc` 的 `secrets.required` 移除 `GITHUB_TOKEN`，保留 `GOOGLE_SERVICE_ACCOUNT`、`FIREBASE_AUTH_CONFIG` 和 `PRIVACY_SALT` 三项必需 Secret。`GITHUB_TOKEN` 仍是运行时支持的可选 Secret：缺失时不会注入自动内容构建或媒体处理 dispatcher。Worker 入口通过 `ApiEnv & { GITHUB_TOKEN?: string }` 显式声明可选绑定，生成的绑定声明继续由 Wrangler 维护。

现有内部执行器接口独立支持真实管理员 Cookie、CSRF、精确 Origin 和本地运行 UUID。首次测试部署计划通过管理员受控启动 [媒体处理及内容发布命令](../../scripts/v3/README.md#首次云端部署的受控执行方式)；后台上传后等待处理、候选排队、执行器运行完成和管理员激活是不同阶段。这个配置调整不改变认证要求，也没有把排队状态伪装成自动执行成功。

自动派发仍待接入：专用权限最小化凭据、默认分支工作流登记、实际派发和 GitHub OIDC 回调均需单独核验。本记录没有声称这些步骤已工作，也没有声称受控执行器已完成首次远端运行。

## 尚未完成的部署和认证步骤

1. 将已取得的管理员 UID 用于固定账号配置，完成真实登录验证；不在日志、聊天或配置文件保存密码。
2. 将已准备且通过本地真实 Google 验证的三个必需 Secret 上传至测试 Worker，再核验边缘运行中的实际访问。运行时 Secret 格式见 [Auth README](../../workers/api/src/auth/README.md) 和 [本地配置样例](../../scripts/v3/local-config.example.json)。Secret 的真实值不进入本记录或 Git。
3. 完成 API Worker、Pages 网关和 `test.xvyin.com` 的实际部署与 HTTPS/服务绑定验证，保存真实代码提交、云版本/部署 ID 及请求结果。本记录尚无这些成功凭证。
4. 在实际恢复页面可访问后配置并验收密码恢复邮件。Firebase 自定义 action URL 保存后应用于项目全部邮件模板，修改前需保留原配置并核查现有项目用途；不能把该设置宣称为仅影响 V3 的单个模板。[官方邮件处理器说明](https://firebase.google.com/docs/auth/custom-email-handler)
5. 完成真实管理员登录、Cookie/CSRF、退出、密码恢复和会话撤销，再执行受控内容保存、预览、发布、隐藏与回滚的远端验收。

本记录不关闭 [部署依赖与验收状态](DEPLOYMENT-READINESS.md) 中的长期运行缺口；尤其不把 R2/Pages 创建成功、Email/Password 已启用或本地测试通过等同于完整测试站上线。
