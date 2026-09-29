# 抖音公开资料小时同步

此任务采集配置账号的公开资料和最多 6 条公开作品。它不是 OAuth 绑定，不接收用户登录 Cookie、密码或 Token。第三方采集器只运行在独立的 `douyin` job；该 job 没有 OIDC 写权限、站点密钥或部署权限。可信导入器只读经过字段白名单校验的 JSON。

## 失败与重试

- 上游浏览器代码会把导航异常包装成 `BackendFailure`。采集器最多检查 4 层原因链，保留超时、网络、上游限制等分类；循环、截断和未知异常不会获得重试授权。
- 游客初始化最多尝试 2 次，只对明确的超时、连接异常或 Playwright 固定网络错误码重试一次，等待 2 秒。两次调用使用同一个 `MintPlan`、临时资料目录、来源地址和 `proxy=None`。不切换身份或出口，不更改签名行为。
- 已识别的风控、限流、权限限制、无效数据，以及无法识别的 `BackendFailure`、通用操作系统错误直接停止。没有游客 Cookie、需要登录或不能公开取得数据时，不提供绕过方式。
- 资料和作品接口各最多请求一次，不递归翻页。资料成功而作品失败时导入新资料、保留旧作品；资料失败时保留最后一次有效资料和时间。失败不制造零粉丝、空作品或新采集时间。
- 单次调用的协作超时为 35 秒；整体采集协作超时为 180 秒，原有 shell `timeout 240` 和 job 8 分钟限制保持不变。`asyncio.wait_for` 会等待底层取消完成，不能当作绝对硬实时退出保证。

`douyin-public.json` 的公开数据契约不变。`douyin-public-diagnostics.json` 可新增 `causeTypes` 和固定枚举 `browserNetworkCode`；发生自动重试时有最多一条 `retries`，说明尝试次数、等待时间及脱敏原因。诊断不记录异常消息、完整路径、请求 URL、Cookie、请求头或上游响应正文。诊断只在 GitHub artifact 中短期保存，不进入网站数据。

## 部署到真实小时任务

工作流是 `.github/workflows/public-social-sync.yml`，由现有 Worker 在每小时第 17 分钟调用 `workflow_dispatch`。工作流只接受 `jimmyshuixin/Home2.0` 的 `refs/heads/main`，所有 checkout 固定到本次 `github.sha`。

1. 将审核并测试过的采集器修复应用到 `main`。仅推送生产站点分支不会改变小时任务。
2. 保留 main 限定、现有 OIDC 校验、独立 runner 及无登录凭据边界；不为测试放宽信任范围。
3. 可以等待下次定时执行，或在当前 UTC 小时预算未使用时，通过原有 main 工作流手动触发一次。claim 仍每 UTC 小时最多接受一次；不绕过限额。
4. 验证新运行的完整 `headSha`，下载同一 run 的脱敏诊断，核对 profile/works 的状态和公开 API 时间。成功必须归因到实际运行的代码版本；修复前自然恢复的成功不能作为新代码上线验证。

若在专用 main 工作树中 cherry-pick 修复，请注意该工作树可能没有生产分支的测试文件。遇到测试路径的 modify/delete 冲突，应保留修复提交里的完整测试文件，再在 main 工作树运行它，不能仅跳过冲突。

## 验证

```sh
python -m unittest discover -s scripts/v3/test -p test_douyin_public_collector.py -v
npx vitest run scripts/v3/test/public-social-sync.test.ts --maxWorkers=1
```

Python 回归不导入第三方浏览器、不访问网络；覆盖真实上游异常包装形状、临时网络故障恢复、两次上限、限制类错误、截断/循环原因链、单次/整体取消、脱敏和最后有效数据行为。云端可达性需由实际 GitHub runner 单独验证，一次成功不保证平台后续持续可用。

## 上游依据

- [当前固定 DTK revision 的 CloakBackend](https://github.com/Evil0ctal/Douyin_TikTok_Download_API/blob/d21b92ec28e481795f4c8530ee6dc0f7d40da69d/docker/browser_rpc/backends/cloak.py)：导航错误包装和 finally 关闭 context。
- [Python 异常原因链](https://docs.python.org/3/library/exceptions.html#exception-context)：显式 cause 和被抑制的 context。
- [Playwright TimeoutError](https://playwright.dev/python/docs/api/class-timeouterror)：浏览器自己的异常类型。
- [asyncio.wait_for](https://docs.python.org/3/library/asyncio-task.html#asyncio.wait_for)：超时通过取消协作完成。
