"""投递契约（task 1.9）：失败即丢、有界超时、幂等键、封闭集拒收、空 body 兜底、截断。"""

import json
import time

import pytest

from yongyi_agent.observe import (
    BODY_CAP,
    DEFAULT_TIMEOUT,
    EVENT_TYPES,
    Observer,
    UnknownEventType,
    build_payload,
    observe_once,
    observe_url,
)


def test_observe_url_tolerates_trailing_slash():
    assert observe_url("http://h:1/") == "http://h:1/observe"
    assert observe_url("http://h:1//") == "http://h:1/observe"


def test_payload_shape_matches_the_kernel_contract():
    payload = build_payload(event_type="tool_call", title="t", body="b")
    assert set(payload) == {"type", "idempotency_key", "title", "body"}
    assert payload["type"] == "tool_call"
    assert len(payload["idempotency_key"]) == 36  # uuid4 字符串


def test_optional_fields_only_appear_when_given():
    payload = build_payload(event_type="turn_outcome", title="t", body="b", subject="s", project="p", metadata={"a": 1})
    assert payload["subject"] == "s"
    assert payload["project"] == "p"
    assert payload["metadata"] == {"a": 1}
    bare = build_payload(event_type="turn_outcome", title="t", body="b")
    for absent in ("subject", "ts", "harness", "metadata", "project"):
        assert absent not in bare


def test_closed_set_is_enforced_at_construction_time():
    with pytest.raises(UnknownEventType):
        build_payload(event_type="page_view", title="t", body="b")
    # 封闭集本身不许悄悄长大
    assert EVENT_TYPES == ("turn_outcome", "tool_call", "health_flip")


def test_empty_title_is_a_configuration_error():
    with pytest.raises(ValueError):
        build_payload(event_type="turn_outcome", title="  ", body="b")


def test_empty_body_gets_a_narrative_fallback_not_a_drop():
    payload = build_payload(event_type="turn_outcome", title="过场回合", body="")
    assert payload["body"].strip() != ""
    assert "过场回合" in payload["body"]


def test_body_is_truncated_client_side():
    payload = build_payload(event_type="tool_call", title="t", body="x" * (BODY_CAP + 5000))
    assert len(payload["body"]) <= BODY_CAP + 1  # +1 = 省略号


def test_delivery_carries_bearer_and_json_content_type(observer, transport):
    observer.emit("tool_call", "工具调用：search", "ok")
    call = transport.last
    assert call["url"] == "http://127.0.0.1:49375/observe"
    assert call["headers"]["authorization"] == "Bearer test-token"
    assert call["headers"]["content-type"] == "application/json"
    assert call["payload"]["harness"] == "pytest"


def test_unreachable_service_is_swallowed(transport):
    observer = Observer("http://h:1", "t", transport=transport, synchronous=True)
    transport.raises = ConnectionRefusedError("nope")
    assert observer.emit("turn_outcome", "t", "b")  # 不抛
    assert observer.last_error is not None


def test_non_2xx_is_a_drop_not_a_raise(transport):
    observer = Observer("http://h:1", "t", transport=transport, synchronous=True)
    transport.status = 400
    observer.emit("turn_outcome", "t", "b")
    assert observer.last_error == "observe HTTP 400"
    assert len(transport.calls) == 1  # 不重试


def test_async_delivery_returns_immediately_and_still_lands(transport):
    observer = Observer("http://h:1", "t", transport=transport)  # 异步
    started = time.monotonic()
    key = observer.emit("turn_outcome", "t", "b")
    assert time.monotonic() - started < 0.5
    deadline = time.monotonic() + 2
    while not transport.calls and time.monotonic() < deadline:
        time.sleep(0.01)
    assert transport.calls, "守护线程应该完成投递"
    assert transport.last["payload"]["idempotency_key"] == key


def test_explicit_idempotency_key_is_reused(observer, transport):
    observer.emit("tool_call", "t", "b", idempotency_key="k-1")
    observer.emit("tool_call", "t", "b", idempotency_key="k-1")
    assert [c["payload"]["idempotency_key"] for c in transport.calls] == ["k-1", "k-1"]


def test_convenience_entry_points_set_metadata(observer, transport):
    observer.tool_call("search", {"hits": 3})
    assert transport.last["payload"]["metadata"]["tool"] == "search"
    observer.turn_outcome("回合收尾", "done", outcome="error")
    assert transport.last["payload"]["metadata"]["outcome"] == "error"


def test_default_timeout_is_bounded(transport):
    observer = Observer("http://h:1", "t", transport=transport, synchronous=True)
    observer.emit("health_flip", "t", "b")
    assert transport.last["timeout"] == DEFAULT_TIMEOUT


def test_observe_once_reports_failure_without_raising(monkeypatch):
    import yongyi_agent.observe as mod

    monkeypatch.setattr(
        mod,
        "_urllib_transport",
        lambda *a, **k: (_ for _ in ()).throw(OSError("down")),
    )
    assert observe_once("http://h:1", "t", "turn_outcome", "t", "b") is False


def test_payload_is_json_serialisable_with_unicode(observer, transport):
    observer.emit("turn_outcome", "回合收尾", "中文正文 ok")
    body = json.dumps(transport.last["payload"], ensure_ascii=False)
    assert "中文正文" in body
