# ── MCP 挂载配方（各框架一份） ───────────────────────────────────────────────
#
# 与 `connect dify` 的配方同形：纯数据 + 人读渲染。框架的 MCP 支持各有各的
# 客户端形状，所以这里给的是「该框架官方客户端怎么写」的片段，而不是一个我们
# 伪造的统一抽象。
#
# 令牌纪律（与前三波同一条）：片段里只出现环境变量引用与取法命令行，绝不出现
# 明文 person 令牌——片段常被贴进 README/issue/群里。

from __future__ import annotations

from typing import Any, Dict

TOKEN_ENV = "YONGYI_TOKEN"


def mcp_url(base_url: str) -> str:
    return base_url.rstrip("/") + "/mcp"


def token_command(env_var: str = TOKEN_ENV) -> str:
    # 拼接而非 %-格式化：命令里本身有 printf 的 %s，混用会解析错。
    return '. "${YONGYI_HOME:-$HOME/.yongyi}/env" && printf \'Bearer %s\\n\' "${' + env_var + '}"'


def langchain_recipe(base_url: str, *, env_var: str = TOKEN_ENV) -> Dict[str, Any]:
    """langchain-mcp-adapters 的 MultiServerMCPClient 片段。"""
    return {
        "framework": "langchain",
        "package": "langchain-mcp-adapters",
        "install": "pip install langchain-mcp-adapters",
        "config": {
            "fd-memory": {
                "url": mcp_url(base_url),
                "transport": "http",
                "headers": {"Authorization": "Bearer ${%s}" % env_var},
            }
        },
        "snippet": (
            "from langchain_mcp_adapters.client import MultiServerMCPClient\n"
            "\n"
            'client = MultiServerMCPClient({"fd-memory": {\n'
            '    "url": "%s",\n'
            '    "transport": "http",\n'
            '    "headers": {"Authorization": "Bearer ${%s}"},\n'
            "}})\n"
            "tools = await client.get_tools()\n"
        )
        % (mcp_url(base_url), env_var),
    }


def llamaindex_recipe(base_url: str, *, env_var: str = TOKEN_ENV) -> Dict[str, Any]:
    """llama-index-tools-mcp 的 BasicMCPClient + McpToolSpec 片段。"""
    return {
        "framework": "llamaindex",
        "package": "llama-index-tools-mcp",
        "install": "pip install llama-index-tools-mcp",
        "config": {"url": mcp_url(base_url), "headers": {"Authorization": "Bearer ${%s}" % env_var}},
        "snippet": (
            "from llama_index.tools.mcp import BasicMCPClient, McpToolSpec\n"
            "\n"
            'client = BasicMCPClient("%s")\n'
            "tools = await McpToolSpec(client=client).to_tool_list_async()\n"
        )
        % mcp_url(base_url),
    }


def crewai_recipe(base_url: str, *, env_var: str = TOKEN_ENV) -> Dict[str, Any]:
    """CrewAI 的 MCP 支持随版本演进，给通用形态并明确标注以所装版本为准。"""
    return {
        "framework": "crewai",
        "package": "crewai-tools",
        "install": "pip install crewai-tools",
        "config": {"url": mcp_url(base_url), "headers": {"Authorization": "Bearer ${%s}" % env_var}},
        "snippet": (
            "# CrewAI 的 MCP 客户端形状随版本变化，以所装版本为准；\n"
            "# 需要的就是一个 HTTP transport MCP 客户端 + 自定义 header：\n"
            "#   url    = %s\n"
            "#   header = Authorization: Bearer ${%s}\n"
        )
        % (mcp_url(base_url), env_var),
        "caveat": "crewai 的 MCP 集成在演进中，此处给通用形态而非固定 API；以所装版本为准。",
    }


def render(recipe: Dict[str, Any], *, env_var: str = TOKEN_ENV) -> str:
    """把一份配方渲染成终端/文档可读文本（含令牌取法，绝不含令牌本身）。"""
    lines = [
        "%s 的 MCP 挂载配方" % recipe["framework"],
        "  端点      %s" % mcp_url_from(recipe),
        "  安装      %s" % recipe["install"],
        "",
        recipe["snippet"].rstrip(),
        "",
        "令牌只以环境变量引用出现；取到整行值再填进去：",
        "  " + token_command(env_var),
    ]
    caveat = recipe.get("caveat")
    if caveat:
        lines.extend(["", "注意：" + caveat])
    return "\n".join(lines)


def mcp_url_from(recipe: Dict[str, Any]) -> str:
    config = recipe.get("config") or {}
    if "url" in config:
        return str(config["url"])
    for value in config.values():
        if isinstance(value, dict) and "url" in value:
            return str(value["url"])
    return ""
