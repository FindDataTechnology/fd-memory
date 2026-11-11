# Embedding-response classification, kept free of heavy imports on purpose.
#
# Why a separate module: `engine.py` imports openai + hy-memory at module level,
# so anything defined there cannot be verified without a full python env. The
# bug this guards against (2026-11-11) is a classification bug, not an algorithm
# one — the lane answered 200 with a non-JSON body, the SDK handed it back as a
# plain `str`, and `resp.data` raised `AttributeError: 'str' object has no
# attribute 'data'`, which reads like a code fault and says nothing about the
# upstream. Being able to run these assertions with a bare `python3 -m unittest`
# is the point.


def parse_embeddings_response(resp):
    """Classify an OpenAI-compatible embeddings response.

    Returns (vectors, tokens, error) where `error` is None on success or a named
    failure string. Named failures, not exceptions: the caller turns them into
    the digest's `model_note`, and the operator needs to tell "upstream returned
    HTML" apart from "our code is wrong".
    """
    data = getattr(resp, "data", None)
    if not isinstance(data, list):
        body = str(resp).replace("\n", " ").strip()[:120]
        return [], 0, f"embed_non_json_body: {type(resp).__name__}: {body}"
    vectors = [d.embedding for d in data if getattr(d, "embedding", None)]
    if not vectors:
        return [], 0, "embed_empty_vectors: the lane returned a JSON body with no embeddings"
    usage = getattr(resp, "usage", None)
    tokens = getattr(usage, "total_tokens", 0) or 0
    return vectors, tokens, None


# ── retry policy (2026-11-11) ────────────────────────────────────────────────
# Measured on production before this existed: 13 of 82 digest reads (3 h) fell
# back to keyword-only recall, and the causes were all transient — 6x upstream
# 503, 5x the caller's 8 s embed deadline, 2x a dropped connection. The embed
# call had NO retry, so a single blip cost the whole turn its vector recall,
# while the sibling LLM-extract path in the same process retries 5 times. These
# failures were scattered (17:00, 17:04, 17:13, 17:37, 18:00), i.e. exactly the
# shape a short retry recovers from.

RETRYABLE_STATUS = frozenset({408, 425, 429, 500, 502, 503, 504})

# Transient network faults with no HTTP status at all.
RETRYABLE_NAMES = frozenset({
    "APIConnectionError", "APITimeoutError", "ConnectError", "ConnectTimeout",
    "ReadError", "ReadTimeout", "RemoteProtocolError", "TimeoutException",
})


def is_retryable(exc):
    """True when trying again could plausibly succeed.

    A 4xx that is not 408/425/429 means the request itself is wrong (bad model
    name, malformed input) — retrying only burns the caller's deadline and
    delays the keyword fallback. A non-JSON body is NOT retried here either: it
    means the lane answered, so the next attempt hits the same path.
    """
    status = getattr(exc, "status_code", None)
    if status is None:
        status = getattr(getattr(exc, "response", None), "status_code", None)
    if isinstance(status, int):
        return status in RETRYABLE_STATUS
    name = type(exc).__name__
    if name in RETRYABLE_NAMES:
        return True
    # openai wraps transport faults; the cause is one level down.
    cause = getattr(exc, "__cause__", None)
    if cause is not None and cause is not exc:
        return type(cause).__name__ in RETRYABLE_NAMES
    return False


def retry_backoff_ms(attempt):
    """Delay before attempt N+1 (attempt is 1-based). Short on purpose: the
    caller gives the whole embed call 8 s, and the failures we see return fast."""
    return min(800, 150 * (2 ** (attempt - 1)))


def parse_deadline_s(raw, default=150.0):
    """Parse DISTILL_LLM_DEADLINE_S; empty/invalid/non-positive => default.

    Why a deadline exists at all: the extraction client is built INSIDE hy-memory
    (LLMProvider(MemoryConfig())), so its read timeout is the openai SDK default
    of 600 s — longer than the caller's 180 s sidecar budget (SIDECCAR_TIMEOUT_MS
    in fd-memory). A hung call therefore burned the caller's whole budget and came
    back to us as a bare `This operation was aborted` with nothing in the
    distiller log. Measured 2026-11-11 on deepseek-v4.1-flash: 3 of 6 /distill
    calls aborted at exactly 180 s, the distiller logged ZERO LLM errors, and a
    max-size 120-item batch only takes 10-16 s — so the hang, not the workload,
    was the cost. Answering first with a named error is what makes it debuggable.
    """
    if raw is None or str(raw).strip() == "":
        return default
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return default
    return value if value > 0 else default


def should_retry(attempt, attempts, elapsed_s, budget_s, exc):
    """Whether to spend another attempt on `exc`.

    Why this is not just `attempt < attempts and is_retryable(exc)`: measured on
    the production lane (2026-11-11), a successful embed takes 2.4-6.9 s, and the
    caller's whole embed budget is 8 s. A retry that ignores the clock therefore
    converts "degrade to keyword in 3 s" into "hit the 8 s deadline and degrade
    anyway" — the same outcome, slower, and it masks the real cause behind a
    deadline note. So: retry only while the wall clock says there is room.
    """
    if attempt >= attempts:
        return False
    if elapsed_s >= budget_s:
        return False
    return is_retryable(exc)


