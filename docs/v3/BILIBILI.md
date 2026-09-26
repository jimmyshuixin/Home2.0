# Bilibili public profile and embedded video

The site owner's declared UID is `520237303`. This configuration displays public account information; it is **not** proof of account control or an OAuth authorization. No Bilibili credentials, cookies, tokens or visitor login are collected.

## Public profile

`GET /api/v1/bilibili/profile` returns the strict `BilibiliProfileSchema` envelope. It exposes name, signature, avatar, follower count, public video count, likes and the fetch timestamp. Missing counts stay `null`. `authorization` is always `public`. The UI labels selected works as content already collected on this site, not the account's full or latest upload list.

The server reads the fixed public website endpoint `https://api.bilibili.com/x/web-interface/card?mid=520237303`. This is a best-effort website endpoint, not the approved Open Platform OAuth API; it can change or deny requests. There is no WBI challenge bypass, cookie import, scraping of private pages or arbitrary URL proxy. Production egress must be verified independently of a local fetch.

Existing optional edge cache provides one hour of freshness, at most 24 hours of stale retention, and five minutes of failure backoff. Cache eviction or unavailability can cause a new bounded upstream request. The API performs no database writes. Responses have a five-second total deadline and a 64 KiB body limit. `stale` retains the original update time; `unavailable` never fabricates a count. Only fixed Bilibili avatar hosts and paths are accepted.

When the server cannot retrieve current data, a separately validated public snapshot in `workers/api/src/bilibili-profile-snapshot.json` can be returned with status `snapshot`. Its original timestamp is always shown and it is never labelled current or authenticated. This historical snapshot has no automatic expiry; fresh upstream data supersedes it when available. Refresh the packaged snapshot only from an actual successful sanitized response and include the new capture timestamp in the next deployment. No periodic GitHub job or guaranteed live synchronization is configured.

## Video embeds

The existing `providerRef` remains the source of truth. Valid BV/av IDs produce a Bilibili official iframe; valid YouTube IDs use the privacy-enhanced iframe host. The iframe is mounted only after an explicit click, with autoplay disabled, a reserved responsive area, fullscreen, close/reload controls and an original-platform link. Loading an iframe does not prove the video is playable. Region, login, browser, platform and uploader restrictions still apply.

The shared media focus manager pauses site audio before opening an iframe and removes the iframe when another media item starts. No unsolicited resume occurs. Bilibili multi-part videos currently use the first part. Raw iframe HTML and arbitrary player URLs are never accepted. The public HTML CSP allows only `player.bilibili.com` and `www.youtube-nocookie.com` in addition to self; admin policies remain separate.

## Future authenticated account connection

Official OAuth requires a reviewed Bilibili Open Platform application, approved permissions and a matching callback domain. Implement a separate administrator binding flow only after those prerequisites and the platform's data handling requirements are met. Store and rotate server-side tokens, validate OAuth state, support revocation/unbinding and use the application-scoped `openid`. An ordinary Bilibili login page or UID must not be presented as a completed binding.

Official references checked on 2026-09-26:

- [Bilibili external player](https://player.bilibili.com/)
- [YouTube player parameters](https://developers.google.com/youtube/player_parameters)
- [Bilibili account authorization](https://open.bilibili.com/doc/4/eaf0e2b5-bde9-b9a0-9be1-019bb455701c)
- [Web OAuth entry and callback](https://openhome.bilibili.com/doc/4/aac73b2e-4ff2-b75c-4c96-35ced865797b)
- [Authorized account information](https://open.bilibili.com/doc/4/feb66f99-7d87-c206-00e7-d84164cd701c)
- [Authorized user statistics](https://open.bilibili.com/doc/4/90936ab5-7c06-e24f-2ad0-0fd6e10c7386)
