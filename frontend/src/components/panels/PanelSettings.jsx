import { useEffect, useState } from "react";

/**
 * PROFILE panel — list of editable preference fields on the left,
 * inline editor for the selected field on the right. Persists to
 * localStorage under "travel-prefs" via the parent.
 */

const FIELDS = [
  { key: "interests", label: "INTERESTS", type: "text", placeholder: "history, ramen, hiking" },
  { key: "dislikes", label: "DISLIKES", type: "text", placeholder: "crowds, seafood" },
  { key: "dietary", label: "DIETARY", type: "text", placeholder: "vegetarian, halal" },
  {
    key: "budget",
    label: "BUDGET",
    type: "select",
    options: [
      ["", "Any"],
      ["$", "$ — budget"],
      ["$$", "$$ — moderate"],
      ["$$$", "$$$ — premium"],
    ],
  },
  { key: "travel_style", label: "TRAVEL STYLE", type: "text", placeholder: "relaxed, adventurous" },
];

const STORAGE_KEY = "travel-prefs";

function loadPrefs() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function savePrefs(prefs) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // ignore
  }
}

export function preferencesForApi(prefs) {
  if (!prefs) return null;
  const out = {};
  if (prefs.interests?.trim()) {
    out.interests = prefs.interests.split(",").map((s) => s.trim()).filter(Boolean);
  }
  if (prefs.dislikes?.trim()) {
    out.dislikes = prefs.dislikes.split(",").map((s) => s.trim()).filter(Boolean);
  }
  if (prefs.dietary?.trim()) out.dietary = prefs.dietary.trim();
  if (prefs.budget) out.budget = prefs.budget;
  if (prefs.travel_style?.trim()) out.travel_style = prefs.travel_style.trim();
  return Object.keys(out).length > 0 ? out : null;
}

export default function PanelSettings({ listIndex, onChange, onSelect }) {
  const [prefs, setPrefs] = useState(() => loadPrefs());

  useEffect(() => {
    onChange?.(preferencesForApi(prefs));
  }, [prefs, onChange]);

  const update = (field) => (e) => {
    const next = { ...prefs, [field]: e.target.value };
    setPrefs(next);
    savePrefs(next);
  };

  const selected = FIELDS[Math.min(listIndex, FIELDS.length - 1)];

  return (
    <section className="panel panel-list" aria-label="Profile">
      <ul className="panel-list-items">
        {FIELDS.map((field, i) => {
          const value = prefs[field.key];
          const display =
            field.type === "select"
              ? field.options.find(([v]) => v === value)?.[1] || "—"
              : value || "—";
          return (
            <li
              key={field.key}
              className={`panel-list-item${i === listIndex ? " active" : ""}`}
              onClick={() => onSelect?.(i)}
            >
              <span className="panel-list-label">{field.label}</span>
              <span className="panel-list-value">{display}</span>
            </li>
          );
        })}
      </ul>
      <div className="panel-detail">
        {selected && (
          <>
            <div className="panel-detail-label">{selected.label}</div>
            {selected.type === "text" && (
              <input
                type="text"
                value={prefs[selected.key] || ""}
                onChange={update(selected.key)}
                placeholder={selected.placeholder}
                className="panel-input"
              />
            )}
            {selected.type === "select" && (
              <select
                value={prefs[selected.key] || ""}
                onChange={update(selected.key)}
                className="panel-input"
              >
                {selected.options.map(([v, label]) => (
                  <option key={v} value={v}>
                    {label}
                  </option>
                ))}
              </select>
            )}
            <p className="panel-detail-hint">
              The agent uses your profile when planning trips. Edit here, or speak to update.
            </p>
          </>
        )}
      </div>
    </section>
  );
}
