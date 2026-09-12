# 公共网站

Vue / Nuxt 4 静态生成应用，公开路由与管理后台、业务 Worker 分开构建。遵循已接受的 V3 图稿；生产默认不包含设计示例、评论、照片记录或虚构日期。

## 构建

从仓库根目录安装工作区依赖，然后运行：

```powershell
$env:XVYIN_SNAPSHOT_PATH = 'C:/absolute/path/published-snapshot.json'
$env:XVYIN_PUBLIC_ORIGIN = 'https://test.xvyin.com'
npm run generate --workspace @xvyin/web
```

构建从指定 JSON 读取公开快照，经 `PublicSnapshotSchema` 严格验证后生成真实 HTML 到 `apps/web/.output/public`。任何未识别字段、私有资产字段或非公开照片状态会阻止构建。输入只允许后端受控发布过程产生的快照，禁止把后台草稿直接传入。未设置输入时仅构建空站用于本地检查；正式发布运行器必须显式提供已验证的快照及 releaseId。

`XVYIN_PUBLIC_ORIGIN` 默认 `https://test.xvyin.com`，所有 canonical 与 og:url 跟随它。测试构建默认 `noindex,nofollow`，robots.txt 禁止抓取。只有显式设置 `XVYIN_INDEXABLE=true` 且 origin 严格为 `https://xvyin.com` 才生成可索引规则与站点地图。每页包含 `xvyin-release` 元数据供发布核验。

私有 R2 + Pages Functions 网关的发布、回滚、域名与 API 绑定由根目录工作流负责。本目录不直接部署。

## 本地联调

```powershell
npm run dev:web
```

API 保持同源 `/api/v1`。GET `/comments` 仅读取审核公开数据；POST `/comments` 接收后保持待审，前端不会自行添加到公共列表。私信 POST `/contact` 与公开留言完全分离。表单携带 `Idempotency-Key`，失败保留输入，重试保留同一键；服务端负责最终校验和限流。

`MusicEngine` 在应用外壳中保持一个音频实例。音乐控件只操作该实例；内容音视频使用真实 HTML 媒体控件。`MediaFocusManager` 捕获播放事件，暂停此前发声媒体，结束或失败不自动恢复其他媒体。默认不播放，音视频 `preload=none`。外部视频采用受控 providerRef 的原平台链接。

健身计数使用共享 contracts 的上海日历算法，由 `/time` 返回的服务器日期驱动；一分钟内刷新并在页面恢复可见时重新确认。服务器时间失败时隐藏数字，只保留明确开始日期。null 状态不显示数字。

## 检查

```powershell
npm run typecheck --workspace @xvyin/web
npm run generate --workspace @xvyin/web
```

Nuxt 4.5.2 当前版本与 Node 22.23.2 兼容；Nuxt 3 已于 2026-07-31 结束支持，因此本项目没有使用旧维护分支。官方依据：https://nuxt.com/docs/4.x/community/roadmap 。本地字体与原头像来自已接受设计包，未修改原像素；摄影和健身素材只在管理员明确发布后进入页面。
