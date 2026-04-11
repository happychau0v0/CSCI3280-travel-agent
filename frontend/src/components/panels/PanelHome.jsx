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
  // Per-row refs keyed by field key so we can focus a specific input
  // when request_input arrives or when the user clicks a row.
  const rowRefs = useRef({});
  const setRowRef = (key) => (el) => {
    rowRefs.current[key] = el;
  };

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

  // When the LLM sends request_input, focus the matching row's input.
  // For date fields, also call showPicker() if the browser supports
  // it (Chrome/Edge) so the calendar pops up without a click.
  useEffect(() => {
    if (!pendingInputRequest) return;
    const el = rowRefs.current[pendingInputRequest.field];
    if (!el) return;
    el.focus();
    if (typeof el.showPicker === "function") {
      try {
        el.showPicker();
      } catch {
        // Some browsers throw if showPicker is called without a user
        // gesture; ignore, the focus alone is enough.
      }
    }
  }, [pendingInputRequest]);

  const update = (key) => (e) => {
    const next = { ...form, [key]: e.target.value };
    setForm(next);
    saveForm(next);
  };

  const handleResolveSubmit = () => {
    if (!pendingInputRequest) return;
    const value = form[pendingInputRequest.field];
    if (value == null || value === "") return;
    const fieldIdx = FIELDS.findIndex((f) => f.key === pendingInputRequest.field);
    onResolveInput?.(pendingInputRequest.field, value, fieldIdx);
  };

  const handleFieldKeyDown = (fieldKey) => (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (pendingInputRequest && pendingInputRequest.field === fieldKey) {
        handleResolveSubmit();
      } else if (form.destination?.trim() && !isLoading) {
        handlePlan();
      }
    }
  };

  const prompt = useMemo(() => buildPrompt(form), [form]);
  const handlePlan = () => onPlan?.(prompt);

  // Register a row activator for the Space hotkey — focus the row
  // matching the current listIndex so the user can start typing
  // without a click.
  useEffect(() => {
    if (!rowDispatchRef) return undefined;
    rowDispatchRef.current = (i) => {
      const field = FIELDS[Math.min(Math.max(0, i), FIELDS.length - 1)];
      const el = field && rowRefs.current[field.key];
      if (el) el.focus();
    };
    return () => {
      if (rowDispatchRef.current) rowDispatchRef.current = null;
    };
  }, [rowDispatchRef]);

  // selectedIdx still drives the visual "active" highlight on the
  // row list. When request_input is pending, override to that field.
  const requestedIdx = pendingInputRequest
    ? FIELDS.findIndex((f) => f.key === pendingInputRequest.field)
    : -1;
  const selectedIdx =
    requestedIdx >= 0 ? requestedIdx : Math.min(Math.max(0, listIndex), FIELDS.length - 1);
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
    <section className="panel panel-grid panel-home" aria-label="Home dashboard">
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

      {/* LEFT — editable trip form (inline inputs per row) */}
      <div className="home-form home-form-inline" data-testid="home-form">
        <ul className="panel-list-items home-form-list">
          {FIELDS.map((field, i) => {
            const value = form[field.key];
            const isFocused = focusedField === field.key;
            const isActive = i === selectedIdx;
            const rowClass =
              `panel-list-item home-form-row home-form-row-${field.type}` +
              (isActive ? " active" : "") +
              (isFocused ? " field-pending" : "");
            return (
              <li
                key={field.key}
                className={rowClass}
                data-field={field.key}
                onClick={() => {
                  onJumpTo && onJumpTo("HOME", i);
                  rowRefs.current[field.key]?.focus();
                }}
              >
                <span className="panel-list-label">{field.label}</span>
                {field.type === "text" && (
                  <input
                    ref={setRowRef(field.key)}
                    type="text"
                    value={value || ""}
                    onChange={update(field.key)}
                    onKeyDown={handleFieldKeyDown(field.key)}
                    onFocus={() => onJumpTo && onJumpTo("HOME", i)}
                    placeholder={field.placeholder}
                    className="home-form-input"
                    data-testid={
                      isFocused
                        ? "home-editor-input"
                        : `home-input-${field.key}`
                    }
                    data-field={field.key}
                  />
                )}
                {field.type === "date" && (
                  <input
                    ref={setRowRef(field.key)}
                    type="date"
                    value={value || ""}
                    onChange={update(field.key)}
                    onKeyDown={handleFieldKeyDown(field.key)}
                    onFocus={() => onJumpTo && onJumpTo("HOME", i)}
                    className="home-form-input"
                    data-testid={
                      isFocused
                        ? "home-editor-input"
                        : `home-input-${field.key}`
                    }
                    data-field={field.key}
                  />
                )}
                {field.type === "number" && (
                  <input
                    ref={setRowRef(field.key)}
                    type="number"
                    min={field.min}
                    max={field.max}
                    value={value || ""}
                    onChange={update(field.key)}
                    onKeyDown={handleFieldKeyDown(field.key)}
                    onFocus={() => onJumpTo && onJumpTo("HOME", i)}
                    placeholder={String(field.min)}
                    className="home-form-input"
                    data-testid={
                      isFocused
                        ? "home-editor-input"
                        : `home-input-${field.key}`
                    }
                    data-field={field.key}
                  />
                )}
                {field.type === "select" && (
                  <select
                    ref={setRowRef(field.key)}
                    value={value || ""}
                    onChange={update(field.key)}
                    onFocus={() => onJumpTo && onJumpTo("HOME", i)}
                    className="home-form-input"
                    data-testid={
                      isFocused
                        ? "home-editor-input"
                        : `home-input-${field.key}`
                    }
                    data-field={field.key}
                  >
                    {field.options.map(([v, label]) => (
                      <option key={v} value={v}>
                        {label}
                      </option>
                    ))}
                  </select>
                )}
                {isFocused && pendingInputRequest?.prompt && (
                  <div className="home-form-prompt" role="status">
                    {pendingInputRequest.prompt}
                  </div>
                )}
                {isFocused && (
                  <button
                    type="button"
                    className="home-form-resolve-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleResolveSubmit();
                    }}
                    disabled={!form[field.key]}
                    data-testid="trip-form-resolve-btn"
                  >
                    SEND →
                  </button>
                )}
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

      {/* RIGHT — next steps / agent status */}
      <aside className="home-next-steps" data-testid="home-next-steps">
        <div className="home-card-label">◢ NEXT STEPS</div>
        {(() => {
          const missing = [];
          if (!form.destination?.trim()) missing.push("Destination");
          if (!form.start_date) missing.push("Start date");
          if (!form.end_date) missing.push("End date");
          if (!form.transport) missing.push("Transport");
          if (agentState === "working") {
            return (
              <div className="home-next-body">
                <div className="home-next-line home-next-working">
                  Agent working{currentTool ? ` · ${currentTool}` : "…"}
                </div>
                <p className="home-next-hint">Hold tight — your plan is cooking.</p>
              </div>
            );
          }
          if (agentState === "error") {
            return (
              <div className="home-next-body">
                <div className="home-next-line home-next-error">Agent error</div>
                <p className="home-next-hint">Try again or check settings.</p>
              </div>
            );
          }
          if (hasItinerary) {
            return (
              <div className="home-next-body">
                <div className="home-next-line">Trip ready · {days.length} day{days.length !== 1 ? "s" : ""}</div>
                <ul className="home-next-todo">
                  {!itinerary.selected_hotel && <li>Pick a hotel in the HOTELS tab</li>}
                  {!itinerary.selected_flight && <li>Pick a flight in the FLIGHTS tab</li>}
                  <li>Review day activities in DAYS</li>
                </ul>
              </div>
            );
          }
          return (
            <div className="home-next-body">
              <p className="home-next-hint">Fill in the form on the left and press PLAN TRIP.</p>
              {missing.length > 0 && (
                <ul className="home-next-todo">
                  {missing.map((m) => (
                    <li key={m}>{m} missing</li>
                  ))}
                </ul>
              )}
            </div>
          );
        })()}
      </aside>

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
