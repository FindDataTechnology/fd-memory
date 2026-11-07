// 纪律文本单源测试：SDK 导出与金样 fixture 逐字节相等（fixture 由旗舰
// 现役实现实跑产出，即旗舰现行注入的字节）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { MEMORY_DISCIPLINE } from "../src/discipline.js";
import { golden } from "./helpers.js";

test("纪律文本：与金样 discipline.txt 逐字节相等（双语单源，无手抄副本）", () => {
  assert.equal(MEMORY_DISCIPLINE, golden("discipline.txt"));
});

test("纪律文本：形状锚点——双语行对行、首尾字节、关键工具名", () => {
  assert.ok(MEMORY_DISCIPLINE.startsWith("\n\n## 工作记忆（fd-memory）/ Working memory (fd-memory)\n"));
  assert.ok(MEMORY_DISCIPLINE.endsWith("verbatim copying is not memory.\n"));
  for (const marker of [
    "memory_handoff_begin",
    "memory_handoff_list",
    "memory_handoff_accept",
    "memory_write_page",
    "memory_query",
    "MCP 服务器 fd-memory 已挂载",
    'An MCP server "fd-memory" is mounted',
  ]) {
    assert.ok(MEMORY_DISCIPLINE.includes(marker), `缺少关键内容: ${marker}`);
  }
});
