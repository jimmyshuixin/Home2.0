# Read-only storage inventory and retention review

`src/storage-inventory.ts` provides `StorageInventory(store, bucket, now)`. Its bucket type exposes only `list` and `get`; the module never writes, deletes, issues HEAD requests, or retrieves object bodies other than the bounded active-release pointer. Pure DTOs live in `src/storage-inventory-types.ts` so the administrator application does not import Worker globals.

## Administrator API contract

The application binds these methods under authenticated, no-store administrator routes. POST requests require the existing Origin and CSRF checks and strict schemas.

| Route | Service call | Body |
| --- | --- | --- |
| GET `/api/v1/admin/maintenance/storage` | `getStatus()` | none |
| POST `/api/v1/admin/maintenance/storage/start` | `start(input)` | `{expectedVersion, keepRecent?}`; keepRecent 3–10, default 5 |
| POST `/api/v1/admin/maintenance/storage/advance` | `advance(input)` | `{jobId, expectedVersion}` |
| POST `/api/v1/admin/maintenance/storage/pause` | `pause(input)` | `{jobId, expectedVersion}` |

Every method returns `StorageInventoryStatus`. The frontend uses the returned `version` and `job.id`; raw R2/Store cursors and lease tokens never leave the service. A stale duplicate request returns current progress without advancing it. An unknown/replaced job ID returns 409. Start never replaces unfinished work; resume uses advance. Starting a completed/limited run replaces the single latest result, keeping storage bounded.

The client should advance sequentially, stop its loop when paused/failed/completed/limited or `canAdvance=false`, show sanitized `lastError`, and support explicit retry/continue. `busy=true` means another request holds the lease; refresh later. A paused job may have `canAdvance=true`: that is permission for explicit resume, not an instruction to automatically resume. Refresh after the displayed UTC budget reset.

## Work, checkpoint and budget lifecycle

1. Start creates the summary checkpoint without R2 access.
2. Each advance transaction reads source state and the fixed budget record, then obtains the current clock. It reserves one attempt and a 60-second token lease.
3. Outside the transaction callback, perform at most one R2 list (`limit:100`, `include:[]`), or one Store list of release records (`limit:5`). The first object step and final metadata step also read `active-release.json`, capped below 4096 bytes. R2 list sizes provide the accounting directly.
4. A final transaction commits the totals/cursor only if job ID, version, lease token and unexpired lease still match. Pause invalidates in-flight results. Expired or replaced lease results are discarded. Retrying a failed page retains its old checkpoint. Reservation attempts are not refunded after failures, pauses or lost responses.

R2 enumeration follows `truncated`, not object count. It moves from `objects` to `release_records`, then `done`. These are time-window observations, not a transaction across R2 and Firestore. Concurrent object writes/deletes/overwrites may change observed totals.

Limits: at most 200 R2 pages (20,000 returned objects), 200 release records, 200 retained release object groups and 400 attempted steps per run; 200 reserved steps and 3 starts per UTC day across administrators. A step has at most one R2 list and one active-pointer GET. Work that cannot finish within limits is explicitly `limited`, with incomplete coverage. A final expired lease may need one zero-I/O advance to checkpoint `limited`, even if the daily budget is exhausted. This avoids trapping an exhausted run. A subsequent run does not extend the old run beyond its safety limit.

Only two fixed Store documents are used: `maintenance/storage_inventory` and `maintenance/storage_inventory_budget`. The budget stores its day and resets only when the observed UTC day advances; a clock rollback never reissues an allowance. No daily budget document or individual-object history accumulates.

## Accounting and interpretation

| Category | Source prefix |
| --- | --- |
| originals | `originals/` from Media upload |
| variants | `variants/` from Processing plans |
| releases | `releases/`, including files, manifests, preparation and public indexes |
| snapshots | `private-snapshots/`, `private-snapshot-sources/`, `private-snapshot-preparation/` |
| other | Everything else, including `active-release.json` |

Only completed R2 objects and payload bytes are counted. Incomplete multipart uploads/parts do not appear in this list and are excluded. The result is not billed GB-month usage, account-wide operation consumption, or the amount of free quota remaining. List is an R2 Class A operation and pointer GET is Class B; conservative local budgets do not guarantee that the rest of the account is within the free tier.

Release grouping stores only bounded IDs and count/byte aggregates. Unknown/malformed release IDs and groups beyond the cap contribute to `unknownReleaseObjects`; they are never called unreferenced. Source object keys, filenames, custom metadata, author IDs, selected revision IDs and upstream error text are not exposed in DTOs. Retention entries contain a selected revision **count** only.

## Retention review is not garbage collection

Every plan and entry has `deleteAllowed:false`. No delete endpoint, automatic collection or “safe to delete” classification is provided.

- Protect both first and final observed active pointers, with `activeObservedAt` as the observation time. It is not a fresh authorization after a new release switches the pointer.
- Independently protect queued, building, ready, activating and reconciling jobs.
- Protect the newest N ready/live/superseded records, sorted by valid creation time then ID. Failed builds do not displace successful rollback history. A historical `live` state alone does not identify the current pointer.
- Other complete known records are `review_only`; missing/invalid records or incomplete metadata scan yield `unknown`.
- `previousReleaseId` and `referencedByReleaseIds` report observed relationships, not a verified reference closure. Shared media, historical revisions and snapshot contents have not been fully audited. Their reference coverage remains unknown.

Never turn a retention suggestion into deletion without a separate implementation and fresh active-pointer, in-progress-release and complete reference review. Age, status and being outside the newest-N policy do not constitute deletion permission.

## Validation and current official references

`node node_modules/vitest/vitest.mjs run workers/api/test/storage-inventory.test.ts --maxWorkers=1` exercises real local workerd R2 and SQLite. It covers exact prefix totals and multipart exclusion; provider-short pagination; empty storage; pause/reload; concurrent starts and advances; failure/retry; expired leases; transaction callback replay; acknowledged-lost commits; UTC rollover/rollback; final attempt exhaustion; caps and unknown coverage; changing active pointers; and successful rollback retention despite recent failures.

References checked 2026-09-29:

- [R2 Workers API reference](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/): list metadata, limit/cursor and truncated semantics.
- [R2 limits](https://developers.cloudflare.com/r2/platform/limits/): object key and provider limits.
- [R2 pricing](https://developers.cloudflare.com/r2/pricing/): Class A/B operations, Standard free-tier scope and GB-month accounting.
- [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/): bindings and bounded I/O.

Current `@cloudflare/workers-types` 5.20260929.1 was retrieved to an external evidence directory for API comparison; project dependencies were not changed by this module work.
