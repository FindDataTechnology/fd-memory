# yongyi-agent

永忆（fd-memory）的 Python 适配层：把 agent 框架的**事件面**接到永忆的 `/observe`，让「工具调用」与「回合收尾」自动落 L0 记忆——不需要 agent 自己想着写。

支持 LangChain、CrewAI、LlamaIndex。核心零第三方依赖（只用标准库），框架依赖走 extras。

## 装

```bash
pip install yongyi-agent                    # 核心（MCP 挂载配方 + 投递契约）
pip install "yongyi-agent[langchain]"       # + LangChain
pip install "yongyi-agent[crewai]"          # + CrewAI
pip install "yongyi-agent[llamaindex]"      # + LlamaIndex
```

## 三级捕获担保，先看清自己在哪一级

| 级别 | 形态 | 记忆写入的保证 |
| --- | --- | --- |
| 平台担保 | 原生平台 | 每个回合收尾自动落 L0，不依赖 agent |
| **适配层担保** | **框架 handler（本包）** | 框架每次工具调用/回合结束都回调，本包自动上报 |
| agent 自觉 | UI 型平台 | 只有提示词纪律，agent 不写就没有 |

本包提供的是**适配层担保**：捕获由事件驱动，不靠 agent 自觉。但注意它担保的是「有事件就一定上报」，不是「一定存在事件」——框架没触发的事件，本包也无从捕获。

## 身份

令牌从这三处按序查找，**不铸造、不改写**凭据：

1. 显式参数（`Observer(url=..., token=...)`）
2. 环境变量 `YONGYI_TOKEN`（或旧名 `FD_MEMORY_TOKEN`）、端点 `YONGYI_URL`
3. 凭据文件 `~/.yongyi/credentials.json`（由 `yongyi connect <harness> --as <user>` 写出，须 0600；权限过宽会告警）

## LangChain

```python
from yongyi_agent.langchain import callback_handler

handler = callback_handler()          # 按环境自动解析身份
graph.invoke(inputs, config={"callbacks": [handler]})
```

映射：`on_tool_end` → `tool_call`；`on_agent_finish` → `turn_outcome`；`on_chain_end` **只认顶层**（`parent_run_id is None`）——内层 chain 不算回合收尾，否则一次运行会落十几条观测把 L0 噪声化。

MCP 挂载（`langchain-mcp-adapters`）：

```python
from langchain_mcp_adapters.client import MultiServerMCPClient

client = MultiServerMCPClient({"fd-memory": {
    "url": "http://127.0.0.1:49375/mcp",
    "transport": "http",
    "headers": {"Authorization": "Bearer ${YONGYI_TOKEN}"},
}})
tools = await client.get_tools()
```

## CrewAI

```python
from yongyi_agent.crewai import event_listener

listener = event_listener()   # 必须持有这个返回值！
```

**坑**：CrewAI 的监听器靠**实例化**注册——只是 import 模块不会生效。丢掉返回值不报错，但会静默失去捕获。

映射：`ToolUsageFinishedEvent` → `tool_call`（`failure` 字段进 `metadata.outcome`）；`CrewKickoffCompletedEvent` / `CrewKickoffFailedEvent` → `turn_outcome`。

CrewAI 的 MCP 集成随版本演进，挂载形态以所装版本为准（需要的就是 HTTP transport MCP 客户端 + 自定义 `Authorization` 头）。

## LlamaIndex

0.14+ 的现役路径是 **instrumentation**，不是回调事件：

```python
from yongyi_agent.llamaindex import event_handler

handler = event_handler()     # 注册进全局分派器；请持有返回值
# ... 跑你的 agent / query engine ...
# uninstall(handler)          # 需要时摘除
```

映射：`AgentToolCallEvent` → `tool_call`（工具名取 `event.tool.name`，参数是 JSON 串）；`QueryEndEvent` → `turn_outcome`（正文从 `response.response` 取，不 unwrap 会落成对象 repr）。

**为什么不是 `CBEventType.TOOL`**：那是 0.10 时代的回调事件。released 的 `llama-index-core 0.14.25` 连这个枚举成员都没有（`tool` 只在上游 main 分支的 schema 里），core 也不再派发它——按老写法接上去会捕获不到任何东西。旧回调面作为低版本兼容保留，认 `tool` / `function_call` / `agent_step` 三种：

```python
from llama_index.core.callbacks import CallbackManager
from yongyi_agent.llamaindex import callback_handler

Settings.callback_manager = CallbackManager([callback_handler()])
```

MCP 挂载（`llama-index-tools-mcp`）：

```python
from llama_index.tools.mcp import BasicMCPClient, McpToolSpec

client = BasicMCPClient("http://127.0.0.1:49375/mcp")
tools = await McpToolSpec(client=client).to_tool_list_async()
```

## 纪律文本

`from yongyi_agent import DISCIPLINE` —— 与 TypeScript 侧平台纪律文本逐字节一致（金样两侧钉住）。贴进 Agent 的系统提示词，让 agent 知道何时该用 `memory_write_page` / `memory_handoff_begin`。

## 设计底线

- **绝不弄破宿主**：每个框架回调体都包在 try/except 里，任何异常不外泄；投递失败、超时、4xx 全部吞掉，不重试。
- **绝不阻塞回合**：默认在守护线程里投递，`emit()` 立即返回（测试与进程退出场景可传 `synchronous=True`）。
- **配置错误在开发期炸**：封闭集之外的事件类型、空标题直接抛错，不静默丢。
- **令牌零明文**：所有挂载片段只出现环境变量引用与取法命令行。

## 测试

```bash
python -m venv .venv && .venv/bin/pip install -e ".[dev]"
.venv/bin/python -m pytest -q
```

68 项，全部无网络、不需要装任何框架（映射函数收鸭子类型事件，框架类型只在真正接线的入口出现）。

## 边界（如实标注）

- **未发布到 PyPI**：包在本仓 `python/` 内可 `pip install -e` 安装使用；上 PyPI 需要发布凭据，属另行批准的步骤。
- **实机验证到了哪一层**：LangChain 与 LlamaIndex 已在隔离环境里对着**真框架**跑过（`langchain-core 1.7.6` / `llama-index-core 0.14.25`，真实 `@tool` 调用、真实 `RunnableLambda` 链、真实 instrumentation 事件与分派器），投递面用桩 transport 捕获——也就是说「事件面形状 + 注册方式」已实证，**没有**跑真实 LLM 驱动的完整 agent 回合。这一步抓到两个缺陷（LangChain 缺事件入口会往宿主日志打 callback 错误；LlamaIndex 的 `CBEventType.TOOL` 在发布版根本不存在），回归测试已入仓。**CrewAI 尚未实机验证**（未安装），其监听器注册与事件字段以所装版本为准，尤其 MCP 客户端形态。
- 框架回调签名随版本演进；本包的容忍策略是「缺字段降级 + 异常全吞」，不会因为签名变化弄破宿主，但可能少上报一条观测。

