---
name: Always do Playwright walkthrough before shipping
description: Mocked tests pass but real browser catches CSS overflow, text truncation, LLM output truncation, map rendering failures. Must use Playwright MCP to browse the app as a real user before declaring any round complete.
type: feedback
originSessionId: 54ec9e18-cdb1-47cf-83d6-e4335ad62414
---
Never ship a round of features without opening the actual app in Playwright and walking through the full user flow (PLAN → fill form → START PLANNING → FLIGHTS pick → HOTELS pick → DAYS review → overlays).

**Why:** Rounds 12-20 shipped 40+ features with 267/267 mocked tests passing, but a single Playwright walkthrough immediately found 8+ real bugs: button clipped below viewport, hotel names truncated, flight times showing wrong day, PICKED badge clipped, partial fast-flights fallback showing 1 option, etc. Mocked tests verify code logic but miss CSS layout issues, real API edge cases, and LLM output format mismatches that only manifest in a real browser.

**How to apply:** After every implementation round, before the final commit, use the Playwright MCP tools (browser_navigate, browser_snapshot, browser_take_screenshot, browser_click, browser_evaluate) to walk through the app at multiple viewport sizes (1440×900 + 1024×600). Check every panel, every overlay, every interactive element. This is now documented in CLAUDE.md as a mandatory checklist.
