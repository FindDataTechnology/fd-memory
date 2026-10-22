# fd-memory-distiller HTTP face: POST /distill (fd-memory is the only caller,
# DISTILLER_SHARED_TOKEN bearer) + GET /healthz. stdlib only — no web framework
# between the contract and the engine.

import asyncio
import json
import os
import sys

import openai
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import engine  # noqa: E402  (applies the boundary patches at import)


class Handler(BaseHTTPRequestHandler):
    def _json(self, status, doc):
        body = json.dumps(doc, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/healthz":
            self._json(200, {"status": "ok", "service": "fd-memory-distiller", "engine": engine.ENGINE})
            return
        self._json(404, {"error": "not_found"})

    def do_POST(self):
        if self.path == "/embed":
            self.handle_embed()
            return
        if self.path != "/distill":
            self._json(404, {"error": "not_found"})
            return
        expected = os.environ.get("DISTILLER_SHARED_TOKEN", "")
        auth = self.headers.get("authorization", "")
        if expected and auth != f"Bearer {expected}":
            self._json(401, {"error": "unauthorized"})
            return
        length = int(self.headers.get("content-length", 0))
        try:
            request = json.loads(self.rfile.read(length) or b"{}")
        except Exception:
            self._json(400, {"error": "invalid_body"})
            return
        try:
            result = asyncio.run(engine.distill(request))
            self._json(200, result)
        except Exception as e:  # engine-level failure: report, keep caller's cursor
            import traceback; traceback.print_exc()
            self._json(200, {
                "facts": [], "experiences": [], "cursor_next": {},
                "llm_calls": [], "tokens": 0,
                "errors": [f"{type(e).__name__}: {str(e)[:300]}"],
            })

    def handle_embed(self):
        expected = os.environ.get("DISTILLER_SHARED_TOKEN", "")
        if expected and self.headers.get("authorization", "") != f"Bearer {expected}":
            self._json(401, {"error": "unauthorized"})
            return
        length = int(self.headers.get("content-length", 0))
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except Exception:
            self._json(400, {"error": "invalid_body"})
            return
        texts = [str(t) for t in (body.get("texts") or []) if str(t).strip()][:engine.EMBED_BATCH_MAX]
        if not texts:
            self._json(400, {"error": "texts_required"})
            return

        async def run():
            client = openai.AsyncOpenAI(
                api_key=os.environ.get("MEMORY_LLM_API_KEY", ""),
                base_url=os.environ.get("MEMORY_LLM_BASE_URL", ""),
            )
            return await engine.embed_texts(lambda: client, texts)

        try:
            vectors, model, tokens, errors = asyncio.run(run())
            self._json(200, {"vectors": vectors, "model": model, "tokens": tokens, "errors": errors})
        except Exception as e:
            self._json(200, {"vectors": [], "model": engine.EMBED_MODEL, "tokens": 0, "errors": [f"{type(e).__name__}: {str(e)[:200]}"]})

    def log_message(self, fmt, *args):
        print(f"[fd-memory-distiller] {self.address_string()} {fmt % args}", flush=True)


def load_provider_env():
    """Resolve the 词元 lane credentials from the shared llm-providers store
    (mounted from the runner's secret) when MEMORY_LLM_* is not set directly —
    one key, one rotation point. Never printed."""
    if os.environ.get("MEMORY_LLM_API_KEY"):
        return
    path = os.environ.get("LLM_PROVIDERS_FILE", "")
    if not path or not os.path.exists(path):
        return
    try:
        import json as _json
        doc = _json.load(open(path))
        providers = doc.get("providers", doc)
        wanted = os.environ.get("MEMORY_LLM_PROVIDER", "finddata")
        for p in providers:
            if isinstance(p, dict) and p.get("id") == wanted:
                if p.get("baseUrl"):
                    os.environ.setdefault("MEMORY_LLM_BASE_URL", str(p["baseUrl"]))
                key = p.get("apiKey") or p.get("key")
                if key:
                    os.environ.setdefault("MEMORY_LLM_API_KEY", str(key))
                return
    except Exception as e:
        print(f"[fd-memory-distiller] provider store parse failed: {e}", flush=True)


def main():
    load_provider_env()
    port = int(os.environ.get("DISTILLER_PORT", "8100"))
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"[fd-memory-distiller] listening on 0.0.0.0:{port} engine={engine.ENGINE}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
