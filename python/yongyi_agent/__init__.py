# ── yongyi-agent · 出口面 ────────────────────────────────────────────────────
#
# 永忆（fd-memory）的 Python 适配层：把框架的事件面（callback handler /
# event bus）接到内核的 /observe，使「工具调用」与「回合收尾」自动落 L0。
#
# 与 TypeScript SDK 的分工：SDK 面向集成者造适配器（注入阶梯、事实捕获、
# 令牌铸造、挂载行），本包面向框架应用直接用——只做一件事：把框架事件变成
# 观测上报，永不弄破宿主。
#
# 模块地图：
#   observe     投递契约（封闭事件集、幂等键、有界超时、失败即丢）
#   tokens      身份解析（环境变量 → 凭据文件）
#   discipline  纪律文本（与 TS 单源逐字节，跨语言金样钉住）
#   mounts      各框架的 MCP 挂载配方
#   langchain / crewai / llamaindex   三个框架的事件映射器
#
# 依赖纪律：核心零第三方依赖；框架集成延迟导入，装不上就报带指引的错。

from .observe import (
    EVENT_TYPES,
    Observer,
    UnknownEventType,
    observe_once,
)
from .tokens import resolve_identity
from .discipline import DISCIPLINE

__all__ = [
    "EVENT_TYPES",
    "Observer",
    "UnknownEventType",
    "observe_once",
    "resolve_identity",
    "DISCIPLINE",
]

__version__ = "0.1.0"
