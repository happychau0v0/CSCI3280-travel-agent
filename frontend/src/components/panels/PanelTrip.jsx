import { useEffect, useMemo, useState } from "react";

/**
 * TRIP panel — primary trip-control surface. Editable form for the
 * destination, dates, transport mode, party size, and interests, plus
 * a big PLAN TRIP button that fires a chat request.
 *
 * Field list on the left (driven by listIndex), inline editor for the
 * focused field on the right. The PLAN button sits below the list.
 *
 * Form values persist to localStorage under "travel-trip-form" so the
 * user doesn't lose their input on reload.
 */

const STORAGE_KEY = "travel-trip-form";

const FIELDS = [
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
    // ignore
  }
}

function buildPrompt(form, origin) {
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
  return (
    `Plan a ${dayText} trip from ${origin || "my current city"} to ${dest}${dateText} ` +
    `with ${transport} transport for ${party}. Interests: ${interests}.`
  );
}

export default function PanelTrip({
  itinerary,
  userLocation,
  listIndex = 0,
  isLoading = false,
  pendingInputRequest = null,
  onPlan,
}) {
  const [form, setForm] = useState(() => loadForm());

  // Seed defaults from the existing itinerary on first mount so the
  // form reflects the user's last trip.
  useEffect(() => {
    if (itinerary && Object.keys(form).length === 0) {
      const seeded = {
        destination: itinerary.destination || "",
        transport: itinerary.local_transport_mode || "",
      };
      setForm(seeded);
      saveForm(seeded);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const update = (key) => (e) => {
    const next = { ...form, [key]: e.target.value };
    setForm(next);
    saveForm(next);
  };

  const origin = userLocation?.city || "";
  const selectedIdx = Math.min(listIndex, FIELDS.length - 1);
  const selected = FIELDS[selectedIdx];
  const hasItinerary = !!itinerary;
  const planLabel = hasItinerary ? "REPLAN TRIP →" : "PLAN TRIP →";

  const prompt = useMemo(() => buildPrompt(form, origin), [form, origin]);

  const handlePlan = () => {
    onPlan?.(prompt);
  };

  // If the LLM has asked us to focus a specific field, pass it to the
  // pulsing-glow class on that <li>.
  const focusedField = pendingInputRequest?.field || null;

  return (
    <section className="panel panel-list panel-trip-form" aria-label="Trip">
      <div className="trip-form-list">
        <div className="trip-form-origin">
          <span className="panel-list-label">FROM</span>
          <span className="panel-list-value">{origin || "Locating…"}</span>
        </div>
        <ul className="panel-list-items">
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
        >
          {isLoading ? "PLANNING…" : planLabel}
        </button>
      </div>

      <div className="panel-detail">
        <div className="panel-detail-label">{selected.label}</div>
        {pendingInputRequest && pendingInputRequest.field === selected.key && (
          <div className="trip-form-prompt">{pendingInputRequest.prompt}</div>
        )}
        {selected.type === "text" && (
          <input
            type="text"
            value={form[selected.key] || ""}
            onChange={update(selected.key)}
            placeholder={selected.placeholder}
            className="panel-input"
            autoFocus
          />
        )}
        {selected.type === "date" && (
          <input
            type="date"
            value={form[selected.key] || ""}
            onChange={update(selected.key)}
            className="panel-input"
            autoFocus
          />
        )}
        {selected.type === "number" && (
          <input
            type="number"
            min={selected.min}
            max={selected.max}
            value={form[selected.key] || ""}
            onChange={update(selected.key)}
            className="panel-input"
            autoFocus
          />
        )}
        {selected.type === "select" && (
          <select
            value={form[selected.key] || ""}
            onChange={update(selected.key)}
            className="panel-input"
            autoFocus
          >
            {selected.options.map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>
        )}
        <p className="panel-detail-hint">
          Use ↑/↓ to move between fields. Click PLAN TRIP when ready.
        </p>
        <pre className="trip-prompt-preview">{prompt}</pre>
      </div>
    </section>
  );
}
