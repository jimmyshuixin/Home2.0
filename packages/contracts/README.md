# @xvyin/contracts

供公共 Vue 应用、管理后台和业务 API 共用的 TypeScript/Zod 4 契约。所有对象使用严格字段校验；没有生产示例记录、真实统计、自动健身日期或认证密钥。

## 使用

从 `@xvyin/contracts` 导入 schema/type，或在尚未注册 workspace 的本地构建中引用 `src/index.ts`。包由调用方的 TypeScript/Vite/Worker 构建器编译，不提交编译副本。

```ts
import { CreationDraftSchema, validateFitnessSettings, deriveFormats } from '@xvyin/contracts';

const draft = CreationDraftSchema.parse(untrustedDraft);
const formats = deriveFormats(draft);
const settings = validateFitnessSettings(untrustedSettings, trustedServerNow);
```

从仓库根目录执行 `npx vitest run packages/contracts/test` 和 `npx tsc -p packages/contracts/tsconfig.json --noEmit`。依赖由根工作区管理；本包没有自己的 lockfile。

## 主要导出

- `CreationDraftSchema` 是可保存的草稿；`CreationSaveInputSchema` 额外要求 `expectedVersion`。`PublishableCreationSchema` 要求非空标题、slug 和有意义的正文。八种 `ContentBlockSchema` 接受结构化文字、资产 ID 或预设 provider 引用，拒绝任意 iframe、autoplay、文件字节和原始对象 key。
- `deriveFormats` 返回稳定顺序的 `text/audio/video` 集合；同一条目可以属于多个格式。`kind` 是独立分类。
- `RichTextDocumentSchema` 使用 doc/paragraph/heading/bulletList/orderedList/listItem、text/hardBreak、有限 marks。递归树先限制深度和节点数，再解析结构。代码块允许展示 HTML 源代码；渲染器必须以文字节点输出它。
- `FitnessSettingsDraftSchema` 适合通用 DraftRecord；`FitnessSettingsSchema` 是带 id/version 的读取模型；`FitnessSettingsInputSchema` 是带 expectedVersion 的保存输入。保存必须显式发送 startDate 日期或 null。`validateFitnessSettings(input, now)` 和 `createFitnessSettingsInputSchema(now)` 同样拒绝未来日期。
- `epochDay`、`shanghaiDate`、`fitnessDayCount`、`fitnessDayCountFromDate` 不隐式读取设备当前时间。`startDate=null` 永远返回 null。CalendarDateError 带稳定 code/status；配置了开始日期而时间源无效时不伪造数字。
- `FitnessEntryDraftSchema`/`FitnessPhotoDraftSchema`、相应读取模型、`AlbumDraftSchema` 与 `PlaylistDraftSchema` 定义可持久化字段，照片拍摄日期未知时保持 null。健身 tags 默认空数组，不自动替真实记录标记“训练/日常”。照片 status 默认 draft，只接受 draft/published/hidden；它是下一次整条发布时采用的照片状态，保存草稿不会立即改变公开版本。
- `SiteSettingsSchema` 包含精确 heroTitle、空白 intro/about、原头像资产引用、社交链接、确定的导航、主题和联系开关。公开设置禁止凭据和任意扩展字段。
- `CommentInputSchema` 使用 nickname/body/targetType/targetId；guestbook 的 targetId 为 null，其余目标须有 ID。`ContactInputSchema` 使用 nickname/email/message。website/startedAt/challengeToken 只是输入辅助字段，不代表身份或反滥用验证已经通过。提交 receipt 不包含公开内容状态。
- `UploadMetadataSchema` 只验证文件声明，限制图片 20 MiB、音频 50 MiB、视频 **512,000,000 字节**、附件 20 MiB。`MEDIA_LIMITS.totalBytes` 为 **10,000,000,000**。`DetectedMediaMetadataSchema` 接收处理器探测结果并检查大小和图片像素，不能代替实际解码。
- `PublicMediaAssetSchema` 与 `PublicMediaVariantSchema` 不接受 originalKey/originalName/objectKey；它们本身不能判断 URL 是否指向私有内容。
- `canReserveMediaBytes` 必须在存储的原子配额预留事务中调用，同时计算已用空间与在途预留。
- API success/error envelope、稳定错误码/HTTP状态、登录输入与幂等键 schema 统一前后端边界。

## 服务端仍必须完成的检查

schema 只能证明数据形状和纯规则。业务 API 仍须执行真实密码认证、会话/CSRF、原子版本检查、幂等、速率限制、目标存在与公开状态检查、资产归属/ready/引用检查、草稿与公开快照隔离。照片 ID、管理员布尔值、MIME、字节数、客户端 startedAt 和 challengeToken 都不能被当作权限证明。

API 要在 JSON.parse 之前限制原始请求体 256 KiB；本包对创作解析结果的 UTF-8 检查不替代网络层限制。大媒体走受控上传流程，完成后核对实际大小、魔数、完整哈希和受控解码结果；保留原件私有并处理展示文件的 GPS/EXIF。全局容量及重试/中断释放预留需要真实存储事务。

providerRef 仅列出 tencent/netease/bilibili/youtube/douyin 的名称和内容 ID，不提供任意 URL 代理能力。实际 resolver 须按媒体类型、来源、固定主机/路径和重定向策略再校验。公开渲染器会再次校验视频 ID，仅由有效 BiliBili BV/av、YouTube 或抖音数字视频编号构造固定官方播放器地址；访客点击后才加载内嵌播放器，默认不自动播放，并始终提供原平台入口。BiliBili 多 P 视频默认第一集。契约仍拒绝任意 iframe HTML、播放器 URL 和 autoplay 参数；外部音频保持原平台跳转。播放器加载完成不代表视频可播放，平台权限、登录要求、地区和网络限制由原平台决定。

UTC 时间戳、发表日期、照片日期、发布成功状态和统计必须来自真实存储/事件。这里的测试日期和测试媒体 ID 均位于 `test/`，不进入生产数据。

实现依据：本项目 `design-v3-2026-09-11/TECHNICAL-HANDOFF.md`、`UX-ACCEPTANCE.md` 及 2026-09-12 用户确认的账号密码/512 MB 修改。Zod 对象、判别联合与校验 API 已对照 [Zod 官方文档](https://zod.dev/api)。
