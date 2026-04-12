---
name: LLM output mirrors the prompt example structure
description: When the system prompt OUTPUT FORMAT example shows N items, the LLM emits exactly N items regardless of how many the tool returned. Always expand examples to match the desired minimum count.
type: feedback
originSessionId: 54ec9e18-cdb1-47cf-83d6-e4335ad62414
---
The Gemini Flash Lite model copies the OUTPUT FORMAT example structure literally. If the example shows 2 flight options, the LLM emits 2 even when search_flights returned 8. If the example shows 1 hotel, the LLM emits 1 even when search_places returned 20.

**Why:** Discovered across Round 11 (hotels) and Round 21 (flights). Both times the backend tool returned plenty of data, but the LLM trimmed to match the example. The "VERBATIM" instruction was ignored because the example spoke louder than the prose.

**How to apply:** Whenever changing the number of items the LLM should emit (flights, hotels, activities per day), ALSO update the OUTPUT FORMAT JSON example in prompts.py to show that many items. The example is the specification the model actually follows — the prose instructions are secondary.
