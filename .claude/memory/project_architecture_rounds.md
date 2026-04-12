---
name: Project architecture evolved across 20+ rounds
description: Summary of the round-by-round feature evolution so future sessions understand what exists and why, without re-reading 80+ commits.
type: project
originSessionId: 54ec9e18-cdb1-47cf-83d6-e4335ad62414
---
The project ships a NieR-style 4-tab menu (PLAN/FLIGHTS/HOTELS/DAYS) with a 3D globe background and voice-first UX. Key architectural decisions that evolved over rounds:

**Round 8-9:** 4-tab shell, inline field editing, TTS subtitle queue, hotel-anchored day plans, request_input for LLM-driven form focus.

**Round 10:** PLAN rename (was HOME), bottom cards removed, compact form rows, airport-anchored Day 1/last day via get_day_windows tool, HotelsMap + DayMiniMap Leaflet components with airport pins, globe zoom on panel switch.

**Round 11:** Fixed the #1 sparseness bug (Google Places pageSize=1 default), flight estimator returns 3+ options, prompt contradictions resolved, navigate events buffered until done, PlanHistoryPanel replaces NEXT STEPS card.

**Round 12-14:** Flight seat class, alternate airports, Ctrl+Z undo/redo, dark/light theme, currency picker, quick-start templates, HelpOverlay (?), all persisted to localStorage.

**Round 15-17:** Trip cost summary, weather forecast strip, expand/collapse all, per-activity notes, shareable permalinks (#plan=base64), subtitle history popover, print view (P), subtitle size, phrasebook tool.

**Round 18-20:** Weather-aware outdoor hints, pre-trip checklist (L), subtitle pause on hover, ICS calendar export, activity favorites with stars, FavoritesOverlay (F), photo lightbox with arrow nav.

**Testing:** 267+ mocked Playwright assertions across 29 phases, 88 backend pytests, mandatory Playwright browser walkthrough before each round (added to CLAUDE.md after discovering that mocked tests miss CSS/layout/UX bugs).

**How to apply:** Before adding new features, check what already exists. The codebase is feature-dense — most "new" ideas may already be partially implemented in an earlier round.
