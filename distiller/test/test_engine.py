# Engine-side unit tests (C1 repair, C2 post-check, sanitize port, message
# mapping). No LLM: provider calls are stubbed at the boundary the patches
# wrap. Run: python -m pytest distiller/test (needs hy-memory + json_repair).
# CI's zero-LLM tier runs the fd-memory node suite; these run wherever the
# python env exists (eval tier + image build smoke).

import sys, os, types, asyncio, json
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import engine  # applies patches


class FakeResp:
    def __init__(self, content):
        self.content = content
        self.prompt_tokens = 10
        self.completion_tokens = 5


def make_provider(responses):
    calls = []
    provider = types.SimpleNamespace()
    async def complete(*a, **kw):
        calls.append(kw.get("prompt", ""))
        r = responses.pop(0)
        if isinstance(r, Exception):
            raise r
        return FakeResp(r)
    provider.complete = complete
    return provider, calls


def test_c1_repaired_parse_recovers_damaged_json():
    # S1 pass-1 s02 shape: an unescaped quote inside a JSON string
    broken = 'Here you go:\n```json\n{"experiences": [{"task": "fix the "quote" bug", "search_keys": ["quote"], "solution": "escape it", "boundary_envs": "", "confidence": 0.8}], "facts": []}\n```'
    from hy_memory.coding.extractor import CodingMemoryExtractor
    raw = engine._orig_parse_output(CodingMemoryExtractor, broken)
    assert raw == ([], []), f"original parse unexpectedly succeeded: {raw}"
    # through the patched classmethod the segment is NOT lost
    exps, facts = CodingMemoryExtractor._parse_output(broken)
    assert exps or facts  # repaired parse recovered something


def test_sanitize_ports_four_classes():
    out = engine.sanitize("key sk-abcdefghijklmnop123456 bearer abcdefghijklmnop password: \"hunter2secret\"")
    assert "sk-abcdefghijklmnop" not in out
    assert "bearer [REDACTED]" in out
    assert "hunter2secret" not in out


def test_items_to_messages_shapes():
    items = [
        {"kind": "observation", "session_id": "s1", "event": "user-prompt-submit", "summary": "查一下 5xx"},
        {"kind": "observation", "session_id": "s1", "event": "pre-tool-use", "tool": "list_sites", "summary": "{\"scope\":\"all\"}"},
        {"kind": "observation", "session_id": "s1", "event": "post-tool-use", "tool": "list_sites", "summary": "9 组 5xx"},
        {"kind": "observation", "session_id": "s1", "event": "stop", "summary": "已定位"},
        {"kind": "handoff", "session_id": "s1", "summary": "交接：G7 处理方案"},
    ]
    messages, order = engine.items_to_messages(items)
    assert order == ["s1"]
    roles = [m.role for m in messages]
    assert roles == ["user", "assistant", "tool", "assistant", "user"]
    assert messages[1].tool_calls[0].name == "list_sites"


def test_distill_reports_errors_not_silence():
    # C3: a failed provider call must surface in errors even though the
    # engine swallows it internally
    provider, _ = make_provider([TimeoutError("gateway timeout")])
    recorder = engine.CallRecorder()
    recorder.wrap(provider)
    import hy_memory.coding.extractor as ex_mod
    extractor = ex_mod.CodingMemoryExtractor(llm_provider=provider, max_tokens=100, scene="working")
    msgs, _ = engine.items_to_messages([
        {"kind": "observation", "session_id": "s1", "event": "user-prompt-submit", "summary": "hi"},
    ])
    drafts, facts = asyncio.run(extractor.extract(messages=msgs, user_id="d-p/a", agent_id="a", session_id="s1"))
    assert drafts == [] and facts == []
    assert recorder.errors and "gateway timeout" in recorder.errors[0]
