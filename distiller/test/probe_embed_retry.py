# In-image probe for the embed retry policy (2026-11-11).
#
# Why: engine.py asks openai.AsyncOpenAI for a client WITHOUT max_retries, and
# the SDK default is 2 — so a 503 that reaches our code has already been tried
# 3 times. Our outer retry therefore multiplies (3 outer x 3 inner = up to 9
# HTTP attempts) and the honest worst-case latency is NOT the 1.05s the backoff
# sum suggests. This script measures it against stub lanes instead of guessing:
#   - always-503      -> how long a doomed call takes (must stay under the
#                        caller's 8s embed deadline, else retrying converts a
#                        fast keyword fallback into a slow one)
#   - 503 twice, then 200 -> does the retry actually recover the turn
# Run inside the built image (it has openai + the real engine.py).
import asyncio
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT = 8765
VECTOR = [0.01] * 8


class _Lane(BaseHTTPRequestHandler):
    mode = "always503"
    hits = 0

    def do_POST(self):  # noqa: N802
        type(self).hits += 1
        n = type(self).hits
        if self.mode == "always503":
            self.send_response(503)
            self.send_header("Content-Type", "text/plain")
            self.end_headers()
            self.wfile.write(b"upstream unavailable")
            return
        if self.mode == "flaky" and n <= 2:
            self.send_response(503)
            self.end_headers()
            self.wfile.write(b"upstream unavailable")
            return
        body = (
            '{"object":"list","model":"stub","usage":{"prompt_tokens":3,"total_tokens":3},'
            '"data":[{"object":"embedding","index":0,"embedding":[' + ",".join(map(str, VECTOR)) + "]}]}"
        ).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


def serve():
    srv = HTTPServer(("127.0.0.1", PORT), _Lane)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


async def main():
    serve()
    os.environ["MEMORY_EMBED_API_KEY"] = "stub"
    os.environ["MEMORY_EMBED_BASE_URL"] = f"http://127.0.0.1:{PORT}/v1"
    os.environ["MEMORY_EMBED_MODEL"] = "stub"
    os.environ.setdefault("EMBED_ATTEMPTS", "3")

    import engine

    for mode in ("always503", "flaky"):
        _Lane.mode = mode
        _Lane.hits = 0
        t0 = time.monotonic()
        vectors, model, tokens, errors = await engine.embed_texts(None, ["a", "b"])
        dt = time.monotonic() - t0
        print(
            f"MODE={mode} http_hits={_Lane.hits} wall={dt:.2f}s "
            f"vectors={len(vectors)} tokens={tokens} errors={errors}"
        )
        print(f"  -> {'RECOVERED' if vectors else 'STILL-FAILED'} in {dt:.2f}s")


asyncio.run(main())
