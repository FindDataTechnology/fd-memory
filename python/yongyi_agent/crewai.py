# ── CrewAI 集成 ──────────────────────────────────────────────────────────────
#
# 映射（design D3，已读上游源码核对）：
#   ToolUsageFinishedEvent          → tool_call（failure 字段进 metadata.outcome）
#   CrewKickoffCompletedEvent       → turn_outcome（output + total_tokens）
#   CrewKickoffFailedEvent          → turn_outcome（outcome=error, error 进正文）
#
# 一个必须写进文档的坑：CrewAI 的监听器要**实例化**才注册（或在 listeners 包里
# 被导入），只是 import 模块不会生效。装了就以为生效是最坏的情况——所以
# install() 返回实例并要求调用方持有它。
#
# 纯映射函数收鸭子类型事件（只读属性），测试不装 crewai 也能跑。

from __future__ import annotations

from typing import Any, Dict, Optional

from .observe import Observer, run_safely

HARNESS = "crewai"
INSTALL_HINT = "pip install 'yongyi-agent[crewai]'"


def _attr(event: Any, name: str, default: Any = None) -> Any:
    value = getattr(event, name, default)
    return default if value is None else value


def tool_usage_payload(event: Any) -> Dict[str, Any]:
    """把 ToolUsageFinishedEvent 折成 tool_call 的入参（鸭子类型）。"""
    failed = getattr(event, "failure", None) is not None
    metadata: Dict[str, Any] = {"tool": str(_attr(event, "tool_name", "tool"))}
    agent_role = _attr(event, "agent_role")
    if agent_role:
        metadata["agent_role"] = str(agent_role)
    task_name = _attr(event, "task_name")
    if task_name:
        metadata["task"] = str(task_name)
    if failed:
        metadata["outcome"] = "error"
    return {
        "name": str(_attr(event, "tool_name", "tool")),
        "output": _attr(event, "output"),
        "metadata": metadata,
    }


def crew_completion_payload(event: Any) -> Dict[str, Any]:
    """把 CrewKickoffCompleted/Failed 折成 turn_outcome 的入参（鸭子类型）。"""
    error = _attr(event, "error")
    failed = error is not None
    metadata: Dict[str, Any] = {"outcome": "error" if failed else "ok"}
    tokens = _attr(event, "total_tokens")
    if tokens:
        metadata["total_tokens"] = tokens
    crew_name = _attr(event, "crew_name")
    if crew_name:
        metadata["crew"] = str(crew_name)
    title = "Crew 收尾（%s）" % ("error" if failed else "ok")
    return {
        "title": title,
        "output": error if failed else _attr(event, "output"),
        "outcome": "error" if failed else "ok",
        "metadata": metadata,
    }


def register(observer: Observer, bus: Any, *, events: Any = None) -> Any:
    """在给定事件总线上注册三个监听器，返回注销函数。

    `events` 是 `crewai.events` 模块（延迟导入后传入），保持本函数不依赖框架，
    测试可传假总线与假事件类。
    """
    if events is None:
        try:
            from crewai import events as crewai_events  # type: ignore
        except ImportError as exc:
            raise ImportError(
                "yongyi_agent.crewai requires crewai — %s" % INSTALL_HINT
            ) from exc
        events = crewai_events

    completed = events.CrewKickoffCompletedEvent
    failed = events.CrewKickoffFailedEvent
    tool_done = events.ToolUsageFinishedEvent

    def on_tool(source: Any, event: Any) -> None:
        payload = tool_usage_payload(event)
        run_safely(
            lambda: observer.tool_call(
                payload["name"],
                payload["output"],
                metadata=payload["metadata"],
            )
        )

    def on_crew_done(source: Any, event: Any) -> None:
        payload = crew_completion_payload(event)
        run_safely(
            lambda: observer.turn_outcome(
                payload["title"],
                payload["output"],
                outcome=payload["outcome"],
                metadata=payload["metadata"],
            )
        )

    bus.on(tool_done)(on_tool)
    bus.on(completed)(on_crew_done)
    bus.on(failed)(on_crew_done)

    def _unregister() -> None:
        for event_cls, handler in ((tool_done, on_tool), (completed, on_crew_done), (failed, on_crew_done)):
            # CrewAI 1.15 的 off 是 `off(event_type, handler)` 两个位置参数——不是
            # `on()` 那样的装饰器工厂。写成 off(cls)(handler) 会抛 TypeError，被下面
            # 的 except 吞掉，于是「断开」变成静默空操作（真机跑出来的）。
            try:
                bus.off(event_cls, handler)
            except Exception:  # noqa: BLE001 — 卸载失败不值得弄破宿主退出流程
                pass

    return _unregister


def event_listener(observer: Optional[Observer] = None) -> Any:
    """造一个 BaseEventListener 子类实例并立即注册（返回实例，请持有它）。

    CrewAI 的监听器靠实例化注册，所以本函数的返回值不是可选的装饰性句柄——
    丢掉它不会报错，但会静默失去捕获。
    """
    if observer is None:
        from .tokens import make_observer

        observer = make_observer(HARNESS)
    try:
        from crewai.events import BaseEventListener, crewai_event_bus  # type: ignore
    except ImportError as exc:
        raise ImportError(
            "yongyi_agent.crewai requires crewai — %s" % INSTALL_HINT
        ) from exc

    class _YongyiListener(BaseEventListener):
        def setup_listeners(self, bus: Any) -> None:
            self._unregister = register(observer, bus)

    return _YongyiListener()


def uninstall(listener: Any) -> None:
    """把 `event_listener()` 注册的监听器从总线上摘掉（失败即忽略）。

    CrewAI 没有「销毁监听器」的官方动作——注册就是往全局 bus 上挂函数。本函数
    调的就是 `register()` 返回的注销函数；摘掉之后捕获停止，已写下的记忆不动。
    """
    unregister = getattr(listener, "_unregister", None)
    if unregister is None:
        return
    try:
        unregister()
    except Exception:  # noqa: BLE001
        pass
