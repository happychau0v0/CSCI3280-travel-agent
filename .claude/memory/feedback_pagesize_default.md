---
name: Google Places pageSize defaults to 1 when omitted
description: The Google Places (New) API returns only 1 result when pageSize is not included in the request body. Always set it unconditionally.
type: feedback
originSessionId: 54ec9e18-cdb1-47cf-83d6-e4335ad62414
---
Google Places (New) API defaults pageSize to 1 when the field is omitted from the POST body. This collapsed every itinerary to 1 hotel / 1 activity / 1 restaurant whenever the LLM called search_places without the optional `location` parameter (which skipped the conditional pageSize assignment).

**Why:** Root cause of the "1 of everything" bug that persisted from Round 8 through Round 11. The single-line fix (`body["pageSize"] = 20` unconditionally) was the highest-leverage change in the entire project.

**How to apply:** When adding any new Google API wrapper, always set pagination/count parameters UNCONDITIONALLY — never gate them on optional parameters. Verify via a pytest that the request body always contains the expected field regardless of which optional args are passed.
