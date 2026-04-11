import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * SettingsOverlay — full-screen dimmed settings panel.
 *
 * Triggered by the S hotkey. Same visual model as HistoryOverlay:
 * portal, dimmed backdrop, framed content area, focus-trap, Esc to
 * close. Inside is a list of editable preference rows + actionable
 * rows (mute, clear data, about).
 *
 * Replaces the deleted PanelSettings tab. The same row schema is
 * preserved so the user's localStorage prefs continue to work.
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
    /* ignore */
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

const TTS_STORAGE_KEY = "travel-tts";
const THEME_STORAGE_KEY = "travel-theme";

export function loadTts() {
  try {
    const raw = localStorage.getItem(TTS_STORAGE_KEY);
    if (!raw) return { rate: 1.15, voiceName: null };
    const parsed = JSON.parse(raw);
    return {
      rate: typeof parsed.rate === "number" ? parsed.rate : 1.15,
      voiceName: typeof parsed.voiceName === "string" ? parsed.voiceName : null,
    };
  } catch {
    return { rate: 1.15, voiceName: null };
  }
}

function saveTts(tts) {
  try {
    localStorage.setItem(TTS_STORAGE_KEY, JSON.stringify(tts));
  } catch {
    /* ignore */
  }
}

export function loadTheme() {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    return raw === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

function saveTheme(theme) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    /* ignore */
  }
}

/** Apply a theme to document.body — called on page load and on toggle. */
export function applyTheme(theme) {
  if (typeof document === "undefined") return;
  const body = document.body;
  if (!body) return;
  if (theme === "light") {
    body.classList.add("theme-light");
  } else {
    body.classList.remove("theme-light");
  }
}

export default function SettingsOverlay({
  open,
  onClose,
  onChange,
  onTtsChange,
  muted = false,
  onToggleMute,
  onClearAll,
}) {
  const [prefs, setPrefs] = useState(() => loadPrefs());
  const [tts, setTts] = useState(() => loadTts());
  const [theme, setTheme] = useState(() => loadTheme());
  const [voices, setVoices] = useState([]);
  const [confirmClear, setConfirmClear] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const [savedFlash, setSavedFlash] = useState(false);
  const previousFocusRef = useRef(null);
  const rootRef = useRef(null);

  useEffect(() => {
    onChange?.(preferencesForApi(prefs));
  }, [prefs, onChange]);

  // Notify the parent whenever TTS config changes so useSubtitleQueue
  // applies the new rate/voice on the next utterance.
  useEffect(() => {
    onTtsChange?.(tts);
  }, [tts, onTtsChange]);

  // speechSynthesis.getVoices() returns [] until the voices finish
  // loading on some browsers (Chrome). Subscribe to the onvoiceschanged
  // event so the dropdown populates when voices become available.
  useEffect(() => {
    if (typeof window === "undefined" || !window.speechSynthesis) return undefined;
    const load = () => {
      try {
        setVoices(window.speechSynthesis.getVoices() || []);
      } catch {
        setVoices([]);
      }
    };
    load();
    window.speechSynthesis.onvoiceschanged = load;
    return () => {
      if (window.speechSynthesis) window.speechSynthesis.onvoiceschanged = null;
    };
  }, []);

  const updateTts = (patch) => {
    const next = { ...tts, ...patch };
    setTts(next);
    saveTts(next);
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 600);
  };

  useEffect(() => {
    if (open) {
      setActiveIdx(0);
      setConfirmClear(false);
      previousFocusRef.current = document.activeElement;
      requestAnimationFrame(() => rootRef.current?.focus());
    } else if (previousFocusRef.current) {
      try {
        previousFocusRef.current.focus();
      } catch {
        // ignore
      }
      previousFocusRef.current = null;
    }
  }, [open]);

  const update = (field) => (e) => {
    const next = { ...prefs, [field]: e.target.value };
    setPrefs(next);
    savePrefs(next);
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 600);
  };

  // Same row schema as the old PanelSettings
  const voiceOptions = [
    ["", "System default"],
    ...voices.map((v) => [v.name, `${v.name} (${v.lang})`]),
  ];
  const rows = [
    ...PREF_FIELDS.map((f) => ({ kind: "field", ...f })),
    {
      kind: "tts",
      key: "tts_voice",
      label: "TTS VOICE",
      value: tts.voiceName || "System default",
    },
    {
      kind: "tts",
      key: "tts_rate",
      label: "TTS SPEED",
      value: `${tts.rate.toFixed(2)}×`,
    },
    {
      kind: "action",
      key: "theme",
      label: "THEME",
      value: theme === "light" ? "LIGHT" : "DARK",
      onActivate: () => {
        const next = theme === "light" ? "dark" : "light";
        setTheme(next);
        saveTheme(next);
        applyTheme(next);
        setSavedFlash(true);
        setTimeout(() => setSavedFlash(false), 600);
      },
    },
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
          onClose?.();
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
      value: "v0.85",
      onActivate: () => {},
    },
  ];

  const selectedIdx = Math.min(activeIdx, rows.length - 1);
  const selected = rows[selectedIdx];

  // Local keyboard handler. Parent useKeyboard is disabled while open.
  useEffect(() => {
    if (!open) return undefined;
    const handler = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose?.();
        return;
      }
      const tag = e.target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIdx((i) => Math.max(0, i - 1));
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIdx((i) => Math.min(rows.length - 1, i + 1));
      } else if (e.key === " " || e.key === "Enter") {
        e.preventDefault();
        const row = rows[selectedIdx];
        if (row?.kind === "action") row.onActivate?.();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, rows, selectedIdx, onClose]);

  const handleRowClick = (i, row) => {
    setActiveIdx(i);
    if (row.kind === "action") row.onActivate?.();
  };

  if (!open) return null;

  const content = (
    <div
      className="settings-overlay"
      role="dialog"
      aria-label="Settings"
      ref={rootRef}
      tabIndex={-1}
    >
      <div className="history-overlay-backdrop" onClick={onClose} />
      <div className="history-overlay-frame settings-overlay-frame">
        <header className="history-overlay-header">
          <span className="history-overlay-title">SETTINGS</span>
          <span className="history-overlay-meta">
            <kbd>↑↓</kbd> row · <kbd>Space</kbd> activate · <kbd>Esc</kbd> close
          </span>
        </header>

        <div className="settings-overlay-body">
          <ul className="panel-list-items settings-overlay-list">
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
                  data-row-key={row.key}
                >
                  <span className="panel-list-label">{row.label}</span>
                  <span className="panel-list-value">{display}</span>
                </li>
              );
            })}
          </ul>

          <div className="panel-detail settings-overlay-detail">
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
                data-testid="settings-input"
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

            {selected.kind === "tts" && selected.key === "tts_voice" && (
              <>
                <select
                  value={tts.voiceName || ""}
                  onChange={(e) => updateTts({ voiceName: e.target.value || null })}
                  className="panel-input"
                  data-testid="settings-tts-voice"
                >
                  {voiceOptions.map(([v, label]) => (
                    <option key={v} value={v}>
                      {label}
                    </option>
                  ))}
                </select>
                <p className="panel-detail-hint">
                  Pick a voice for spoken subtitles. Voices depend on your
                  browser / OS. "System default" uses the browser's built-in.
                </p>
              </>
            )}

            {selected.kind === "tts" && selected.key === "tts_rate" && (
              <>
                <input
                  type="range"
                  min="0.8"
                  max="1.5"
                  step="0.05"
                  value={tts.rate}
                  onChange={(e) =>
                    updateTts({ rate: parseFloat(e.target.value) })
                  }
                  className="panel-input"
                  data-testid="settings-tts-rate"
                />
                <p className="panel-detail-hint">
                  Speaking rate (0.8–1.5×). Higher is faster. Applies to the
                  next spoken subtitle.
                </p>
              </>
            )}

            {selected.kind === "action" && selected.key === "mute" && (
              <>
                <button
                  type="button"
                  className="settings-btn"
                  onClick={selected.onActivate}
                  data-testid="settings-mute-btn"
                >
                  {muted ? "🔇 UNMUTE TTS" : "🔊 MUTE TTS"}
                </button>
                <p className="panel-detail-hint">
                  When muted, replies still show as subtitles but aren't
                  spoken aloud and audio cues are silenced.
                </p>
              </>
            )}

            {selected.kind === "action" && selected.key === "clear" && (
              <>
                <button
                  type="button"
                  className={`settings-btn settings-btn-danger${confirmClear ? " confirming" : ""}`}
                  onClick={selected.onActivate}
                  data-testid="settings-clear-btn"
                >
                  {confirmClear ? "TAP AGAIN TO CONFIRM" : "CLEAR ALL DATA"}
                </button>
                <p className="panel-detail-hint">
                  Wipes the conversation, current itinerary, and saved
                  trip form. Preferences are preserved.
                </p>
              </>
            )}

            {selected.kind === "action" && selected.key === "about" && (
              <p className="panel-detail-hint" style={{ marginTop: 0 }}>
                CSCI3280 AI Travel Agent — round 8.5 build.<br />
                NieR-style menu shell, voice-first, LLM-driven.
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(content, document.body);
}
