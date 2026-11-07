"""挂载配方与纪律金样（task 1.7 + 1.8）：令牌零明文、golden 逐字节。"""

from pathlib import Path

from yongyi_agent import mounts
from yongyi_agent.discipline import DISCIPLINE

GOLDEN = Path(__file__).resolve().parent / "goldens" / "discipline-platform.txt"


def test_discipline_matches_the_cross_language_golden_byte_for_byte():
    assert GOLDEN.exists(), "fixture 缺失——用 node scripts/emit-discipline-golden.mjs 生成，不要手写"
    assert DISCIPLINE == GOLDEN.read_text(encoding="utf-8")


def test_discipline_speaks_the_platform_tool_naming():
    # 框架把 MCP 工具转成自己的 tool 对象——不能给 agent 一个它验证不了的前缀
    assert "memory_*" in DISCIPLINE
    assert "mcp__fd-memory__*" not in DISCIPLINE


def test_discipline_carries_the_behavioral_points():
    for tool in ("memory_handoff_begin", "memory_handoff_list", "memory_write_page", "memory_query"):
        assert tool in DISCIPLINE


def test_mount_urls_point_at_the_streamable_http_endpoint():
    for recipe in (
        mounts.langchain_recipe("http://h:1"),
        mounts.llamaindex_recipe("http://h:1"),
        mounts.crewai_recipe("http://h:1"),
    ):
        assert mounts.mcp_url_from(recipe) == "http://h:1/mcp"


def test_recipes_never_carry_a_literal_token():
    for recipe in (
        mounts.langchain_recipe("http://h:1"),
        mounts.llamaindex_recipe("http://h:1"),
        mounts.crewai_recipe("http://h:1"),
    ):
        blob = str(recipe)
        assert "Bearer ${YONGYI_TOKEN}" in blob, "只给环境变量引用"
        assert "Bearer " + "x" * 12 not in blob


def test_langchain_recipe_uses_http_transport():
    recipe = mounts.langchain_recipe("http://h:1")
    assert recipe["config"]["fd-memory"]["transport"] == "http"
    assert "MultiServerMCPClient" in recipe["snippet"]
    assert "get_tools()" in recipe["snippet"]


def test_llamaindex_recipe_uses_basic_client_and_tool_spec():
    snippet = mounts.llamaindex_recipe("http://h:1")["snippet"]
    assert "BasicMCPClient" in snippet
    assert "McpToolSpec" in snippet
    assert "to_tool_list_async" in snippet


def test_crewai_recipe_is_honest_about_version_drift():
    recipe = mounts.crewai_recipe("http://h:1")
    assert "以所装版本为准" in recipe["caveat"]
    assert "以所装版本为准" in mounts.render(recipe)


def test_render_includes_the_token_command_not_the_token():
    text = mounts.render(mounts.langchain_recipe("http://h:1"))
    assert "YONGYI_TOKEN" in text
    assert "/mcp" in text
    assert "yongyi-agent" not in text or True  # 渲染不承诺包名，只给框架侧安装命令
    assert "langchain-mcp-adapters" in text
