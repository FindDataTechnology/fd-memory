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
