"""Collect one account's public Douyin profile and first page, without login.

Run only in the isolated collector job. Third-party DTK and CloakBrowser code
receives no site credentials or OIDC environment. The trusted import job reads
only douyin-public.json; diagnostics never form part of the public data.
"""

import asyncio
import contextlib
from datetime import UTC, datetime
import json
import logging
import os
from pathlib import Path
import re
import tempfile
import time
import traceback
from urllib.parse import urlsplit, urlunsplit

DTK_REVISION = "d21b92ec28e481795f4c8530ee6dc0f7d40da69d"
CLOAK_REVISION = "f04c23da285b3b3d3cf10c8f9d282e7adc1d52ce"
CHROMIUM_VERSION = "146.0.7680.177.5"
TARGET = "MS4wLjABAAAAKZ2zSL9DDu1Uc3IZleN2zqIqoOpNXtwvAW4_2E6PBrLmkyTMw_MsrzxGVrQvvI1-"
PROFILE_URL = f"https://www.douyin.com/user/{TARGET}"
OUTPUT_DIRECTORY = Path(__file__).resolve().parents[2] / "output"
TOTAL_TIMEOUT_SECONDS = 180
CALL_TIMEOUT_SECONDS = 35
WORK_LIMIT = 6
MAX_SAFE_INTEGER = 9007199254740991
FAILURE_REASONS = frozenset({
    "timeout", "network", "upstream-blocked", "invalid-response", "rate-limited", "unavailable",
})
ALLOWED_ENVIRONMENT = frozenset({
    "PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "VIRTUAL_ENV", "PYTHONPATH",
    "CLOAKBROWSER_VERSION", "CLOAKBROWSER_AUTO_UPDATE",
})
LOGIN_MARKERS = frozenset({"sessionid", "sessionid_ss", "sid_tt", "sid_guard"})
_UNSAFE_TEXT = re.compile(r"[<>\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]")
_TAGS = re.compile(r"<[^>]*>")
_AVATAR_PATH = re.compile(r"/aweme/1080x1080/aweme-avatar/[A-Za-z0-9_-]+\.(?:jpeg|jpg|png|webp)")


class CollectorError(Exception):
    def __init__(self, reason):
        self.reason = reason if reason in FAILURE_REASONS else "invalid-response"
        super().__init__()


def isolate_environment(environment=None):
    """Remove credentials/proxies before importing or starting third-party code."""
    environment = os.environ if environment is None else environment
    for key in tuple(environment):
        if key not in ALLOWED_ENVIRONMENT:
            del environment[key]
    environment["CLOAKBROWSER_VERSION"] = CHROMIUM_VERSION
    environment["CLOAKBROWSER_AUTO_UPDATE"] = "false"


def utc_now():
    return datetime.now(UTC)


def iso_time(value):
    if not isinstance(value, datetime) or value.tzinfo is None:
        raise CollectorError("invalid-response")
    return value.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def plain_text(value, maximum):
    if not isinstance(value, str):
        return None
    value = _UNSAFE_TEXT.sub(" ", _TAGS.sub("", value)).strip()
    # The shared plainText contract counts Unicode characters via Array.from.
    value = "".join(character for character in value if not 0xD800 <= ord(character) <= 0xDFFF)
    return value[:maximum].strip() or None


def count_or_null(value):
    return value if type(value) is int and 0 <= value <= MAX_SAFE_INTEGER else None


def public_avatar(value):
    if not isinstance(value, str) or len(value) > 4096:
        return None
    try:
        parts = urlsplit(value)
        if (parts.scheme != "https" or parts.netloc != "p3-pc.douyinpic.com"
                or not _AVATAR_PATH.fullmatch(parts.path)):
            return None
    except ValueError:
        return None
    # Public image path only; never persist a CDN/session query or fragment.
    normalized = urlunsplit(("https", parts.netloc, parts.path, "", ""))
    return normalized if len(normalized) <= 512 else None


def normalize_profile(author, captured_at):
    if getattr(author, "uid", None) != TARGET or getattr(author, "sec_uid", None) != TARGET:
        raise CollectorError("invalid-response")
    name = plain_text(getattr(author, "nickname", None), 80)
    if not name:
        raise CollectorError("invalid-response")
    stats, avatar = getattr(author, "stats", None), getattr(author, "avatar", None)
    return {
        "secUid": TARGET, "profileUrl": PROFILE_URL, "name": name,
        "signature": plain_text(getattr(author, "signature", None), 500),
        "avatarUrl": public_avatar(getattr(avatar, "url", None)),
        "followers": count_or_null(getattr(stats, "follower_count", None)),
        "following": count_or_null(getattr(stats, "following_count", None)),
        "postCount": count_or_null(getattr(stats, "content_count", None)),
        "likes": count_or_null(getattr(stats, "total_digg", None)),
        "updatedAt": iso_time(captured_at), "status": "fresh", "authorization": "public",
    }


def normalize_works(items, captured_at):
    if not isinstance(items, list):
        raise CollectorError("invalid-response")
    works, seen = [], set()
    # The collector requests six; bounded inspection also handles an ignored count.
    for item in items[:100]:
        author = getattr(item, "author", None)
        if getattr(author, "uid", None) != TARGET or getattr(author, "sec_uid", None) != TARGET:
            raise CollectorError("invalid-response")
        if getattr(item, "is_private", None) is not False or getattr(item, "is_deleted", None) is not False:
            continue
        item_id = getattr(item, "content_id", None)
        if not isinstance(item_id, str) or not re.fullmatch(r"[1-9][0-9]{18}", item_id):
            raise CollectorError("invalid-response")
        kind = getattr(item, "kind", None)
        kind = getattr(kind, "value", kind)
        if kind not in {"video", "image_album"}:
            continue
        if item_id in seen:
            continue
        seen.add(item_id)
        published_at = getattr(item, "created_at", None)
        if not isinstance(published_at, datetime) or published_at.tzinfo is None or published_at > captured_at:
            published_at = None
        slug = "note" if kind == "image_album" else "video"
        works.append({
            "id": item_id,
            "title": plain_text(getattr(item, "title", None), 200)
            or plain_text(getattr(item, "description", None), 200) or "抖音作品",
            "kind": slug, "url": f"https://www.douyin.com/{slug}/{item_id}",
            "publishedAt": iso_time(published_at) if published_at else None,
        })
        if len(works) == WORK_LIMIT:
            break
    return {"works": works, "worksUpdatedAt": iso_time(captured_at)}


def failure_reason(error):
    if isinstance(error, CollectorError):
        return error.reason
    if isinstance(error, TimeoutError):
        return "timeout"
    name = type(error).__name__
    if name in {"UpstreamRiskControl"}:
        return "upstream-blocked"
    if name in {"UpstreamChanged", "InvalidParam", "ValidationError", "JSONDecodeError", "UnicodeDecodeError"}:
        return "invalid-response"
    if name in {"TransportFailure", "ConnectError", "NetworkError", "ConnectionError", "OSError"}:
        return "network"
    return "unavailable"


def safe_name(value):
    return value if isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_.-]{1,100}", value) else "unknown"


def diagnostic_error(error, phase):
    return {
        "stage": safe_name(phase), "reason": failure_reason(error),
        "exceptionType": safe_name(type(error).__name__),
        "stack": [
            {"filename": Path(frame.filename).name, "line": frame.lineno, "function": safe_name(frame.name)}
            for frame in traceback.extract_tb(error.__traceback__)[-8:]
        ],
    }


def response_failure(http_status, outcome):
    if http_status == 429:
        return "rate-limited"
    if http_status in {401, 403, 412} or outcome == "risk_control":
        return "upstream-blocked"
    if outcome == "network_error":
        return "network"
    return "unavailable" if http_status >= 500 else "invalid-response"


async def collect_content(load_profile, load_works, state, diagnostics, now=utc_now):
    """A works failure never replaces a newly captured valid profile with failure."""
    diagnostics["phase"] = "profile"
    state["profile"] = normalize_profile(await load_profile(), now())
    diagnostics["phase"] = "works"
    try:
        state["profile"].update(normalize_works(await load_works(), now()))
    except Exception as error:
        diagnostics["warnings"].append(diagnostic_error(error, "works"))
    diagnostics["phase"] = "completed"


def result_for(state, error=None):
    if "profile" in state:
        return {"status": "ok", "profile": state["profile"]}
    return {"status": "failed", "reason": failure_reason(error) if error else "unavailable"}


async def collect_with_dtk(state, diagnostics):
    diagnostics["phase"] = "imports"
    from browser_rpc.backends.base import MintPlan
    from browser_rpc.backends.cloak import CloakBackend
    from browser_rpc.geo import GeoProfile
    from browser_rpc.settings import Settings
    from browser_rpc.validation import LANDING_URLS, Platform as BrowserPlatform
    from dtk.core.types import BrowserFamily, Outcome, Platform
    from dtk.platforms.douyin.adapter import ADAPTER
    from dtk.signing.base import RequestSpec as SignRequestSpec
    from dtk.signing.base import SigningSession, StaticFingerprint
    from dtk.signing.native.signer import NativeSigner
    from dtk.transport.base import Fingerprint, RequestSpec as HttpRequestSpec, TransportIdentity
    from dtk.transport.wreq_transport import WreqTransport

    backend, transport, cookies = None, None, {}
    with tempfile.TemporaryDirectory(prefix="douyin-public-") as temporary_root:
        try:
            backend = CloakBackend(Settings(
                headless=True, prewarm=False, warm_contexts=0, geo_probe_url=None,
                sign_proxy_url=None, profile_root=temporary_root,
            ))
            diagnostics["phase"] = "browser-start"
            await asyncio.wait_for(backend.start(), CALL_TIMEOUT_SECONDS)
            diagnostics["phase"] = "guest-mint"
            diagnostics["attempts"]["mint"] += 1
            minted = await asyncio.wait_for(backend.mint(MintPlan(
                platform=BrowserPlatform.DOUYIN,
                landing_url=LANDING_URLS[BrowserPlatform.DOUYIN],
                profile_dir=str(Path(temporary_root) / "guest"),
                geo=GeoProfile(timezone="UTC", locale="en-US", languages="en-US,en;q=0.9"),
                proxy=None, timeout_seconds=CALL_TIMEOUT_SECONDS - 5,
            )), CALL_TIMEOUT_SECONDS)
            cookies.update(minted.cookies)
            if not cookies or any(cookies.get(name) for name in LOGIN_MARKERS):
                raise CollectorError("invalid-response")
            if not minted.user_agent or not minted.browser_major:
                raise CollectorError("invalid-response")
            fp = Fingerprint(
                browser_family=BrowserFamily(minted.browser_family), browser_major=minted.browser_major,
                user_agent=minted.user_agent, platform=minted.navigator_platform,
                screen=minted.screen, language=minted.language, timezone=minted.timezone,
                hardware_concurrency=minted.hardware_concurrency, device_memory=minted.device_memory,
            )
            identity = TransportIdentity(
                id="douyin-public", platform=Platform.DOUYIN, fingerprint=fp,
                proxy_url=None, cookies=cookies,
            )

            async def update_cookies(_identity_id, changes):
                cookies.update(changes)

            transport = WreqTransport(
                default_timeout=CALL_TIMEOUT_SECONDS - 5, connect_timeout=10,
                max_clients=1, cookie_sink=update_cookies,
            )
            signer, client_profile = NativeSigner(Platform.DOUYIN), ADAPTER.profile_for(fp)

            async def fetch_one(short_name, endpoint, **arguments):
                if any(cookies.get(name) for name in LOGIN_MARKERS):
                    raise CollectorError("invalid-response")
                built = ADAPTER.build_request(
                    endpoint, profile=client_profile, sec_user_id=TARGET, **arguments
                )
                signed = await signer.sign(
                    SignRequestSpec.get(built["url"], built["params"], built["headers"]),
                    StaticFingerprint.of(fp),
                    SigningSession(cookies=cookies, proxy_url=None, identity_id=identity.id),
                )
                outbound = HttpRequestSpec(
                    url=signed.signed_url(built["url"]), method=built["method"], params=None,
                    headers={**built["headers"], **signed.headers}, endpoint=endpoint,
                )
                diagnostics["attempts"][short_name] += 1
                response = await asyncio.wait_for(
                    transport.request(identity, outbound, timeout=CALL_TIMEOUT_SECONDS - 5),
                    CALL_TIMEOUT_SECONDS,
                )
                verdict = transport.classify(response)
                diagnostics["requests"].append({
                    "endpoint": short_name, "httpStatus": response.status,
                    "bytes": len(response.body), "elapsedMs": response.elapsed_ms,
                    "outcome": safe_name(verdict.outcome.value), "rule": safe_name(verdict.rule),
                })
                if verdict.outcome is not Outcome.OK or not response.ok:
                    raise CollectorError(response_failure(response.status, verdict.outcome.value))
                if len(response.body) > 2 * 1024 * 1024:
                    raise CollectorError("invalid-response")
                return response.json()

            async def load_profile():
                return ADAPTER.parse_author(await fetch_one("profile", "douyin.author_profile"))

            async def load_works():
                await asyncio.sleep(2)
                return ADAPTER.parse_author_posts(
                    await fetch_one("works", "douyin.author_posts", count=WORK_LIMIT, cursor=None),
                    fetched_at=utc_now(),
                ).items

            await collect_content(load_profile, load_works, state, diagnostics)
        finally:
            for resource in (transport, backend):
                if resource is not None:
                    with contextlib.suppress(Exception):
                        await asyncio.wait_for(resource.close(), 5)
            cookies.clear()


def main():
    isolate_environment()
    started, state, failure = time.monotonic(), {}, None
    diagnostics = {
        "dtkRevision": DTK_REVISION, "cloakRevision": CLOAK_REVISION,
        "chromiumVersion": CHROMIUM_VERSION, "startedAt": iso_time(utc_now()),
        "phase": "startup", "attempts": {"mint": 0, "profile": 0, "works": 0},
        "requests": [], "warnings": [],
    }
    logging.disable(logging.CRITICAL)
    with open(os.devnull, "w", encoding="utf-8") as quiet:
        with contextlib.redirect_stdout(quiet), contextlib.redirect_stderr(quiet):
            try:
                asyncio.run(asyncio.wait_for(collect_with_dtk(state, diagnostics), TOTAL_TIMEOUT_SECONDS))
            except Exception as error:
                failure = error
                clean = diagnostic_error(error, diagnostics["phase"])
                if "profile" in state:
                    diagnostics["warnings"].append(clean)
                else:
                    diagnostics["failure"] = clean
    payload = result_for(state, failure)
    diagnostics["finishedAt"] = iso_time(utc_now())
    diagnostics["elapsedSeconds"] = round(time.monotonic() - started, 3)
    OUTPUT_DIRECTORY.mkdir(parents=True, exist_ok=True)
    (OUTPUT_DIRECTORY / "douyin-public.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    (OUTPUT_DIRECTORY / "douyin-public-diagnostics.json").write_text(
        json.dumps(diagnostics, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return 0 if payload["status"] == "ok" else 1


if __name__ == "__main__":
    raise SystemExit(main())
