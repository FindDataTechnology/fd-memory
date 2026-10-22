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

from hy_memory.agent.llm_provider import LLMProvider
from hy_memory.config import MemoryConfig
from hy_memory.coding.extractor import CodingMemoryExtractor
from hy_memory.coding.reconciler import (
    build_experience_reconcile_prompt,
    CodingMemoryReconciler,
)
from hy_memory.coding.types import CodingMemory
from hy_memory.pipelines.base import ChatMessage, ToolCall
from json_repair import repair_json

ENGINE = "engine:hy-memory/0244ebe"

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

    if messages:
        drafts, fact_drafts = await extractor.extract(
            messages=messages,
            history_messages=None,
            user_id=scope,
            agent_id=project,
            session_id=session_ids[0] if session_ids else "",
        )
        # fact layer: extract-only at v1 (subject normalization lands with the
        # fact reconciler in a later slice)
        for fd in fact_drafts:
            facts_out.append(entry_from_draft(fd, "fact", [], sources))

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
                for c in candidates_in
            ]
            ops = []
            if cand_objs:
                prompt, _lang = build_experience_reconcile_prompt(drafts, [cand_objs for _ in drafts])
                resp = await provider.complete(prompt=prompt, max_tokens=2000, audit_stage="distill_reconcile")
                ops = CodingMemoryReconciler._parse_ops(resp.content)
            cand_ids = {str(c.get("id")) for c in candidates_in}
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

        # C2 post-check: a CJK conversation must not produce non-CJK tasks
        conv_text = " ".join(m.content or "" for m in messages if getattr(m, "content", None))
        if is_cjk(conv_text):
            for e in experiences_out:
                if not is_cjk(e.get("task", "")):
                    recorder.calls.append({"stage": "lang_check", "ok": True, "warning": f"non-CJK task for CJK session: {e['task'][:60]}"})

    tokens = sum(int(c.get("prompt_tokens", 0) or 0) + int(c.get("completion_tokens", 0) or 0) for c in recorder.calls if c.get("ok"))
    return {
        "facts": facts_out,
        "experiences": experiences_out,
        "cursor_next": {},
        "llm_calls": recorder.calls,
        "tokens": tokens,
        "errors": recorder.errors,
    }
