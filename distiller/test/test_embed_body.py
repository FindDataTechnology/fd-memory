# Embed body classification (2026-11-11). Runs with a bare
# `python3 -m unittest distiller/test/test_embed_body.py` — no pytest, no openai,
# no hy-memory. That is deliberate: the regression is in classification, and the
# previous shape (`AttributeError: 'str' object has no attribute 'data'`) could
# only be reproduced against the real lane.
import os
import sys
import types
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from embed_body import parse_embeddings_response


class _Datum:
    def __init__(self, embedding):
        self.embedding = embedding


class TestParseEmbeddingsResponse(unittest.TestCase):
    def test_non_json_body_is_named_with_a_snippet(self):
        vectors, tokens, err = parse_embeddings_response("<html>502 Bad Gateway</html>")
        self.assertEqual(vectors, [])
        self.assertEqual(tokens, 0)
        self.assertTrue(err.startswith("embed_non_json_body:"), err)
        self.assertIn("502 Bad Gateway", err, "the body snippet is the diagnosis — do not drop it")
        self.assertNotIn("attribute 'data'", err)

    def test_html_body_that_is_multiline_keeps_one_line(self):
        _, _, err = parse_embeddings_response("<html>\n<body>blocked</body>\n</html>")
        self.assertNotIn("\n", err)

    def test_json_body_without_embeddings_is_named(self):
        vectors, tokens, err = parse_embeddings_response(types.SimpleNamespace(data=[], usage=None))
        self.assertEqual(vectors, [])
        self.assertTrue(err.startswith("embed_empty_vectors:"), err)

    def test_success_returns_vectors_and_usage(self):
        resp = types.SimpleNamespace(data=[_Datum([0.1, 0.2])], usage=types.SimpleNamespace(total_tokens=7))
        vectors, tokens, err = parse_embeddings_response(resp)
        self.assertIsNone(err)
        self.assertEqual(vectors, [[0.1, 0.2]])
        self.assertEqual(tokens, 7)

    def test_entries_without_embedding_are_dropped_not_fatal(self):
        resp = types.SimpleNamespace(data=[_Datum(None), _Datum([1.0])], usage=None)
        vectors, tokens, err = parse_embeddings_response(resp)
        self.assertIsNone(err)
        self.assertEqual(vectors, [[1.0]])
        self.assertEqual(tokens, 0)


# ── retry policy (2026-11-11) ────────────────────────────────────────────────
# Measured: 13 of 82 digest reads in 3 h fell back to keyword-only, causes all
# transient (6x 503, 5x embed deadline, 2x dropped connection) and scattered in
# time. Before this, the embed call did not retry at all.

from embed_body import is_retryable, retry_backoff_ms, should_retry, RETRYABLE_STATUS


class _Status(Exception):
    def __init__(self, code):
        super().__init__(f"Error code: {code}")
        self.status_code = code


# Named exactly like the openai SDK's classes — the policy matches on type
# name, so a leading underscore here would test the wrong thing.
class APIConnectionError(Exception):
    pass


class _BadRequestError(Exception):
    def __init__(self):
        super().__init__("model not found")
        self.status_code = 400


class _Wrapped(Exception):
    def __init__(self, cause):
        super().__init__("wrapped")
        self.__cause__ = cause


class TestRetryPolicy(unittest.TestCase):
    def test_transient_statuses_are_retryable(self):
        for code in (429, 500, 502, 503, 504):
            self.assertTrue(is_retryable(_Status(code)), f"{code} should retry")

    def test_client_errors_are_not_retried(self):
        # 400/401/404 mean the request is wrong — retrying burns the caller's 8 s.
        for code in (400, 401, 404):
            self.assertFalse(is_retryable(_Status(code)), f"{code} must not retry")

    def test_status_is_found_on_wrapped_response(self):
        exc = Exception("boom")
        exc.response = types.SimpleNamespace(status_code=503)
        self.assertTrue(is_retryable(exc))

    def test_transport_faults_are_retryable_by_name(self):
        self.assertTrue(is_retryable(APIConnectionError("conn reset")))

    def test_transport_fault_found_through_cause(self):
        self.assertTrue(is_retryable(_Wrapped(APIConnectionError("reset"))))

    def test_unknown_exception_is_not_retried(self):
        self.assertFalse(is_retryable(ValueError("nope")))

    def test_backoff_is_short_and_bounded(self):
        # The caller gives the whole embed call ~8 s; keep the total retry cost small.
        delays = [retry_backoff_ms(i) for i in (1, 2, 3)]
        self.assertEqual(delays[0], 150)
        self.assertLessEqual(max(retry_backoff_ms(i) for i in range(1, 10)), 800)
        self.assertLess(sum(delays), 1600)


class TestShouldRetryBudget(unittest.TestCase):
    """The budget gate exists because a retry that ignores the clock can turn a
    fast keyword fallback into a deadline hit. Measured on the real lane: one
    successful embed takes 2.4-6.9 s, and the SDK's own 2 retries make an
    exhausted 503 round cost 3.03 s."""

    def test_retries_a_fresh_transient_failure(self):
        self.assertTrue(should_retry(1, 3, 0.8, 6.0, _Status(503)))

    def test_stops_when_attempts_are_exhausted(self):
        self.assertFalse(should_retry(3, 3, 0.1, 6.0, _Status(503)))

    def test_stops_when_the_budget_is_spent(self):
        # 6.9 s elapsed on a slow attempt: there is no room for another.
        self.assertFalse(should_retry(1, 3, 6.9, 6.0, _Status(503)))

    def test_budget_does_not_make_client_errors_retryable(self):
        self.assertFalse(should_retry(1, 3, 0.1, 6.0, _BadRequestError()))

    def test_zero_budget_means_no_retry(self):
        self.assertFalse(should_retry(1, 3, 0.0, 0.0, _Status(503)))


if __name__ == "__main__":
    unittest.main()
