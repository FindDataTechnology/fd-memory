# ── LangChain 集成 ───────────────────────────────────────────────────────────
#
# 映射（design D3，已读上游源码核对）：
#   on_tool_end                 → tool_call
#   on_agent_finish             → turn_outcome
#   on_chain_end（仅顶层）      → turn_outcome（无 agent 的应用走这条）
#
# 为什么 on_chain_end 只能认顶层：LangChain 为每一层 runnable 都发 chain 事件，
# 一次 agent 运行能触发十几层；不按「无 parent_run_id」过滤，一次回合会落十几
# 条 turn_outcome，把 L0 直接噪声化。
#
# 纯映射函数（*_event）不依赖框架，收鸭子类型 kwargs——测试不装 langchain 也能
# 跑；框架类型只在 callback_handler() 的延迟导入里出现。

from __future__ import annotations

from typing import Any, Dict, Optional

from .observe import Observer, run_safely

HARNESS = "langchain"
INSTALL_HINT = "pip install 'yongyi-agent[langchain]'"


def _tool_name(kwargs: Dict[str, Any]) -> str:
    name = kwargs.get("name")
    if not name:
        serialized = kwargs.get("serialized") or {}
        if isinstance(serialized, dict):
            name = serialized.get("name")
    return str(name or "tool")


def tool_end_event(
    observer: Observer, kwargs: Dict[str, Any], *, failed: bool = False
) -> Optional[str]:
    """on_tool_end 的纯映射：工具名 + 输出摘要 → tool_call。"""
    metadata: Dict[str, Any] = {}
    if failed:
        metadata["outcome"] = "error"
    return observer.tool_call(_tool_name(kwargs), kwargs.get("output"), metadata=metadata or None)


def is_top_level(kwargs: Dict[str, Any]) -> bool:
    """顶层 runnable（无 parent_run_id）——只有它代表一次回合的收尾。"""
    return kwargs.get("parent_run_id") is None


def turn_end_event(
    observer: Observer, kwargs: Dict[str, Any], *, summary: Optional[str] = None, failed: bool = False
) -> Optional[str]:
    """on_agent_finish / on_chain_end 的纯映射 → turn_outcome。"""
    output = kwargs.get("return_values")
    if output is None:
        output = kwargs.get("response")
    outcome = "error" if failed else "ok"
    title = summary or ("LangChain 回合收尾（%s）" % outcome)
    return observer.turn_outcome(title, output, outcome=outcome)


class YongyiCallbackHandler:
    """把永忆观测接到 LangChain 回调面的 handler（鸭子类型包装）。

    用法：
        from yongyi_agent.tokens import make_observer
        from yongyi_agent.langchain import callback_handler
        handler = callback_handler(make_observer("langchain"))
        graph.invoke(inputs, config={"callbacks": [handler]})

    实现上它不继承任何框架类，只实现 LangChain 会调用的那几个方法名——这样
    导入本模块不需要装 langchain；真正传进 LangChain 时才由框架决定是否接受
    （LangChain 接受任何带同名方法的对象，`callbacks=` 参数就是鸭子类型）。
    """

    raise_error = False
    run_inline = True

    def __init__(self, observer: Observer, *, turn_summary: Optional[str] = None) -> None:
        self.observer = observer
        self.turn_summary = turn_summary

    # 下面这些属性是 LangChain 用来决定「这个 handler 关心哪些事件」的；默认
    # 全部 False = 只收我们显式实现的那几类。
    ignore_llm = True
    ignore_chain = False
    ignore_agent = False
    ignore_retriever = True
    ignore_chat_model = True
    ignore_custom_event = True

    def on_tool_end(self, output: Any = None, **kwargs: Any) -> None:  # noqa: D401
        run_safely(tool_end_event, self.observer, {**kwargs, "output": output})

    def on_tool_error(self, error: BaseException, **kwargs: Any) -> None:
        run_safely(tool_end_event, self.observer, {**kwargs, "output": str(error)}, failed=True)

    # ── 无操作的事件入口 ─────────────────────────────────────────────────────
    # LangChain 的回调管理器对每个事件都调 handler 上的同名方法，缺了就抛
    # AttributeError 并把它当成 callback 错误打到宿主日志里（真跑 langchain-core
    # 1.7.6 实测）。我们不关心这些事件，但必须实现成空操作——否则用户每天在
    # 日志里看到一排「Error in YongyiCallbackHandler.on_tool_start」。
    def on_llm_start(self, *args: Any, **kwargs: Any) -> None:
        return None

    def on_chat_model_start(self, *args: Any, **kwargs: Any) -> None:
        return None

    def on_llm_end(self, *args: Any, **kwargs: Any) -> None:
        return None

    def on_llm_error(self, *args: Any, **kwargs: Any) -> None:
        return None

    def on_llm_new_token(self, *args: Any, **kwargs: Any) -> None:
        return None

    def on_chain_start(self, *args: Any, **kwargs: Any) -> None:
        return None

    def on_tool_start(self, *args: Any, **kwargs: Any) -> None:
        return None

    def on_agent_action(self, *args: Any, **kwargs: Any) -> None:
        return None

    def on_text(self, *args: Any, **kwargs: Any) -> None:
        return None

    def on_retry(self, *args: Any, **kwargs: Any) -> None:
        return None

    def on_retriever_start(self, *args: Any, **kwargs: Any) -> None:
        return None

    def on_retriever_end(self, *args: Any, **kwargs: Any) -> None:
        return None

    def on_retriever_error(self, *args: Any, **kwargs: Any) -> None:
        return None

    def on_custom_event(self, *args: Any, **kwargs: Any) -> None:
        return None

    def on_stream_event(self, *args: Any, **kwargs: Any) -> None:
        return None

    def on_agent_finish(self, finish: Any = None, **kwargs: Any) -> None:
        run_safely(turn_end_event, self.observer, {**kwargs, "return_values": finish}, summary=self.turn_summary)

    def on_chain_end(self, outputs: Any = None, **kwargs: Any) -> None:
        if not is_top_level(kwargs):
            return  # 内层 chain：不是回合收尾
        run_safely(
            turn_end_event,
            self.observer,
            {**kwargs, "return_values": outputs},
            summary=self.turn_summary,
        )

    def on_chain_error(self, error: BaseException, **kwargs: Any) -> None:
        if not is_top_level(kwargs):
            return
        run_safely(turn_end_event, self.observer, {**kwargs, "response": str(error)}, summary=self.turn_summary, failed=True)


def callback_handler(observer: Optional[Observer] = None, *, turn_summary: Optional[str] = None) -> YongyiCallbackHandler:
    """造一个 handler；不传 observer 时按环境解析身份并新建一个。"""
    if observer is None:
        from .tokens import make_observer

        observer = make_observer(HARNESS)
    return YongyiCallbackHandler(observer, turn_summary=turn_summary)
