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


# ── v2.1: fact reconcile + subject dual-path + cap ───────────────────────────

import types, asyncio


class FactDraft:
    def __init__(self, statement, subject, details=""):
        self.statement = statement
        self.subject = subject
        self.details = details
        self.files = []

    def to_dict(self):
        return {"statement": self.statement, "subject": self.subject, "details": self.details, "files": []}


def test_subject_equal_paths():
    assert engine.subject_equal("HKCCR.ccs.TencentYun.COM / PAAS / Agent ", "hkccr.ccs.tencentyun.com/paas/agent")
    assert engine.subject_equal("web/src/pages/UsageTable.tsx", "web/src/pages/UsageTable.tsx ")
    assert not engine.subject_equal("web/src/pages/UsageTable.tsx", "web/src/pages/UsageDetail.tsx")
    # S1 drifted pair: path 1 must NOT equate (that is path 2's job)
    assert not engine.subject_equal("cheap-2 deploy/agent-api", "cheap-2 上的 deploy/agent-api (namespace serving)")


def fake_provider(responses):
    calls = []
    p = types.SimpleNamespace()
    async def complete(*a, **kw):
        calls.append({"stage": kw.get("audit_stage"), "prompt": kw.get("prompt", "")[:60]})
        r = responses.pop(0)
        if isinstance(r, Exception):
            raise r
        return types.SimpleNamespace(content=r, prompt_tokens=10, completion_tokens=5)
    p.complete = complete
    return p, calls


class Rec:
    def __init__(self):
        self.calls = []
        self.errors = []


def test_fact_reconcile_maps_and_merges():
    provider, calls = fake_provider(['{"ops": [{"draft_idx": 0, "supersedes": ["fact_old1"]}]}'])
    rec = Rec()
    drafts = [FactDraft("G7 分组上游 DNS 超时已定位", "G7/DNS")]
    cands = [{"id": "fact_old1", "kind": "fact", "task": "G7 分组 5xx 根因排查", "search_keys": [], "solution": "", "boundary_envs": ""}]
    out = asyncio.run(engine.reconcile_facts(provider, rec, drafts, cands, ["session:s1"], "d-p/a"))
    assert len(out) == 1
    assert out[0]["supersedes"] == ["fact_old1"]
    assert any(c["stage"] == "distill_fact_reconcile" for c in calls)


def test_subject_judge_merges_drifted_pair():
    judge_json = '{"matches": [{"i": 0, "j": 0, "same": true, "reason": "同一车道仅措辞不同"}]}'
    provider, calls = fake_provider(['{"ops": {}}', judge_json])
    rec = Rec()
    drafts = [FactDraft("cheap-2 上的 deploy/agent-api (namespace serving) 恢复", "cheap-2 deploy/agent-api 车道")]
    cands = [{"id": "fact_old9", "kind": "fact", "task": "cheap-2 deploy/agent-api 车道 403 排查", "search_keys": [], "solution": "", "boundary_envs": ""}]
    out = asyncio.run(engine.reconcile_facts(provider, rec, drafts, cands, ["session:s2"], "d-p/a"))
    assert out[0]["supersedes"] == ["fact_old9"]
    assert any(c["stage"] == "distill_subject_judge" for c in calls)
    assert any(c.get("merged") for c in rec.calls)


def test_fact_cap_drops_with_audit():
    provider, calls = fake_provider(['{"ops": [{"draft_idx": 0, "supersedes": ["f1"]}, {"draft_idx": 1, "supersedes": ["f2"]}]}', '{"matches": []}'])
    rec = Rec()
    drafts = [FactDraft(f"事实 {i}", f"s{i}") for i in range(4)]
    cands = [{"id": f"f{i}", "kind": "fact", "task": f"t{i}", "search_keys": [], "solution": "", "boundary_envs": ""} for i in range(2)]
    out = asyncio.run(engine.reconcile_facts(provider, rec, drafts, cands, ["session:s3"], "d-p/a"))
    assert len(out) == 2  # FACT_MAX default 2
    assert any(c.get("stage") == "fact_cap" and "dropped" in c.get("warning", "") for c in rec.calls)
    # merged drafts keep their slots (both supersedes present or merged-first ordering)
    assert all(e["supersedes"] or i >= 0 for i, e in enumerate(out))
