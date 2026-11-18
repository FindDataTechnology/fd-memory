# fd-memory-distiller HTTP face: POST /distill (fd-memory is the only caller,
# DISTILLER_SHARED_TOKEN bearer) + GET /healthz. stdlib only — no web framework
# between the contract and the engine. Fails closed: no shared token in the
# environment means the process exits instead of serving an open port; binds
# 127.0.0.1 unless DISTILLER_BIND names another interface.

import asyncio
import json
import os
import sys
import threading

import openai
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import engine  # noqa: E402  (applies the boundary patches at import)


# 常驻 event loop（2026-11-17 修）。
#
# 症状：distiller 反复崩，fd-memory 侧报 `fetch failed`；err 日志里是
#   RuntimeError: Event loop is closed
#   Task exception was never retrieved
#   future: <Task ... coro=<AsyncClient.aclose()>>
#
# 原因：ThreadingHTTPServer 每个请求一个线程，而每个请求调一次 asyncio.run()，
# 各建一个 loop 用完就关。openai/httpx 的 AsyncClient 在 GC 时要把
# aclose() 的回调投递到**创建它的那个 loop**；等 GC 跑起来，那个 loop 早关了，
# 于是抛 RuntimeError，最坏直接把进程带走（实测一天崩数次，launchd 靠 KeepAlive
# 兜着，所以表现为「蒸馏偶尔 fetch failed」而不是明显的长期宕机）。
#
# 修法：一条常驻 loop 跑在该线程里，所有协程都用 run_coroutine_threadsafe 投进去。
# loop 永不关闭 ⇒ 清理回调永远有地方可投。单 loop 也顺带把并发度钉在 1，
# 这对蒸馏是对的：调度器侧本来就有「同 owner 串行」的约束。
_loop = asyncio.new_event_loop()
_loop_thread = threading.Thread(target=_loop.run_forever, daemon=True, name="distiller-loop")
_loop_thread.start()


def run_async(coro, timeout=None):
    """在常驻 loop 上跑一个协程并等结果（可从任意线程调用）。"""
    fut = asyncio.run_coroutine_threadsafe(
        asyncio.wait_for(coro, timeout=timeout) if timeout else coro, _loop
    )
    return fut.result()


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
        if self.path == "/tag":
            self.handle_tag()
            return
        if self.path == "/promote":
            self.handle_promote()
            return
        if self.path != "/distill":
            self._json(404, {"error": "not_found"})
            return
        expected = os.environ.get("DISTILLER_SHARED_TOKEN", "")
        auth = self.headers.get("authorization", "")
        if not expected or auth != f"Bearer {expected}":
            self._json(401, {"error": "unauthorized"})
            return
        length = int(self.headers.get("content-length", 0))
        try:
            request = json.loads(self.rfile.read(length) or b"{}")
        except Exception:
            self._json(400, {"error": "invalid_body"})
            return
        # Answer before the caller's own budget runs out. fd-memory aborts a
        # /distill call at SIDECCAR_TIMEOUT_MS = 180 s (fd-memory side), and when
        # it does we get no signal at all: the extraction client lives inside
        # hy-memory with the SDK's 600 s read timeout, so a hung call surfaced as
        # a bare `This operation was aborted` on their side and NOTHING in our
        # log (measured 2026-11-11: 3 of 6 calls aborted at exactly 180 s while
        # this process logged zero LLM errors, and a max-size 120-item batch
        # needs only 10-16 s). Timing out here turns that silence into a named
        # error the scheduler can show and retry.
        deadline = engine.parse_deadline_s(os.environ.get("DISTILL_LLM_DEADLINE_S"))
        try:
            result = run_async(engine.distill(request), timeout=deadline)
            self._json(200, result)
        except asyncio.TimeoutError:
            self._json(200, {
                "facts": [], "experiences": [], "cursor_next": {},
                "llm_calls": [], "tokens": 0,
                "errors": [f"distill_deadline_exceeded: no result within {deadline:.0f}s "
                           f"(one LLM call most likely hung; the caller would otherwise "
                           f"abort at its own budget and record nothing)"],
            })
        except Exception as e:  # engine-level failure: report, keep caller's cursor
            import traceback; traceback.print_exc()
            self._json(200, {
                "facts": [], "experiences": [], "cursor_next": {},
                "llm_calls": [], "tokens": 0,
                "errors": [f"{type(e).__name__}: {str(e)[:300]}"],
            })

    def handle_tag(self):
        expected = os.environ.get("DISTILLER_SHARED_TOKEN", "")
        if not expected or self.headers.get("authorization", "") != f"Bearer {expected}":
            self._json(401, {"error": "unauthorized"})
            return
        length = int(self.headers.get("content-length", 0))
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except Exception:
            self._json(400, {"error": "invalid_body"})
            return
        items = body.get("items") or []

        async def run():
            recorder = engine.CallRecorder()
            provider = engine.LLMProvider(engine.MemoryConfig())
            recorder.wrap(provider)
            result = await engine.tag_items(provider, items)
            result["llm_calls"] = recorder.calls
            result["errors"] = result.get("errors", []) + recorder.errors
            return result

        try:
            self._json(200, run_async(run()))
        except Exception as e:
            import traceback; traceback.print_exc()
            self._json(200, {"results": [], "tokens": 0, "llm_calls": [], "errors": [f"{type(e).__name__}: {str(e)[:300]}"]})

    def handle_promote(self):
        # Tier promotion (add-tier-promotion-candidates): same skeleton as
        # /tag — shared token, recorder accounting, failures come back as a
        # structured 200 (never a 500 the scheduler has to guess about).
        expected = os.environ.get("DISTILLER_SHARED_TOKEN", "")
        if not expected or self.headers.get("authorization", "") != f"Bearer {expected}":
            self._json(401, {"error": "unauthorized"})
            return
        length = int(self.headers.get("content-length", 0))
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except Exception:
            self._json(400, {"error": "invalid_body"})
            return
        items = body.get("items") or []

        async def run():
            recorder = engine.CallRecorder()
            provider = engine.LLMProvider(engine.MemoryConfig())
            recorder.wrap(provider)
            result = await engine.promote_items(provider, items)
            result["llm_calls"] = recorder.calls
            result["errors"] = result.get("errors", []) + recorder.errors
            return result

        try:
            self._json(200, run_async(run()))
        except Exception as e:
            import traceback; traceback.print_exc()
            self._json(200, {"results": [], "tokens": 0, "llm_calls": [], "errors": [f"{type(e).__name__}: {str(e)[:300]}"]})

    def handle_embed(self):
        expected = os.environ.get("DISTILLER_SHARED_TOKEN", "")
        if not expected or self.headers.get("authorization", "") != f"Bearer {expected}":
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

        # Vector-lane kill switch, same contract as the Node side
        # (unify-harness-delivery 1.3): MEMORY_EMBED=off means "this deployment
        # has no serving embedding model", so answer without calling upstream
        # instead of paying a 404 round-trip on every digest. Empty vectors is
        # the honest answer — the caller already treats it as keyword-only.
        if str(os.environ.get("MEMORY_EMBED", "")).strip().lower() in ("off", "0", "false", "no"):
            self._json(200, {"vectors": [], "model": engine.EMBED_MODEL, "tokens": 0, "errors": []})
            return

        try:
            vectors, model, tokens, errors = run_async(run())
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
    if not os.environ.get("DISTILLER_SHARED_TOKEN"):
        print("[fd-memory-distiller] DISTILLER_SHARED_TOKEN is not set — refusing to serve", file=sys.stderr, flush=True)
        sys.exit(1)
    load_provider_env()
    host = os.environ.get("DISTILLER_BIND", "127.0.0.1")
    port = int(os.environ.get("DISTILLER_PORT", "8100"))
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"[fd-memory-distiller] listening on {host}:{port} engine={engine.ENGINE}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
