# Measure real embed-lane latency (2026-11-11). Run inside the distiller pod:
#   kubectl exec ... -- sh -c 'cd /app && python /tmp/lat.py'
import asyncio
import time

import engine
import openai


async def main():
    k, b = engine.embed_credentials()
    for n in (1, 4, 8):
        c = openai.AsyncOpenAI(api_key=k, base_url=b or None)
        texts = ["中国新能源汽车出口 2025 年 数据"] * n
        t0 = time.monotonic()
        try:
            r = await c.embeddings.create(model=engine.EMBED_MODEL, input=texts)
            dt = time.monotonic() - t0
            tok = getattr(r.usage, "total_tokens", 0)
            print("n=%d wall=%.2fs vectors=%d tokens=%s" % (n, dt, len(r.data), tok))
        except Exception as e:
            print("n=%d wall=%.2fs ERR %s: %s" % (n, time.monotonic() - t0, type(e).__name__, str(e)[:80]))


asyncio.run(main())
