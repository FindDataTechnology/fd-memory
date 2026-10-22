# fd-memory-distiller HTTP face: POST /distill (fd-memory is the only caller,
# DISTILLER_SHARED_TOKEN bearer) + GET /healthz. stdlib only — no web framework
# between the contract and the engine.

import asyncio
import json
import os
import sys
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
            self._json(200, {
                "facts": [], "experiences": [], "cursor_next": {},
                "llm_calls": [], "tokens": 0,
                "errors": [f"{type(e).__name__}: {str(e)[:300]}"],
            })

    def log_message(self, fmt, *args):
        print(f"[fd-memory-distiller] {self.address_string()} {fmt % args}", flush=True)


def main():
    port = int(os.environ.get("DISTILLER_PORT", "8100"))
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"[fd-memory-distiller] listening on 0.0.0.0:{port} engine={engine.ENGINE}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
