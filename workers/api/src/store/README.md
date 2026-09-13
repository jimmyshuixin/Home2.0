# Storage adapters and Google service-account OAuth

`Store` persists private application records under `collection/id`. All reads inside a transaction must complete before any put/delete. Transaction callbacks may be re-run on explicit database contention and must not send email, upload media or perform other external side effects. Put captures an immutable serialized value; a transaction handle becomes unusable when the callback ends.

## Adapters

- `MemoryStore(seed?)`: deterministic test adapter only. The application must never choose it as an unconfigured production fallback.
- `SqliteStore(filename)`: real local Node `node:sqlite` persistence, WAL, FULL synchronous mode and BEGIN IMMEDIATE transactions. All in-process connections to the same canonical file share a queue; SQLite locking also protects against other processes. Transient lock contention gets bounded retries. Call `await close()` before removing a test database. This file is Node-only and must not be imported into the Worker bundle. Node 22.23.2 marks its SQLite API experimental.
- `FirestoreStore({projectId,databaseId,edition:'standard',collectionPrefix?},{getAccessToken,fetch?,timeoutMs?,maxAttempts?})`: fixed Google REST endpoints, explicit Standard/Native configuration, `v3_` namespace by default. A different prefix must still begin with `v3_`. Missing or unsupported configuration fails closed. It never selects a Firebase project, provisions infrastructure, reads the legacy guestbook, or migrates data automatically.

Firestore stores `record_json.stringValue` and `schema_version.integerValue=1` in each private document. This isolates the application JSON schema from Firestore-specific value encoding. It is not a queryable public projection. `list` orders by document ID, requests at most five records per upstream query, and reuses readTime while assembling one page. Public filtering and safe projection belong in repositories/routes.

The fixed `queryMedia` exception uses the private `media_catalog` projection. Every `media/<id>` transaction write also updates this catalog atomically; verified, active files also update a SHA-256 lookup in `media_hashes`. Catalog documents additionally store single-field `sort_created`, `sort_name`, and `sort_size` strings with an ID suffix for stable ordering. A query uses one of these fields only and needs no composite index. Filename ordering is case-insensitive Unicode ordering, not locale/pinyin collation. Other media filters are applied to a bounded 48-record ordered scan. An empty filtered page with a continuation cursor does not mean there are no more matches. Changing filters or ordering invalidates the cursor.

Before using the catalog, `MediaLibrary.advanceCatalog()` backfills five legacy media records per call, using fresh transaction reads. New writes maintain the projection during this migration. Until the persisted catalog state is ready, library reads report `catalogReady: false` rather than omitting old records. Duplicate lookup rechecks the actual media status, lifecycle, kind, size and verified hash; a stale hash pointer never authorizes reuse. Deleted media retain tombstones but leave the catalog.

Permanent deletion uses a resumable reference-check task, not a collection-wide Worker request. During its 15-minute check/confirmation window, a shared lifecycle fence pauses record saves and candidate creation. Existing public reads continue. Cancelling or expiration releases this pause. Confirmation turns the target into a `purging` tombstone and releases the global fence, so unrelated editing continues during cleanup retries. Saved media references are checked in batches of 100 (maximum 2000 distinct references per save), and the final save transaction verifies the lifecycle epoch has not changed. Each cleanup step deletes one owned R2 object. The final transaction changes the tombstone to `deleted` and deducts the complete original-plus-variants byte count exactly once. No automatic retirement of historical revisions/releases or cleanup of unconfirmed failed processing reservations is implied.

Standard edition automatically indexes fields; the deployment configuration should exempt `record_json` from single-field indexing because this adapter never queries its contents. Expiry values inside that JSON string are not Firestore TTL timestamp fields. Session, rate-limit and idempotency cleanup therefore needs an application cleanup job or a separately reviewed timestamp projection and TTL configuration. This adapter does not provision either.

## Statistics bootstrap and correction

`system/statistics` is an explicitly initialized, versioned projection maintained in the same transactions as content creation, first idempotent submission and pending-comment moderation. Its absence means unknown: the statistics endpoint returns null counts and never scans the database. Updating a draft does not increase the content count.

Before initializing an existing namespace, pause admin writes and anonymous submissions. Call `statisticsRebuildPage(store, collection, cursor?)` from `records.ts` separately for creations, albums, fitness, playlists, comments and contacts; persist the running sums and returned cursors in a trusted operator runner. Each call fetches one page of at most 50 records. Continue a collection until nextCursor is null; count comments only when pending. Do not put that loop into one HTTP Worker request. For a newly verified empty namespace the operator may explicitly supply six zero counts instead of scanning, but code must never infer this from a missing statistics document.

After all pages are accounted for, call `installStatisticsProjection(store, counts, expectedVersion, trustedNow)`. Supply null only when no valid projection exists. If a valid projection existed, capture its version before scanning and pass that version: any intervening counted write makes installation fail with VERSION_CONFLICT. Uninitialized writes do not increment a projection, so the maintenance pause is mandatory for that initial scan. Resume writes only after installing the result. This procedure writes only the V3 namespace chosen by the operator; it does not inspect or count legacy records. No bootstrap or correction is performed automatically by the request factory.

Only an explicit Firestore ABORTED response triggers transaction retry with fresh reads. A transport failure during commit is ambiguous and is returned as unavailable without replaying the callback. The client's retry must use the original idempotency key so the application can retrieve an already-committed result. Rollback is awaited best effort and does not mask the original error.

## Data boundary

Storage rejects values that JSON would silently change or drop: undefined, NaN/Infinity, unsafe integers, BigInt, Dates, Maps/classes, getters, symbols, sparse arrays and cycles. Records must be no larger than 900 KiB of UTF-8 JSON and must have bounded depth/size. `get<T>` is a caller-provided business type, not runtime schema validation; routes/repositories must use the shared Zod schemas when accepting data and before producing public output.

List limits are 1–50 (default 20). Cursor tokens are validated and bound to the collection. Keys never permit slashes in IDs, traversal, arbitrary collection nesting or interpolated SQL. All SQLite values are bound parameters. Provider errors and bodies are not exposed.

## OAuth

`createGoogleAccessTokenProvider({projectId,clientEmail,privateKey},{scopes?,fetch?,now?,timeoutMs?})` returns an async token getter. Create it inside each Worker request factory; it reuses a token/signing key and de-duplicates issuance within that factory, without a module-level pending I/O promise. Default scope is only `datastore`. Key import/JWT signing use jose RS256, a fixed token endpoint/audience, one-hour assertions, bounded requests/responses, and token refresh at least 60 seconds before expiry.

For the present Firestore + Identity Platform admin account lookup/update path, explicitly select `GOOGLE_OAUTH_SCOPES.datastore` and `GOOGLE_OAUTH_SCOPES.identityToolkit`. The Identity Platform account lookup API documents identitytoolkit/cloud-platform scopes and the IAM permission `firebaseauth.users.get`. OAuth scopes do not grant IAM permissions, and `firebase` alone must not be assumed to authorize those methods. Configure only the additional IAM operations actually needed for account lookup/update and Firestore CRUD. Do not grant project Owner merely to make an adapter work.

No service-account key, production token, Firestore project data or actual network call is used in the adapter tests. OAuth tests generate a temporary RSA key in process. Firestore tests verify the REST protocol with injected fetch, including missing documents, fresh-read contention retries, ambiguous commits, rollback, namespace isolation and bounded pagination. They do not certify the actual project's edition, IAM, region, backup state, latency or bill.

## Checks and references

From the repository root:

```text
node node_modules/typescript/bin/tsc -p workers/api/src/store/tsconfig.json --noEmit
node node_modules/vitest/vitest.mjs run workers/api/test/store.test.ts workers/api/test/google-oauth.test.ts workers/api/test/firestore.test.ts
```

Current official references checked for this implementation:

- [Node 22.23.2 SQLite](https://nodejs.org/download/release/v22.23.2/docs/api/sqlite.html)
- [Cloudflare Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
- [Google service-account OAuth](https://developers.google.com/identity/protocols/oauth2/service-account)
- [Firestore beginTransaction](https://docs.cloud.google.com/firestore/docs/reference/rest/v1/projects.databases.documents/beginTransaction), [batchGet](https://docs.cloud.google.com/firestore/docs/reference/rest/v1/projects.databases.documents/batchGet), [commit](https://docs.cloud.google.com/firestore/docs/reference/rest/v1/projects.databases.documents/commit), [runQuery](https://docs.cloud.google.com/firestore/docs/reference/rest/v1/projects.databases.documents/runQuery)
- [Identity Platform account lookup scopes and IAM permission](https://docs.cloud.google.com/identity-platform/docs/reference/rest/v1/projects.accounts/lookup)
