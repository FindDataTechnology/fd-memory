# DESIGN.md — 永忆官网视觉世界（漂浮星群修复程序）

> This file is the durable record of the shipped visual world for `site/`. Written at finish, from the built world, by the documenter. A rulebook written before the build gets defended against reality; this one describes what shipped.

## Own-world identity

- **Palette** (no gradients text, no decorative glass):
  - ground `#070c17`（深夜）
  - surface `#0b1220` / panel `#101a2b`（次深）
  - ink `#e9e2d2`（主文，warm off-white，高对比 ≥ 7:1）
  - ink-dim `#b6ac97`（次文，≥ 4.5:1）
  - ink-faint `#978e79`（雾文，≥ 5:1，升级自 #7d7663 修评 `#1`)
  - signal cyan `#4fd0d8` / dim `#269fa8`（召回动作、链接、segment boundaries）
  - amber `#e8b45e` / dim `#8f6a2e` — **只能用于 live-write 与 supersede**，不能作装饰色
  - focus ring = amber；selection = `rgba(79,208,216,.28)`
- **Type**:
  - display/body — **Noto Serif SC**（zh display，替代 contract 里写的「Libre Baskerville display zh」——后者不含中文字形；英文/拉丁同套）
  - coordinates / tags / code — **IBM Plex Mono**
  - 这两套通过 Google Fonts CDN 载入（`fonts.googleapis.com`，CSS2 `family=IBM+Plex+Mono:wght@400;500;600&family=Noto+Serif+SC:wght@400;600;700&display=swap`）
  - tracking 只在 display 用 `-0.022em`，body 与 mono 不用
  - body measure 65–75ch；无需有别的 style 消耗
- **Forms**: circles with thin halo dash (libcandidate outer rings), solid nodes, dashed supersede arc. Amber reserved for: 当前会话节点， live-write flash, supersede arc hover state, v2 candidate node. Cyan reserved for: L0 nodes / semantic recall entries / links / nav accents. No gradient text anywhere, no glassblur, no icon card bento, no zero-offset glow. Open ring one ambient scene (deep space), not near-black glow.
- **Chrome**: sticky topbar with hairline bottom line; nav is mono-spaced, 2-char zh items with `white-space: nowrap` on mobile.

## Signature constructs

1. **漂浮星群 canvas**（hero right canvas）: self-drawn SVG. Central amber node `当前会话 · owner root`, around it L0 outer obit dot, L1 note/handoff nodes, L2 facts/experiences nodes, L3 profiles dimmed, rings 70/130/200/270. A supersede arc: dim v1 node → bright amber v2 candidate node, dashed, on hover of either endpoint it lights up and thickens (contract THESIS). Hover any L1–L3 node increases radius by +2.
2. **记忆河 · live**（right rail digest）: right-border line panel, per frame one entry, types distinguished by prefix color (amber = new write, cyan = semantic hit, faded = retired superseded). On mobile it rehosts under the lede, legend centered.
3. **The one authored motion** (cycle shared by refresh + write):
   - center pulse (amber ring expands and dies) every 4.8s—**merged into the flash**: at each flash moment the same ring fires once, and its amber dot expands to 1.55× and vanishes. No second orchestrated moment anywhere else on the page; entrance motion is `digest-in` per entry only.
4. **supersede arc hover** — the ACTIVE demonstration, not decorative: it lights up, thickens, v1 turns muted to live color while hovered.

## Contrast & browsers

- Intended contrast pairs: `#e9e2d2`/`#070c17` (high), `#b6ac97`/`#070c17` (body secondary), `#978e79`/`#070c17` (faint — ≥ 5:1).
- Chrome finish: `::selection` cyan-tinted; `<body>` scrollbar styled; focus ring amber 2px; links underline offset 3px; browser`-webkit-scrollbar` borders matched on `bg-2`.
- prefers-reduced-motion: full static map, full curated digest list, no cycle, no entrance animation.

## Orientation checks

- `.hero` 92vh two-column on desktop; <860px single column + sky dimmed to 42% so the text wins (review fix #1).
- Layers use fill-bar progress, not icon cards.
- Recall lanes are hairline-top rules with lead copy, not boxed cards.
- Start steps are 4-row numbered grids with code blocks — no ornament.

## Files

- `index.html` — full page structure & copy (zh-CN lead)
- `style.css` — tokens + layout + layout + monochrome prose styles
- `script.js` — constellation canvas + digest flow + supersede-hover wiring (dead code merged into the write-flash moment)

## Never

- No invented pricing, benchmarks, production customer claims, or mission control styled clock
- No new motion without a named live trigger (no infinite ambient anim loops other than the one flash cycle)
- No amber anywhere except live-write semantics
- No static-image stand-ins for the constellation; it is always drawn live
- Removed supersede-hover dimming will make the chain illegible — keep the hover light rule as-is
