/**
 * Round 18 — trip checklist (packing + reminders).
 *
 * A small pop-down panel the user can open from the PLAN LIVE card
 * to tick off pre-trip tasks. State is persisted to localStorage
 * keyed by the current destination so different trips have
 * independent checklists.
 */
import { useEffect, useState } from "react";

const STORAGE_KEY = "travel-checklist";

const DEFAULT_ITEMS = [
  { key: "passport", label: "Passport valid for 6+ months", critical: true },
  { key: "visa", label: "Visa / ESTA / travel authorization", critical: true },
  { key: "insurance", label: "Travel insurance booked", critical: false },
  { key: "flights_confirm", label: "Flight confirmation received", critical: true },
  { key: "hotel_confirm", label: "Hotel booking confirmed", critical: true },
  { key: "adapter", label: "Power adapter for destination", critical: false },
  { key: "sim", label: "SIM / eSIM / roaming plan", critical: false },
  { key: "cash", label: "Local currency / card with no FX fees", critical: false },
  { key: "meds", label: "Medications + copies of prescriptions", critical: false },
  { key: "emergency", label: "Emergency contacts saved offline", critical: true },
  { key: "calendar", label: "Out of office / calendar blocked", critical: false },
  { key: "home", label: "House-sitter / mail / plants", critical: false },
];

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveState(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* ignore */
  }
}

export default function TripChecklist({ open, destinationKey, onClose }) {
  const [state, setState] = useState(() => loadState());
  const key = destinationKey || "default";
  const checked = state[key] || {};

  useEffect(() => {
    if (!open) return undefined;
    const handler = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose?.();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose]);

  const toggle = (itemKey) => {
    setState((prev) => {
      const prevChecked = prev[key] || {};
      const nextChecked = { ...prevChecked, [itemKey]: !prevChecked[itemKey] };
      const next = { ...prev, [key]: nextChecked };
      saveState(next);
      return next;
    });
  };

  const doneCount = DEFAULT_ITEMS.filter((it) => checked[it.key]).length;
  const critCount = DEFAULT_ITEMS.filter((it) => it.critical).length;
  const critDone = DEFAULT_ITEMS.filter((it) => it.critical && checked[it.key]).length;

  if (!open) return null;

  return (
    <div className="trip-checklist-backdrop" onClick={onClose} data-testid="trip-checklist">
      <div
        className="trip-checklist"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Trip checklist"
      >
        <div className="trip-checklist-header">
          <span className="trip-checklist-chevron">◢</span>
          <span className="trip-checklist-title">TRIP CHECKLIST</span>
          <span className="trip-checklist-count">
            {doneCount}/{DEFAULT_ITEMS.length}
            <span className="trip-checklist-crit">
              {" "}· {critDone}/{critCount} critical
            </span>
          </span>
          <button
            type="button"
            className="trip-checklist-close"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <ul className="trip-checklist-list">
          {DEFAULT_ITEMS.map((item) => {
            const isChecked = !!checked[item.key];
            return (
              <li
                key={item.key}
                className={
                  `trip-checklist-row${isChecked ? " done" : ""}${item.critical ? " critical" : ""}`
                }
              >
                <label>
                  <input
                    type="checkbox"
                    checked={isChecked}
                    onChange={() => toggle(item.key)}
                    data-testid={`trip-checklist-${item.key}`}
                  />
                  <span className="trip-checklist-label">{item.label}</span>
                  {item.critical && <span className="trip-checklist-flag">CRIT</span>}
                </label>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
