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


if __name__ == "__main__":
    unittest.main()
