---
name: Merge partial live API data with estimator padding
description: When fast-flights returns fewer than 3 results (proxy blocked, slow route), merge them with the estimator fallback instead of using partial data alone.
type: feedback
originSessionId: 54ec9e18-cdb1-47cf-83d6-e4335ad62414
---
fast-flights sometimes returns 1-2 flights instead of 10+ (IP blocked, proxy, rate limit). The old `if live_options:` truthiness check accepted any non-empty list, so the user saw 1 flight with no alternatives.

**Why:** Discovered via Playwright walkthrough on HK → Vancouver route. The single live flight had no departure_time, making the UI confusing.

**How to apply:** For any tool that has a "live data" path and an "estimator/fallback" path, require a MINIMUM viable count (≥3) before using live data exclusively. When below that threshold, merge live + estimator so the user gets both real pricing AND enough alternatives to compare. Tag the source as "fast-flights+estimator" so debugging knows which path was taken.
