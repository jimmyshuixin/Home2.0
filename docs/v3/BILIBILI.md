# Public social profiles and embedded videos

The owner chose credential-free public display. Bilibili administrator QR login, binding, credential encryption, TV-client protocols and account-token refresh have been removed. The site never lends an owner's login to visitors or players.

## Hourly synchronization

The existing Cloudflare Worker Cron (minute 17 of every hour) dispatches .github/workflows/public-social-sync.yml on jimmyshuixin/Home2.0's default branch main. The existing server-side GitHub deployment credential authorizes that dispatch; it is not copied to the runner. Keeping the timer in Cloudflare avoids GitHub's automatic disabling of native schedules after 60 days of public-repository inactivity. The independent daily analytics cleanup is preserved.

The standard Ubuntu runner checks out the exact workflow SHA and runs scripts/v3/public-social-sync.ts with Node 22 native type stripping. It installs no dependencies, uses no Bilibili or GitHub account credentials for provider requests, writes no commits and does not rebuild the website. Type-only contract imports are erased. Standard runners are free for this public repository; no larger runner, artifacts or caches are configured.

The runner claims one UTC hour through POST /api/v1/internal/social-sync/claim, captures public data, then imports through POST /api/v1/internal/social-sync. Each call obtains fresh GitHub OIDC. Its verifier is separate from release/media trust and fixes repository/owner IDs, refs/heads/main, exact workflow, workflow_dispatch event, hosted runner, audience, signed times, run ID, attempt and matching workflow/code SHA. No permanent import key is stored.

One control document and two profile documents bound storage. Claims expire after 15 minutes; after an unsuccessful attempt a new collection waits until the next UTC hour. Retransmission of an active claim is idempotent. Identity, capture times and ownership are checked transactionally; late jobs cannot replace newer captures. A provider failure retains its last successful data and original timestamp. Omitted project/video sections retain their earlier section/date; an explicitly successful empty list clears it.

Timers and job queues are best effort, not a strict hourly SLA. Pages expose actual last successful capture times, aging fresh data to stale and then a dated snapshot. The administrator settings panel reads this public status; its refresh button only re-reads status. Public reads use a 60-second edge cache and never expose tokens or private job state.

## Bilibili

GET /api/v1/bilibili/profile exposes the sanitized public profile for UID 520237303: name, signature, avatar, followers, public video count, likes and capture time. Its fixed anonymous website endpoint is https://api.bilibili.com/x/web-interface/card?mid=520237303. This is a best-effort website endpoint, not approved Open Platform OAuth; it may change or deny requests. Missing counts remain null.

On 2026-09-26 the [credential-free GitHub probe](https://github.com/jimmyshuixin/Home2.0/actions/runs/36248959220) returned HTTP 200/code 0 for all displayed fields. Local anonymous reads also succeeded. An earlier Cloudflare direct-egress probe returned HTTP 412; direct Cloudflare access is not evidence of ongoing successful synchronization.

Before the first cloud import, the original bounded anonymous read path and packaged bilibili-profile-snapshot.json remain a fallback. That snapshot retains its real historical timestamp. Once available, the independent imported public record supplies the card without Bilibili credentials.

The site's 本站收录 list is published site content, not a complete/latest Bilibili upload list. Anonymous space-video enumeration returned -352 in local testing; this collector does not claim to synchronize it. Profile success does not prove every API or video is available.

## GitHub

GET /api/v1/github/profile uses jimmyshuixin, immutable ID 121843277. Anonymous official REST requests fetch its public profile and owned repositories. Pagination reads the next-page indication but constructs URLs locally; page/body limits bound work. Only verified own public non-fork repositories are selected. The public repository total remains GitHub's total including forks, matching the 公开仓库 label.

Project cards show the newest eligible projects, real descriptions, primary language, Stars, Forks and push times. Project capture time is independent from profile capture time. There is no annual contribution-graph approximation using limited Events data. Anonymous rate limits are shared by egress IP, so the one hourly collector performs requests rather than every visitor.

## Embedded video and Douyin

Existing providerRef remains the media source. Strict Bilibili BV/av IDs, YouTube IDs and numeric Douyin video IDs generate only their fixed official players; raw iframe HTML is never accepted. CSP adds exactly https://open.douyin.com alongside player.bilibili.com and www.youtube-nocookie.com.

Players are created only after a click, with autoplay disabled, reserved responsive space, fullscreen, close/reload and original-platform controls. Shared media focus pauses site audio and removes another active iframe. Bilibili multi-part videos use the first part. Individual works remain subject to platform, visitor-login, region and uploader restrictions.

Douyin's official no-permission iframe API was verified for public video 7661639577056136457, and its official player actually played anonymously. About links the owner's existing profile (虚宁, tidingjinluo) and this selected photography video. Its unknown publication date is omitted. No stable anonymous source for automatic Douyin account statistics or complete latest works has been verified, so those capabilities are not advertised.

## Validation and references

Verify a real trusted claim/import, anonymous APIs with new capture times and a subsequent Cloudflare-triggered run. Website changes still require private preview, explicit activation and anonymous production checks. Never log raw provider bodies, Cookie/Authorization headers, OIDC tokens or runtime environment variables.

- [GitHub public user API](https://docs.github.com/en/rest/users/users#get-a-user)
- [GitHub public repository API](https://docs.github.com/en/rest/repos/repos#list-repositories-for-a-user)
- [GitHub rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
- [GitHub OIDC](https://docs.github.com/en/actions/concepts/security/openid-connect)
- [Native schedule limitations](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)
- [Standard runner billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
- [Cloudflare Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [Bilibili player](https://player.bilibili.com/)
- [YouTube player parameters](https://developers.google.com/youtube/player_parameters)
- [Douyin official iframe API](https://developer.open-douyin.com/docs/resource/zh-CN/dop/develop/openapi/video-management/douyin/iframe-player)
