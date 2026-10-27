# Raster provenance — site captures

These are the review/preview game captures of `/site/index.html`, all produced by this session's machine using `playwright screenshot` with Chromium; no image generation tool ran, and no third-party artwork is embedded.

| File                                | How produced                                                              | Original prompt | Captured at       |
|-------------------------------------|---------------------------------------------------------------------------|-----------------|-------------------|
| /tmp/yongyi-desktop.png             | `playwright screenshot http://127.0.0.1:49378/index.html`                 | AI draw none    | 2026-10-27T08:24Z |
| /tmp/yongyi-desktop-v2.png          | same URL after CSS/layout fixes #1–#5                                     | AI draw none    | 2026-10-27T08:27Z |
| /tmp/yongyi-mobile.png              | same URL, Playwright Chromium `--viewport-size=390,844`                   | AI draw none    | 2026-10-27T08:25Z |
| /tmp/yongyi-mobile-v2.png           | same URL after CSS/layout fixes #1–#5, same viewport                      | AI draw none    | 2026-10-27T08:27Z |
| /tmp/yongyi-full.png                | same URL, `--full-page`                                                   | AI draw none    | 2026-10-27T08:28Z |
| /tmp/yongyi-desktop-v3.png          | same URL after finish-review FIX round (typography, digest copy, hero copy) | AI draw none    | 2026-10-27T09:14Z |
| /tmp/yongyi-mobile-v3.png           | same URL after FIX round, same mobile viewport                            | AI draw none    | 2026-10-27T09:14Z |
| /tmp/yongyi-desktop-final.png       | same URL, ship state (SVG hover restored, digest read-only, glass removed) | AI draw none   | 2026-10-27T09:36Z |
| /tmp/yongyi-mobile-final.png        | same URL, ship state, same mobile viewport                                 | AI draw none   | 2026-10-27T09:36Z |
| /tmp/yongyi-desktop-final2.png      | same URL after FIX round 3 (supersede chain pulled left of digest, hero-sky overflow hidden) — SHIP verdict | AI draw none | 2026-10-27T13:35Z |
| /tmp/yongyi-mobile-final2.png       | same URL after FIX round 3, same mobile viewport — SHIP verdict            | AI draw none   | 2026-10-27T13:35Z |

The artifact itself contains **no third-party images**: the constellation, rings, supersede arc, legend dots, and written content are all self-drawn SVG + local CSS. Google Fonts CDN (`fonts.googleapis.com`) loads `Noto Serif SC` + `IBM Plex Mono`; those are public-font-library references, not hosted assets, and they carry no `crossorigin` or integrity requirement (fallbacks in css: Songti SC / SF Mono).

| /tmp/yongyi-landing-desktop.png     | `playwright screenshot http://127.0.0.1:49381/memory-landing/index.html`  | AI draw none    | 2026-10-28T06:34Z |
| /tmp/yongyi-landing-mobile.png      | same URL, Playwright Chromium `--viewport-size=390,844`                   | AI draw none    | 2026-10-28T06:34Z |
| /tmp/yongyi-landing-full.png        | same URL, `--full-page`                                                   | AI draw none    | 2026-10-28T06:34Z |

The memory-landing surface (site/memory-landing/index.html) ships no rasters at all — one hand-authored inline SVG constellation ornament; finish-review SHIP 8/8 (2026-10-28).
