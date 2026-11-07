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
from yongyi_agent.crewai import event_listener, uninstall

listener = event_listener()   # 必须持有这个返回值！
# ...
uninstall(listener)           # 停止捕获（已写下的记忆不动）
```

**坑**：CrewAI 的监听器靠**实例化**注册——只是 import 模块不会生效。丢掉返回值不报错，但会静默失去捕获。

映射：`ToolUsageFinishedEvent` → `tool_call`（`failure` 是 `ToolFailure` 对象，非空即 `metadata.outcome=error`）；`CrewKickoffCompletedEvent` / `CrewKickoffFailedEvent` → `turn_outcome`（`total_tokens`、`crew_name` 进 metadata）。

两点实测事实（crewai 1.15.37）：①事件类经 `crewai.events` 的懒加载导出可取，不必记子模块路径；②`bus.emit()` 把同步 handler 提交到线程池并返回 Future，**不阻塞**——所以回调体永远不在调用方线程上，自己写测试时要 `future.result()` 等它。

CrewAI 的 MCP 集成随版本演进，挂载形态以所装版本为准（需要的就是 HTTP transport MCP 客户端 + 自定义 `Authorization` 头）。

## LlamaIndex

LlamaIndex 是三个框架里最麻烦的一个：**agent 执行路径里框架不发工具事件，回合摘要又被截断**，所以两条线都放在调用点上。

```python
from yongyi_agent.llamaindex import event_handler, instrument_agent, instrument_tools

handler = event_handler()                        # query engine 收尾；请持有返回值
agent = instrument_agent(FunctionAgent(          # 回合收尾（真答案）
    tools=instrument_tools([my_tool]),           # 工具调用（真输出）
    llm=...,
))
answer = await agent.run(user_msg="...")         # 调用方式不变
# uninstall(handler)                             # 需要时摘除
```

| 面 | 抓法 | 落成 | 为什么 |
| --- | --- | --- | --- |
| agent 工具 | `instrument_tools([...])` | `tool_call`（真输出） | 框架没有工具事件可订阅 |
| agent 回合 | `instrument_agent(agent)` | `turn_outcome`（真答案） | 框架摘要只有 200 字、常被思考块吃满 |
| query engine | `event_handler()` | `turn_outcome`（`QueryEndEvent`） | 这条事件框架真的会发 |

**为什么 agent 要靠调用点**（`llama-index-core 0.14.25` 实机，不是读源码猜的）：跑一个真 `FunctionAgent` 回合——工具确实执行、答案为 42——事件流里只有 `LLMChat*` 与 `Workflow*`。`AgentToolCallEvent` 有类定义但**全包无一处实例化**；`CBEventType.FUNCTION_CALL` 有枚举但**没有任何发射点**；`LLMChatEndEvent.response.message.tool_calls` 是空的。唯一痕迹是 `WorkflowStepOutputEvent.output` 里 `ToolCallResult(...)` 的**字符串 repr**。回合收尾的 `WorkflowRunOutputEvent.output` 也没好到哪去：它是 `summarize_event(max_length=200)` 截出来的 repr，推理模型先吐 `ThinkingBlock`，200 字截完**答案根本不在里面**（实测只留下思考前缀）。

parse 框架 repr 不是契约，所以两处都改在调用点：`instrument_tools()` 包工具、`instrument_agent()` 拦 `agent.run()` 的 await，用 `AgentOutput.response` 作正文。工具 metadata 与函数签名、agent 的其它属性和 `stream_events()` 全部原样保留；代理不改框架对象也不改类（`FunctionAgent` 是 pydantic 模型，实例上塞不了 `run`：`"FunctionAgent" object has no field "run"`）。

`event_handler()` 默认**不**落 agent 回合摘要（`agent_turn_summary=True` 可开）：两条都开时同一次回合会落两条 `turn_outcome`（真机实测 2 条）。只在你不方便包 agent、又想要「回合发生过」的存在性记录时才打开。

**为什么不是 `CBEventType.TOOL`**：那是 0.10 时代的回调事件。released 的 `llama-index-core 0.14.25` 连这个枚举成员都没有（`tool` 只在上游 main 分支的 schema 里），core 也不再派发它。旧回调面作为低版本兼容保留，认 `tool` / `function_call` / `agent_step` 三种：

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

85 项，全部无网络、不需要装任何框架（映射函数收鸭子类型事件，框架类型只在真正接线的入口出现）。

## 边界（如实标注）

- **已发布到 PyPI**（0.1.1，2026-11-08）：`pip install yongyi-agent` 直接装；0.1.0 的 LlamaIndex 说明是错的（把 instrumentation 当现役路径），0.1.1 起为本文所写的行为；本仓 `python/` 仍可 `pip install -e` 用于开发。版本发布走 `python -m build` + `twine upload`，发布凭据不进仓、用完即吊销。
- **实机验证到了哪一层**：三个框架都在隔离环境里对着**真框架**跑过——`langchain-core 1.7.6`、`llama-index-core 0.14.25`、`crewai 1.15.37`；投递面一律用桩 transport 捕获。三个框架**都还跑过真实 LLM 驱动的完整回合**（模型 `glm-5.3-flash`，走 OpenAI 兼容网关）：LangChain 的 react agent 产生 `tool_call`（`add` → 5）与恰好一条 `turn_outcome`；LlamaIndex 的 `FunctionAgent` 产生 `tool_call`（`multiply` → 42）与正文就是答案 `42` 的 `turn_outcome`；CrewAI 的 crew 产生 `tool_call`（`add` → 5）与 `turn_outcome`（`total_tokens` 1105）。这证的是「真回合里事件确实会发生」，比构造事件投递更强。
- **这条路上抓到五个缺陷**，回归钉全部入仓：LangChain 缺事件入口会往宿主日志打 callback 错误；LlamaIndex 的 `CBEventType.TOOL` 在发布版根本不存在（捕获率为零）；**LlamaIndex 的 `AgentToolCallEvent` 同样有定义无发射点**（agent 工具调用零捕获，只能包调用点）；**`WorkflowRunOutputEvent.output` 是 200 字截断 repr**（推理模型的回合正文里没有答案）；CrewAI 的 `bus.off` 是两个位置参数、当装饰器工厂用会让「断开」静默失效。
- 框架回调签名随版本演进；本包的容忍策略是「缺字段降级 + 异常全吞」，不会因为签名变化弄破宿主，但可能少上报一条观测。LlamaIndex 的工具级捕获因此不依赖框架事件面——那是它唯一不随版本漂移的接法。

