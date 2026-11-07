"""三个框架的映射器（task 1.9）：假事件对象，不装框架即可跑；含载荷缺字段降级与回调抛错不外泄。"""

import pytest

from yongyi_agent import crewai as crewai_mod
from yongyi_agent import langchain as lc_mod
from yongyi_agent import llamaindex as li_mod


# ── LangChain ────────────────────────────────────────────────────────────────

def test_langchain_tool_end_maps_to_tool_call(observer, transport):
    handler = lc_mod.callback_handler(observer)
    handler.on_tool_end("42", name="calculator", run_id="r1", parent_run_id="p1")
    payload = transport.last["payload"]
    assert payload["type"] == "tool_call"
    assert payload["title"] == "工具调用：calculator"
    assert "42" in payload["body"]
    assert payload["harness"] == "pytest"


def test_langchain_tool_name_falls_back_to_serialized(observer, transport):
    handler = lc_mod.callback_handler(observer)
    handler.on_tool_end("x", serialized={"name": "search"}, run_id="r1")
    assert "search" in transport.last["payload"]["title"]


def test_langchain_agent_finish_maps_to_turn_outcome(observer, transport):
    handler = lc_mod.callback_handler(observer)
    handler.on_agent_finish({"output": "最终答案"}, run_id="r1", parent_run_id=None)
    payload = transport.last["payload"]
    assert payload["type"] == "turn_outcome"
    assert payload["metadata"]["outcome"] == "ok"
    assert "最终答案" in payload["body"]


def test_langchain_chain_end_only_counts_at_top_level(observer, transport):
    handler = lc_mod.callback_handler(observer)
    handler.on_chain_end({"output": "inner"}, run_id="r2", parent_run_id="r1")
    assert transport.calls == [], "内层 chain 不是回合收尾"
    handler.on_chain_end({"output": "outer"}, run_id="r1", parent_run_id=None)
    assert len(transport.calls) == 1
    assert transport.last["payload"]["type"] == "turn_outcome"


def test_langchain_chain_error_is_recorded_as_error(observer, transport):
    handler = lc_mod.callback_handler(observer)
    handler.on_chain_error(RuntimeError("boom"), run_id="r1", parent_run_id=None)
    payload = transport.last["payload"]
    assert payload["metadata"]["outcome"] == "error"
    assert "boom" in payload["body"]


def test_langchain_tool_error_is_a_tool_call_with_error_outcome(observer, transport):
    handler = lc_mod.callback_handler(observer)
    handler.on_tool_error(ValueError("bad input"), name="search", run_id="r1")
    payload = transport.last["payload"]
    assert payload["type"] == "tool_call"
    assert payload["metadata"]["outcome"] == "error"


def test_langchain_missing_fields_degrade_instead_of_raising(observer, transport):
    handler = lc_mod.callback_handler(observer)
    handler.on_tool_end(None)  # 什么字段都没有
    assert transport.last["payload"]["title"] == "工具调用：tool"
    handler.on_agent_finish(None)  # 也没有输出
    assert transport.last["payload"]["body"].strip() != ""


def test_langchain_callback_body_never_leaks_exceptions(observer):
    class Exploding:
        def tool_call(self, *a, **k):
            raise RuntimeError("observer broke")

        def turn_outcome(self, *a, **k):
            raise RuntimeError("observer broke")

    handler = lc_mod.YongyiCallbackHandler(Exploding())  # type: ignore[arg-type]
    # 四个入口全部不许抛——框架回调抛错会弄破宿主
    handler.on_tool_end("x", name="t")
    handler.on_tool_error(RuntimeError("e"), name="t")
    handler.on_agent_finish({"output": "x"})
    handler.on_chain_end({"output": "x"})
    handler.on_chain_error(RuntimeError("e"))


def test_langchain_handler_declares_what_it_ignores():
    handler = lc_mod.YongyiCallbackHandler(object())  # type: ignore[arg-type]
    assert handler.ignore_llm is True and handler.ignore_chat_model is True
    assert handler.ignore_chain is False and handler.ignore_agent is False


# ── CrewAI ───────────────────────────────────────────────────────────────────

class FakeToolEvent:
    def __init__(self, name="search", output="3 hits", failure=None, role="researcher", task="find"):
        self.tool_name = name
        self.tool_args = {"q": "x"}
        self.output = output
        self.failure = failure
        self.agent_role = role
        self.task_name = task


class FakeCrewEvent:
    def __init__(self, output="crew done", error=None, total_tokens=1234, crew_name="demo"):
        self.output = output
        self.error = error
        self.total_tokens = total_tokens
        self.crew_name = crew_name


class FakeBus:
    """按 CrewAI 1.15 真机核对的签名：`on(cls)` 是装饰器工厂，`off(cls, fn)` 是两个
    位置参数。

    这两者不对称是真实存在的——我最初把 `off` 也写成装饰器工厂，单测跟着我的假设
    一起错，真机一跑才发现注销是静默空操作（off(cls) 抛 TypeError 被 except 吞）。
    """

    def __init__(self):
        self.handlers = {}

    def on(self, event_cls):
        def register(fn):
            self.handlers.setdefault(event_cls, []).append(fn)
            return fn

        return register

    def off(self, event_cls, fn):
        self.handlers.get(event_cls, []).remove(fn)

    def fire(self, event_cls, event):
        for fn in list(self.handlers.get(event_cls, [])):
            fn("source", event)


class FakeEvents:
    CrewKickoffCompletedEvent = "completed"
    CrewKickoffFailedEvent = "failed"
    ToolUsageFinishedEvent = "tool_done"


def test_crewai_tool_usage_maps_to_tool_call(observer, transport):
    bus = FakeBus()
    crewai_mod.register(observer, bus, events=FakeEvents)
    bus.fire(FakeEvents.ToolUsageFinishedEvent, FakeToolEvent())
    payload = transport.last["payload"]
    assert payload["type"] == "tool_call"
    assert payload["metadata"]["tool"] == "search"
    assert payload["metadata"]["agent_role"] == "researcher"
    assert "3 hits" in payload["body"]


def test_crewai_tool_failure_is_marked(observer, transport):
    bus = FakeBus()
    crewai_mod.register(observer, bus, events=FakeEvents)
    bus.fire(FakeEvents.ToolUsageFinishedEvent, FakeToolEvent(failure=RuntimeError("bad")))
    assert transport.last["payload"]["metadata"]["outcome"] == "error"


def test_crewai_completion_and_failure_map_to_turn_outcome(observer, transport):
    bus = FakeBus()
    crewai_mod.register(observer, bus, events=FakeEvents)
    bus.fire(FakeEvents.CrewKickoffCompletedEvent, FakeCrewEvent())
    ok = transport.last["payload"]
    assert ok["type"] == "turn_outcome"
    assert ok["metadata"]["outcome"] == "ok"
    assert ok["metadata"]["total_tokens"] == 1234

    bus.fire(FakeEvents.CrewKickoffFailedEvent, FakeCrewEvent(output=None, error="crew exploded"))
    bad = transport.last["payload"]
    assert bad["metadata"]["outcome"] == "error"
    assert "crew exploded" in bad["body"]


def test_crewai_missing_fields_degrade(observer, transport):
    class Bare:
        pass

    bus = FakeBus()
    crewai_mod.register(observer, bus, events=FakeEvents)
    bus.fire(FakeEvents.ToolUsageFinishedEvent, Bare())
    assert transport.last["payload"]["title"] == "工具调用：tool"
    bus.fire(FakeEvents.CrewKickoffCompletedEvent, Bare())
    assert transport.last["payload"]["type"] == "turn_outcome"


def test_crewai_unregister_stops_capture(observer, transport):
    bus = FakeBus()
    unregister = crewai_mod.register(observer, bus, events=FakeEvents)
    unregister()
    bus.fire(FakeEvents.ToolUsageFinishedEvent, FakeToolEvent())
    assert transport.calls == []


def test_crewai_unregister_uses_two_positional_bus_off(observer):
    """真机（crewai 1.15.37）的 `bus.off(event_type, handler)` 是两个位置参数，不是
    `on()` 那样的装饰器工厂。写成 `off(cls)(handler)` 会抛 TypeError，而注销逻辑
    里那个 except 会把它吞掉——「断开」因此变成静默空操作，捕获继续。"""
    calls = []

    class StrictBus(FakeBus):
        def off(self, event_cls, fn):
            calls.append((event_cls, fn))
            super().off(event_cls, fn)

    bus = StrictBus()
    unregister = crewai_mod.register(observer, bus, events=FakeEvents)
    unregister()
    assert len(calls) == 3, "三个事件都要真的摘掉: %s" % (calls,)
    assert all(bus.handlers[k] == [] for k in bus.handlers), "摘除后不应残留 handler: %s" % (bus.handlers,)


def test_crewai_unregister_failure_does_not_break_host(observer):
    """注销抛错也不许外泄——宿主退出流程不能被我们的清理逻辑弄挂。"""

    class BrokenBus(FakeBus):
        def off(self, event_cls, fn):
            raise RuntimeError("bus is already gone")

    bus = BrokenBus()
    crewai_mod.register(observer, bus, events=FakeEvents)()


def test_crewai_uninstall_public_entry_stops_capture(observer, transport):
    """公开面：`uninstall(listener)` 摘掉监听器（真实监听器把注销函数存在 _unregister）。"""
    bus = FakeBus()
    unregister = crewai_mod.register(observer, bus, events=FakeEvents)

    class FakeListener:
        def __init__(self):
            self._unregister = unregister  # 注意存实例属性：存类属性能变成绑定方法

    crewai_mod.uninstall(FakeListener())
    bus.fire(FakeEvents.ToolUsageFinishedEvent, FakeToolEvent())
    assert transport.calls == []


def test_crewai_uninstall_on_foreign_object_is_a_noop():
    crewai_mod.uninstall(object())


def test_crewai_listener_never_leaks_exceptions(observer):
    class Exploding:
        def tool_call(self, *a, **k):
            raise RuntimeError("boom")

        def turn_outcome(self, *a, **k):
            raise RuntimeError("boom")

    bus = FakeBus()
    crewai_mod.register(Exploding(), bus, events=FakeEvents)  # type: ignore[arg-type]
    bus.fire(FakeEvents.ToolUsageFinishedEvent, FakeToolEvent())
    bus.fire(FakeEvents.CrewKickoffCompletedEvent, FakeCrewEvent())


def test_crewai_install_hint_when_framework_missing():
    pytest.importorskip  # noqa: B018 — 明确本测试不需要任何框架
    try:
        import crewai  # noqa: F401
    except ImportError:
        with pytest.raises(ImportError) as err:
            crewai_mod.event_listener(object())  # type: ignore[arg-type]
        assert "yongyi-agent[crewai]" in str(err.value)
    else:
        pytest.skip("crewai 已安装——安装指引分支不适用")


# ── LlamaIndex ───────────────────────────────────────────────────────────────

class FakeEnum:
    def __init__(self, value):
        self.value = value


def test_llamaindex_tool_event_maps_to_tool_call(observer, transport):
    handler = li_mod.callback_handler(observer)
    handler.on_event_end(
        FakeEnum("tool"),
        {"tool": None, "tool_output": "search results", "tool_name": "search"},
        event_id="e1",
    )
    payload = transport.last["payload"]
    assert payload["type"] == "tool_call"
    assert "search" in payload["title"]
    assert "search results" in payload["body"]


def test_llamaindex_agent_step_maps_to_turn_outcome(observer, transport):
    handler = li_mod.callback_handler(observer)
    handler.on_event_end(FakeEnum("agent_step"), {"response": "final answer"}, event_id="e2")
    payload = transport.last["payload"]
    assert payload["type"] == "turn_outcome"
    assert "final answer" in payload["body"]


def test_llamaindex_accepts_plain_string_event_types(observer, transport):
    assert li_mod.send_event_end(observer, "tool", {"tool_name": "t", "tool_output": "o"})
    assert transport.last["payload"]["type"] == "tool_call"


def test_llamaindex_ignores_unrelated_events(observer, transport):
    handler = li_mod.callback_handler(observer)
    handler.on_event_end(FakeEnum("llm"), {"response": "x"}, event_id="e3")
    handler.on_event_end(FakeEnum("retrieve"), {}, event_id="e4")
    assert transport.calls == [], "只关心 tool / agent_step"


def test_llamaindex_missing_payload_degrades(observer, transport):
    handler = li_mod.callback_handler(observer)
    handler.on_event_end(FakeEnum("tool"), None, event_id="e5")
    assert transport.last["payload"]["title"] == "工具调用：tool"
    handler.on_event_end(FakeEnum("agent_step"), {}, event_id="e6")
    assert transport.last["payload"]["body"].strip() != ""


def test_llamaindex_callback_never_leaks_exceptions():
    class Exploding:
        def emit(self, *a, **k):
            raise RuntimeError("boom")

    handler = li_mod.YongyiHandler(Exploding())  # type: ignore[arg-type]
    handler.on_event_end(FakeEnum("tool"), {"tool_name": "t"})
    handler.on_event_end(FakeEnum("agent_step"), {"response": "x"})


def test_llamaindex_trace_hooks_are_safe_no_ops(observer):
    handler = li_mod.callback_handler(observer)
    assert handler.on_event_start(FakeEnum("tool"), {}, event_id="e1") == "e1"
    handler.start_trace("t1")
    handler.end_trace("t1", {})


# ── 真框架跑出来的两个缺陷（回归钉） ────────────────────────────────────────
# 这两条不是从文档推的，是真跑 langchain-core 1.7.6 / llama-index-core 0.14.25
# 打出来的：缺方法会污染宿主日志；工具事件的名字/载体与我们最初的假设不同。

def test_langchain_handler_implements_the_full_event_surface():
    """LangChain 的回调管理器对每个事件都调同名方法，缺一个就往宿主日志里打
    「Error in ... callback: AttributeError」。所以整个面必须存在（哪怕是空操作）。
    """
    required = [
        "on_llm_start", "on_chat_model_start", "on_llm_new_token", "on_llm_end", "on_llm_error",
        "on_chain_start", "on_chain_end", "on_chain_error",
        "on_tool_start", "on_tool_end", "on_tool_error",
        "on_agent_action", "on_agent_finish",
        "on_retriever_start", "on_retriever_end", "on_retriever_error",
        "on_text", "on_retry", "on_custom_event",
    ]
    handler = lc_mod.YongyiCallbackHandler(object())  # type: ignore[arg-type]
    missing = [name for name in required if not callable(getattr(handler, name, None))]
    assert missing == [], "缺这些入口会让 LangChain 往宿主日志里打 callback 错误: %s" % missing


def test_langchain_uninteresting_events_are_silent_noops(observer, transport):
    handler = lc_mod.callback_handler(observer)
    for name in ("on_llm_start", "on_chat_model_start", "on_tool_start", "on_chain_start", "on_text"):
        getattr(handler, name)({"run_id": "r"}, name="x")
    assert transport.calls == [], "不关心的事件不该产生观测"


class FakeToolMeta:
    def __init__(self, name):
        self.name = name


class FakeToolCallEvent:
    """真 AgentToolCallEvent 的鸭子类型（含 ToolMetadata 形状的 tool）。"""

    def __init__(self, name="multiply", arguments='{"a": 3}'):
        self.tool = FakeToolMeta(name)
        self.arguments = arguments


FakeToolCallEvent.__name__ = "AgentToolCallEvent"


class FakeResponse:
    def __init__(self, response):
        self.response = response


class FakeQueryEndEvent:
    def __init__(self, response="the answer"):
        self.response = FakeResponse(response)


FakeQueryEndEvent.__name__ = "QueryEndEvent"


def test_llamaindex_instrumentation_tool_call_event(observer, transport):
    payload = li_mod.send_instrumentation_event(observer, FakeToolCallEvent())
    assert payload
    sent = transport.last["payload"]
    assert sent["type"] == "tool_call"
    assert sent["title"] == "工具调用：multiply"
    assert sent["metadata"]["tool"] == "multiply"


def test_llamaindex_instrumentation_unwraps_response_object(observer, transport):
    """QueryEndEvent.response 是 pydantic Response 对象；不 unwrap 会落成对象 repr。"""
    li_mod.send_instrumentation_event(observer, FakeQueryEndEvent())
    sent = transport.last["payload"]
    assert sent["type"] == "turn_outcome"
    assert sent["body"] == "the answer"
    assert "object at 0x" not in sent["body"]


def test_llamaindex_instrumentation_ignores_unrelated_events(observer, transport):
    class AgentRunStepEndEvent:
        pass

    assert li_mod.instrumentation_payload(AgentRunStepEndEvent()) is None
    assert transport.calls == []


def test_llamaindex_callback_face_accepts_function_call_kind(observer, transport):
    """0.14 发布版的工具类回调事件叫 function_call（tool 只在 main 分支）。"""
    li_mod.send_event_end(observer, "function_call", {"tool_name": "legacy", "tool_output": "out"})
    sent = transport.last["payload"]
    assert sent["type"] == "tool_call"
    assert sent["title"] == "工具调用：legacy"
    assert sent["body"] == "out"


def test_llamaindex_callback_face_still_accepts_tool_kind(observer, transport):
    li_mod.send_event_end(observer, "tool", {"tool_name": "newer", "tool_output": "out"})
    assert transport.last["payload"]["title"] == "工具调用：newer"
