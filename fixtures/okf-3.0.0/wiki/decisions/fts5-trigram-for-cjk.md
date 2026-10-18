---
type: decision
kind: decision
title: FTS5 trigram 分词承载 CJK 子串检索
tags:
  - storage
  - search
generated:
  by: human:fd-memory-fixture
  at: 2026-10-19T00:00:00.000Z
---
unicode61 不切中文、trigram 需 >=3 字符；<3 字符走 LIKE 兜底。零依赖（node:sqlite 内置）。
