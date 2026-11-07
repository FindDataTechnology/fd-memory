# ── LlamaIndex 集成 ──────────────────────────────────────────────────────────
#
# 这里有三张面，因为 LlamaIndex 的机制换过两次，而**发布版里到底谁在发事件**只能
# 真跑才知道（本模块的三条结论全部来自隔离环境实机，不是读 main 分支猜的）：
#
#   ① query engine（现役、可靠）：查询收尾发 `QueryEndEvent`，经 instrumentation
#      分派器送达。真机验证：RetrieverQueryEngine + 真 LLM → 捕获到答案正文。
#   ② agent（0.14.25 实测：工具调用**没有**结构化事件）：`AgentToolCallEvent`
#      只有定义、全包无一处实例化；`CBEventType.FUNCTION_CALL` 同样无发射点；
#      `LLMChatEndEvent.response.message.tool_calls` 是空的。真 agent 回合一跑，
#      事件流里只有 LLMChat* / Workflow*，工具确实执行了却什么都收不到。唯一结构化
#      痕迹是 `WorkflowStepOutputEvent.output` 里 `ToolCallResult(...)` 的**字符串
#      repr**——parse 它不可接受。所以本模块给 `instrument_tools()`：在调用点上
#      包一层，确定性捕获，不依赖框架事件。
#      agent 回合同理：`WorkflowRunOutputEvent.output` 是框架 `summarize_event(
#      max_length=200)` 截出的 repr，推理模型先吐 ThinkingBlock，答案常常被截掉。
#      所以给 `instrument_agent()`：拦 `__await__`，用 `AgentOutput.response`
#      作正文（真答案）。
#   ③ 0.10 时代的回调事件（低版本兼容）：`CBEventType.tool/function_call/agent_step`
#      经 CallbackManager 到 `on_event_end`。
#
# 分工：工具级 + agent 回合级用调用点包装（`instrument_tools()` / `instrument_agent()`）；
# query engine 用 instrumentation（`QueryEndEvent`）；`WorkflowRunOutputEvent` 只当
# 存在性兜底。纯映射函数收鸭子类型事件，不装框架也能测。

from __future__ import annotations

import functools
import re
from typing import Any, Dict, List, Optional

from .observe import Observer, run_safely

HARNESS = "llamaindex"
INSTALL_HINT = "pip install 'yongyi-agent[llamaindex]'"


def _kind(event_type: Any) -> str:
    value = getattr(event_type, "value", event_type)
    return str(value).lower()


def _pick(payload: Optional[Dict[str, Any]], *keys: str) -> Any:
    if not isinstance(payload, dict):
        return None
    for key in keys:
        if key in payload and payload[key] is not None:
            return payload[key]
        for candidate, value in payload.items():
            if getattr(candidate, "value", candidate) == key and value is not None:
                return value
    return None


# ── 回调面（旧版本兼容） ─────────────────────────────────────────────────────

def event_end_payload(event_type: Any, payload: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """把一次 on_event_end 折成观测（None = 这个事件不关心）。

    工具类事件的名字随版本变：0.14 发布版有 `function_call`，`tool` 只存在于
    上游 main 分支的 schema 里。两个都认，避免绑死在某个小版本上。
    """
    kind = _kind(event_type)
    if kind in ("tool", "function_call"):
        tool = _pick(payload, "tool", "tool_name", "function_call")
        meta = getattr(tool, "metadata", None)
        name = (
            getattr(meta, "name", None)
            or getattr(tool, "name", None)
            or getattr(tool, "__name__", None)
            or (str(tool) if tool else "tool")
        )
        return {
            "event_type": "tool_call",
            "title": "工具调用：%s" % name,
            "body": _pick(payload, "tool_output", "function_call_response", "output"),
            "metadata": {"tool": str(name)},
        }
    if kind == "agent_step":
        return {
            "event_type": "turn_outcome",
            "title": "LlamaIndex 回合收尾",
            "body": _unwrap_response(_pick(payload, "response", "completion")),
            "metadata": {"outcome": "ok"},
        }
    return None


def send_event_end(observer: Observer, event_type: Any, payload: Optional[Dict[str, Any]]) -> Optional[str]:
    """回调面：纯映射 + 投递。"""
    folded = event_end_payload(event_type, payload)
    if not folded:
        return None
    return observer.emit(
        folded["event_type"],
        folded["title"],
        folded["body"] if isinstance(folded["body"], str) else str(folded["body"] or ""),
        metadata=folded["metadata"],
    )


# ── 仪器化面（0.14+，现役） ──────────────────────────────────────────────────

def _unwrap_response(value: Any) -> Any:
    """QueryEndEvent.response 是 pydantic 的 Response 对象，正文在 .response 里。

    不 unwrap 的话 str(Response(...)) 会落成对象 repr——那既不是答案也不是可读
    内容。鸭子类型：有 .response 属性就取它，否则原样返回。
    """
    inner = getattr(value, "response", None)
    return value if inner is None else inner


_TEXT_IN_REPR = re.compile(r"text='([^']*)'")


def _text_from_repr(value: Any) -> Any:
    """从框架给的 repr 字符串里取最后一段 text='...'。

    发布版的 `WorkflowRunOutputEvent.output` 是 str（`StopEvent(result=AgentOutput(
    response=ChatMessage(... blocks=[TextBlock(text='12')])))` 的 repr），不是结构化
    对象。整串塞进记忆正文是噪声，所以取最后一处 text='...'。取不到就原样返回
    （宁可多带壳，也不丢内容）。
    """
    if not isinstance(value, str):
        return value
    hits = _TEXT_IN_REPR.findall(value)
    return hits[-1] if hits else value


def instrumentation_payloads(event: Any) -> List[Dict[str, Any]]:
    """把一条 instrumentation 事件折成若干观测（鸭子类型，按类名分派）。

    - QueryEndEvent          → turn_outcome（query engine 收尾，真机验证可用）
    - WorkflowRunOutputEvent → turn_outcome（agent 回合收尾；正文是框架摘要字符串）
    - AgentToolCallEvent     → tool_call（**版本兼容**：发布版 0.14.25 只有类定义、
                                全包无一处实例化，真 agent 回合收不到它）
    其它事件一律忽略（LLMChat* / WorkflowStep* 噪声太大）。
    """
    name = type(event).__name__
    if name == "AgentToolCallEvent":
        tool = getattr(event, "tool", None)
        tool_name = getattr(tool, "name", None) or (str(tool) if tool else "tool")
        return [{
            "event_type": "tool_call",
            "title": "工具调用：%s" % tool_name,
            "body": getattr(event, "arguments", None),
            "metadata": {"tool": str(tool_name)},
        }]
    if name == "QueryEndEvent":
        return [{
            "event_type": "turn_outcome",
            "title": "LlamaIndex 查询收尾",
            "body": _unwrap_response(getattr(event, "response", None)),
            "metadata": {"outcome": "ok", "phase": "query"},
        }]
    if name == "WorkflowRunOutputEvent":
        return [{
            "event_type": "turn_outcome",
            "title": "LlamaIndex 智能体回合收尾",
            "body": _text_from_repr(getattr(event, "output", None)),
            "metadata": {"outcome": "ok", "phase": "workflow"},
        }]
    return []


def instrumentation_payload(event: Any) -> Optional[Dict[str, Any]]:
    """单条折叠（保留旧入口；多观测用 `instrumentation_payloads`）。"""
    folded = instrumentation_payloads(event)
    return folded[0] if folded else None


def send_instrumentation_event(observer: Observer, event: Any, *, agent_turn_summary: bool = True) -> List[Optional[str]]:
    """投递一条 instrumentation 事件的观测。

    `agent_turn_summary=False` 时丢弃 agent 回合摘要（`WorkflowRunOutputEvent`）——
    那条正文是框架 200 字截断的 repr，真答案在 `instrument_agent()` 那条上；两条
    都开会给同一次回合落两条 `turn_outcome`（真机实测 2 条）。拿了调用点包装就
    关掉它。
    """
    sent: List[Optional[str]] = []
    for folded in instrumentation_payloads(event):
        if not agent_turn_summary and folded["metadata"].get("phase") == "workflow":
            continue
        body = folded["body"]
        sent.append(
            observer.emit(
                folded["event_type"],
                folded["title"],
                body if isinstance(body, str) else str(body or ""),
                metadata=folded["metadata"],
            )
        )
    return sent


def event_handler(observer: Optional[Observer] = None, *, agent_turn_summary: bool = False) -> Any:
    """造一个 instrumentation event handler 并注册到全局分派器。

    返回值请持有：分派器持有强引用，但显式 hold 住便于 `uninstall()`。

    `agent_turn_summary` 默认关：agent 回合的正文用 `instrument_agent()` 取真答案，
    框架那条摘要只有 200 字（推理模型常被思考块吃满，答案不在里面）。不包 agent、
    只想要「回合发生过」的存在性记录时才打开。
    """
    if observer is None:
        from .tokens import make_observer

        observer = make_observer(HARNESS)
    try:
        from llama_index.core.instrumentation import get_dispatcher
        from llama_index.core.instrumentation.event_handlers import BaseEventHandler
    except ImportError as exc:
        raise ImportError(
            "yongyi_agent.llamaindex requires llama-index-core — %s" % INSTALL_HINT
        ) from exc

    class _YongyiEventHandler(BaseEventHandler):
        observer: Any

        def handle(self, event: Any, **kwargs: Any) -> None:
            run_safely(
                send_instrumentation_event,
                self.observer,
                event,
                agent_turn_summary=agent_turn_summary,
            )

    handler = _YongyiEventHandler(observer=observer)
    get_dispatcher().add_event_handler(handler)
    return handler


def uninstall(handler: Any) -> None:
    """从全局分派器摘掉一个 event handler（失败即忽略）。"""
    try:
        from llama_index.core.instrumentation import get_dispatcher

        dispatcher = get_dispatcher()
        dispatcher.event_handlers = [h for h in dispatcher.event_handlers if h is not handler]
    except Exception:  # noqa: BLE001
        pass


# ── 工具级捕获（agent 路径唯一可靠的路子） ──────────────────────────────────

def _emit_tool_call(observer: Observer, name: str, output: Any, failed: bool) -> None:
    metadata: Dict[str, Any] = {"tool": str(name), "phase": "finished"}
    if failed:
        metadata["outcome"] = "error"
    observer.tool_call(str(name), output, metadata=metadata)


def _wrap_sync(observer: Observer, name: str, fn: Any) -> Any:
    @functools.wraps(fn)
    def inner(*args: Any, **kwargs: Any) -> Any:
        try:
            out = fn(*args, **kwargs)
        except BaseException as exc:
            run_safely(_emit_tool_call, observer, name, str(exc), True)
            raise  # 异常永远还给宿主：我们只记录，不吞
        run_safely(_emit_tool_call, observer, name, out, False)
        return out

    return inner


def _wrap_async(observer: Observer, name: str, fn: Any) -> Any:
    @functools.wraps(fn)
    async def inner(*args: Any, **kwargs: Any) -> Any:
        try:
            out = await fn(*args, **kwargs)
        except BaseException as exc:
            run_safely(_emit_tool_call, observer, name, str(exc), True)
            raise
        run_safely(_emit_tool_call, observer, name, out, False)
        return out

    return inner


def instrument_tools(tools: Any, observer: Optional[Observer] = None) -> List[Any]:
    """给一组 LlamaIndex 工具包一层，让每次调用落一条 `tool_call`（含真实输出）。

    为什么要这一层：0.14.25 的 agent 执行路径里工具调用**没有事件**。实测一个真
    FunctionAgent 回合（工具确实执行了、答案为 12），事件流只有 `LLMChat*` 与
    `Workflow*`；`AgentToolCallEvent` 有定义但全包无一处实例化，`CBEventType.
    FUNCTION_CALL` 也没有发射点，`LLMChatEndEvent.response.message.tool_calls`
    是空的——唯一的结构化痕迹是 `ToolCallOutputEvent.output` 里 `ToolCallResult`
    的字符串 repr，parse 它不可接受。

    所以捕获点放在**调用点**：包装后的函数在工具真正执行完时上报，与框架事件无关，
    因此不会随某个小版本的事件面变化而静默失效。工具的 metadata（名字/描述/schema）
    原样保留，函数签名经 `functools.wraps` 保留，函数调用协议不变。

    用法：
        tools = instrument_tools([my_tool])          # 可传 observer
        agent = FunctionAgent(tools=tools, llm=...)

    返回新列表（原工具不被改动）；包装失败的工具原样返回，绝不弄破宿主。
    """
    if observer is None:
        from .tokens import make_observer

        observer = make_observer(HARNESS)
    wrapped: List[Any] = []
    for tool in tools or []:
        try:
            wrapped.append(_instrument_one(tool, observer))
        except Exception:  # noqa: BLE001 — 包不动就原样给出
            wrapped.append(tool)
    return wrapped


def _instrument_one(tool: Any, observer: Observer) -> Any:
    metadata = getattr(tool, "metadata", None)
    name = (
        getattr(metadata, "name", None)
        or getattr(tool, "name", None)
        or getattr(tool, "__name__", None)
        or "tool"
    )
    fn = getattr(tool, "_fn", None)
    async_fn = getattr(tool, "_async_fn", None)
    if fn is None and async_fn is None:
        # 纯 callable（还没变成 FunctionTool）：直接包函数
        if callable(tool):
            if _is_coroutine(tool):
                return _wrap_async(observer, name, tool)
            return _wrap_sync(observer, name, tool)
        return tool

    from llama_index.core.tools import FunctionTool

    kwargs: Dict[str, Any] = {"tool_metadata": metadata}
    if fn is not None:
        kwargs["fn"] = _wrap_sync(observer, name, fn)
    if async_fn is not None:
        kwargs["async_fn"] = _wrap_async(observer, name, async_fn)
    return FunctionTool.from_defaults(**kwargs)


def _is_coroutine(fn: Any) -> bool:
    import inspect

    return inspect.iscoroutinefunction(fn)


# ── 回合级捕获（拿到真答案，不靠 200 字摘要） ───────────────────────────────

def _agent_answer(value: Any) -> Any:
    """AgentOutput → 文本。`AgentOutput.response` 是 ChatMessage，再往下是内容块。"""
    text = getattr(value, "response", None)
    if text is None:
        return value
    content = getattr(text, "content", None)
    return text if content is None else content


def _emit_turn(observer: Observer, body: Any, failed: bool) -> None:
    metadata: Dict[str, Any] = {"phase": "agent"}
    if failed:
        metadata["outcome"] = "error"
    title = "LlamaIndex 智能体回合收尾（%s）" % ("error" if failed else "ok")
    observer.turn_outcome(title, str(body or ""), metadata=metadata)


class _TrackedRun:
    """把 `agent.run()` 返回的 WorkflowHandler 包成 awaitable 代理。

    真机实测（0.14.25）：`WorkflowRunOutputEvent.output` 是框架用
    `summarize_event(max_length=200)` 截出来的 repr。推理模型先吐 ThinkingBlock，
    200 字截断后**答案常常不在里面**——只能证明「回合发生了」，当记忆正文是噪声。

    所以回合正文改从调用点取：宿主 `await` 完拿到的 `AgentOutput.response` 才是
    真答案。代理只拦 `__await__`，其它属性一律原样转发（`stream_events()` 之类
    照旧可用），不改框架对象、不动类。
    """

    def __init__(self, pending: Any, observer: Observer) -> None:
        self._pending = pending
        self._observer = observer

    async def _settle(self) -> Any:
        try:
            out = await self._pending
        except BaseException as exc:
            run_safely(_emit_turn, self._observer, exc, True)
            raise  # 异常永远还给宿主
        run_safely(_emit_turn, self._observer, _agent_answer(out), False)
        return out

    def __await__(self) -> Any:
        return self._settle().__await__()

    def __getattr__(self, item: str) -> Any:
        return getattr(self._pending, item)


class _TrackedAgent:
    """agent 的只读代理：只把 `run` 换成带捕获的版本，其余全部委托。"""

    def __init__(self, agent: Any, observer: Observer) -> None:
        object.__setattr__(self, "_agent", agent)
        object.__setattr__(self, "_observer", observer)

    def run(self, *args: Any, **kwargs: Any) -> Any:
        return _TrackedRun(self._agent.run(*args, **kwargs), self._observer)

    def __getattr__(self, item: str) -> Any:
        return getattr(self._agent, item)


def instrument_agent(agent: Any, observer: Optional[Observer] = None) -> Any:
    """给 LlamaIndex agent 包一层，让每个回合落一条带**真实答案**的 `turn_outcome`。

        agent = instrument_agent(FunctionAgent(tools=..., llm=...))
        answer = await agent.run(user_msg="...")   # 调用方式不变

    `FunctionAgent` 是 pydantic 模型，`"FunctionAgent" object has no field "run"`
    ——实例上塞不了方法，所以返回代理而不是原地改（也不改类，别影响别的 agent）。
    包装失败（没有 `run`）时原样返回。

    与 `event_handler()` 的关系：两者都能出 `turn_outcome`，但只有这里拿到的是
    真答案。`event_handler()` 那条是框架的 200 字摘要（可能只有思考前缀），适合
    「只记存在性」；同一次回合两条都开会各落一条观测，**按需择一**。
    """
    if observer is None:
        from .tokens import make_observer

        observer = make_observer(HARNESS)
    if not callable(getattr(agent, "run", None)):
        return agent
    try:
        return _TrackedAgent(agent, observer)
    except Exception:  # noqa: BLE001
        return agent


# ── 回调 handler（旧版本兼容面） ─────────────────────────────────────────────

class YongyiHandler:
    """CallbackManager 风格 handler（鸭子类型；导入本模块不需装框架）。

        Settings.callback_manager = CallbackManager([YongyiHandler(observer)])

    0.14+ 的工具调用不经过这里（core 不再派发 CBEventType.TOOL）——新版本用
    `event_handler()`。
    """

    def __init__(self, observer: Observer) -> None:
        self.observer = observer

    event_starts_to_ignore: tuple = ()
    event_ends_to_ignore: tuple = ()

    def on_event_start(self, event_type: Any = None, payload: Any = None, event_id: str = "", **kwargs: Any) -> str:
        return event_id or ""

    def on_event_end(self, event_type: Any = None, payload: Any = None, event_id: str = "", **kwargs: Any) -> None:
        run_safely(send_event_end, self.observer, event_type, payload)

    def start_trace(self, trace_id: Optional[str] = None) -> None:
        return None

    def end_trace(self, trace_id: Optional[str] = None, trace_map: Optional[Dict[str, Any]] = None) -> None:
        return None


def callback_handler(observer: Optional[Observer] = None) -> YongyiHandler:
    if observer is None:
        from .tokens import make_observer

        observer = make_observer(HARNESS)
    return YongyiHandler(observer)
