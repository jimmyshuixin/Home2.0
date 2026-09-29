# 失败媒体清理与重新上传

此流程使用现有管理员媒体库、回收站和永久删除接口。不会自动清理生产文件，也不会尝试把旧失败任务换成新 run 覆写同一个 asset。

## 管理员步骤

1. 在媒体库筛选“处理失败”，将文件移入回收站。
2. 在回收站选择“永久删除”，逐页检查当前内容、草稿、历史 revision、候选和已发布 release 的引用。存在引用则保留文件。
3. 检查通过后，页面分别显示将释放的已用容量和处理预留。管理员再次确认才开始删除。
4. 系统先结束已知的未完成上传，再逐个核对、删除原件与变体。中断时在同一清理任务选择继续；全部清理确认后才一次性释放容量。
5. 显示清理完成后，从媒体库重新上传本地原文件，新上传使用新 asset ID。删除不可恢复，请先保留原文件。

“有上传初始化结果未能确认”意味着缺少可信的 R2 multipart handle。该任务保留容量，不能通过等待、反复点击或切换新 run 自动解除。需在存储管理侧完成独立对账；本次没有引入 R2 S3 凭据或自动猜测 handle。旧记录中 `planned` 且没有 handle、也没有明确“尚未开始初始化”标记的情况同样保留。

## 一致性边界

- 引用检查继续使用现有媒体 fence。确认事务重新验证版本、处理记录指纹和额度，并给失败 processing 写入不可逆的 `cleanupId`，媒体进入 `purging`。
- processing 的领取、读取、计划、分片、合并、完成、失败入口均检查 cleanupId；涉及外部 I/O 的后续写事务也重新检查。同一旧 run 不能在清理后继续登记成果。
- 未结束的分片/合并 lease、初始化 marker 阻止开始清理。合并调用结束后按 token 释放自身 lease，使短期重试立即可用；保留尚未结束调用的 lease。
- 所有持久化 multipart handle 先 abort，再删除任何对象。并发的旧 complete 要么先完成并被后续删除，要么因 handle 结束无法完成；不能仅删除对象后假设旧任务不再写。
- 原件核对原始 R2 version/etag/字节；已完成变体核对预定 key、run、role、SHA 元数据、multipart etag 和字节。对象身份变化则暂停、保留额度。
- 每次 advance 最多 abort 一个 handle 或 delete 一个 key。删除后 HEAD 确认不存在，再事务更新进度；网络错误和未确认提交不当作成功。
- 失败任务的原件仍计 `usedBytes`；未 finish 的变体计划即使已有完成对象仍计 `reservedBytes`。最后在同一事务扣两者、写 media tombstone、processing cleanedAt 和审计。并发重试或提交响应丢失不会再次扣减。
- 新版初始化明确区分尚未开始、已知 handle 和结果未知；已知 handle 在数据库响应异常时仍尽力持久化，未知结果不会再次 create。

公开给管理 UI 的清理结果仅含 recovery 布尔值、reservedBytes、totalUploads、abortedUploads 与既有文件计数；不包含底层 key、run 指纹或 multipart handle。

## 验证

`workers/api/test/failed-media-recovery.test.ts` 使用本地真实 Miniflare R2 和 MemoryStore，覆盖部分上传/合并后失败、历史引用、active lease、unknown create、已知 handle 的提交响应丢失、abort/delete ACK 丢失、并发 advance、最终提交响应丢失、在途 uploadPart/complete、对象变化、HEAD 未确认及合并立即重试。它不认证实际云环境的吞吐、延时、账单或历史未知 multipart。

```text
node node_modules/vitest/vitest.mjs run workers/api/test/failed-media-recovery.test.ts workers/api/test/processing.test.ts workers/api/test/media-library.test.ts --maxWorkers 1
```
