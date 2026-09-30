# 第三阶段：搜索、摄影和阅读体验

本阶段延续 Nuxt/Vue、Workers、R2 与现有发布快照，不增加付费搜索或编辑器服务。公开数据不变；生产部署和激活状态以本次 `upgrade-experience-2026-09-30` 交付证据为准。

## 新增能力

- `/search`：Pagefind 1.5.2 的中文静态全文索引，支持正文、图注、栏目筛选、分页、输入法合成期间不提交、失败重试与版本过期提示。查询词在浏览器内检索，不发送至搜索服务。搜索资源在首次提交非空关键词后才加载。
- 摄影灯箱：PhotoSwipe 5.4.4 延迟加载，使用已经公开的派生图及真实尺寸，支持触摸切换、双指缩放、键盘、焦点恢复、降动效和失败重试；保留图注、许可 EXIF 与点赞。
- 阅读目录：收录每个 richtext block 的所有标题，以 block ID 和节点位置生成唯一锚点；重复标题也能分别跳转，正文 h1 降为 h2，旧 block 锚点保留。
- 分享：创作和相册分别提供 Open Graph、Twitter Card、JSON-LD 与公开封面。封面优先使用已公开 content/large/thumb 派生图，缺图回退本站纸墨背景，不请求原文件或生成虚构拍摄信息。
- `/subscribe`、`/feed.xml`、`/feed.json`：最近 100 篇公开创作和相册，稳定内容 ID、真实发布时间、纯文本内容与正确 MIME；全站提供 feed 自动发现链接。

## 发布边界

`PublicSnapshotSchema` 先严格校验快照。索引只挑选公开正文、标题、摘要、标签和照片说明，不扫描源目录、不包含素材对象、坐标、后台或动态留言。Feed 同样只投影公开内容文字。

索引位于 `/search-index/<releaseId>/`，生成、逐文件哈希校验和清单上传都在候选 ready 之前完成。续跑校验索引快照摘要及所有文件；缺失或被改动的产物不能继续发布。服务器继续只允许当前公开版本或有效管理员私有预览；不开放历史 release 读取。激活、隐藏与回滚同时切换 HTML、Feed 和索引。私有 Feed/索引也返回 `private, no-store` 和 `noindex`。

公开页 CSP 仅增加 `wasm-unsafe-eval` 供 Pagefind 使用 WebAssembly，不开启 JavaScript `unsafe-eval`，并以 `noWorker: true` 避免扩大 worker/blob 权限。1.5.2 的 WASM 使用官方压缩 `.pagefind` 载荷，仍按二进制传输；标准 `.wasm` MIME 也显式支持。所有索引随同当前免费架构承担存储和请求用量，不承诺无限免费容量。

## 编辑器原型边界

Tiptap 原型保存在交付目录的 `editor-prototype/`，依赖和 lockfile 独立，不进入后台生产 bundle、不读取真实草稿、不写 API/数据库。它用于验证当前 RichTextDocument 契约往返、列表、marks、撤销、粘贴及输入法合成事件。

默认 StarterKit 与本站旧稿存在结构差异：内联 code 标记共存、嵌套列表首节点及重复 marks 都须明确适配。生产编辑器保持现状，不能把原型测试通过当作全量迁移或真实系统中文输入法验收通过。

## 验证与继续维护

运行 `npm run check`、`npm run test:unit`、`npm run test:publication` 和后台构建；完整 Nuxt 构建与 dev 服务不得共用输出目录并发运行。`test:publication` 使用真实 Nuxt、SQLite 与 workerd R2，覆盖私有 Feed/索引鉴权、激活、隐藏、回滚及旧索引 404。真实浏览器验证另存桌面/手机截图和结果。

`npm run generate --workspace @xvyin/web` 会生成页面后构建搜索索引。正式 `publish.ts` 也调用同一索引生成器，不能只运行裸 `nuxt generate` 后直接发布。线上仅重建当前公开内容，保留未发布草稿；候选预览确认后再激活，最后退出预览并匿名验证。

参考：[Pagefind 中文支持](https://pagefind.app/docs/multilingual/)、[Pagefind Node API](https://pagefind.app/docs/node-api/)、[PhotoSwipe](https://photoswipe.com/getting-started/)、[Tiptap JSON](https://tiptap.dev/docs/editor/core-concepts/persistence)、[Open Graph](https://ogp.me/)、[JSON Feed 1.1](https://www.jsonfeed.org/version/1.1/)、[RSS 2.0](https://www.rssboard.org/rss-specification)。
