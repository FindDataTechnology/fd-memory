# ── 观测投递契约（对齐 TS SDK observe.ts 的语义，不重新发明） ───────────────
#
# 三条铁律：
#   1. 绝不弄破宿主 —— 任何失败（不可达/超时/4xx/序列化）都吞掉，不抛给框架
#      回调，不重试（重试会把一次失败放大成雪崩）；
#   2. 绝不阻塞回合 —— 默认在守护线程里投递，emit() 立即返回；
#   3. 配置错误在开发期炸 —— 封闭集之外的事件类型、空标题直接 raise，绝不
#      静默丢在运行期（那会让人以为捕获生效了）。
#
# 事件类型是内核侧封闭集：turn_outcome / tool_call / health_flip。4xx 是内核
# 对「这条观测不合法」的权威裁决，客户端不辩解、不重发。

from __future__ import annotations

import json
import threading
import urllib.error
import urllib.request
import uuid
from typing import Any, Callable, Dict, Mapping, Optional

EVENT_TYPES = ("turn_outcome", "tool_call", "health_flip")

DEFAULT_TIMEOUT = 10.0
TITLE_CAP = 200
# 客户端先截断，留出 JSON 包装与元数据的余量；服务端另有 32KB 硬截断。
BODY_CAP = 24 * 1024

Transport = Callable[[str, bytes, Mapping[str, str], float], int]


class UnknownEventType(ValueError):
    """封闭集之外的事件类型——配置错误，构造期就炸。"""


def _urllib_transport(url: str, payload: bytes, headers: Mapping[str, str], timeout: float) -> int:
    req = urllib.request.Request(url, data=payload, headers=dict(headers), method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310 — 端点是调用方给的
        return int(getattr(resp, "status", 0) or 0)


def _clip(text: str, cap: int) -> str:
    if len(text) <= cap:
        return text
    return text[:cap] + "…"


def observe_url(base_url: str) -> str:
    return base_url.rstrip("/") + "/observe"


def build_payload(
    *,
    event_type: str,
    title: str,
    body: str,
    idempotency_key: Optional[str] = None,
    subject: Optional[str] = None,
    ts: Optional[str] = None,
    harness: Optional[str] = None,
    metadata: Optional[Dict[str, Any]] = None,
    project: Optional[str] = None,
) -> Dict[str, Any]:
    """构造 /observe 请求体。字段与 TS observePayload 一一对应。"""
    if event_type not in EVENT_TYPES:
        raise UnknownEventType(
            "unknown observe event type: %r — expected one of %s" % (event_type, ", ".join(EVENT_TYPES))
        )
    title = (title or "").strip()
    if not title:
        raise ValueError("observe title must not be empty — use a one-line summary of the event")
    # 内核 body 必填（空 body 直接 400）；过程性回合没有正文时给兜底叙事，
    # 而不是把这条观测丢掉。
    body = (body or "").strip() or "（%s，无正文）" % title
    payload: Dict[str, Any] = {
        "type": event_type,
        "idempotency_key": idempotency_key or str(uuid.uuid4()),
        "title": _clip(title, TITLE_CAP),
        "body": _clip(body, BODY_CAP),
    }
    if subject is not None:
        payload["subject"] = subject
    if ts is not None:
        payload["ts"] = ts
    if harness is not None:
        payload["harness"] = harness
    if metadata is not None:
        payload["metadata"] = metadata
    if project is not None:
        payload["project"] = project
    return payload


class Observer:
    """一个绑定好的观测出口：端点 + 令牌 + harness 标注 + 投递缝。

    `transport` 是为测试与自建通道留的缝：签名 (url, body, headers, timeout)
    → HTTP 状态码。默认走 stdlib urllib。
    """

    def __init__(
        self,
        url: str,
        token: str,
        harness: str = "python",
        *,
        timeout: float = DEFAULT_TIMEOUT,
        transport: Optional[Transport] = None,
        env: Optional[Mapping[str, str]] = None,
        synchronous: bool = False,
    ) -> None:
        self.url = observe_url(url)
        self.token = token
        self.harness = harness
        self.timeout = timeout
        self._transport: Transport = transport or _urllib_transport
        self._env = env if env is not None else {}
        self.synchronous = synchronous
        self.last_error: Optional[str] = None

    # ── 投递 ─────────────────────────────────────────────────────────────────
    def deliver(self, payload: Mapping[str, Any]) -> bool:
        """同步投递一次，返回是否成功。任何异常都折算成 False，从不抛出。"""
        try:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            headers = {
                "authorization": "Bearer " + self.token,
                "content-type": "application/json",
            }
            status = self._transport(self.url, body, headers, self.timeout)
            if 200 <= int(status) < 300:
                return True
            self.last_error = "observe HTTP %s" % status
            return False
        except Exception as exc:  # noqa: BLE001 — 适配层吞掉一切，见文件头铁律 1
            self.last_error = str(exc)
            return False

    def emit(
        self,
        event_type: str,
        title: str,
        body: str,
        *,
        idempotency_key: Optional[str] = None,
        subject: Optional[str] = None,
        ts: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
        project: Optional[str] = None,
    ) -> str:
        """构造并投递一条观测，返回本次的幂等键。

        默认异步（守护线程），立即返回；`synchronous=True` 时同步投递，供测试
        与「进程马上要退出」的场景使用。
        """
        payload = build_payload(
            event_type=event_type,
            title=title,
            body=body,
            idempotency_key=idempotency_key,
            subject=subject,
            ts=ts,
            harness=self.harness,
            metadata=metadata,
            project=project,
        )
        if self.synchronous:
            self.deliver(payload)
        else:
            t = threading.Thread(target=self.deliver, args=(payload,), daemon=True)
            t.start()
        return str(payload["idempotency_key"])

    # ── 便捷入口（框架映射器都用这三个） ──────────────────────────────────────
    def tool_call(self, name: str, output: Any = None, **kwargs: Any) -> str:
        body = _output_text(output)
        title = "工具调用：%s" % name
        meta = dict(kwargs.pop("metadata", {}) or {})
        meta.setdefault("tool", name)
        return self.emit("tool_call", title, body, metadata=meta, **kwargs)

    def turn_outcome(self, summary: str, output: Any = None, *, outcome: str = "ok", **kwargs: Any) -> str:
        meta = dict(kwargs.pop("metadata", {}) or {})
        meta.setdefault("outcome", outcome)
        return self.emit("turn_outcome", summary, _output_text(output), metadata=meta, **kwargs)


def _output_text(output: Any) -> str:
    if output is None:
        return ""
    if isinstance(output, str):
        return output
    try:
        return json.dumps(output, ensure_ascii=False, default=str)
    except Exception:  # noqa: BLE001
        return str(output)


def observe_once(
    url: str, token: str, event_type: str, title: str, body: str, **kwargs: Any
) -> bool:
    """一次性同步上报（诊断与脚本用）。失败返回 False，不抛。"""
    observer = Observer(url, token, harness=kwargs.pop("harness", "python"), synchronous=True, **kwargs)
    payload = build_payload(event_type=event_type, title=title, body=body)
    return observer.deliver(payload)


def run_safely(fn: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
    """跑一段框架回调体，吞掉一切异常。

    框架回调抛错会弄破宿主应用——那是本适配层唯一不可接受的失败模式，所以
    每个映射器入口都套这一层。返回值在失败时是 None。
    """
    try:
        return fn(*args, **kwargs)
    except Exception:  # noqa: BLE001 — 见上
        return None

