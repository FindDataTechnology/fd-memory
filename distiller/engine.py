# fd-memory-distiller — engine #1 sidecar (add-memory-distiller, design D3)
#
# Boundary patches over pinned Hy-Memory — the engine's own internals stay
# authoritative; we only repair at the JSON boundary (C1), pin output language
# (C2), and make every LLM call visible (C3):
#   C1  _parse_output / _parse_ops are wrapped to retry through json_repair
#       when the native parse yields nothing (S1 pass-1 s02: one unescaped
#       quote dropped a whole segment).
#   C2  the selected extract template gets a hard language-pinning line
#       appended (task/search_keys must follow the conversation language),
#       plus a post-check that records a warning call when a CJK session
#       produced non-CJK task text.
#   C3  provider.complete is wrapped per request: every call (ok or failed)
#       lands in llm_calls; the engine's swallowed exceptions surface in
#       DistillResult.errors so "nothing worth keeping" and "call failed" are
#       distinguishable in OUR books (S1 pass-1 s08).

import json
import os
import re
import time
import uuid

import openai

from hy_memory.agent.llm_provider import LLMProvider
from hy_memory.config import MemoryConfig
from hy_memory.coding.extractor import CodingMemoryExtractor
from hy_memory.coding.reconciler import (
    build_experience_reconcile_prompt,
    CodingMemoryReconciler,
)
from hy_memory.coding.types import CodingMemory, WorkingFact
from hy_memory.coding.fact_reconciler import build_fact_reconcile_prompt, WorkingFactReconciler
from hy_memory.pipelines.base import ChatMessage, ToolCall
from json_repair import repair_json

ENGINE = "engine:hy-memory/0244ebe"

EMBED_MODEL = os.environ.get("MEMORY_EMBED_MODEL", "Qwen/Qwen3-Embedding-8B")

# Unified memory & outputs (add-unified-memory-and-outputs): tagging lane —
# propose <=5 tags and a tier candidate for reference pages, learning the
# owner's correction vocabulary. JSON repaired at the boundary like /distill.
TAG_MAX = 5
TAG_TIERS = ("draft", "stable", "canonical")


async def tag_items(provider: LLMProvider, items: list[dict]) -> dict:
    if not items:
        return {"results": [], "tokens": 0, "llm_calls": [], "errors": []}
    payload = []
    for i, it in enumerate(items[:12]):
        payload.append({
            "idx": i,
            "title": str(it.get("title") or "")[:200],
            "summary": str(it.get("summary") or "")[:400],
            "current_tags": list(it.get("current_tags") or [])[:TAG_MAX],
            "corrections": str(it.get("corrections") or "")[:400],
            "current_tier": str(it.get("current_tier") or "draft"),
        })
    prompt = (
        "你是记忆系统的打标器。给每个 reference 产出："
        "最多 5 个语义 tags 与一个 tier 候选（draft|stable|canonical，"
        "canonical 仅在明显已定稿/被分享/已被引用时给，否则保守为 stable 或保持 draft）。"
        "如果给出了用户以往修正用过的词汇表，tags 优先借用那份词表。"
        "只回 JSON 数组，无其它文字："
        '[{"idx": 0, "tags": ["..."], "tier": "stable"}]\n\n' + json.dumps(payload, ensure_ascii=False)
    )
    llm_calls: list[dict] = []
    tokens = 0
    # 1200 was the observed completion ceiling for a single item on a chatty
    # model (production probe 2026-10-28: completion_tokens=1200 exactly, body
    # truncated → empty results, tokens still billed). Items ride 12 per call,
    # so the ceiling must hold a list of them, not one.
    resp = await provider.complete(prompt=prompt, max_tokens=4000, audit_stage="reference_tag")
    texto = getattr(resp, "content", "") or ""
    tokens = int(getattr(resp, "prompt_tokens", 0) or 0) + int(getattr(resp, "completion_tokens", 0) or 0)
    llm_calls.append({"kind": "tag", "tokens": tokens})
    text = texto
    # json_repair.repair_json() returns a JSON *string* (its callers elsewhere in
    # this file hand that string to a text parser). Treating it as an already
    # parsed object here made `isinstance(parsed, list)` false for every
    # response, so /tag answered {"results": []} while still burning a full
    # LLM call — production tagged nothing for a day (2026-10-28).
    try:
        raw = str(text).strip()
        try:
            parsed = json.loads(raw)
        except Exception:
            parsed = json.loads(repair_json(raw))
        if isinstance(parsed, dict):
            # Tolerate a wrapper object from a chattier model.
            parsed = parsed.get("results") or parsed.get("items") or []
        if not isinstance(parsed, list):
            raise ValueError("tag result is not a list")
    except Exception:
        parsed = []
    results = []
    for r in parsed:
        try:
            idx = int(r.get("idx"))
            tags = [str(t).strip() for t in (r.get("tags") or []) if str(t).strip()][:TAG_MAX]
            tier_in = str(r.get("tier") or "")
            tier = tier_in if tier_in in TAG_TIERS else "draft"
            if 0 <= idx < len(items):
                results.append({"idx": idx, "tags": tags, "tier": tier})
        except Exception:
            continue
    return {"results": results, "tokens": tokens, "llm_calls": llm_calls, "errors": []}


# Tier promotion lane (add-tier-promotion-candidates): a second opinion on
# draft pages — is this worth `stable`? The judgement is ADVISORY: fd-memory
# stores it as a pending proposal a human accepts or ignores; nothing here
# changes a page's tier directly. The ceiling lives in the parser, not the
# prompt: whatever the model says, a suggestion can only ever come out
# `stable` (canonical is reserved for human gestures / trusted signals).
PROMOTE_MAX = 20


async def promote_items(provider: LLMProvider, items: list[dict]) -> dict:
    if not items:
        return {"results": [], "tokens": 0, "llm_calls": [], "errors": []}
    payload = []
    for i, it in enumerate(items[:PROMOTE_MAX]):
        payload.append({
            "idx": i,
            "title": str(it.get("title") or "")[:200],
            "summary": str(it.get("summary") or "")[:400],
            "current_tier": str(it.get("current_tier") or "draft"),
        })
    prompt = (
        "你是记忆系统的层级晋升评委。判断每个 draft 页是否值得升为 stable："
        "stable = 内容完整、表述稳定、有复用价值（口径清晰、结论可用）；"
        "none = 仍是草稿（残缺、过时、一次性、含糊）。"
        "你只能给 stable 或 none 两种答案；canonical 由人类专属授予，你绝对不给。"
        "只回 JSON 数组，无其它文字："
        '[{"idx": 0, "suggest_tier": "stable", "reason": "一句话理由"}]\n\n'
        + json.dumps(payload, ensure_ascii=False)
    )
    llm_calls: list[dict] = []
    tokens = 0
    resp = await provider.complete(prompt=prompt, max_tokens=2000, audit_stage="tier_promotion")
    texto = getattr(resp, "content", "") or ""
    tokens = int(getattr(resp, "prompt_tokens", 0) or 0) + int(getattr(resp, "completion_tokens", 0) or 0)
    llm_calls.append({"kind": "promote", "tokens": tokens})
    try:
        raw = str(texto).strip()
        try:
            parsed = json.loads(raw)
        except Exception:
            parsed = json.loads(repair_json(raw))
        if isinstance(parsed, dict):
            parsed = parsed.get("results") or parsed.get("items") or []
        if not isinstance(parsed, list):
            raise ValueError("promote result is not a list")
    except Exception:
        parsed = []
    results = []
    for r in parsed:
        try:
            idx = int(r.get("idx"))
            if not (0 <= idx < len(items[:PROMOTE_MAX])):
                continue
            sug = str(r.get("suggest_tier") or r.get("tier") or "").strip().lower()
            # The cap is enforced HERE, not in the prompt: models say
            # "canonical" when told not to. Anything above stable collapses
            # to stable; anything unrecognized collapses to no-proposal.
            if sug in ("stable", "canonical"):
                sug = "stable"
            else:
                sug = "none"
            reason = str(r.get("reason") or "").strip()[:240]
            results.append({"idx": idx, "suggest_tier": sug, "reason": reason})
        except Exception:
            continue
    return {"results": results, "tokens": tokens, "llm_calls": llm_calls, "errors": []}



EMBED_BATCH_MAX = 64


def embed_credentials():
    """Lane key with the same fallback chain hy's provider config uses."""
    return (
        os.environ.get("MEMORY_EMBED_API_KEY") or os.environ.get("MEMORY_LLM_API_KEY") or os.environ.get("LLM_API_KEY") or "",
        os.environ.get("MEMORY_EMBED_BASE_URL") or os.environ.get("MEMORY_LLM_BASE_URL") or os.environ.get("LLM_BASE_URL") or "",
    )


async def embed_texts(provider_factory, texts):
    """Embed via the 词元 lane through a bare OpenAI-compatible call on the
    SAME provider env the engine uses. Returns (vectors, model, tokens, errors)."""
    errors = []
    vectors = []
    # Lane credentials resolved HERE (same chain as hy's provider config:
    # MEMORY_EMBED_* → MEMORY_LLM_* → LLM_*) — a construction-time empty key
    # raises outside the try below, so resolve before touching openai.
    k, b = embed_credentials()
    client = openai.AsyncOpenAI(api_key=k, base_url=b or None)
    try:
        resp = await client.embeddings.create(model=EMBED_MODEL, input=list(texts)[:EMBED_BATCH_MAX])
        vectors = [d.embedding for d in resp.data]
        tokens = getattr(resp.usage, "total_tokens", 0) or 0
        return vectors, EMBED_MODEL, tokens, errors
    except Exception as e:
        errors.append(f"embed {type(e).__name__}: {str(e)[:160]}")
        return [], EMBED_MODEL, 0, errors

LANG_PIN_ZH = "\n\n硬性要求（MUST）：task 与 search_keys 必须使用与会话相同的语言（本次会话为中文，就必须用中文书写 task 与 search_keys）。\n"
LANG_PIN_EN = "\n\nHARD REQUIREMENT: task and search_keys MUST be written in the same language as the conversation.\n"


# ── boundary patches (applied once at import) ────────────────────────────────

_orig_select_tmpl = CodingMemoryExtractor._select_prompt_template


def _select_tmpl_with_pin(self, messages):
    tmpl, lang = _orig_select_tmpl(self, messages)
    return tmpl + (LANG_PIN_ZH if lang == "zh" else LANG_PIN_EN), lang


CodingMemoryExtractor._select_prompt_template = _select_tmpl_with_pin

_orig_parse_output = CodingMemoryExtractor._parse_output.__func__


def _parse_output_repaired(cls, text):
    if not text:
        return [], []
    res = _orig_parse_output(cls, text)
    if res == ([], []) and "{" in text:
        try:
            fixed = repair_json(text)
            res2 = _orig_parse_output(cls, fixed)
            if res2 != ([], []):
                return res2
        except Exception:
            pass
    return res


CodingMemoryExtractor._parse_output = classmethod(_parse_output_repaired)

_orig_parse_ops = CodingMemoryReconciler._parse_ops
if hasattr(_orig_parse_ops, "__func__"):  # classmethod vs plain staticmethod
    _orig_parse_ops = _orig_parse_ops.__func__


def _parse_ops_repaired(cls, text):
    if not text:
        return []
    # _orig_parse_ops is the raw staticmethod function: signature is (text)
    ops = _orig_parse_ops(text)
    if not ops and "{" in text:
        try:
            ops = _orig_parse_ops(repair_json(text))
        except Exception:
            pass
    return ops


CodingMemoryReconciler._parse_ops = classmethod(_parse_ops_repaired)


class CallRecorder:
    """C3: per-request record of every provider.complete call."""

    def __init__(self):
        self.calls = []
        self.errors = []

    def wrap(self, provider):
        orig = provider.complete

        async def complete(*args, **kwargs):
            entry = {"stage": kwargs.get("audit_stage", "?"), "ok": False, "t0": time.time()}
            self.calls.append(entry)
            try:
                resp = await orig(*args, **kwargs)
                entry.update(
                    ok=True,
                    prompt_tokens=getattr(resp, "prompt_tokens", 0),
                    completion_tokens=getattr(resp, "completion_tokens", 0),
                    elapsed=round(time.time() - entry["t0"], 2),
                )
                return resp
            except Exception as e:
                entry.update(elapsed=round(time.time() - entry["t0"], 2), error=f"{type(e).__name__}: {str(e)[:200]}")
                self.errors.append(entry["error"])
                raise

        provider.complete = complete


# ── sanitization (ported verbatim from fd-memory src/sanitize.ts) ────────────

PEM_BLOCK = re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----.*?-----END (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----", re.S)
KNOWN_TOKEN = re.compile(r"\b(?:sk-[A-Za-z0-9_-]{16,}|sk_live_[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[A-Z0-9]{12,}|AIza[A-Za-z0-9_-]{30,}|xox[bp]-[A-Za-z0-9-]{10,}|fdm_[A-Za-z0-9]{32,}|wgk--[A-Za-z0-9-]{16,})\b")
BEARER = re.compile(r"\b[Bb]earer\s+[A-Za-z0-9._~+/=-]{12,}")
LABELED_SECRET = re.compile(r"\b(api[_-]?key|access[_-]?token|auth[_-]?token|secret|password|token)\b[\"'\s:=]{1,3}[\"']?([A-Za-z0-9._~+/=-]{6,})", re.I)
BIDI = re.compile("[\u202A-\u202E\u2066-\u2069]")


def sanitize(text):
    if not text:
        return text
    out = BIDI.sub("\uFFFD", text)
    out = PEM_BLOCK.sub("[REDACTED PRIVATE KEY]", out)
    out = KNOWN_TOKEN.sub("[REDACTED CREDENTIAL]", out)
    out = BEARER.sub("bearer [REDACTED]", out)
    out = LABELED_SECRET.sub(lambda m: f"{m.group(1)}=[REDACTED]", out)
    return out


CJK = re.compile(r"[\u4e00-\u9fff]")

SUBJECT_EDGE_PUNCT = " \t\r\n,.;:、。，；：！？\"'`()[]（）「」【】《》-_/\\|"


def subject_equal(a, b):
    """Path-1 gate: squeezed-form OR whitespace-stripped equality — the spec
    scenario is 'case or whitespace differences only (paths/domains/emails)'."""
    na, nb = normalize_subject(a), normalize_subject(b)
    return bool(na) and bool(nb) and (na == nb or re.sub(r"\s", "", na) == re.sub(r"\s", "", nb))


def normalize_subject(s):
    """D2 path 1: NFKC (full→half width), lowercase, squeezed whitespace,
    edge punctuation stripped. Machine identifiers (paths/domains/emails)
    become equal here; drifted CJK noun phrases do not (path 2 judges them)."""
    if not s:
        return ""
    out = unicodedata.normalize("NFKC", str(s)).lower()
    out = re.sub(r"\s+", " ", out).strip()
    return out.strip(SUBJECT_EDGE_PUNCT)


import unicodedata  # noqa: E402  (kept next to its single consumer)


FACT_MAX_PER_DISTILL = int(os.environ.get("DISTILLER_FACT_MAX", "2"))

SUBJECT_JUDGE_PROMPT = """You are a subject-equivalence judge for a memory system.
Decide whether each DRAFT subject refers to the SAME real-world entity/topic as a CANDIDATE subject.
Drifted phrasing of one entity (added location words, parentheses, suffixes, word order) is the SAME subject.
Genuinely different entities (different host/path/account/task) are DIFFERENT.
Answer ONLY with JSON:
{{"matches": [{{"i": <draft index>, "j": <candidate index>, "same": true|false, "reason": "<short>"}}]}}
One entry per PAIR listed below.

DRAFTS:
{drafts_block}

CANDIDATES:
{candidates_block}
"""


def is_cjk(text):
    return bool(text) and bool(CJK.search(text))


# ── items → engine messages (the S1 fixture shape) ───────────────────────────


def items_to_messages(items):
    sessions = {}
    order = []
    for it in items:
        sid = str(it.get("session_id") or "")
        if not sid:
            continue
        if sid not in sessions:
            sessions[sid] = []
            order.append(sid)
        kind = it.get("kind")
        if kind == "handoff":
            sessions[sid].append(ChatMessage(role="user", content=f"[handoff from {it.get('agent', 'unknown')}] {it.get('summary', '')}"))
            continue
        ev = it.get("event")
        summary = str(it.get("summary") or "")
        tool = it.get("tool")
        if ev == "user-prompt-submit":
            sessions[sid].append(ChatMessage(role="user", content=summary))
        elif ev == "pre-tool-use":
            call_id = f"{sid}:{len(sessions[sid])}"
            sessions[sid].append({"call_id": call_id, "tool": tool or "tool", "summary": summary})
        elif ev == "post-tool-use":
            pending = None
            for m in reversed(sessions[sid]):
                if isinstance(m, dict):
                    pending = m
                    break
            if pending is None:
                pending = {"call_id": f"{sid}:{len(sessions[sid])}", "tool": tool or "tool", "summary": ""}
                sessions[sid].append(pending)
            sessions[sid].append(
                ChatMessage(role="tool", tool_call_id=pending["call_id"], tool_name=pending["tool"], content=summary)
            )
            sessions[sid][sessions[sid].index(pending)] = ChatMessage(
                role="assistant",
                content="",
                tool_calls=[ToolCall(id=pending["call_id"], name=pending["tool"], arguments=pending["summary"])],
            )
        elif ev == "stop":
            sessions[sid].append(ChatMessage(role="assistant", content=summary))
        # session-start / session-end are boundaries only
    messages = []
    for sid in order:
        messages.extend(m for m in sessions[sid] if not isinstance(m, dict))
    return messages, order


def entry_from_draft(draft, kind, supersedes, sources):
    d = draft.to_dict() if hasattr(draft, "to_dict") else dict(draft.__dict__)
    eid = f"{kind}_{uuid.uuid4().hex[:8]}"
    if kind == "experience":
        return {
            "id": eid,
            "engine": ENGINE,
            "task": sanitize(str(d.get("task", ""))),
            "search_keys": [sanitize(str(k)) for k in d.get("search_keys", [])],
            "solution": sanitize(str(d.get("solution", ""))),
            "boundary_envs": sanitize(str(d.get("boundary_envs", ""))),
            "files": [sanitize(str(f)) for f in d.get("files", [])],
            "confidence": d.get("confidence"),
            "supersedes": supersedes,
            "sources": sources,
        }
    return {
        "id": eid,
        "engine": ENGINE,
        "statement": sanitize(str(d.get("statement", ""))),
        "subject": sanitize(str(d.get("subject", ""))),
        "files": [sanitize(str(f)) for f in d.get("files", [])],
        "details": sanitize(str(d.get("details", "")))[:4000],
        "supersedes": supersedes,
        "sources": sources,
    }


async def reconcile_facts(provider, recorder, fact_drafts, fact_candidates, sources, scope):
    """v2.1 fact layer: engine reconcile mapping → subject dual-path → cap.
    Returns the fact entries to emit."""
    out: list = []
    if fact_drafts:
        related: dict[int, list[str]] = {}
        if fact_candidates:
            fact_objs = [
                WorkingFact(
                    fact_id=str(c.get("id")),
                    user_id=scope,
                    statement=str(c.get("task", "")),
                    subject=str(c.get("task", ""))[:200],
                )
                for c in fact_candidates
            ]
            fprompt, _flang = build_fact_reconcile_prompt(fact_drafts, [fact_objs for _ in fact_drafts])
            fresp = await provider.complete(prompt=fprompt, max_tokens=2000, audit_stage="distill_fact_reconcile")
            related = WorkingFactReconciler._parse_ops(fresp.content) or {}

            # D2 path 2: subjects that normalization cannot equate go to ONE
            # structured LLM judgment; judged-same pairs count as related.
            judge_pairs = []
            for i in range(len(fact_drafts)):
                d_sub = getattr(fact_drafts[i], "subject", "") or ""
                for j, c in enumerate(fact_candidates):
                    if str(c.get("id")) in [str(x) for x in related.get(i, [])]:
                        continue
                    if subject_equal(d_sub, str(c.get("task", ""))):
                        related.setdefault(i, []).append(str(c.get("id")))  # path 1: equality
                        continue
                    judge_pairs.append((i, j, d_sub, str(c.get("task", ""))))
            if judge_pairs:
                drafts_block = "\n".join(f"{i}. {sub}" for i, _j, sub, _c in judge_pairs)
                cands_block = "\n".join(f"{j}. {csub}" for _i, j, _s, csub in judge_pairs)
                jresp = await provider.complete(
                    prompt=SUBJECT_JUDGE_PROMPT.format(drafts_block=drafts_block, candidates_block=cands_block),
                    max_tokens=1000,
                    audit_stage="distill_subject_judge",
                )
                try:
                    jm = json.loads(repair_json(jresp.content))
                    for m in jm.get("matches", []):
                        if not m.get("same"):
                            continue
                        pair = judge_pairs[int(m.get("i", -1))]
                        if int(m.get("j", -1)) == pair[1]:
                            related.setdefault(pair[0], []).append(str(fact_candidates[pair[1]].get("id")))
                            recorder.calls.append({"stage": "distill_subject_judge", "ok": True, "merged": f"{pair[2][:40]} == {pair[3][:40]}", "reason": str(m.get("reason", ""))[:120]})
                except Exception as e:
                    recorder.calls.append({"stage": "distill_subject_judge", "ok": True, "warning": f"judge parse failed, pairs left unrelated: {type(e).__name__}"})

        # cap: merges (supersedes) keep their slots first, then plain adds
        merged = [(i, sup) for i, sup in related.items() if sup]
        plain = [i for i in range(len(fact_drafts)) if not related.get(i)]
        keep = [i for i, _ in merged] + plain
        dropped = keep[FACT_MAX_PER_DISTILL:]
        keep = keep[:FACT_MAX_PER_DISTILL]
        if dropped:
            recorder.calls.append({"stage": "fact_cap", "ok": True, "warning": f"dropped {len(dropped)} fact draft(s) (DISTILLER_FACT_MAX={FACT_MAX_PER_DISTILL})"})
        for i in keep:
            out.append(entry_from_draft(fact_drafts[i], "fact", [str(x) for x in related.get(i, [])], sources))
    return out


async def distill(request):
    scope = str(request.get("scope", ""))
    project = scope.split("/")[-1] if "/" in scope else "default"
    items = request.get("items") or []
    candidates_in = request.get("candidates") or []

    recorder = CallRecorder()
    provider = LLMProvider(MemoryConfig())
    recorder.wrap(provider)
    extractor = CodingMemoryExtractor(llm_provider=provider, max_tokens=6000, scene="working")

    messages, session_ids = items_to_messages(items)
    sources = [f"session:{sid}" for sid in session_ids]

    facts_out = []
    experiences_out = []

    exp_candidates = [c for c in candidates_in if c.get("kind") != "fact"]
    fact_candidates = [c for c in candidates_in if c.get("kind") == "fact"]

    if messages:
        drafts, fact_drafts = await extractor.extract(
            messages=messages,
            history_messages=None,
            user_id=scope,
            agent_id=project,
            session_id=session_ids[0] if session_ids else "",
        )

        if drafts:
            cand_objs = [
                CodingMemory(
                    experience_id=str(c.get("id")),
                    user_id=scope,
                    task=str(c.get("task", "")),
                    search_keys=list(c.get("search_keys", [])),
                    solution=str(c.get("solution", "")),
                    boundary_envs=str(c.get("boundary_envs", "")),
                )
                for c in exp_candidates
            ]
            ops = []
            if cand_objs:
                prompt, _lang = build_experience_reconcile_prompt(drafts, [cand_objs for _ in drafts])
                resp = await provider.complete(prompt=prompt, max_tokens=2000, audit_stage="distill_reconcile")
                ops = CodingMemoryReconciler._parse_ops(resp.content)
            cand_ids = {str(c.get("id")) for c in exp_candidates}
            decided = set()
            for op in ops or []:
                idx = getattr(op, "draft_idx", None)
                target = str(getattr(op, "target_experience_id", "") or "")
                action = str(getattr(op, "action", "")).upper()
                if idx is None or idx < 0 or idx >= len(drafts) or idx in decided:
                    continue
                decided.add(idx)
                if action == "SKIP":
                    continue
                supersedes = [target] if (action in ("UPDATE", "DELETE") and target in cand_ids) else []
                experiences_out.append(entry_from_draft(drafts[idx], "experience", supersedes, sources))
            for i, d in enumerate(drafts):
                if i not in decided:
                    experiences_out.append(entry_from_draft(d, "experience", [], sources))

        if fact_drafts:
            facts_out.extend(await reconcile_facts(provider, recorder, fact_drafts, fact_candidates, sources, scope))

        # C2 post-check: a CJK conversation must not produce non-CJK tasks
        conv_text = " ".join(m.content or "" for m in messages if getattr(m, "content", None))
        if is_cjk(conv_text):
            for e in experiences_out:
                if not is_cjk(e.get("task", "")):
                    recorder.calls.append({"stage": "lang_check", "ok": True, "warning": f"non-CJK task for CJK session: {e['task'][:60]}"})

    tokens = sum(int(c.get("prompt_tokens", 0) or 0) + int(c.get("completion_tokens", 0) or 0) for c in recorder.calls if c.get("ok"))

    # v2.2: embed emitted entries (task/statement + solution) so fd-memory can
    # store companion vectors — recall no longer depends on keyword overlap.
    embeddable = [(e, f"{e.get('task', e.get('statement', ''))} {e.get('solution', '')}".strip()) for e in experiences_out + facts_out]
    if embeddable:
        t0 = time.time()
        vecs, model, etokens, eerrors = await embed_texts(
            lambda: openai.AsyncOpenAI(
                api_key=os.environ.get("MEMORY_LLM_API_KEY", ""),
                base_url=os.environ.get("MEMORY_LLM_BASE_URL", ""),
            ),
            [t for _e, t in embeddable],
        )
        # vectors are companion data: an embed outage must NOT fail the
        # distillation — entries ship without vectors, recall falls back to
        # keywords (the warning row keeps it visible in llm_calls).
        recorder.calls.append({"stage": "embed", "ok": not eerrors, "count": len(vecs), "model": model,
                               "tokens": etokens, "elapsed": round(time.time() - t0, 2),
                               **({"warning": eerrors[0]} if eerrors else {})})
        for (entry, _t), v in zip(embeddable, vecs):
            entry["vector"] = v
            entry["vector_model"] = model
        tokens += etokens

    return {
        "facts": facts_out,
        "experiences": experiences_out,
        "cursor_next": {},
        "llm_calls": recorder.calls,
        "tokens": tokens,
        "errors": recorder.errors,
    }
