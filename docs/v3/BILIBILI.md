# Bilibili public profile and embedded video

The site owner's declared UID is `520237303`. Public UID display is independent of the optional administrator-only account binding described below. The public API exposes only public information and never lends the owner's login to visitors or embedded players. This integration is **not** approved Open Platform OAuth.

## Public profile

`GET /api/v1/bilibili/profile` returns the strict `BilibiliProfileSchema` envelope. It exposes name, signature, avatar, follower count, public video count, likes and the fetch timestamp. Missing counts stay `null`. `authorization` is always `public`. The UI labels selected works as content already collected on this site, not the account's full or latest upload list.

The server reads the fixed public website endpoint `https://api.bilibili.com/x/web-interface/card?mid=520237303`. This is a best-effort website endpoint, not the approved Open Platform OAuth API; it can change or deny requests. There is no WBI challenge bypass, cookie import, scraping of private pages or arbitrary URL proxy. Production egress must be verified independently of a local fetch.

Existing optional edge cache provides one hour of freshness, at most 24 hours of stale retention, and five minutes of failure backoff. Cache eviction or unavailability can cause a new bounded upstream request. Anonymous profile requests perform no database writes. Responses have a five-second total deadline and a 64 KiB body limit. `stale` retains the original update time; `unavailable` never fabricates a count. Only fixed Bilibili avatar hosts and paths are accepted. Workers requests use `redirect: manual` and reject redirects; the runtime does not support `redirect: error`.

When the server cannot retrieve current data, a separately validated public snapshot in `workers/api/src/bilibili-profile-snapshot.json` can be returned with status `snapshot`. Its original timestamp is always shown and it is never labelled current or authenticated. This historical snapshot has no automatic expiry; fresh upstream data supersedes it when available. Refresh the packaged snapshot only from an actual successful sanitized response and include the new capture timestamp in the next deployment. Account binding enables periodic synchronization; an unbound account still uses the public path and dated fallback.

## Video embeds

The existing `providerRef` remains the source of truth. Valid BV/av IDs produce a Bilibili official iframe; valid YouTube IDs use the privacy-enhanced iframe host. The iframe is mounted only after an explicit click, with autoplay disabled, a reserved responsive area, fullscreen, close/reload controls and an original-platform link. Loading an iframe does not prove the video is playable. Region, login, browser, platform and uploader restrictions still apply.

The shared media focus manager pauses site audio before opening an iframe and removes the iframe when another media item starts. No unsolicited resume occurs. Bilibili multi-part videos currently use the first part. Raw iframe HTML and arbitrary player URLs are never accepted. The public HTML CSP allows only `player.bilibili.com` and `www.youtube-nocookie.com` in addition to self; admin policies remain separate.

## Administrator QR binding

The owner explicitly selected server-side account storage. Settings contains an administrator-only Bilibili panel using the publicly documented TV-client QR protocol. Its implementation is based on protocol behavior verified in [biliup's current client](https://github.com/biliup/biliup/blob/master/crates/biliup/src/uploader/credential.rs), without importing or executing the uploader. This obtains a full account session, not a platform-enforced read-only token. The application only implements identity checks and reads for display; it has no upload, comment, like, message or account-modification functions.

`BILIBILI_CREDENTIAL_KEY` is a separately provisioned 32-byte random hex Worker secret. AES-GCM encrypts both short-lived QR transaction codes and account credentials before storage in the existing private Firestore. Additional authenticated data binds ciphertext to its purpose and account/session. The key must not be placed in source, logs, `.env` committed files, build outputs or public bindings. Replacing it invalidates existing encrypted credentials and requires a new scan. The administrator browser receives only the short-lived official QR URL, rendered locally by the bundled QR library; it never receives account cookies or access/refresh tokens.

Routes, all under existing administrator session and mutation CSRF/origin checks:

- `GET /api/v1/admin/bilibili`: projected status and sanitized display data.
- `POST /api/v1/admin/bilibili/qr`: creates a three-minute transaction scoped to the administrator session, limited to five attempts per ten minutes.
- `POST /api/v1/admin/bilibili/qr/:transactionId/poll`: polls serially; successful token/cookie UID and authenticated identity must all match `520237303`. Binding success starts background initial synchronization.
- `POST /api/v1/admin/bilibili/sync`: manual synchronization, limited to twice per five minutes.
- `POST /api/v1/admin/bilibili/unlink`: removes the site's stored account credentials and stops its authenticated synchronization. It retains timestamped public display data; it does not claim to revoke all Bilibili sessions.

The Worker cron `15 */6 * * *` attempts synchronization every six hours, independently of the existing daily analytics cleanup. An unbound account makes no Bilibili login/sync requests. The TV refresh protocol uses the matching TV platform constants. Failure preserves the last successful public snapshot and records a fixed error classification without raw provider bodies or credentials. QR, sync and rebind operations use transaction fences to prevent an old operation overwriting a newer binding or undoing unlink.

The optional `works` list is fetched from the public space API and each candidate is checked through an anonymous video-detail request for public visibility and matching owner before display. It is distinct from the site's existing curated `本站收录` content. Private drafts, income, messages, viewing history and unrelated account fields are not part of the public projection. Bound public data uses a 60-second edge cache; original capture times remain visible.

Deployment alone does not prove that Bilibili accepts the server's IP. On 2026-09-26 a credential-free Cloudflare remote-preview probe returned HTTP 412 for QR creation and public profile, while the identical local request returned code 0. Verify the actual production route before asking the owner to scan, and never call a blocked or merely rendered login flow a completed binding. No external proxy, cookie-import form or alternate credential relay is configured.

Official OAuth remains a separate alternative requiring a reviewed Open Platform application, approved permissions and callback domain. A UID or ordinary login link must never be presented as completed OAuth authorization.

Official references checked on 2026-09-26:

- [Bilibili external player](https://player.bilibili.com/)
- [YouTube player parameters](https://developers.google.com/youtube/player_parameters)
- [Bilibili account authorization](https://open.bilibili.com/doc/4/eaf0e2b5-bde9-b9a0-9be1-019bb455701c)
- [Web OAuth entry and callback](https://openhome.bilibili.com/doc/4/aac73b2e-4ff2-b75c-4c96-35ced865797b)
- [Authorized account information](https://open.bilibili.com/doc/4/feb66f99-7d87-c206-00e7-d84164cd701c)
- [Authorized user statistics](https://open.bilibili.com/doc/4/90936ab5-7c06-e24f-2ad0-0fd6e10c7386)
