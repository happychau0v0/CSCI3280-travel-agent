import { useEffect, useState } from "react";

/**
 * SETTINGS panel — list of editable preference fields plus app-level
 * controls (mute, clear data). Persists prefs to localStorage under
 * "travel-prefs" via the parent.
 *
 * Two kinds of rows:
 *   - "field" rows are editable preferences (text/select). Activated
 *     row swaps in an inline editor on the right.
 *   - "action" rows are buttons (mute toggle, clear all data). Pressing
 *     Space or clicking calls the action handler.
 */

const PREF_FIELDS = [
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

export default function PanelSettings({
  listIndex,
  onChange,
  onSelect,
  muted = false,
  onToggleMute,
  onClearAll,
  rowDispatchRef,
}) {
  const [prefs, setPrefs] = useState(() => loadPrefs());
  const [savedFlash, setSavedFlash] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  useEffect(() => {
    onChange?.(preferencesForApi(prefs));
  }, [prefs, onChange]);

  const update = (field) => (e) => {
    const next = { ...prefs, [field]: e.target.value };
    setPrefs(next);
    savePrefs(next);
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 600);
  };

  // Combine pref fields with action rows so the same listIndex cursor
  // moves through everything in a single column.
  const rows = [
    ...PREF_FIELDS.map((f) => ({ kind: "field", ...f })),
    {
      kind: "action",
      key: "mute",
      label: "MUTE TTS",
      value: muted ? "ON" : "OFF",
      onActivate: onToggleMute,
    },
    {
      kind: "action",
      key: "clear",
      label: "CLEAR ALL DATA",
      value: confirmClear ? "TAP AGAIN" : "RESET",
      onActivate: () => {
        if (confirmClear) {
          onClearAll?.();
          setConfirmClear(false);
        } else {
          setConfirmClear(true);
          setTimeout(() => setConfirmClear(false), 4000);
        }
      },
    },
    {
      kind: "action",
      key: "about",
      label: "ABOUT",
      value: "v0.8",
      onActivate: () => {},
    },
  ];

  const selectedIdx = Math.min(listIndex, rows.length - 1);
  const selected = rows[selectedIdx];

  const handleRowClick = (i, row) => {
    onSelect?.(i);
    if (row.kind === "action") row.onActivate?.();
  };

  // Register an imperative row activator so the global Space hotkey
  // can fire the focused row's action without going through a click.
  useEffect(() => {
    if (!rowDispatchRef) return undefined;
    rowDispatchRef.current = (i) => {
      const row = rows[Math.min(i, rows.length - 1)];
      if (row?.kind === "action") row.onActivate?.();
    };
    return () => {
      if (rowDispatchRef.current) rowDispatchRef.current = null;
    };
  }, [rowDispatchRef, rows]);

  return (
    <section className="panel panel-list" aria-label="Settings">
      <ul className="panel-list-items">
        {rows.map((row, i) => {
          let display = "—";
          if (row.kind === "field") {
            const value = prefs[row.key];
            display =
              row.type === "select"
                ? row.options.find(([v]) => v === value)?.[1] || "—"
                : value || "—";
          } else {
            display = row.value;
          }
          return (
            <li
              key={row.key}
              className={
                `panel-list-item${i === selectedIdx ? " active" : ""}` +
                (row.kind === "action" ? " panel-list-action" : "")
              }
              onClick={() => handleRowClick(i, row)}
            >
              <span className="panel-list-label">{row.label}</span>
              <span className="panel-list-value">{display}</span>
            </li>
          );
        })}
      </ul>
      <div className="panel-detail">
        <div className="panel-detail-label">
          {selected.label}
          {savedFlash && selected.kind === "field" && (
            <span className="settings-saved">✓ SAVED</span>
          )}
        </div>

        {selected.kind === "field" && selected.type === "text" && (
          <input
            type="text"
            value={prefs[selected.key] || ""}
            onChange={update(selected.key)}
            placeholder={selected.placeholder}
            className="panel-input"
          />
        )}
        {selected.kind === "field" && selected.type === "select" && (
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

        {selected.kind === "action" && selected.key === "mute" && (
          <>
            <button
              type="button"
              className="settings-btn"
              onClick={selected.onActivate}
            >
              {muted ? "🔇 UNMUTE TTS" : "🔊 MUTE TTS"}
            </button>
            <p className="panel-detail-hint">
              When muted, the agent's reply still shows as a subtitle but
              isn't spoken aloud and audio cues are silenced.
            </p>
          </>
        )}

        {selected.kind === "action" && selected.key === "clear" && (
          <>
            <button
              type="button"
              className={`settings-btn settings-btn-danger${confirmClear ? " confirming" : ""}`}
              onClick={selected.onActivate}
            >
              {confirmClear ? "TAP AGAIN TO CONFIRM" : "CLEAR ALL DATA"}
            </button>
            <p className="panel-detail-hint">
              Wipes the conversation, current itinerary, and saved trip
              form. Preferences are preserved.
            </p>
          </>
        )}

        {selected.kind === "action" && selected.key === "about" && (
          <>
            <p className="panel-detail-hint" style={{ marginTop: 0 }}>
              CSCI3280 AI Travel Agent — round 8 build.<br />
              NieR-style menu shell, voice-first, LLM-driven.
            </p>
          </>
        )}

        {selected.kind === "field" && (
          <p className="panel-detail-hint">
            The agent uses your profile when planning trips. Edit here,
            or speak to update.
          </p>
        )}
      </div>
    </section>
  );
}
