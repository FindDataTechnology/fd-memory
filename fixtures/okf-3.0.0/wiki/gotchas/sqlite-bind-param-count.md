---
type: gotcha
title: node:sqlite 绑定参数必须与占位符严格相等
tags:
  - node-sqlite
  - testing
generated:
  by: human:fd-memory-fixture
  at: 2026-10-19T00:00:00.000Z
sources:
  - fd-memory 实现期
---
参数多于占位符报 column index out of range；少于占位符（LIMIT ? 缺参）报 datatype mismatch。
