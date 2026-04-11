import { useEffect, useMemo, useRef, useState } from "react";
import PlanHistoryPanel from "../PlanHistoryPanel";
import { formatDisplayPrice } from "../SettingsOverlay";

/**
 * PLAN (was HOME) — the trip-setup panel. Left = editable form,
 * center = globe background, right = NEXT STEPS hint card. Round 10
 * dropped the bottom flight/hotel preview cards so the form fits at
 * 1280×720 without scroll.
 *
 * Layout (CSS grid, 2 rows):
 *   ┌───────────┬─────────────────┬───────────┐
 *   │ 📍 LIVE   │   ↑ NEXT TRIP ↑ │ (empty)   │
 *   ├───────────┤    (globe in    ├───────────┤
 *   │ TRIP FORM │    background)  │ ◢ NEXT    │
 *   │ ↑↓ fields │                 │   STEPS   │
 *   │ START →   │                 │           │
 *   └───────────┴─────────────────┴───────────┘
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
  {
    key: "seat_class",
    label: "CABIN",
    type: "select",
    options: [
      ["economy", "Economy"],
      ["premium_economy", "Premium Economy"],
      ["business", "Business"],
      ["first", "First"],
    ],
  },
  { key: "party_size", label: "PARTY SIZE", type: "number", min: 1, max: 8 },
  { key: "interests", label: "INTERESTS", type: "text", placeholder: "history, food, hiking" },
];

export const HOME_FIELD_COUNT = FIELDS.length;

// Round 14 — quick-start templates that pre-fill the form with
// common trip shapes. Users still edit individual fields after
// applying a template.
function _daysFromToday(start, length) {
  const d = new Date();
  d.setDate(d.getDate() + start);
  const startIso = d.toISOString().slice(0, 10);
  d.setDate(d.getDate() + length - 1);
  const endIso = d.toISOString().slice(0, 10);
  return { start_date: startIso, end_date: endIso };
}

const TEMPLATES = [
  {
    key: "weekend",
    label: "WEEKEND",
    fields: () => ({
      destination: "",
      transport: "transit",
      seat_class: "economy",
      party_size: "2",
      interests: "food, local culture, coffee",
      ..._daysFromToday(14, 3),
    }),
  },
  {
    key: "foodie",
    label: "FOODIE",
    fields: () => ({
      destination: "",
      transport: "transit",
      seat_class: "premium_economy",
      party_size: "2",
      interests: "restaurants, street food, markets, michelin",
      ..._daysFromToday(30, 5),
    }),
  },
  {
    key: "museum",
    label: "MUSEUM",
    fields: () => ({
      destination: "",
      transport: "walking",
      seat_class: "economy",
      party_size: "1",
      interests: "museums, galleries, history, architecture",
      ..._daysFromToday(30, 4),
    }),
  },
  {
    key: "honeymoon",
    label: "HONEYMOON",
    fields: () => ({
      destination: "",
      transport: "driving",
      seat_class: "business",
      party_size: "2",
      interests: "romantic dinners, scenic views, spas, beaches",
      ..._daysFromToday(60, 7),
    }),
  },
];

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

const SEAT_CLASS_TEXT = {
  economy: "economy",
  premium_economy: "premium economy",
  business: "business class",
  first: "first class",
};

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
  const seat = form.seat_class || "economy";
  const seatText = SEAT_CLASS_TEXT[seat] || "economy";
  return (
    `Plan a ${dayText} trip from ${origin} to ${dest}${dateText} ` +
    `with ${transport} transport for ${party}. Interests: ${interests}. ` +
    `Flight cabin: ${seatText}. Use search_flights with seat_class="${seat}".`
  );
}

// Round 15 — rough estimate of per-person, per-night hotel cost by
// Google Places price_level. Pure HKD approximations.
const HOTEL_NIGHTLY_HKD = {
  PRICE_LEVEL_FREE: 0,
  PRICE_LEVEL_INEXPENSIVE: 600,
  PRICE_LEVEL_MODERATE: 1200,
  PRICE_LEVEL_EXPENSIVE: 2500,
  PRICE_LEVEL_VERY_EXPENSIVE: 4500,
};

const DEFAULT_ACTIVITY_COST_HKD = 250;

function computeTripCostHkd(itinerary) {
  if (!itinerary) return null;
  const party = Number(itinerary.party_size) || 1;
  // Flight: party * price_low of the picked or recommended option
  const flight = itinerary.flight;
  const flightOpt = itinerary.selected_flight || flight?.options?.[0] || null;
  const flightCost =
    flightOpt && typeof flightOpt.price_low === "number"
      ? flightOpt.price_low * party
      : 0;
  // Hotel: price_level → nightly rate × nights × 1 (shared room)
  const hotel = itinerary.selected_hotel || itinerary.hotels?.[0] || null;
  const days = itinerary.days || [];
  const nights = Math.max(0, days.length - 1);
  const nightly = hotel ? HOTEL_NIGHTLY_HKD[hotel.price_level] ?? 1200 : 0;
  const hotelCost = nightly * nights;
  // Activities: rough DEFAULT_ACTIVITY_COST_HKD per non-hotel, non-airport activity × party
  const hotelName = hotel?.name || null;
  let activityCount = 0;
  for (const d of days) {
    for (const a of d.activities || []) {
      if (a.name === hotelName) continue;
      if (/airport/i.test(a.name || "")) continue;
      activityCount += 1;
    }
  }
  const activityCost = activityCount * DEFAULT_ACTIVITY_COST_HKD * party;
  return {
    total: flightCost + hotelCost + activityCost,
    flight: flightCost,
    hotel: hotelCost,
    activity: activityCost,
    activityCount,
    nights,
    party,
  };
}

export default function PanelHome({
  itinerary,
  userLocation,
  agentState = "idle",
  currentTool = null,
  listIndex = 0,
  isLoading = false,
  pendingInputRequest = null,
  planHistory = [],
  currency = "HKD",
  onLoadPlan,
  onDeletePlan,
  onImportPlan,
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

  const days = itinerary?.days || [];
  const hasItinerary = !!itinerary;
  const planLabel = hasItinerary ? "REPLAN →" : "START PLANNING →";

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

      {/* TOP-CENTER — next trip summary + R14 template chips */}
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
            Fill the form on the left and press START PLANNING
          </div>
        )}
        {(() => {
          const cost = computeTripCostHkd(itinerary);
          if (!cost || cost.total <= 0) return null;
          return (
            <div className="home-summary-cost" data-testid="home-summary-cost">
              <span className="home-summary-meta">EST TOTAL</span>{" "}
              <strong>{formatDisplayPrice(cost.total, currency)}</strong>
              <span className="home-summary-meta">
                {" "}· flight {formatDisplayPrice(cost.flight, currency)}
                {cost.hotel > 0 && ` · hotel ${formatDisplayPrice(cost.hotel, currency)}`}
                {cost.activity > 0 && ` · ${cost.activityCount} stops`}
              </span>
            </div>
          );
        })()}
        <div className="home-template-strip" data-testid="home-template-strip">
          <span className="home-template-label">QUICK START</span>
          {TEMPLATES.map((tpl) => (
            <button
              key={tpl.key}
              type="button"
              className="home-template-chip"
              data-testid={`home-template-${tpl.key}`}
              onClick={() => {
                const patch = tpl.fields();
                // Keep any user-set destination / origin — templates
                // only fill the missing slots so clicking doesn't
                // stomp a typed destination.
                const merged = {
                  ...form,
                  ...patch,
                  origin: form.origin?.trim() || userLocation?.city || "",
                  destination: form.destination?.trim() || patch.destination || "",
                };
                setForm(merged);
                saveForm(merged);
              }}
            >
              {tpl.label}
            </button>
          ))}
        </div>
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
                    data-testid={`home-input-${field.key}`}
                    data-field={field.key}
                    {...(isFocused ? { "data-editor-active": "true" } : {})}
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
                    data-testid={`home-input-${field.key}`}
                    data-field={field.key}
                    {...(isFocused ? { "data-editor-active": "true" } : {})}
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
                    data-testid={`home-input-${field.key}`}
                    data-field={field.key}
                    {...(isFocused ? { "data-editor-active": "true" } : {})}
                  />
                )}
                {field.type === "select" && (
                  <select
                    ref={setRowRef(field.key)}
                    value={value || ""}
                    onChange={update(field.key)}
                    onFocus={() => onJumpTo && onJumpTo("HOME", i)}
                    className="home-form-input"
                    data-testid={`home-input-${field.key}`}
                    data-field={field.key}
                    {...(isFocused ? { "data-editor-active": "true" } : {})}
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

      {/* RIGHT — plan history (Round 11 — replaced the NEXT STEPS
       *  hint card with a scrollable list of past plans). */}
      <div className="home-history-slot">
        <PlanHistoryPanel
          plans={planHistory}
          onLoad={onLoadPlan}
          onDelete={onDeletePlan}
          onImport={onImportPlan}
        />
      </div>
    </section>
  );
}
