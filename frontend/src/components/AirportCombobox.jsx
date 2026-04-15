import { useEffect, useRef, useState } from "react";
import { searchAirports } from "../api/client";

/**
 * Searchable airport combobox. Stores the selected airport as a label
 * string in the format "Airport Name (IATA)" — e.g. "Hong Kong International (HKG)".
 *
 * Props:
 *   value       string — current value ("Name (IATA)" or "" or bare "IATA")
 *   onChange    (label: string) => void — called with "Name (IATA)" on select, "" on clear
 *   placeholder string
 *   disabled    bool
 *   inputRef    ref — forwarded to the <input> for focus management
 */
export default function AirportCombobox({
  value = "",
  onChange,
  placeholder = "Search airport…",
  disabled = false,
  inputRef: externalRef,
}) {
  const [query, setQuery] = useState(value);
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const internalRef = useRef(null);
  const inputEl = externalRef || internalRef;
  const debounceRef = useRef(null);
  // Track the last committed value so blur can revert partial edits.
  const committedRef = useRef(value);

  // When value prop changes from outside (e.g., form prefill from LLM), sync display.
  // Bare IATA codes ("HKG") are resolved to full labels via the API.
  useEffect(() => {
    if (!value) {
      setQuery("");
      committedRef.current = "";
      return;
    }
    // Already in "Name (IATA)" format — use directly.
    if (/\([A-Z]{3}\)/.test(value)) {
      setQuery(value);
      committedRef.current = value;
      return;
    }
    // Bare IATA code: resolve to full label.
    if (/^[A-Z]{3}$/.test(value.trim().toUpperCase())) {
      searchAirports(value.trim().toUpperCase(), 1).then((res) => {
        if (res[0]) {
          const label = formatLabel(res[0]);
          setQuery(label);
          committedRef.current = label;
          onChange?.(label);
        }
      });
      return;
    }
    // Unknown format — display as-is.
    setQuery(value);
    committedRef.current = value;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  function formatLabel(airport) {
    return `${airport.name} (${airport.iata})`;
  }

  function handleInput(e) {
    const q = e.target.value;
    setQuery(q);
    setActiveIdx(-1);
    if (!q.trim()) {
      setResults([]);
      setOpen(false);
      onChange?.("");
      committedRef.current = "";
      return;
    }
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      const res = await searchAirports(q, 10);
      setResults(res);
      setOpen(res.length > 0);
    }, 180);
  }

  function selectAirport(airport) {
    const label = formatLabel(airport);
    setQuery(label);
    committedRef.current = label;
    setResults([]);
    setOpen(false);
    setActiveIdx(-1);
    onChange?.(label);
  }

  function handleKeyDown(e) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open && results.length > 0) { setOpen(true); return; }
      setActiveIdx((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && open && activeIdx >= 0) {
      e.preventDefault();
      selectAirport(results[activeIdx]);
    } else if (e.key === "Escape") {
      setOpen(false);
      setQuery(committedRef.current);
    }
  }

  function handleBlur() {
    // Delay so a mousedown on a result fires selectAirport first.
    setTimeout(() => {
      setOpen(false);
      if (query !== committedRef.current) {
        setQuery(committedRef.current);
      }
    }, 150);
  }

  return (
    <div className="airport-combo-wrap">
      <input
        ref={inputEl}
        type="text"
        className="airport-combo-input"
        value={query}
        onChange={handleInput}
        onKeyDown={handleKeyDown}
        onFocus={() => { if (results.length > 0) setOpen(true); }}
        onBlur={handleBlur}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete="off"
        spellCheck={false}
      />
      {open && results.length > 0 && (
        <ul className="airport-combo-list">
          {results.map((a, i) => (
            <li
              key={a.iata}
              className={`airport-combo-item${i === activeIdx ? " airport-combo-item-active" : ""}`}
              onMouseDown={(e) => {
                e.preventDefault(); // prevent blur firing before click
                selectAirport(a);
              }}
            >
              <span className="airport-combo-iata">{a.iata}</span>
              <span className="airport-combo-name">{a.name}</span>
              <span className="airport-combo-city">{a.city}, {a.country}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
