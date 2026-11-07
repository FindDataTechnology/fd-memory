# ── LlamaIndex 集成 ──────────────────────────────────────────────────────────
#
# 这里有两张面，因为 LlamaIndex 在 0.14 前后换了机制（真框架跑出来的结论，
# 不是文档抄来的）：
#
#   0.14+ 仪器化（instrumentation）：工具调用发 `AgentToolCallEvent`，查询收尾
#          发 `QueryEndEvent`；监听方式是把 event handler 注册到分派器
#          （`get_dispatcher().add_event_handler(...)`）。**这是现役路径。**
#   0.10 时代的回调事件：`CBEventType.TOOL` / `AGENT_STEP` 经 CallbackManager
#          发到 `on_event_end`。0.14.25 的 core 已经不再派发 `CBEventType.TOOL`
#          （枚举还在，没人发），所以回调面只作为旧版本兼容保留。
#
# 两张面共用同一套映射语义，纯映射函数收鸭子类型事件，不装框架也能测。

from __future__ import annotations

from typing import Any, Dict, Optional

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


def instrumentation_payload(event: Any) -> Optional[Dict[str, Any]]:
    """把一条 instrumentation 事件折成观测（鸭子类型，按类名分派）。

    - AgentToolCallEvent   → tool_call（工具名来自 event.tool.name，参数是 JSON 串）
    - QueryEndEvent        → turn_outcome（response 字段里的正文）
    - AgentRunStepEndEvent → 不关心（步级噪声，一个回合有 N 步）
    """
    name = type(event).__name__
    if name == "AgentToolCallEvent":
        tool = getattr(event, "tool", None)
        tool_name = getattr(tool, "name", None) or (str(tool) if tool else "tool")
        return {
            "event_type": "tool_call",
            "title": "工具调用：%s" % tool_name,
            "body": getattr(event, "arguments", None),
            "metadata": {"tool": str(tool_name)},
        }
    if name == "QueryEndEvent":
        return {
            "event_type": "turn_outcome",
            "title": "LlamaIndex 查询收尾",
            "body": _unwrap_response(getattr(event, "response", None)),
            "metadata": {"outcome": "ok"},
        }
    return None


def send_instrumentation_event(observer: Observer, event: Any) -> Optional[str]:
    folded = instrumentation_payload(event)
    if not folded:
        return None
    body = folded["body"]
    return observer.emit(
        folded["event_type"],
        folded["title"],
        body if isinstance(body, str) else str(body or ""),
        metadata=folded["metadata"],
    )


def event_handler(observer: Optional[Observer] = None) -> Any:
    """造一个 instrumentation event handler 并注册到全局分派器。

    返回值请持有：分派器持有强引用，但显式 hold 住便于 `uninstall()`。
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
            run_safely(send_instrumentation_event, self.observer, event)

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
