# xvyin 管理端

独立 Vue / Vite 客户端，生产入口 `/admin/`，只请求同源 `/api/v1`。不包含 Firebase 浏览器 SDK、后端密钥、初始管理员密码或演示业务数据。数据库与认证未配置时显示后端错误，不生成模拟成功结果。

## 可用管理流程

- 总览、创作、摄影、健身、歌单、评论审核（含私密联系）、媒体、统计、设置九个入口。
- 创作统一编辑八类内容块；文字为结构化富文本，图片、图集、音频、视频、引用、代码和附件均使用合同字段。上下移动与拖动排序；媒体从已处理完毕的媒体库选择。
- 摄影与健身照片独立编辑替代文字、图注、拍摄日期、排序、精选和发布状态。只有选择“随本条记录发布”的照片进入候选版本；开始日期空值不显示天数。
- 草稿写入携带 `expectedVersion`。版本冲突保留当前编辑，要求重新读取并合并；会话失效时登录覆盖层保留当前组件内存。离页或刷新时提示未保存内容。关闭页面不会将业务草稿写入浏览器存储。
- 发布由后端真实任务状态驱动：生成候选、认证预览、激活；历史可用版本使用同一 CAS 激活端点恢复。状态、版本和日期来自服务响应。私有预览 Cookie 状态可退出。
- 512,000,000 字节视频上限、10,000,000,000 字节总额度。增量 SHA-256，每次只读 5 MiB；上传分片大小与数量始终读取 API 的 `partSize` / `totalParts`，进度是服务器确认字节。刷新后重新选择同名、同大小并且同 SHA-256 的原文件续传。`sessionStorage` 仅保存上传续传元信息。媒体处理成功前不可选择用于发布。
- 登录、退出、当前密码复验后的修改，以及本站邮箱恢复链接处理。实际账号/邮箱/UID 来自后端运行配置。恢复入口读取 `oobCode` 后立即从地址栏删除。

## 本地构建

在仓库根统一安装依赖后：

```powershell
npm run typecheck --workspace=@xvyin/admin
npm run build --workspace=@xvyin/admin
npm exec vitest run apps/admin/tests/api.test.ts
npm run dev --workspace=@xvyin/admin
```

开发端口 5174，API 代理至 127.0.0.1:8787。在另一个终端运行根目录的 `npm run dev:api` 启动持久 SQLite / 本地 R2 后端；真实 Firebase 管理员配置见 `scripts/v3/README.md`，缺配置时登录保持关闭。

## 隔离浏览器验证

以下入口**只用于自动化 UI 测试**：真实 `createApi` 路由、内存测试存储与明确的本地测试身份。不能用于开发后端或生产服务，R2、Firebase 和 GitHub 远端操作均不启用。所有页面带不可混淆的红色测试夹具标识；测试记录随进程结束清空。

```powershell
# 终端一，先完成上面的 build
$env:XVYIN_UI_FIXTURE='1'
npm exec tsx apps/admin/tests/browser-fixture.ts
# 终端二
node apps/admin/tests/browser-smoke.mjs
```

浏览器测试只允许固定 `http://127.0.0.1:5194`，使用独立 headless Edge，`XVYIN_TEST_BROWSER` 可指定本地 Chromium 可执行文件。截图与结果写入仓库外 `../admin-ui-qa/`。测试覆盖登录、真实草稿 POST/CSRF、八类编辑块与排序、照片状态、媒体空态、健身空日期保存、歌单曲目保存、留言/联系、设置保存、发布空态以及 390 px 手机布局。该检查不代表 Firebase 云端登录、512 MB 上传、媒体处理或 GitHub 构建发布已验收。
