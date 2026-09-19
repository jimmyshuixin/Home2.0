# 私密原文件与可发布衍生文件

`process-media.ts` 是受控 Node / CI 任务。它接收已经上传完成的私密原文件，检测实际格式、解码并生成衍生文件；不持有浏览器凭据，不修改或删除调用方原文件，也不把本地测试素材放入公开快照。

运行环境为项目锁定的 Node 22.19 以上版本、`sharp`、`pdf-lib` 和系统 `ffmpeg` / `ffprobe`。Windows 可通过 `FFMPEG_PATH`、`FFPROBE_PATH` 指定可执行文件的绝对路径。CI 应从操作系统官方软件源安装 FFmpeg，不从上传内容或用户提供的 URL 下载可执行程序。

```powershell
npx tsx scripts/v3/process-media.ts --input C:/private/source.upload --metadata C:/private/upload-metadata.json --output C:/private/processed --report C:/private/processed-report.json
```

四个参数均为本地路径。声明 JSON 使用共享 `UploadMetadataSchema`，包括 `kind`、`originalName`、`expectedMime`、`expectedBytes` 和可选 `expectedSha256`。报告文件必须不存在，防止静默覆盖旧任务结果。脚本创建独立 `processed-*` 目录，返回实际 `metadata` 以及每个衍生版本的 `role/path/mime/bytes/sha256` 和适用的尺寸、时长。

所有视频输入和输出均不得超过 **512,000,000 字节**。声明大小、磁盘实际大小、复制后大小与可选 SHA-256 必须一致。原文件复制与全部文件哈希均使用有界流；不会将 512 MB 视频整体放入 Node 内存。图片上限为 **100,000,000 字节（100 MB）**、静态文件为 20 MiB、音频为 50 MiB，图片解码上限为 **1.5 亿像素**。图片仍以 5 MiB 分片上传，不把整张 100 MB 图片交给 Worker 内存。Node 图片处理按文件及衍生版本串行执行，libvips 操作缓存设为 32 MB、并发为 1，每个解码管线超时 120 秒；缓存限额不是整个进程的内存硬上限。

| 输入 | 必需输出 | 处理规则 |
| --- | --- | --- |
| JPEG / PNG / WebP | `thumb`、`content`、`large` | WebP 最长边分别不超过 384、960、1600；不放大；依据 EXIF 调整方向和等比缩放；公开图片删除 EXIF/XMP 等元数据，摄影参数经白名单提取另存。禁止动画输入静默丢帧，不改变真实身体形态。 |
| WAV / MP3 / AAC / M4A / Ogg | `playback` | 完整 AAC/M4A，160 kbps，移除附带图像与元数据；验证转码前后时长。 |
| MP4 / WebM | `playback`、`poster` | H.264/AAC MP4、faststart、画面不超过 1920×1080，等比缩放；取真实第一帧作为 WebP 海报。超过输出限制直接失败，不截断内容。 |
| PDF | `download` | 解析实际 PDF 对象，包括压缩对象流；拒绝加密、脚本、自动动作、嵌入附件和交互表单；保留静态 PDF 原字节。 |
| UTF-8 纯文本 | `download` | 严格 UTF-8 解码和控制字符验证；保留原字节。 |
| WebVTT | `download`、`captions` | 验证标记、时间戳与起止顺序；首期拒绝 STYLE/REGION 和活动 HTML 内容；保留原字节。 |

FFmpeg 通过无 shell 的子进程启动，禁用网络输入协议和交互标准输入，设置输出与执行时间上限。衍生文件不直接公开：`processMedia()` 成功只表示本地处理成功。

`metadata.photography` 仅保留相机品牌/型号、镜头品牌/型号、焦距/等效焦距、曝光秒数、光圈、ISO、原始拍摄日期时间，以及相机确实记录的时区偏移。不提取 GPS、机身或镜头序列号、作者/所有者、MakerNote。仅使用 `DateTimeOriginal` 作为拍摄时间；缺失时不以上传日期或文件修改日期替代，也不推测时区。坏日期、无效分数和未知字段会被忽略，坏 EXIF 不会单独阻止有效照片上传。公开快照的 `asset.photography` 使用同一严格白名单。

该提取适用于升级后的新处理任务。已完成媒体的旧元数据不会在读取时扫描或重新下载，已有原件也不会被替换；旧照片需要独立的受控元数据回填任务后才能显示摄影参数。当前支持 JPEG、PNG、WebP；相机 RAW、HEIC、TIFF 不在本次支持范围。

编码期间每 250 毫秒检查输出文件大小，超过播放版本限额则终止子进程并清理本任务失败结果；结束后再次验证大小与完整时长。该轮询允许一个检查周期内的短暂磁盘超量，CI 应预留足够处理空间。

## 服务端任务协议

`workers/api/src/processing.ts` 的 `Processing` 类由私密 runner 路由调用。路由必须先认证获授权的运行身份，类内 `runId` 绑定用于防止跨任务操作，不能代替路由认证。

1. `claim(assetId, runId)` 绑定已上传且状态为 `processing` 的媒体，记录原文件 R2 version/etag，返回上传声明与私密 source 地址。相同 run 重试不创建新任务。
2. `source(assetId, runId, request)` 流式读取原文件，检查 version/etag/大小，强制 `private, no-store` 与附件下载。读取完成后在受控 runner 运行 `processMedia()`。
3. `plan(assetId, runId, {metadata, variants})` 接收报告去除本地 `path` 后的字段，每个版本另外包含 `partSha256[]` 与 `multipartEtag`。runner 逐块计算每片 SHA-256，以及 R2 约定的 `MD5(按顺序拼接每片二进制MD5)-片数`。服务端严格验证元数据、用途、大小、摘要数量，事务预留全部衍生容量；连同原文件与其它预留合计不得超过 **9 GB**。另留 1 GB 给发布快照及网站历史文件。已预留计划不可修改。旧账本如已有超过 9 GB 的文件会保留原件，并阻止新容量预留。
4. 每个版本均使用 R2 multipart；`part(assetId, runId, role, partNumber, request)` 接收 **5 MiB** 分片及实际尾片。服务端实测字节数与 SHA-256，必须与固定计划中相应位置的摘要一致，才调用 R2 并记录其返回的 opaque etag。最多两个在途分片；重复已确认分片内容必须相同。
5. `completeVariant(assetId, runId, role)` 核对已确认记录的片号、大小与 SHA-256，使用服务端保存的 opaque etag 按顺序调用 R2 合并。HEAD 检查完整大小、预期 multipart etag 和任务元数据，支持完成响应丢失后的恢复，记录 version/etag/大小。此处和 finish **不读取或重新计算整文件哈希**。
6. `finish(assetId, runId)` 再检查全部版本 HEAD 与验证记录一致，以事务将衍生容量由 reserved 转为 used，媒体变为 `ready`。保持原文件 key 不变。只有内容发布快照引用后，公开网关才能提供相应资源。
7. `fail(assetId, runId, {code,message})` 保留原文件及全部容量预留，标记失败。不会因请求失败虚构已释放容量。中间 R2 multipart/对象需要后续有凭据的核对与清理流程确认后才能释放额度；失败记录不自动绑定新 run。

`download` 版本必须通过网关按附件提供，并加 `nosniff`；`captions` 是单独的字幕用途，不可用通用下载地址在浏览器中打开任意主动内容。

此实现遵守 Workers Free 的方向：重解码、完整 SHA-256 与 MD5 全部在 Node/CI 执行；Worker 请求最多验证一片 5 MiB，不执行整段 512 MB 哈希。完整文件 `sha256` 与 `multipartEtag` 是受认证执行器提供的清单元数据，不能描述为 Worker 独立验证的整文件哈希。服务器的证明是“每片实际 SHA-256 对应固定计划 + 已确认 R2 etag + R2 有序合并 + HEAD version/etag”。

本地 Miniflare 可验证分片和状态语义，不能证明 Cloudflare 生产环境每次请求 CPU 均低于 10 ms。接通账户后仍需在免费环境检查实际 CPU 和子请求指标，尤其 5 MiB 分片的 SHA-256、请求认证、数据库事务及冷启动。当前不会自动升级收费计划。

免费容量边界：R2 Standard 免费额度是账户级 10 GB-month/月、Class A 100 万次/月、Class B 1000 万次/月。9 GB 媒体预算加 1 GB 预留只覆盖本站应用规划，发布历史、其他 bucket 和同账号操作量仍须核对；本预算不能保证账户级账单恒为零，也没有无限免费存储。去重、WebP 衍生图和站外视频可提高可容纳的内容量；不会擅自删除相机原件。参见 [R2 当前计费规则](https://developers.cloudflare.com/r2/pricing/)。

## 完整执行命令与工作流

```powershell
node --import tsx scripts/v3/media-runner.ts --asset <媒体ID> --origin https://test.xvyin.com --auth-file C:/private/admin-session.json
```

本地认证复用内容发布执行器的受保护管理员会话文件，包含 `cookie` 和 `csrfToken`，不接受命令行明文密码。runner 将身份、原文件和处理报告写入仓库已忽略的 `.private-build/media-<ID>/`。相同命令保留本地运行身份、核对本地输出哈希并查询服务端已确认分片，支持响应丢失后的续跑；不同运行身份不可接管任务。报错不会删除原文件或将未知中间对象的容量视为已释放。

`.github/workflows/v3-media.yml` 使用固定版本操作、锁定 npm 依赖和 GitHub OIDC，身份 audience 为 `<origin>/v3-runner`。只允许两个已批准站点根地址，并由服务端继续验证仓库、分支和固定工作流路径。所有 source 与衍生文件仅保存在短期 runner 磁盘和私密 R2 中，不上传 GitHub artifacts。GitHub 的重新运行沿用同一个 run ID；新建运行不能自动接管已被另一次运行领取的任务。

## 已执行的本地验证

```powershell
npx vitest run scripts/v3/test/photo-metadata.test.ts scripts/v3/test/process-media.test.ts workers/api/test/processing.test.ts workers/api/test/upload-start.test.ts scripts/v3/test/media-runner.test.ts
```

解码测试在系统临时目录生成真实 JPEG/EXIF、WAV、MP4、PDF、WebVTT，验证原照哈希保持、方向与比例、去元数据、真实解码、完整时长与异常文件拒绝。服务端测试使用 Miniflare 的实际 R2 multipart，验证 5 MiB 加尾片、容量并发、同 run 幂等、错误哈希、丢失确认恢复和 R2 对象后续变化。所有 fixture 均为明确的测试内容，结束后清理，不进入生产数据。

参考：[R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)、[R2 multipart 与 ETag](https://developers.cloudflare.com/r2/objects/upload-objects/#etags)、[Workers Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)、[Sharp metadata 默认移除](https://sharp.pixelplumbing.com/api-output/)、[FFmpeg](https://ffmpeg.org/ffmpeg.html)、[pdf-lib PDFDocument](https://pdf-lib.js.org/docs/api/classes/pdfdocument)。
