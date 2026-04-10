import { useEffect, useMemo, useRef, useState } from "react";

/**
 * HOME — combines the editable trip form, the dashboard summary
 * cards, and the globe-as-background into a single landing screen.
 *
 * Layout (CSS grid):
 *   ┌───────────┬─────────────────┬───────────┐
 *   │ 📍 LIVE   │   ↑ NEXT TRIP ↑ │ EDITOR    │
 *   │ card      │                 │ (focused  │
 *   │           │   (globe in     │  field)   │
 *   ├───────────┤    middle)      │           │
 *   │ TRIP FORM │                 │           │
 *   │ ↑↓ fields │                 │           │
 *   │ PLAN BTN  │                 │           │
 *   ├───────────┼─────────────────┼───────────┤
 *   │ ✈ FLIGHT  │                 │ 🏨 HOTEL  │
 *   │ SELECTED  │                 │ SELECTED  │
 *   └───────────┴─────────────────┴───────────┘
 *
 * The form's listIndex doubles as the menu state's listIndex so
 * ↑/↓ moves between fields. Clicking a field also enters scope=list.
 */

const STORAGE_KEY = "travel-trip-form";

const FIELDS = [
  { key: "origin", label: "ORIGIN", type: "text", placeholder: "Hong Kong" },
  { key: "destination", label: "DESTINATION", type: "text", placeholder: "Tokyo, Japan" },
  { key: "start_date", label: "START DATE", type: "date" },
  { key: "end_date", label: "END DATE", type: "date" },
  {
    key: "transport",
    label: "TRANSPORT",
    type: "select",
    options: [
      ["", "—"],
      ["transit", "Public transit"],
      ["driving", "Driving"],
      ["walking", "Walking-focused"],
      ["mixed", "Mixed"],
    ],
  },
  { key: "party_size", label: "PARTY SIZE", type: "number", min: 1, max: 8 },
  { key: "interests", label: "INTERESTS", type: "text", placeholder: "history, food, hiking" },
];

export const HOME_FIELD_COUNT = FIELDS.length;

const PRICE_LEVEL_LABELS = {
  PRICE_LEVEL_INEXPENSIVE: "$",
  PRICE_LEVEL_MODERATE: "$$",
  PRICE_LEVEL_EXPENSIVE: "$$$",
  PRICE_LEVEL_VERY_EXPENSIVE: "$$$$",
};

function loadForm() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveForm(form) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(form));
  } catch {
    /* ignore */
  }
}

function formatHKD(n) {
  if (n == null) return "—";
  return `HK$${n.toLocaleString("en-HK")}`;
}

function buildPrompt(form) {
  const dest = form.destination?.trim() || "somewhere";
  const start = form.start_date || "";
  const end = form.end_date || "";
  const days =
    start && end
      ? Math.max(
          1,
          Math.round((new Date(end).getTime() - new Date(start).getTime()) / 86400000) + 1,
        )
      : null;
  const dayText = days ? `${days}-day` : "multi-day";
  const transport = form.transport || "any";
  const party = form.party_size ? `${form.party_size} people` : "1 person";
  const interests = form.interests?.trim() || "general sightseeing";
  const dateText = start ? ` starting ${start}` : "";
  const origin = form.origin?.trim() || "my current city";
  return (
    `Plan a ${dayText} trip from ${origin} to ${dest}${dateText} ` +
    `with ${transport} transport for ${party}. Interests: ${interests}.`
  );
}

export default function PanelHome({
  itinerary,
  userLocation,
  agentState = "idle",
  currentTool = null,
  listIndex = 0,
  isLoading = false,
  pendingInputRequest = null,
  onJumpTo,
  onPlan,
  onResolveInput,
  rowDispatchRef,
}) {
  const [form, setForm] = useState(() => loadForm());
  const editorRef = useRef(null);

  // Seed defaults from existing itinerary + GPS on first mount.
  useEffect(() => {
    if (Object.keys(form).length === 0) {
      const seeded = {
        origin: itinerary?.origin || userLocation?.city || "",
        destination: itinerary?.destination || "",
        transport: itinerary?.local_transport_mode || "",
      };
      setForm(seeded);
      saveForm(seeded);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Focus the inline editor only when the LLM has driven the user
  // here via request_input. Regular ↑/↓ keeps focus on body.
  useEffect(() => {
    if (pendingInputRequest && editorRef.current) {
      editorRef.current.focus();
    }
  }, [pendingInputRequest]);

  const update = (key) => (e) => {
    const next = { ...form, [key]: e.target.value };
    setForm(next);
    saveForm(next);
  };

  // When the LLM asks for a specific field, override the user's
  // listIndex so the editor jumps to it on arrival.
  const requestedIdx = pendingInputRequest
    ? FIELDS.findIndex((f) => f.key === pendingInputRequest.field)
    : -1;
  const selectedIdx =
    requestedIdx >= 0 ? requestedIdx : Math.min(Math.max(0, listIndex), FIELDS.length - 1);
  const selected = FIELDS[selectedIdx];

  const handleResolveSubmit = () => {
    if (!pendingInputRequest) return;
    const value = form[pendingInputRequest.field];
    if (value == null || value === "") return;
    const fieldIdx = FIELDS.findIndex((f) => f.key === pendingInputRequest.field);
    onResolveInput?.(pendingInputRequest.field, value, fieldIdx);
  };

  const handleEditorKeyDown = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (pendingInputRequest) {
        handleResolveSubmit();
      } else if (form.destination?.trim() && !isLoading) {
        // Plain Enter inside the editor (not during request_input)
        // submits the PLAN button — the form's primary action.
        handlePlan();
      }
    }
  };

  const prompt = useMemo(() => buildPrompt(form), [form]);
  const handlePlan = () => onPlan?.(prompt);

  // Register a row activator so the global Space hotkey can focus
  // the inline editor without forcing the user to click. The dispatch
  // returns true if it activated, so the global handler can stop.
  useEffect(() => {
    if (!rowDispatchRef) return undefined;
    rowDispatchRef.current = () => {
      if (editorRef.current) {
        editorRef.current.focus();
      }
    };
    return () => {
      if (rowDispatchRef.current) rowDispatchRef.current = null;
    };
  }, [rowDispatchRef]);

  const focusedField = pendingInputRequest?.field || null;

  // Selected flight = the currently picked option, defaults to options[0]
  const selectedFlight =
    itinerary?.selected_flight ||
    itinerary?.flight?.options?.[0] ||
    null;
  const selectedHotel =
    itinerary?.selected_hotel || itinerary?.hotels?.[0] || null;
  const days = itinerary?.days || [];
  const hasItinerary = !!itinerary;
  const planLabel = hasItinerary ? "REPLAN TRIP →" : "PLAN TRIP →";

  return (
    <section className="panel panel-home" aria-label="Home dashboard">
      {/* TOP-LEFT — live status */}
      <button
        type="button"
        className={`home-card home-card-tl agent-${agentState}`}
        onClick={() => onJumpTo?.("HOME")}
        data-testid="home-card-live"
      >
        <div className="home-card-label">📍 LIVE</div>
        <div className="home-card-value">
          {userLocation?.city || "Locating…"}
        </div>
        <div className="home-card-sub">
          {agentState === "working"
            ? `AGENT WORKING${currentTool ? ` · ${currentTool}` : ""}`
            : agentState === "error"
              ? "AGENT ERROR"
              : "AGENT IDLE"}
        </div>
      </button>

      {/* TOP-CENTER — next trip summary */}
      <div className="home-summary-top">
        <div className="home-card-label">🌏 NEXT TRIP</div>
        {itinerary?.destination ? (
          <div className="home-summary-line">
            <strong>{itinerary.origin || userLocation?.city || "—"}</strong>
            <span className="home-arrow"> → </span>
            <strong>{itinerary.destination}</strong>
            <span className="home-summary-meta">
              {days.length > 0
                ? ` · ${days.length} day${days.length !== 1 ? "s" : ""}`
                : " · not yet planned"}
            </span>
          </div>
        ) : (
          <div className="home-summary-line home-card-empty">
            Fill the form on the left and press PLAN TRIP
          </div>
        )}
      </div>

      {/* LEFT — editable trip form */}
      <div className="home-form" data-testid="home-form">
        <ul className="panel-list-items home-form-list">
          {FIELDS.map((field, i) => {
            const value = form[field.key];
            const display =
              field.type === "select"
                ? field.options.find(([v]) => v === value)?.[1] || "—"
                : value || "—";
            const isFocused = focusedField === field.key;
            return (
              <li
                key={field.key}
                className={
                  `panel-list-item${i === selectedIdx ? " active" : ""}` +
                  (isFocused ? " field-pending" : "")
                }
                onClick={() => onJumpTo && onJumpTo("HOME", i)}
                data-field={field.key}
              >
                <span className="panel-list-label">{field.label}</span>
                <span className="panel-list-value">{display}</span>
              </li>
            );
          })}
        </ul>
        <button
          type="button"
          className="trip-plan-btn"
          onClick={handlePlan}
          disabled={isLoading || !form.destination?.trim()}
          data-testid="trip-plan-btn"
        >
          {isLoading ? "PLANNING…" : planLabel}
        </button>
      </div>

      {/* RIGHT — inline editor for the focused field */}
      <div className="home-editor">
        <div className="panel-detail-label">{selected.label}</div>
        {pendingInputRequest && pendingInputRequest.field === selected.key && (
          <div className="trip-form-prompt">{pendingInputRequest.prompt}</div>
        )}
        {selected.type === "text" && (
          <input
            ref={editorRef}
            type="text"
            value={form[selected.key] || ""}
            onChange={update(selected.key)}
            onKeyDown={handleEditorKeyDown}
            placeholder={selected.placeholder}
            className="panel-input"
            data-testid="home-editor-input"
          />
        )}
        {selected.type === "date" && (
          <input
            ref={editorRef}
            type="date"
            value={form[selected.key] || ""}
            onChange={update(selected.key)}
            onKeyDown={handleEditorKeyDown}
            className="panel-input"
            data-testid="home-editor-input"
          />
        )}
        {selected.type === "number" && (
          <input
            ref={editorRef}
            type="number"
            min={selected.min}
            max={selected.max}
            value={form[selected.key] || ""}
            onChange={update(selected.key)}
            onKeyDown={handleEditorKeyDown}
            className="panel-input"
            data-testid="home-editor-input"
          />
        )}
        {selected.type === "select" && (
          <select
            ref={editorRef}
            value={form[selected.key] || ""}
            onChange={update(selected.key)}
            className="panel-input"
            data-testid="home-editor-input"
          >
            {selected.options.map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>
        )}
        {pendingInputRequest && pendingInputRequest.field === selected.key && (
          <button
            type="button"
            className="trip-form-resolve-btn"
            onClick={handleResolveSubmit}
            disabled={!form[selected.key]}
            data-testid="trip-form-resolve-btn"
          >
            SEND ANSWER →
          </button>
        )}
        <p className="panel-detail-hint">
          Click a row or press ↑/↓ to focus a field. Space focuses the editor.
        </p>
      </div>

      {/* BOTTOM-LEFT — selected flight */}
      <button
        type="button"
        className="home-card home-card-bl"
        onClick={() => onJumpTo?.("FLIGHTS")}
        data-testid="home-card-flight"
      >
        <div className="home-card-label">✈ FLIGHT SELECTED</div>
        {itinerary?.flight && selectedFlight ? (
          <>
            <div className="home-card-value">
              {itinerary.flight.from_iata} → {itinerary.flight.to_iata}
            </div>
            <div className="home-card-sub">
              {selectedFlight.airline ? `${selectedFlight.airline} · ` : ""}
              {formatHKD(selectedFlight.price_low)}
              {itinerary.flight.source === "fast-flights" && (
                <span style={{ marginLeft: 8, color: "#5eead4" }}>● LIVE</span>
              )}
            </div>
          </>
        ) : (
          <>
            <div className="home-card-value home-card-empty">—</div>
            <div className="home-card-sub">No flight yet · click to pick</div>
          </>
        )}
      </button>

      {/* BOTTOM-RIGHT — selected hotel */}
      <button
        type="button"
        className="home-card home-card-br"
        onClick={() => onJumpTo?.("HOTELS")}
        data-testid="home-card-hotel"
      >
        <div className="home-card-label">🏨 HOTEL SELECTED</div>
        {selectedHotel ? (
          <>
            <div className="home-card-value">{selectedHotel.name}</div>
            <div className="home-card-sub">
              {selectedHotel.rating != null && (
                <span style={{ color: "#fbbf24", marginRight: 8 }}>
                  ★ {selectedHotel.rating.toFixed(1)}
                </span>
              )}
              {PRICE_LEVEL_LABELS[selectedHotel.price_level] && (
                <span style={{ color: "var(--accent)" }}>
                  {PRICE_LEVEL_LABELS[selectedHotel.price_level]}
                </span>
              )}
            </div>
          </>
        ) : (
          <>
            <div className="home-card-value home-card-empty">—</div>
            <div className="home-card-sub">No hotel yet · click to pick</div>
          </>
        )}
      </button>
    </section>
  );
}
