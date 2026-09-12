# 真实旧内容迁移：本地私有清单

本工具从**这份完整仓库**读取已存在的文字、媒体路径和元数据，生成可审阅的 V3 草稿清单。它不是数据库 seed、上传器或发布器；不会访问 GitHub、QQ、外部图片、Firebase 或 Cloudflare，也不会保存/发布后台记录。原文和原图文件只读，媒体字节不复制、不加工。

2026-09-12 的实跑来源是本独立工作副本的 `src/data/site.js`、`src/App.vue` 和 `content/`，合计 **77 个源文件**，HEAD 为 `685e73c653e6f6cc08bd4b7e30308bcb376421ab`。这是此次本地来源证据，不代表未来或线上最新版本。仓库没有 `public/content/`，不读取生成的 `dist/`，也不读取 37 文件的 `audit-2026-09-11/home2-source` 审查集合。

## 运行

在完整仓库根目录，用已经安装的依赖运行；命令不会通过 `npx` 临时联网安装软件。

```powershell
node node_modules/tsx/dist/cli.mjs scripts/v3/migrate-legacy.ts
```

输出固定在 `.private-build/migration/run-<随机目录>/`，每次新建目录、不覆盖之前结果。工具先用 `git check-ignore --no-index` 确认目标被忽略，拒绝符号链接来源/输出目录，不接受任意 `--out` 或源目录 CLI 参数。输出包括：

| 文件 | 内容 |
| --- | --- |
| `manifest.json` | 候选草稿、阻塞原因、源文件 SHA-256/字节数、媒体来源、未转换模块 |
| `media-requirements.json` | 每个需要实际上传的来源、原始哈希、字节数、所属候选、当前映射状态 |
| `mapping.template.json` | 严格映射输入的空模板，`{"schemaVersion":1,"assets":[]}` |
| `REVIEW.md` | 可直接阅读的逐项审阅清单 |

`generatedAt` 是清单生成时间，不是任何内容创建、拍摄或发布日期。读取前后逐个重新计算 77 个原文件 SHA-256；如运行期间原件变化，整次清单生成失败。清单包含现有个人内容来源，继续留在被忽略的私有目录，不提交 Git 或放进公共构建目录。Windows 文件权限遵循该私有工作目录的 ACL；`mode` 参数不等于跨平台文件加密。

## 这次真实盘点

不提供任何资产映射的实跑得到 **7 项候选，2 项完整可审阅草稿，5 项阻塞**：

| 候选 | 原内容来源 | 自动转换与阻塞 |
| --- | --- | --- |
| 站点设置 1 项 | 当前首页介绍、`about.md`、GitHub 链接、当前手绘头像 | 文字与受控链接可转换；需要头像 WEBP 的真实 `assetId` 才输出完整 SiteSettings 草稿 |
| 健身设置 1 项 | `interests/fitness.md` | 原介绍可转换，`startDate:null`、`timezone:Asia/Shanghai`；没有创建健身天数 |
| 默认 QQ 歌单 1 项 | `site.js` 已检入的环境变量回退配置 | `source:tencent`、`sourceId:9206816111`、名称 `QQ Music Playlist`；不虚构曲目，`tracks:[]` |
| 本地歌单 2 项 | `local_playlists.json`、`朝花夕拾.json`、`Animenz.json` | 名称、歌名、艺人、排序保留；6 首不同音频与 6 张封面均需要真实资产映射 |
| 文章 1 项 | `blog/manifest.json` 和 `mylife.md` | 保留列表标题“我的个人旅”及正文标题“往前看便好”；正文外部图片需要实际资产映射，未获取图片时整项阻塞 |
| 摄影相册 1 项 | 当前摄影卡片“光隅”、摄影介绍、摄影 WEBP 封面 | 需要当前原图映射；图片 alt 保留“暖色灯光摄影作品”，`photoDate:null`、`status:draft` |

共 **15 个需要映射的媒体来源：14 个本地文件合计 48,587,314 字节，加 1 个未获取的外部文章图片 URL**。其中没有视频。所列本地字节是本次原文件大小，不是未来媒体库处理变体后的总占用，也不是远端额度使用情况。`uploadDeclaration` 只是由原文件扩展名、大小、SHA-256 形成并经过上传契约校验的声明；实际 MIME、解码、处理结果仍必须通过正常后台媒体流程校验。

`content/music/music.json` 的三首曲目与 `Animenz.json` 逐项相同，只生成一个来源别名，不重复建第三个本地歌单。清单同时保留 6 条命名歌单曲目引用和 3 条回退引用，便于检查去重依据。默认 QQ 配置可能被原构建环境变量覆盖；本工具不会把已检入回退值称为当前线上已核实歌单。

## 资产映射

通过既有后台上传真实原件并完成媒体处理之后，在私有模板的 `assets` 数组中逐项填写以下字段，随后重新生成清单：

| 字段 | 要求 |
| --- | --- |
| `source` | 精确匹配 `media-requirements.json` 中的规范来源：`content/...` 或原始完整 HTTPS URL |
| `assetId` | 正常媒体库上传后返回的真实资产 ID，不是文件名、占位值或随意生成的 seed ID |
| `kind` | `image` 或 `audio`，必须与实际源用途匹配 |
| `sourceSha256` | 64 位小写十六进制原件 SHA-256；本地文件必须与清单核对一致 |

模板故意不包含可以被误当为真实资产的示例 ID。数组中不得重复 `source`，同一 `assetId` 不得对应不同原始哈希或媒体种类。误填原始哈希、媒体种类、路径穿越、额外字段会报错。未被本次内容使用的映射列入 `unusedMappings`，不会自动上传或补建内容。

```powershell
node node_modules/tsx/dist/cli.mjs scripts/v3/migrate-legacy.ts --mapping .private-build/migration/my-asset-mapping.json
```

对外部文章图，本工具只保留原文里的 URL，不下载，也无法证实操作者提交的 SHA-256。后续需自行取得该原图、核对内容并通过正常媒体上传流程；这类映射标记为 `remote-unverified`。本地映射标记 `local-source-hash-only`，也只说明与本地原件哈希相同。**任何 `ready-draft` 都不表示对应远端资产存在、已处理完成、可公开或已发布**；保存草稿/发布时仍由后端执行资产归属、状态、配额和版本校验。

## 保留与转换规则

- `heroTitle` 使用已确定的 V3 原文 `hello！i‘m 虚宁`。首页介绍从原 `hero-statement` 取得“路漫漫其修远兮，吾将上下而求索。”。原头像仍对应页面当前使用的 `field-portrait.webp`；没有重新绘制或更换头像。
- `about.md` 实际是 HTML。本工具仅接受已经实现的标题、段落、引用、容器、换行、粗体/斜体和安全链接子集，把文字转换为共享 RichTextDocument。保留可见文字、NBSP 缩进和链接目标；移除旧 CSS/容器，引用转为段落。脚本、任意 iframe、事件属性、不安全 URL、未知实体和不平衡标签均报错，不以原始 HTML 绕过内容契约。
- 原文章目前只含标题与图片。解析器另外支持纯段落和引用；未知 Markdown 语法使该文章保留在阻塞清单，不静默删去不支持的片段。媒体映射缺失时，整个候选 `draft:null`，不会输出丢失原图的“完整草稿”。
- 文章日期 `2025-06-15` 明确来自旧 manifest，只放在候选 `sourceDate` 中并附 JSON pointer `/0/date`。CreationDraft 不支持旧发布日期字段；工具不捏造午夜时分、不填 V3 `publishedAt`。V3 的发布时间只能由未来真实发布事件产生；如产品需要显示旧文章日期，需先明确增加一个有来源的历史日期字段。
- 没有日期依据的照片保持 `photoDate:null`。不从文件系统 mtime、Git 提交日、图片文件名推算拍摄日，不用清单时间补齐内容日期。
- 旧 `App.vue` 里有 `2022-10-18` 健身起始常量，但用户已明确要求真实开始日期尚待提供；本工具始终输出 `startDate:null`。旧 `siteStartDate` 是站点日期，亦不作健身日期。
- 歌单/曲目/内容块的 ASCII 标识使用原来源的稳定哈希，仅用于迁移候选及块/曲目技术 ID，**不充当媒体资产 ID**。文章 slug 取原文件名 `mylife`；摄影相册路由名 `guang-yu` 是可审阅的技术选择。原标题、歌名、艺人和描述不改写。
- 所有新建照片为 `draft`，创作 `featured:false`；内容排序沿用原列表顺序。站点导航、主题等没有一一对应的旧字段使用共享契约既定默认值，不导入旧运行时统计、备案声明、任意 iframe、SVG 图标代码或旧登录方式。

## 明确尚未自动迁移的内容

完整未转换文件名均在 `manifest.unconverted` 和 `REVIEW.md`，目前包括：

- `content/Photos/1.jpg`、`2.jpg`、`3.jpg`：没有可靠关联、标题/alt 或拍摄日期来源。不能仅凭目录名决定它们属于摄影还是健身，需要确定分类和可公开文案。
- `recent/fitness-cover.png` 与 WEBP：原件保留。没有确认的健身条目 `entryDate`，不构造不合法 FitnessEntry；照片可通过媒体库上传后再由后台填写真实日期创建条目。不会改变身体形态。
- 履历 JSON、项目/研究成果描述、成长时间线与目标进度：不重新验证或改写研究事实，不把旧百分比/年数当成当前统计；可另行逐条人工迁入关于页/创作。
- 书架、游戏图片、其余兴趣内容、旧嵌入媒体：超出这次已经可靠实现的转换子集，保留全部源文件和哈希，后续按受控内容块逐项审阅。
- 头像 PNG、摄影 JPG 等同名伴随原件：当前页面明确引用 WEBP，所以先映射该确切来源。不能只凭同名文件认定字节等同或自动替换当前图；原高分辨率版本都继续保留，可另行确认替换来源。
- 字体、图标、二维码、旧页脚链接：属于静态资源/配置，未变成内容记录；不从旧配置推断当前备案、访问统计或服务状态。

这份工具不需要迁移数据库凭据，不创建管理员账号，也不自动建立后台记录。完成逐项审阅后，真实上传媒体、使用实际资产映射生成草稿，再通过正常后台保存/预览/发布流程导入；服务端版本控制、评论审核、媒体公开投影与发布激活仍适用。

## 验证

```powershell
node node_modules/vitest/vitest.mjs run scripts/v3/test/migrate-legacy.test.ts
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
```

已通过 15 项迁移测试：对真实检入内容计数、回退歌单去重、无映射整项阻塞、显式日期来源保留、健身空日期、内存中测试映射形成 7 个严格草稿、原始哈希/种类错误拒绝、危险 HTML/链接/路径/未知 Markdown 拒绝，以及转换期间禁止网络调用。测试专用资产 ID 只在测试进程内使用，不写入私有迁移输出或任何 seed 文件。

本地实跑还确认源文件二次哈希一致、输出被 Git 忽略，`git status --short -- content src/App.vue src/data/site.js` 为空。这是本地转换与来源完整性验证，不是线上迁移、部署或发布验收。
