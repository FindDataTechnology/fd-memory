# ── LlamaIndex 集成 ──────────────────────────────────────────────────────────
#
# 映射（design D3，已读上游源码核对）：
#   on_event_end(event_type=CBEventType.TOOL)         → tool_call
#   on_event_end(event_type=CBEventType.AGENT_STEP)   → turn_outcome
#
# LlamaIndex 的回调是「事件开始/结束」两段式，载荷键在 EventPayload 里
# （TOOL / TOOL_OUTPUT / RESPONSE）。事件类型按 `.value` 归一化后比较，因此
# 纯映射函数不依赖框架——测试传字符串或假枚举都能跑。
#
# 兜底：AGENT_STEP 未必出现在所有编排里（纯 query engine 就没有），所以任一
# 事件结束都可能成为「这条回合的唯一信号」。映射层只做「按已知类型分派」，
# 不做「一定会有几次」的假设。

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
        # EventPayload 是 str 枚举，真实载荷也用同样的字符串键——两种都试。
        for candidate, value in payload.items():
            if getattr(candidate, "value", candidate) == key and value is not None:
                return value
    return None


def event_end_payload(event_type: Any, payload: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """把一次 on_event_end 折成你要发的观测（None = 这个事件不关心）。"""
    kind = _kind(event_type)
    if kind == "tool":
        tool = _pick(payload, "tool", "tool_name")
        name = getattr(tool, "metadata", None)
        name = getattr(name, "name", None) or getattr(tool, "__name__", None) or (str(tool) if tool else "tool")
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
            "body": _pick(payload, "response", "completion"),
            "metadata": {"outcome": "ok"},
        }
    return None


def send_event_end(observer: Observer, event_type: Any, payload: Optional[Dict[str, Any]]) -> Optional[str]:
    """纯映射 + 投递（不依赖框架类型）。"""
    folded = event_end_payload(event_type, payload)
    if not folded:
        return None
    return observer.emit(
        folded["event_type"],
        folded["title"],
        folded["body"] if isinstance(folded["body"], str) else str(folded["body"] or ""),
        metadata=folded["metadata"],
    )


class YongyiHandler:
    """LlamaIndex 回调 handler（鸭子类型；不继承框架类，导入本模块不需装框架）。

    LlamaIndex 只查方法名有没有实现（`CallbackManager` 按 `on_event_start` /
    `on_event_end` 调用），所以鸭子类型够用：

        from llama_index.core.callbacks import CallbackManager
        from yongyi_agent.llamaindex import callback_handler
        Settings.callback_manager = CallbackManager([callback_handler(make_observer("llamaindex"))])
    """

    def __init__(self, observer: Observer) -> None:
        self.observer = observer

    # CallbackManager 会读这两个属性来决定忽略哪些事件；空 = 全收。
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
