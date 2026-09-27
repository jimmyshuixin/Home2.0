"""One bounded anonymous Douyin probe using unmodified DTK v5.1.1 modules.

No account login, proxy, persistent session, production write, or pagination.
Only the explicitly projected public fields and sanitized diagnostics are saved.
"""

import os

# Do this before importing third-party code or launching its browser subprocess.
_ALLOWED_ENV = {
    "PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "VIRTUAL_ENV", "PYTHONPATH",
    "CLOAKBROWSER_VERSION", "CLOAKBROWSER_AUTO_UPDATE",
}
for _key in tuple(os.environ):
    if _key not in _ALLOWED_ENV:
        del os.environ[_key]

import asyncio
import contextlib
from datetime import UTC, datetime
import json
import logging
from pathlib import Path
import re
import tempfile
import time
import traceback
from urllib.parse import urlsplit, urlunsplit

UPSTREAM_SHA = "d21b92ec28e481795f4c8530ee6dc0f7d40da69d"
TARGET = "MS4wLjABAAAAKZ2zSL9DDu1Uc3IZleN2zqIqoOpNXtwvAW4_2E6PBrLmkyTMw_MsrzxGVrQvvI1-"
OUTPUT = Path(__file__).resolve().parents[2] / "output" / "douyin-v5-probe.json"
TOTAL_TIMEOUT_SECONDS = 180
CALL_TIMEOUT_SECONDS = 35
POST_LIMIT = 6


class ProbeFailure(Exception):
    """A locally controlled failure code, never an upstream response string."""

    def __init__(self, reason):
        self.reason = reason
        super().__init__()


def utc_now():
    return datetime.now(UTC).isoformat()


def safe_name(value):
    value = str(value)
    return value if re.fullmatch(r"[A-Za-z0-9_.-]{1,100}", value) else "unrecognized"


def safe_avatar(value):
    """Keep a public HTTPS image path without any URL query or fragment."""
    if not isinstance(value, str):
        return None
    parts = urlsplit(value)
    if parts.scheme != "https" or not parts.hostname or parts.username or parts.password:
        return None
    return urlunsplit(("https", parts.netloc, parts.path, "", ""))


def count_or_null(value):
    return value if type(value) is int and value >= 0 else None


def clean_failure(exc, phase):
    if isinstance(exc, ProbeFailure):
        reason = exc.reason
    elif isinstance(exc, TimeoutError):
        reason = "timeout"
    else:
        reason = "exception"
    return {
        "phase": phase,
        "reason": safe_name(reason),
        "exceptionType": safe_name(type(exc).__name__),
        "stack": [
            {
                "filename": Path(frame.filename).name,
                "line": frame.lineno,
                "function": safe_name(frame.name),
            }
            for frame in traceback.extract_tb(exc.__traceback__)[-8:]
        ],
    }


async def run_probe(report):
    report["phase"] = "imports"
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
    from dtk.transport.base import Fingerprint, RequestSpec as HttpRequestSpec
    from dtk.transport.base import TransportIdentity
    from dtk.transport.wreq_transport import WreqTransport

    backend = None
    transport = None
    cookies = {}
    with tempfile.TemporaryDirectory(prefix="douyin-v5-probe-") as temporary_root:
        try:
            backend = CloakBackend(Settings(
                headless=True,
                prewarm=False,
                warm_contexts=0,
                geo_probe_url=None,
                sign_proxy_url=None,
                profile_root=temporary_root,
            ))
            report["phase"] = "browser_start"
            await asyncio.wait_for(backend.start(), CALL_TIMEOUT_SECONDS)
            report["phase"] = "guest_mint"
            report["attempts"]["mint"] += 1
            minted = await asyncio.wait_for(backend.mint(MintPlan(
                platform=BrowserPlatform.DOUYIN,
                landing_url=LANDING_URLS[BrowserPlatform.DOUYIN],
                profile_dir=str(Path(temporary_root) / "guest"),
                geo=GeoProfile(timezone="UTC", locale="en-US", languages="en-US,en;q=0.9"),
                proxy=None,
                timeout_seconds=CALL_TIMEOUT_SECONDS - 5,
            )), CALL_TIMEOUT_SECONDS)
            cookies.update(minted.cookies)
            if not cookies:
                raise ProbeFailure("no_guest_session")
            # A new visitor profile must never contain an authenticated session.
            login_markers = {"sessionid", "sessionid_ss", "sid_tt", "sid_guard"}
            if any(cookies.get(name) for name in login_markers):
                raise ProbeFailure("unexpected_authenticated_session")
            if not minted.user_agent or not minted.browser_major:
                raise ProbeFailure("incomplete_browser_identity")
            fp = Fingerprint(
                browser_family=BrowserFamily(minted.browser_family),
                browser_major=minted.browser_major,
                user_agent=minted.user_agent,
                platform=minted.navigator_platform,
                screen=minted.screen,
                language=minted.language,
                timezone=minted.timezone,
                hardware_concurrency=minted.hardware_concurrency,
                device_memory=minted.device_memory,
            )
            identity = TransportIdentity(
                id="douyin-readonly-probe", platform=Platform.DOUYIN,
                fingerprint=fp, proxy_url=None, cookies=cookies,
            )

            async def update_cookies(_identity_id, changes):
                cookies.update(changes)

            transport = WreqTransport(
                default_timeout=CALL_TIMEOUT_SECONDS - 5,
                connect_timeout=10,
                max_clients=1,
                cookie_sink=update_cookies,
            )
            signer = NativeSigner(Platform.DOUYIN)
            profile = ADAPTER.profile_for(fp)

            async def fetch_one(short_name, endpoint, **arguments):
                report["phase"] = short_name
                built = ADAPTER.build_request(
                    endpoint, profile=profile, sec_user_id=TARGET, **arguments
                )
                signed = await signer.sign(
                    SignRequestSpec.get(built["url"], built["params"], built["headers"]),
                    StaticFingerprint.of(fp),
                    SigningSession(cookies=cookies, proxy_url=None, identity_id=identity.id),
                )
                # Never re-encode the query or lose the signed headers.
                request = HttpRequestSpec(
                    url=signed.signed_url(built["url"]), method=built["method"],
                    params=None, headers={**built["headers"], **signed.headers},
                    endpoint=endpoint,
                )
                report["attempts"][short_name] += 1
                response = await asyncio.wait_for(
                    transport.request(identity, request, timeout=CALL_TIMEOUT_SECONDS - 5),
                    CALL_TIMEOUT_SECONDS,
                )
                verdict = transport.classify(response)
                report["requests"].append({
                    "endpoint": short_name,
                    "httpStatus": response.status,
                    "bytes": len(response.body),
                    "elapsedMs": response.elapsed_ms,
                    "outcome": safe_name(verdict.outcome.value),
                    "reason": safe_name(verdict.rule),
                })
                if verdict.outcome is not Outcome.OK or not response.ok:
                    raise ProbeFailure("upstream_response_rejected")
                return response.json()

            author = ADAPTER.parse_author(await fetch_one("profile", "douyin.author_profile"))
            if author.uid != TARGET or author.sec_uid != TARGET:
                raise ProbeFailure("profile_identity_mismatch")
            stats = author.stats
            report["profile"] = {
                "uid": author.uid,
                "secUid": author.sec_uid,
                "nickname": author.nickname,
                "description": author.signature,
                "avatar": safe_avatar(author.avatar.url if author.avatar else None),
                "url": f"https://www.douyin.com/user/{TARGET}",
                "followers": count_or_null(stats.follower_count if stats else None),
                "following": count_or_null(stats.following_count if stats else None),
                "postCount": count_or_null(stats.content_count if stats else None),
                "totalLikes": count_or_null(stats.total_digg if stats else None),
            }
            await asyncio.sleep(2)
            posts = ADAPTER.parse_author_posts(
                await fetch_one("posts", "douyin.author_posts", count=POST_LIMIT, cursor=None),
                fetched_at=datetime.now(UTC),
            )
            public_posts = []
            for item in posts.items[:POST_LIMIT]:
                if item.author.uid != TARGET or item.author.sec_uid != TARGET:
                    raise ProbeFailure("post_author_mismatch")
                if item.is_deleted or item.is_private:
                    continue
                if not re.fullmatch(r"\d{1,30}", item.content_id):
                    raise ProbeFailure("invalid_public_post_id")
                slug = "note" if item.kind.value == "image_album" else "video"
                public_posts.append({
                    "id": item.content_id,
                    "description": item.description,
                    "publishedAt": item.created_at.isoformat() if item.created_at else None,
                    "url": f"https://www.douyin.com/{slug}/{item.content_id}",
                })
            report["posts"] = public_posts
            report["hasMorePosts"] = bool(posts.has_more)
            report["success"] = True
            report["phase"] = "completed"
        finally:
            if transport is not None:
                with contextlib.suppress(Exception):
                    await asyncio.wait_for(transport.close(), 5)
            if backend is not None:
                with contextlib.suppress(Exception):
                    await asyncio.wait_for(backend.close(), 5)
            cookies.clear()


def main():
    started = time.monotonic()
    report = {
        "upstreamVersion": "5.1.1",
        "upstreamSha": UPSTREAM_SHA,
        "targetSecUid": TARGET,
        "startedAt": utc_now(),
        "success": False,
        "phase": "startup",
        "mode": "anonymous_direct_single_probe",
        "attempts": {"mint": 0, "profile": 0, "posts": 0},
        "requests": [],
        "profile": None,
        "posts": [],
    }
    # Third-party exception messages and browser logs can contain session URLs.
    logging.disable(logging.CRITICAL)
    with open(os.devnull, "w", encoding="utf-8") as quiet:
        with contextlib.redirect_stdout(quiet), contextlib.redirect_stderr(quiet):
            try:
                asyncio.run(asyncio.wait_for(run_probe(report), TOTAL_TIMEOUT_SECONDS))
            except Exception as exc:
                report["failure"] = clean_failure(exc, report["phase"])
    report["finishedAt"] = utc_now()
    report["elapsedSeconds"] = round(time.monotonic() - started, 3)
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return 0 if report["success"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
