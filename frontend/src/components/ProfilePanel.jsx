import { useEffect, useState } from "react";

const STORAGE_KEY = "travel-prefs";

const EMPTY_PREFS = {
  interests: "",
  dislikes: "",
  dietary: "",
  budget: "",
  travel_style: "",
};

function loadPrefs() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...EMPTY_PREFS };
    const parsed = JSON.parse(raw);
    return { ...EMPTY_PREFS, ...parsed };
  } catch {
    return { ...EMPTY_PREFS };
  }
}

function savePrefs(prefs) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // localStorage may be unavailable (private mode); fail silently
  }
}

/** Convert raw form values into the dict shape the backend expects. */
export function preferencesForApi(prefs) {
  if (!prefs) return null;
  const out = {};
  if (prefs.interests?.trim()) {
    out.interests = prefs.interests
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (prefs.dislikes?.trim()) {
    out.dislikes = prefs.dislikes
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (prefs.dietary?.trim()) out.dietary = prefs.dietary.trim();
  if (prefs.budget) out.budget = prefs.budget;
  if (prefs.travel_style?.trim()) out.travel_style = prefs.travel_style.trim();
  return Object.keys(out).length > 0 ? out : null;
}

export { loadPrefs };

/**
 * Collapsible profile panel with persistent travel preferences.
 * Calls onChange whenever the preferences are updated.
 */
export default function ProfilePanel({ onChange }) {
  const [open, setOpen] = useState(false);
  const [prefs, setPrefs] = useState(() => loadPrefs());

  // Notify parent on mount + every change
  useEffect(() => {
    onChange?.(preferencesForApi(prefs));
  }, [prefs, onChange]);

  const update = (field) => (e) => {
    const next = { ...prefs, [field]: e.target.value };
    setPrefs(next);
    savePrefs(next);
  };

  const clear = () => {
    setPrefs({ ...EMPTY_PREFS });
    savePrefs({ ...EMPTY_PREFS });
  };

  const filledCount = Object.values(prefs).filter((v) => v).length;

  return (
    <div className={`profile-panel${open ? " open" : ""}`}>
      <button
        type="button"
        className="profile-toggle"
        onClick={() => setOpen((v) => !v)}
        title="Travel preferences"
      >
        <span className="profile-toggle-icon">👤</span>
        <span>Preferences</span>
        {filledCount > 0 && <span className="profile-badge">{filledCount}</span>}
      </button>

      {open && (
        <div className="profile-form">
          <label>
            <span>Interests</span>
            <input
              type="text"
              value={prefs.interests}
              onChange={update("interests")}
              placeholder="history, ramen, hiking"
            />
          </label>
          <label>
            <span>Dislikes</span>
            <input
              type="text"
              value={prefs.dislikes}
              onChange={update("dislikes")}
              placeholder="crowds, seafood"
            />
          </label>
          <label>
            <span>Dietary</span>
            <input
              type="text"
              value={prefs.dietary}
              onChange={update("dietary")}
              placeholder="vegetarian, halal..."
            />
          </label>
          <label>
            <span>Budget</span>
            <select value={prefs.budget} onChange={update("budget")}>
              <option value="">Any</option>
              <option value="$">$ — budget</option>
              <option value="$$">$$ — moderate</option>
              <option value="$$$">$$$ — premium</option>
            </select>
          </label>
          <label>
            <span>Travel style</span>
            <input
              type="text"
              value={prefs.travel_style}
              onChange={update("travel_style")}
              placeholder="relaxed, adventurous..."
            />
          </label>
          <button type="button" className="profile-clear" onClick={clear}>
            Clear all
          </button>
        </div>
      )}
    </div>
  );
}
