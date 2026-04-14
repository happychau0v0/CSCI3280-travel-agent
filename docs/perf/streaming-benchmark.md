# Streaming Benchmark Results

**Date:** 2026-04-14  
**Model:** x-ai/grok-4.20 (via OpenRouter)  
**Backend:** Real APIs (Google Maps + OpenRouter)  
**Runs:** 3 × "Plan a 3-day trip to Tokyo from Hong Kong"

---

## Summary

Progressive streaming (`partial_itinerary` SSE events) makes flight options visible
**~7.4 seconds before** the full `done` event would have arrived.

| Metric | mean | P50 | P90 | min | max |
|--------|-----:|----:|----:|----:|----:|
| `t_first_tool_ms` | 2,457 | 2,539 | 2,665 | 2,167 | 2,665 |
| `t_first_partial_ms` | 4,433 | 4,220 | 4,995 | 4,085 | 4,995 |
| `t_done_ms` | 11,810 | 11,671 | 12,308 | 11,452 | 12,308 |
| **`partial_lead_ms`** | **7,377** | **7,367** | **7,450** | **7,313** | **7,450** |
| `sum_tool_ms` | 2,250 | 2,361 | 2,535 | 1,853 | 2,535 |
| `llm_inference_ms` | 9,561 | 9,773 | 9,818 | 9,091 | 9,818 |
| `server_to_client_ms` | 1 | 1 | 1 | 0 | 1 |

## Tool Breakdown (mean elapsed_ms)

| Tool | Mean ms |
|------|--------:|
| `search_flights` | 1,977 |
| `geocode_city` | 272 |
| `get_day_windows` | ~0 (mock stub) |
| `get_phrasebook` | ~0 (mock stub) |

## Interpretation

- **LLM think time** (before any tool fires): ~2.5s — the model processes the prompt and decides to call `geocode_city` + `search_flights`
- **`search_flights`** takes ~2s, making `t_first_partial` land at ~4.4s
- **`t_done`** = ~11.8s — the LLM takes another ~7.4s to write its full itinerary text after tools return
- **`partial_lead_ms` = 7.4s** — without streaming, users stared at a blank FLIGHTS panel for this entire window; now they see flight cards appear at ~4.4s while the agent finishes writing
- **`llm_inference_ms` = 9.6s** vs **`sum_tool_ms` = 2.3s**: the bottleneck is LLM generation time, not tool latency — streaming the tool results early is the right optimization

## Raw JSON

Full per-run data: `docs/perf/streaming-2026-04-13T20-13-32.json`
