import { useMemo } from "react";

/**
 * Strip leftover markdown emphasis markers (**bold**, __bold__,
 * *italic*, `code`) from agent replies before rendering. The system
 * prompt forbids markdown but the LLM still emits it, so we sanitize
 * client-side. Exported so PanelHistory / Subtitle / day descriptions
 * can call it before passing text to HighlightedText.
 */
export function stripMarkdown(text) {
  if (!text) return "";
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1") // **bold**
    .replace(/__(.+?)__/g, "$1") // __bold__
    .replace(/(?<!\*)\*(?!\*)([^*\n]+?)\*(?!\*)/g, "$1") // *italic* (not **)
    .replace(/`([^`\n]+?)`/g, "$1") // `inline code`
    .replace(/\*\*/g, "") // any orphaned **
    .replace(/__/g, ""); // any orphaned __
}

/**
 * Renders text with important entities wrapped in styled spans so the
 * user's eye can grab them at a glance — places, prices, dates, IATA
 * codes, durations.
 *
 * Detection is purely regex-based — there's no NLP. The patterns are
 * tuned for travel-agent text shapes:
 *   - HK$1,234        → entity-price
 *   - $123 / €123     → entity-price
 *   - HKG / NRT       → entity-iata (3-letter all-caps with word
 *                       boundaries; we conservatively skip if the token
 *                       is an English stop-word like "AND" or "ALL")
 *   - 2026-05-15      → entity-date
 *   - 10:00 / 4h 30m  → entity-time
 *   - "Tokyo" etc.    → entity-place (matched against a small bundled
 *                       list of common destination names; not exhaustive)
 *
 * The same component is used in the History panel, the subtitle bar,
 * day cards, hotel addresses — anywhere the agent's text shows up.
 */

const PLACE_NAMES = [
  // East Asia
  "Tokyo", "Kyoto", "Osaka", "Nara", "Hiroshima", "Sapporo",
  "Hong Kong", "Macau", "Taipei", "Kaohsiung",
  "Seoul", "Busan", "Jeju",
  "Beijing", "Shanghai", "Guangzhou", "Chengdu", "Xi'an",
  "Singapore", "Bangkok", "Phuket", "Chiang Mai",
  "Hanoi", "Ho Chi Minh City", "Da Nang",
  "Manila", "Cebu", "Bali", "Jakarta", "Kuala Lumpur",
  // Europe
  "London", "Paris", "Rome", "Barcelona", "Madrid", "Berlin",
  "Amsterdam", "Vienna", "Prague", "Lisbon", "Athens", "Istanbul",
  "Zurich", "Copenhagen", "Stockholm", "Oslo", "Helsinki", "Dublin",
  // Americas
  "New York", "Los Angeles", "San Francisco", "Chicago", "Boston",
  "Washington", "Seattle", "Miami", "Las Vegas", "Honolulu",
  "Toronto", "Vancouver", "Montreal",
  "Mexico City", "Cancun", "Buenos Aires", "Rio de Janeiro", "Lima",
  // Oceania
  "Sydney", "Melbourne", "Auckland", "Queenstown",
  // Middle East / Africa
  "Dubai", "Abu Dhabi", "Doha", "Tel Aviv", "Cairo",
  "Cape Town", "Marrakech", "Nairobi",
];

// Build a single regex with all the patterns. Each named group acts
// as the entity type.
const ENTITY_PATTERNS = [
  { type: "price", pattern: /(?:HK\$|US\$|S\$|NT\$|JPY|USD|EUR|GBP|HKD|\$|€|£|¥)\s?\d[\d,]*(?:\.\d+)?/g },
  { type: "date", pattern: /\b\d{4}-\d{2}-\d{2}\b/g },
  { type: "time", pattern: /\b\d{1,2}:\d{2}(?:\s?(?:AM|PM|am|pm))?\b/g },
  { type: "duration", pattern: /\b\d+\s?(?:hrs?|hours?|h)\s?\d*\s?(?:min|mins|minutes|m)?\b|\b\d+\s?(?:min|mins|minutes)\b/g },
  { type: "iata", pattern: /\b[A-Z]{3}\b/g },
];

const IATA_STOPWORDS = new Set([
  "AND", "THE", "FOR", "ARE", "WAS", "BUT", "NOT", "YOU", "ALL", "CAN",
  "HAS", "HAD", "WHO", "OUT", "WHY", "HOW", "DID", "ONE", "TWO", "TEN",
  "OUR", "ANY", "USE", "DAY", "WAY", "GET", "NEW", "MAY", "SEE", "TOP",
  "TBD", "ETC",
]);

function findEntities(text) {
  const matches = [];

  // Pattern-based matches
  for (const { type, pattern } of ENTITY_PATTERNS) {
    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(text)) !== null) {
      // Filter out IATA stopwords
      if (type === "iata" && IATA_STOPWORDS.has(m[0])) continue;
      matches.push({ start: m.index, end: m.index + m[0].length, type, text: m[0] });
    }
  }

  // Place-name matches (case-sensitive substring scan)
  for (const place of PLACE_NAMES) {
    let idx = 0;
    while ((idx = text.indexOf(place, idx)) !== -1) {
      // Word-boundary check on each side
      const before = text[idx - 1];
      const after = text[idx + place.length];
      const isWordBefore = before && /[A-Za-z]/.test(before);
      const isWordAfter = after && /[A-Za-z]/.test(after);
      if (!isWordBefore && !isWordAfter) {
        matches.push({
          start: idx,
          end: idx + place.length,
          type: "place",
          text: place,
        });
      }
      idx += place.length;
    }
  }

  // Sort and de-overlap (favor earlier match, then longer)
  matches.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
  const result = [];
  let cursor = 0;
  for (const m of matches) {
    if (m.start < cursor) continue; // overlaps an earlier match
    result.push(m);
    cursor = m.end;
  }
  return result;
}

export default function HighlightedText({ text, className }) {
  const segments = useMemo(() => {
    if (!text) return [];
    // Strip leaked markdown before entity detection so entity offsets
    // don't include `**` markers in the visible output.
    const clean = stripMarkdown(text);
    const matches = findEntities(clean);
    const out = [];
    let cursor = 0;
    for (const m of matches) {
      if (m.start > cursor) {
        out.push({ kind: "text", text: clean.slice(cursor, m.start) });
      }
      out.push({ kind: "entity", type: m.type, text: m.text });
      cursor = m.end;
    }
    if (cursor < clean.length) {
      out.push({ kind: "text", text: clean.slice(cursor) });
    }
    return out;
  }, [text]);

  return (
    <span className={className}>
      {segments.map((seg, i) =>
        seg.kind === "entity" ? (
          <span key={i} className={`entity entity-${seg.type}`}>
            {seg.text}
          </span>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </span>
  );
}
