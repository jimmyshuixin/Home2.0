"""Offline boundaries for the credential-free collector; no third-party imports."""

import asyncio
from datetime import UTC, datetime, timedelta
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace as Object
import unittest
from unittest.mock import patch

MODULE_PATH = Path(__file__).resolve().parents[1] / "douyin-public-collector.py"
SPEC = importlib.util.spec_from_file_location("douyin_public_collector", MODULE_PATH)
collector = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(collector)
NOW = datetime(2026, 9, 28, 0, 0, 0, tzinfo=UTC)
PlaywrightTimeoutError = type("TimeoutError", (Exception,), {"__module__": "playwright._impl._errors"})
PlaywrightError = type("Error", (Exception,), {"__module__": "playwright._impl._errors"})


class BackendFailure(Exception):
    pass


def wrapped(error):
    # Reproduce the pinned upstream's page.goto wrapper without importing a browser.
    try:
        raise error
    except Exception as cause:
        try:
            raise BackendFailure("could not load https://example.com/?cookie=MUST_NOT_ESCAPE") from cause
        except BackendFailure as failure:
            return failure


def author(**changes):
    value = Object(
        uid=collector.TARGET, sec_uid=collector.TARGET, nickname="虚宁", signature="公开简介",
        avatar=Object(url="https://p3-pc.douyinpic.com/aweme/1080x1080/aweme-avatar/test.jpeg"),
        stats=Object(follower_count=85, following_count=3, content_count=22, total_digg=6559),
        raw={"sessionid": "MUST_NOT_ESCAPE"},
    )
    vars(value).update(changes)
    return value


def work(item_id="7661639577056136457", **changes):
    value = Object(
        content_id=item_id, author=author(), title="摄影作品", description="公开作品描述",
        kind="video", is_private=False, is_deleted=False, created_at=NOW - timedelta(days=1),
        raw={"cookies": "MUST_NOT_ESCAPE"}, web_url="https://evil.example/secret?token=MUST_NOT_ESCAPE",
    )
    vars(value).update(changes)
    return value


class NormalizationTests(unittest.TestCase):
    def test_public_projection_strips_raw_and_rejects_wrong_identity(self):
        profile = collector.normalize_profile(author(), NOW)
        self.assertEqual(profile["name"], "虚宁")
        self.assertEqual(profile["updatedAt"], "2026-09-28T00:00:00.000Z")
        self.assertEqual(profile["followers"], 85)
        self.assertNotIn("MUST_NOT_ESCAPE", json.dumps(profile))
        for bad in (author(uid="another"), author(sec_uid="another"), author(nickname="<b></b>")):
            with self.assertRaises(collector.CollectorError):
                collector.normalize_profile(bad, NOW)

    def test_unknown_or_unsafe_counts_remain_null(self):
        profile = collector.normalize_profile(author(stats=Object(
            follower_count=None, following_count=True, content_count=-1, total_digg=2**53,
        )), NOW)
        for key in ("followers", "following", "postCount", "likes"):
            self.assertIsNone(profile[key])
        self.assertEqual(collector.normalize_profile(author(stats=Object(follower_count=0)), NOW)["followers"], 0)

    def test_text_limits_count_unicode_characters_and_remove_active_markup(self):
        profile = collector.normalize_profile(author(nickname="<b>虚宁</b>\u202e\x00", signature="😀" * 600), NOW)
        self.assertEqual(profile["name"], "虚宁")
        self.assertEqual(len(profile["signature"]), 500)
        title = collector.normalize_works([work(title="😀" * 200)], NOW)["works"][0]["title"]
        self.assertEqual(len(title), 200)

    def test_avatar_allows_only_the_verified_public_cdn_path(self):
        valid = author().avatar.url
        self.assertEqual(collector.public_avatar(valid + "?token=MUST_NOT_ESCAPE#x"), valid)
        for bad in (valid.replace("https:", "http:"), valid.replace("p3-pc.", "p6-pc."),
                    valid.replace("/aweme/", "/private/"), valid.replace(".com/", ".com:443/"),
                    valid.replace("test.jpeg", "x" * 512 + ".jpeg"),
                    "https://p3-pc.douyinpic.com.evil.example/aweme/1080x1080/aweme-avatar/a.jpeg"):
            self.assertIsNone(collector.public_avatar(bad))

    def test_works_exclude_private_deleted_duplicates_and_never_use_raw_urls(self):
        normalized = collector.normalize_works([
            work(is_private=True), work(is_deleted=True), work(), work(),
            work("7666406543629337841", kind="image_album"), work("7651940137106975921", kind="live"),
        ], NOW)
        self.assertEqual(len(normalized["works"]), 2)
        self.assertEqual(normalized["works"][1]["kind"], "note")
        self.assertEqual(normalized["works"][1]["url"], "https://www.douyin.com/note/7666406543629337841")
        self.assertNotIn("MUST_NOT_ESCAPE", json.dumps(normalized))

    def test_works_identity_id_limit_and_future_timestamp_boundaries(self):
        for bad in (work(author=author(uid="wrong")), work("123"), work("0661639577056136457")):
            with self.assertRaises(collector.CollectorError):
                collector.normalize_works([bad], NOW)
        result = collector.normalize_works([work(str(7661639577056136457 + i)) for i in range(10)], NOW)
        self.assertEqual(len(result["works"]), 6)
        self.assertIsNone(collector.normalize_works([work(created_at=NOW + timedelta(days=1))], NOW)["works"][0]["publishedAt"])

    def test_environment_drops_tokens_and_proxies_and_pins_browser(self):
        environment = {"PATH": "bin", "HOME": "home", "PYTHONPATH": "upstream", "GITHUB_TOKEN": "secret",
                       "ACTIONS_ID_TOKEN_REQUEST_TOKEN": "secret", "HTTPS_PROXY": "secret", "CLOAKBROWSER_AUTO_UPDATE": "true"}
        collector.isolate_environment(environment)
        self.assertEqual(environment["PATH"], "bin")
        self.assertEqual(environment["CLOAKBROWSER_AUTO_UPDATE"], "false")
        self.assertFalse(set(environment) - collector.ALLOWED_ENVIRONMENT)

    def test_diagnostics_do_not_print_exception_messages_or_source(self):
        try:
            raise RuntimeError("https://example.com/?sessionid=MUST_NOT_ESCAPE")
        except RuntimeError as error:
            diagnostic = collector.diagnostic_error(error, "works")
        self.assertEqual(diagnostic["exceptionType"], "RuntimeError")
        self.assertNotIn("MUST_NOT_ESCAPE", json.dumps(diagnostic))
        self.assertEqual(set(diagnostic["stack"][0]), {"filename", "line", "function"})
        self.assertEqual(collector.response_failure(429, "risk_control"), "rate-limited")
        self.assertEqual(collector.response_failure(403, "risk_control"), "upstream-blocked")


class FailureClassificationTests(unittest.TestCase):
    def test_wrapped_playwright_timeout_retains_cause_without_message(self):
        error = wrapped(PlaywrightTimeoutError("Page.goto timeout: https://example.com/?token=MUST_NOT_ESCAPE"))
        self.assertEqual(collector.failure_reason(error), "timeout")
        self.assertTrue(collector.mint_retryable(error))
        self.assertEqual(collector.result_for({}, error), {"status": "failed", "reason": "timeout"})
        diagnostic = collector.diagnostic_error(error, "guest-mint")
        self.assertEqual(diagnostic["exceptionType"], "BackendFailure")
        self.assertEqual(diagnostic["causeTypes"], ["TimeoutError"])
        self.assertNotIn("MUST_NOT_ESCAPE", json.dumps(diagnostic))
        self.assertNotIn("https:", json.dumps(diagnostic))

    def test_browser_network_codes_are_allowlisted_and_message_is_not_exposed(self):
        error = wrapped(PlaywrightError("Page.goto: net::ERR_CONNECTION_CLOSED at https://example.com/?token=MUST_NOT_ESCAPE"))
        diagnostic = collector.diagnostic_error(error, "guest-mint")
        self.assertEqual(diagnostic["reason"], "network")
        self.assertEqual(diagnostic["browserNetworkCode"], "ERR_CONNECTION_CLOSED")
        self.assertTrue(collector.mint_retryable(error))
        self.assertNotIn("MUST_NOT_ESCAPE", json.dumps(diagnostic))
        for cause in (RuntimeError("net::ERR_CONNECTION_CLOSED"),
                      PlaywrightError("net::ERR_ABORTED"), PlaywrightError("net::ERR_BLOCKED_BY_CLIENT"),
                      PlaywrightError("net::ERR_CERT_AUTHORITY_INVALID"), PlaywrightError("HTTP 403 captcha")):
            with self.subTest(cause=type(cause).__name__, message=cause.args[0]):
                self.assertFalse(collector.mint_retryable(wrapped(cause)))

    def test_platform_and_validation_failures_override_transient_cause(self):
        for reason in ("upstream-blocked", "rate-limited", "invalid-response"):
            error = collector.CollectorError(reason)
            error.__cause__ = TimeoutError()
            self.assertEqual(collector.failure_reason(wrapped(error)), reason)
            self.assertFalse(collector.mint_retryable(wrapped(error)))

    def test_unknown_wrappers_and_operating_system_errors_are_not_retried(self):
        error = RuntimeError("unexpected application failure")
        error.__cause__ = TimeoutError()
        for failure in (error, BackendFailure("no cookies or configuration failure"),
                        wrapped(PermissionError()), wrapped(OSError("disk full"))):
            self.assertFalse(collector.mint_retryable(failure))

    def test_exception_context_is_bounded_and_respects_explicit_suppression(self):
        hidden = BackendFailure("not caused by the previous timeout")
        hidden.__context__ = TimeoutError()
        hidden.__suppress_context__ = True
        self.assertEqual(collector.failure_reason(hidden), "unavailable")
        self.assertEqual(collector.diagnostic_error(hidden, "guest-mint")["causeTypes"], [])
        self.assertFalse(collector.mint_retryable(hidden))
        cycle = BackendFailure()
        cycle.__cause__ = cycle
        self.assertEqual(len(collector.exception_chain(cycle)), 1)
        self.assertFalse(collector.mint_retryable(cycle))
        long_chain = wrapped(TimeoutError())
        for _ in range(10):
            long_chain = wrapped(long_chain)
        self.assertEqual(len(collector.exception_chain(long_chain)), collector.MAX_EXCEPTION_CHAIN)
        self.assertFalse(collector.mint_retryable(long_chain))


class MintRetryTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.diagnostics = {"attempts": {"mint": 0, "profile": 0, "works": 0}, "warnings": []}
        self.delays = []

    async def backoff(self, seconds):
        self.delays.append(seconds)

    async def test_first_success_does_not_retry_or_delay(self):
        expected = Object(cookies={"anonymous": "in-memory-only"})

        async def mint():
            return expected

        result = await collector.mint_guest(mint, self.diagnostics, self.backoff)
        self.assertIs(result, expected)
        self.assertEqual(self.diagnostics["attempts"]["mint"], 1)
        self.assertNotIn("retries", self.diagnostics)
        self.assertEqual(self.delays, [])

    async def test_wrapped_navigation_timeout_retries_once_and_preserves_plan(self):
        attempts, same_plan = [], Object(profile_dir="one-guest", proxy=None)
        expected = Object(cookies={"anonymous": "in-memory-only"})

        async def backend_mint(plan):
            attempts.append(plan)
            if len(attempts) == 1:
                raise wrapped(PlaywrightTimeoutError("secret=MUST_NOT_ESCAPE"))
            return expected

        result = await collector.mint_guest(lambda: backend_mint(same_plan), self.diagnostics, self.backoff)
        self.assertIs(result, expected)
        self.assertEqual(attempts, [same_plan, same_plan])
        self.assertEqual(self.delays, [2])
        self.assertEqual(self.diagnostics["attempts"], {"mint": 2, "profile": 0, "works": 0})
        self.assertEqual(self.diagnostics["retries"][0]["reason"], "timeout")
        self.assertEqual(self.diagnostics["retries"][0]["nextAttempt"], 2)
        self.assertNotIn("MUST_NOT_ESCAPE", json.dumps(self.diagnostics))

    async def test_repeated_transient_failure_stops_after_two_attempts(self):
        async def mint():
            # Each attempt gets a fresh traceback/cause, as the real backend does.
            raise wrapped(PlaywrightError("Page.goto: net::ERR_CONNECTION_RESET"))

        with self.assertRaises(BackendFailure) as caught:
            await collector.mint_guest(mint, self.diagnostics, self.backoff)
        self.assertEqual(collector.failure_reason(caught.exception), "network")
        self.assertEqual(self.diagnostics["attempts"]["mint"], 2)
        self.assertEqual(self.delays, [2])
        self.assertEqual(len(self.diagnostics["retries"]), 1)

    async def test_blocked_invalid_ratelimit_and_unknown_failures_stop_immediately(self):
        for failure in (collector.CollectorError("upstream-blocked"), collector.CollectorError("rate-limited"),
                        collector.CollectorError("invalid-response"), BackendFailure("no guest cookies"),
                        wrapped(PermissionError("browser startup permission denied"))):
            diagnostics = {"attempts": {"mint": 0}}

            async def mint():
                raise failure

            with self.assertRaises(type(failure)):
                await collector.mint_guest(mint, diagnostics, self.backoff)
            self.assertEqual(diagnostics["attempts"]["mint"], 1)
            self.assertNotIn("retries", diagnostics)
        self.assertEqual(self.delays, [])

    async def test_call_timeouts_remain_bounded_and_cancel_the_attempt(self):
        cancelled = []

        async def mint():
            try:
                await asyncio.sleep(10)
            finally:
                cancelled.append(True)

        with patch.object(collector, "CALL_TIMEOUT_SECONDS", 0.01):
            with self.assertRaises(TimeoutError):
                await collector.mint_guest(mint, self.diagnostics, self.backoff)
        self.assertEqual(len(cancelled), 2)
        self.assertEqual(self.diagnostics["attempts"]["mint"], 2)
        self.assertEqual(self.delays, [2])

    async def test_outer_timeout_during_mint_cancels_without_retry(self):
        async def mint():
            await asyncio.sleep(10)

        with self.assertRaises(TimeoutError):
            await asyncio.wait_for(collector.mint_guest(mint, self.diagnostics, self.backoff), 0.01)
        self.assertEqual(self.diagnostics["attempts"]["mint"], 1)
        self.assertEqual(self.delays, [])

    async def test_cancellation_during_backoff_does_not_launch_another_browser(self):
        sleeping = asyncio.Event()

        async def mint():
            raise wrapped(TimeoutError())

        async def backoff(_seconds):
            sleeping.set()
            await asyncio.sleep(10)

        pending = asyncio.create_task(collector.mint_guest(mint, self.diagnostics, backoff))
        await asyncio.wait_for(sleeping.wait(), 1)
        pending.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await pending
        self.assertEqual(self.diagnostics["attempts"]["mint"], 1)


class PartialFailureTests(unittest.IsolatedAsyncioTestCase):
    async def test_posts_timeout_keeps_new_profile_and_omits_works(self):
        async def load_profile():
            return author()

        async def load_works():
            raise TimeoutError("MUST_NOT_ESCAPE")

        state, diagnostics = {}, {"warnings": []}
        await collector.collect_content(load_profile, load_works, state, diagnostics, now=lambda: NOW)
        result = collector.result_for(state)
        self.assertEqual(result["status"], "ok")
        self.assertNotIn("works", result["profile"])
        self.assertNotIn("worksUpdatedAt", result["profile"])
        self.assertEqual(diagnostics["warnings"][0]["reason"], "timeout")

    async def test_successful_empty_posts_is_distinct_from_failed_posts(self):
        async def load_profile():
            return author()

        async def load_works():
            return []

        state, diagnostics = {}, {"warnings": []}
        await collector.collect_content(load_profile, load_works, state, diagnostics, now=lambda: NOW)
        self.assertEqual(state["profile"]["works"], [])
        self.assertEqual(state["profile"]["worksUpdatedAt"], "2026-09-28T00:00:00.000Z")
        self.assertEqual(diagnostics["warnings"], [])

    async def test_profile_failure_never_fetches_or_imports_works(self):
        async def load_profile():
            raise collector.CollectorError("upstream-blocked")

        async def load_works():
            self.fail("works must not run before identity validation")

        state, diagnostics = {}, {"warnings": []}
        try:
            await collector.collect_content(load_profile, load_works, state, diagnostics, now=lambda: NOW)
        except collector.CollectorError as error:
            result = collector.result_for(state, error)
        self.assertEqual(result, {"status": "failed", "reason": "upstream-blocked"})

    async def test_outer_timeout_after_profile_preserves_it(self):
        async def load_profile():
            return author()

        async def load_works():
            await asyncio.sleep(10)

        state, diagnostics = {}, {"warnings": []}
        with self.assertRaises(TimeoutError):
            await asyncio.wait_for(collector.collect_content(load_profile, load_works, state, diagnostics, now=lambda: NOW), 0.01)
        result = collector.result_for(state, TimeoutError())
        self.assertEqual(result["status"], "ok")
        self.assertNotIn("works", result["profile"])


if __name__ == "__main__":
    unittest.main()
